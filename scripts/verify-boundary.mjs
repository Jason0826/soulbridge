/**
 * ADR 0027 的三项验证（离线、确定性）。
 *
 * E3 删除 importance 后排序是否退化：真实 memories × 真实 query
 * E1 聚合保真：全库真值 vs 模型"看得到的前 k 条"里的值
 * E2 原料条数 vs 命中率：k 条候选里含来源轮次的比例
 *
 * 用法：node --experimental-strip-types scripts/verify-boundary.mjs <db-path>
 */
import { DatabaseSync } from 'node:sqlite';

const core = new URL('../packages/core/src/', import.meta.url).href;
const { tokenize, bm25, buildCorpusStats } = await import(`${core}scoring.ts`);
const { openSqlite } = await import(`${core}sqlite.ts`);

const DB_PATH = process.argv[2] ?? 'C:/Users/DELL/.soulbridge/soul.db';
if (process.argv[2]) openSqlite(DB_PATH).close(); // migrate a copy, never the live file
const db = new DatabaseSync(DB_PATH);

const memories = db
  .prepare(
    `SELECT id, content, keywords, importance, recall_count, last_recalled_at, created_at
     FROM memories WHERE status = 'active' AND deleted_at IS NULL`,
  )
  .all();

const turns = db
  .prepare('SELECT id, user_text, assistant_text, started_at FROM turns ORDER BY started_at DESC LIMIT 60')
  .all();

const queries = turns
  .slice(0, 20)
  .map((t) => String(t.user_text).replace(/\s+/g, ' ').trim())
  .filter((q) => q.length >= 4);

console.log(`记忆 ${memories.length} 条 / 轮 ${turns.length} 条 / 查询 ${queries.length} 条`);

// ---------- E3 ----------
const memTokens = (m) => [
  ...tokenize(String(m.content)),
  ...String(m.keywords ?? '[]')
    .replace(/[\[\]"]/g, ' ')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((k) => k.toLowerCase()),
];
const memStats = buildCorpusStats(memories.map(memTokens));

function rankWith(w) {
  return (query) => {
    const q = tokenize(query);
    if (q.length === 0) return [];
    const scored = memories.map((m, i) => ({ m, raw: bm25(q, memTokens(m), memStats) }));
    const best = scored.reduce((max, s) => Math.max(max, s.raw), 0);
    if (best <= 0) return [];
    return scored
      .filter((s) => s.raw > 0)
      .map(({ m, raw }) => {
        const rel = raw / best;
        const imp = Math.min(1, Math.max(0, Number(m.importance) / 10));
        const days = Math.max(0, (Date.now() - Number(m.last_recalled_at ?? m.created_at)) / 86400000);
        const rec = Math.pow(0.5, days / 30);
        const viv = 0.85; // 真机上只有 0.8/0.9 两个值
        const recall = Math.min(1, Math.max(0, Number(m.recall_count) / 10));
        return {
          id: m.id,
          score: rel * w.relevance + imp * w.importance + rec * w.recency + viv * w.vividness + recall * w.recall,
        };
      })
      .sort((a, b) => b.score - a.score);
  };
}

const base = { relevance: 0.35, importance: 0.25, recency: 0.2, vividness: 0.15, recall: 0.05 };
const noImpRaw = { ...base, importance: 0 };
const sumWithout = 0.35 + 0.2 + 0.15 + 0.05;
const noImpRenorm = {
  relevance: 0.35 / sumWithout,
  importance: 0,
  recency: 0.2 / sumWithout,
  vividness: 0.15 / sumWithout,
  recall: 0.05 / sumWithout,
};

function compare(w) {
  const rankA = rankWith(base);
  const rankB = rankWith(w);
  let sum = 0;
  let n = 0;
  let same = 0;
  for (const q of queries) {
    const a = rankA(q).slice(0, 5).map((x) => x.id);
    const b = rankB(q).slice(0, 5).map((x) => x.id);
    if (a.length === 0 && b.length === 0) continue;
    n += 1;
    const setB = new Set(b);
    const inter = a.filter((id) => setB.has(id)).length;
    const union = new Set([...a, ...b]).size;
    sum += union === 0 ? 1 : inter / union;
    if (a.join() === b.join()) same += 1;
  }
  return { jaccard: sum / Math.max(1, n), same, n };
}

const raw = compare(noImpRaw);
const renorm = compare(noImpRenorm);
console.log('\n[E3] 去 importance 后 top-5 重合（5 权重原式，含 vividness）');
console.log(`  其余权重不动   : Jaccard ${raw.jaccard.toFixed(3)}，完全不变 ${raw.same}/${raw.n}`);
console.log(`  其余权重再归一 : Jaccard ${renorm.jaccard.toFixed(3)}，完全不变 ${renorm.same}/${renorm.n}`);

// ---------- 轮次检索（E1、E2 共用） ----------
const turnDocs = turns.map((t) => [...tokenize(String(t.user_text)), ...tokenize(String(t.assistant_text))]);
const turnStats = buildCorpusStats(turnDocs);
function search(text, k) {
  const q = tokenize(text);
  if (q.length === 0) return [];
  return turns
    .map((t, i) => ({ id: t.id, score: bm25(q, turnDocs[i], turnStats) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// E1：聚合问题只能数"给到的原料"，所以要看 k 增大时真值集合被找到多少
const topics = ['记忆', '测试', '会话', '人物', '数据', '文档'];
console.log('\n[E1] 聚合保真：k 条原料覆盖了真值集合的多少');
for (const topic of topics) {
  const truthIds = new Set(
    db
      .prepare('SELECT id FROM turns WHERE user_text LIKE ? OR assistant_text LIKE ?')
      .all(`%${topic}%`, `%${topic}%`)
      .map((r) => r.id),
  );
  if (truthIds.size === 0) {
    console.log(`  「${topic}」真值 0 条（跳过）`);
    continue;
  }
  const parts = [5, 10, 20, 40].map((k) => {
    const got = search(topic, k).filter((x) => truthIds.has(x.id)).length;
    return `k=${k}:${got}/${truthIds.size}`;
  });
  console.log(`  「${topic}」真值 ${truthIds.size} 条 → ${parts.join('  ')}`);
}

// E2：用一段时间里的真实短查询（用户消息前 10 字）反查该轮
const ks = [1, 3, 5, 10, 20, 40];
const hits = new Map(ks.map((k) => [k, 0]));
let cases = 0;
for (const t of turns) {
  const q = String(t.user_text).replace(/\s+/g, ' ').trim().slice(0, 10);
  if (q.length < 4) continue;
  cases += 1;
  const ranked = search(q, turns.length);
  const idx = ranked.findIndex((x) => x.id === t.id);
  for (const k of ks) if (idx >= 0 && idx < k) hits.set(k, hits.get(k) + 1);
}
console.log(`\n[E2] k 条原料里含来源轮次（查询=用户消息前 10 字，样本 ${cases} 轮）`);
for (const k of ks) {
  console.log(`  k=${String(k).padStart(2)} → ${((hits.get(k) / Math.max(1, cases)) * 100).toFixed(1)}%`);
}

db.close();
