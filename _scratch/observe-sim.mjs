// 只读探针 v2：按装机 0.0.127 的算法重建 S1(12:44)/S2(12:48) 的候选池，与 trace 对账；
// 并对三次抽取的 incoming 事实做相似度筛查（辨别样本：池里到底有没有真重复）。
// 用法: node _scratch/observe-sim.mjs [sim|dup|all]   (默认 all)
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HOME = join(homedir(), '.soulbridge');
const INSTALLED = 'D:/DSH/home/profiles/web/node_modules/soulbridge/dist/packages/core/src/index.js';
const part = process.argv[2] ?? 'all';
const SOUL = 'xiaoling';
const USER = 'local';
const BUDGET = 2400;
const SIMILAR_CAP = 60;
const FLOOR_RATIO = 0.35;
const RECENT_FLOOR = 12;

const SCRATCH = 'D:/git-workspace/repos/soulbridge/_scratch';
const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const { tokenize, bm25, buildCorpusStats } = await import(pathToFileURL(INSTALLED).href);

const FLUSHES = [
  {
    tag: 'S1',
    session: 'session-a6a1e6f6-2805-4f40-a8c3-bf4165d15a91',
    turnNo: 1372,
    headRow: 'tp_mwhtbh1o_xvee',
    flushIso: '2026-11-15T12:44:28.893Z',
    trace: {
      chosen: 44,
      chars: 2368,
      byTier: { entity: 0, thread: 0, similar: 44, recent: 0 },
      dropped: ['fc_mw21idgn_c','fc_mw1z71du_1','fc_mw0dvgpi_18','fc_mw0dqxv0_16','fc_mw6kgbrq_b','fc_mw6jxz1m_1b','fc_mw6it6wh_2o','fc_mw538csb_7','fc_mw45r3sr_5','fc_mw5ru7sm_f','fc_mw1z71gd_5','fc_mw1z71fm_3','fc_mw0o6085_4','fc_mw0dvgqh_1b','fc_mw6it6vw_2m','fc_mw2qv2nf_2'],
    },
  },
  {
    tag: 'S2',
    session: 'session-be8b74a6-0766-4c6b-8114-876551d02ae8',
    turnNo: 614,
    headRow: 'tp_mwhttt6c_ejk3',
    flushIso: '2026-11-15T12:47:07.715Z',
    trace: {
      chosen: 53,
      chars: 3092,
      byTier: { entity: 0, thread: 53, similar: 0, recent: 0 },
      dropped: ['fc_mw01gjet_9','fc_mw00yaus_4','fc_lg_mem_mvwu6qmn_f9bh','fc_mw255e8l_d','fc_mwaqxj4w_1y','fc_mw1z71du_1'],
    },
  },
];

function rowToFact(r) {
  return { id: String(r.id), statement: String(r.statement), createdAt: Number(r.created_at), status: String(r.status) };
}

function activeFactsAsOf(flushMs) {
  const rows = db
    .prepare(
      `SELECT id, statement, created_at, status, valid_from FROM facts
        WHERE soul_id = ? AND user_id = ? AND created_at < ?
        ORDER BY COALESCE(valid_from, created_at) DESC LIMIT 100000`,
    )
    .all(SOUL, USER, flushMs);
  return rows.map(rowToFact).filter((f) => f.status === 'active');
}

function threadBefore(sessionId, turnNo) {
  const row = db
    .prepare(
      `SELECT thread_id FROM turns WHERE session_id = ? AND turn_no < ? AND thread_id IS NOT NULL
        ORDER BY turn_no DESC LIMIT 1`,
    )
    .get(sessionId, turnNo);
  return row ? String(row.thread_id) : null;
}

function threadTurnIds(threadId) {
  return db.prepare('SELECT id FROM turns WHERE thread_id = ? ORDER BY turn_no ASC').all(threadId).map((r) => String(r.id));
}

function factsByTurnsAsOf(turnIds, flushMs) {
  if (turnIds.length === 0) return [];
  const ph = turnIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, statement, created_at, status FROM facts
        WHERE source_turn_id IN (${ph}) AND status = 'active' AND created_at < ?
        ORDER BY created_at ASC`,
    )
    .all(...turnIds, flushMs);
  return rows.map(rowToFact);
}

function entitiesAsOf(flushMs) {
  const rows = db
    .prepare(
      `SELECT * FROM entities WHERE soul_id = ? AND user_id = ? AND created_at < ?
        ORDER BY last_mentioned_at DESC LIMIT 500`,
    )
    .all(SOUL, USER, flushMs);
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    aliases: (() => { try { return JSON.parse(String(r.aliases ?? '[]')); } catch { return []; } })(),
  }));
}

function entityFactsAsOf(entityId, flushMs) {
  const rows = db
    .prepare(
      `SELECT f.id, f.statement, f.created_at, f.status FROM facts f
        WHERE f.soul_id = ? AND f.user_id = ? AND f.created_at < ?
          AND EXISTS (SELECT 1 FROM fact_slots s WHERE s.fact_id = f.id AND s.entity_id = ?)
        ORDER BY COALESCE(f.valid_from, f.created_at) DESC LIMIT 200`,
    )
    .all(SOUL, USER, flushMs, entityId);
  return rows.map(rowToFact).filter((f) => f.status === 'active');
}

function reconstruct(spec) {
  const flushMs = Date.parse(spec.flushIso);
  const text = String(db.prepare('SELECT user_text FROM turns WHERE id = ?').get(spec.headRow)?.user_text ?? '');
  const active = activeFactsAsOf(flushMs);
  const groups = [];

  // Tier 0: entity groups (name/alias appears in the text)
  const entities = entitiesAsOf(flushMs);
  const entityHits = [];
  for (const entity of entities) {
    const names = [entity.name, ...(entity.aliases ?? [])].filter((n) => n.trim().length >= 2);
    if (!names.some((n) => text.includes(n))) continue;
    const ofEntity = entityFactsAsOf(entity.id, flushMs);
    entityHits.push(`${entity.name}:${ofEntity.length}`);
    if (ofEntity.length > 0) groups.push({ key: `entity:${entity.name}`, tier: 0, facts: ofEntity });
  }

  // Tier 1: the thread the previous turn belonged to
  const threadId = threadBefore(spec.session, spec.turnNo);
  let threadInfo = 'null';
  if (threadId) {
    const ofThread = factsByTurnsAsOf(threadTurnIds(threadId), flushMs);
    threadInfo = `${threadId} facts=${ofThread.length} ch=${ofThread.reduce((s, f) => s + f.statement.length, 0)}`;
    if (ofThread.length > 0) groups.push({ key: 'thread', tier: 1, facts: ofThread });
  }

  // Tier 2: BM25 look-alikes
  let similarInfo = 'no-text';
  if (text.trim()) {
    const picked = new Set(groups.flatMap((g) => g.facts.map((f) => f.id)));
    const pool = active.filter((f) => !picked.has(f.id));
    if (pool.length > 0) {
      const query = tokenize(text);
      const docs = pool.map((f) => tokenize(f.statement));
      const stats = buildCorpusStats(docs);
      const scored = pool
        .map((f, at) => ({ fact: f, score: bm25(query, docs[at], stats) }))
        .filter((e) => e.score > 0)
        .sort((l, r) => r.score - l.score || r.fact.createdAt - l.fact.createdAt);
      const best = scored[0]?.score ?? 0;
      const strong = scored.filter((e) => e.score >= best * FLOOR_RATIO);
      similarInfo = `pool=${pool.length} scored>0=${scored.length} best=${best.toFixed(3)} strong=${strong.length}`;
      for (const e of strong.slice(0, SIMILAR_CAP)) groups.push({ key: `similar:${e.fact.id}`, tier: 2, facts: [e.fact] });
    }
  }

  // Tier 3: recent floor
  const named = new Set(groups.flatMap((g) => g.facts.map((f) => f.id)));
  const specific = groups.filter((g) => g.tier < 3).reduce((s, g) => s + g.facts.length, 0);
  let recentInfo = 'skipped';
  if (specific < RECENT_FLOOR) {
    const recent = active.filter((f) => !named.has(f.id)).sort((l, r) => r.createdAt - l.createdAt).slice(0, RECENT_FLOOR - specific);
    recentInfo = `added=${recent.length}`;
    if (recent.length > 0) groups.push({ key: 'recent', tier: 3, facts: recent });
  }

  // Ordering: tier first, then group relevance (BM25 top fact)
  const queryTokens = text ? tokenize(text) : [];
  let ordered = groups;
  let orderedBy = 'tier-only';
  if (queryTokens.length > 0 && groups.length > 1) {
    const docs = groups.flatMap((g) => g.facts.map((f) => tokenize(f.statement)));
    const stats = buildCorpusStats(docs);
    let at = 0;
    const scored = groups.map((group) => {
      let top = 0;
      for (const _fact of group.facts) {
        const score = bm25(queryTokens, docs[at], stats);
        at += 1;
        if (score > top) top = score;
      }
      return { group, top };
    });
    ordered = scored.sort((l, r) => l.group.tier - r.group.tier || r.top - l.top).map((e) => e.group);
    orderedBy = 'tier+relevance';
  } else {
    ordered = [...groups].sort((l, r) => l.tier - r.tier);
  }

  // Budget walk with first-group oversized exception
  const chosen = [];
  const taken = new Set();
  const dropped = [];
  const byTier = { entity: 0, thread: 0, similar: 0, recent: 0 };
  let chars = 0;
  for (const group of ordered) {
    const fresh = group.facts.filter((f) => !taken.has(f.id));
    if (fresh.length === 0) continue;
    const cost = fresh.reduce((s, f) => s + f.statement.length, 0);
    const tier = group.tier === 0 ? 'entity' : group.tier === 1 ? 'thread' : group.tier === 2 ? 'similar' : 'recent';
    if (chosen.length > 0 && chars + cost > BUDGET) {
      dropped.push({ group: group.key, facts: fresh.length });
      continue;
    }
    for (const f of fresh) { chosen.push(f); taken.add(f.id); }
    chars += cost;
    byTier[tier] += fresh.length;
  }

  return { text, threadInfo, entityHits, similarInfo, recentInfo, orderedBy, groups, chosen, dropped, byTier, chars, activeCount: active.length, entityCount: entities.length };
}

function compare(tag, sim, trace) {
  const problems = [];
  if (sim.chosen.length !== trace.chosen) problems.push(`chosen ${sim.chosen.length} != ${trace.chosen}`);
  if (sim.chars !== trace.chars) problems.push(`chars ${sim.chars} != ${trace.chars}`);
  for (const k of Object.keys(trace.byTier)) {
    if (sim.byTier[k] !== trace.byTier[k]) problems.push(`byTier.${k} ${sim.byTier[k]} != ${trace.byTier[k]}`);
  }
  const simDropped = sim.dropped.map((d) => d.group.replace(/^similar:/, '')).sort();
  const traceDropped = [...trace.dropped].sort();
  if (JSON.stringify(simDropped) !== JSON.stringify(traceDropped)) {
    problems.push(`dropped mismatch\n    sim:   ${simDropped.join(',')}\n    trace: ${traceDropped.join(',')}`);
  }
  return problems;
}

if (part === 'all' || part === 'sim') {
  for (const spec of FLUSHES) {
    const sim = reconstruct(spec);
    console.log(`\n===== ${spec.tag} (${spec.flushIso}) =====`);
    console.log(`text(${sim.text.length}ch): ${JSON.stringify(sim.text)}`);
    console.log(`active as-of=${sim.activeCount} entities=${sim.entityCount} entityHits=[${sim.entityHits.join(' ')}]`);
    console.log(`threadBefore: ${sim.threadInfo}`);
    console.log(`similar: ${sim.similarInfo} | recent: ${sim.recentInfo} | ordering: ${sim.orderedBy}`);
    console.log(`groups: ${sim.groups.map((g) => `${g.key}(${g.facts.length})`).join(' ')}`);
    console.log(`WALK: chosen=${sim.chosen.length} chars=${sim.chars} byTier=${JSON.stringify(sim.byTier)} dropped=${sim.dropped.map((d) => `${d.group}:${d.facts}`).join(' ')}`);
    const problems = compare(spec.tag, sim, spec.trace);
    console.log(problems.length === 0 ? 'RECONCILE: PASS (与 trace 逐项一致)' : `RECOCILE: FAIL\n  - ${problems.join('\n  - ')}`);
    writeFileSync(join(SCRATCH, `sim-chosen-${spec.tag}.json`), JSON.stringify(sim.chosen.map((f) => f.id), null, 1));
    // S2: dump the thread pool for the duplicate judgment
    if (spec.tag === 'S2') {
      console.log('--- S2 pool (53) statements ---');
      for (const f of sim.chosen) console.log(`  ${f.id} ${f.statement}`);
    }
  }
}

if (part === 'all' || part === 'dup') {
  const windows = [
    ['S1', ['fc_mwhtufs6_1','fc_mwhtufss_2','fc_mwhtuft0_3','fc_mwhtuft8_4','fc_mwhtuftg_5','fc_mwhtuftv_6'], Date.parse('2026-11-15T12:44:28.893Z')],
    ['S2', ['fc_mwhtylvo_7','fc_mwhtylw0_8','fc_mwhtylwk_9','fc_mwhtylx2_a','fc_mwhtylxf_b','fc_mwhtylxz_c','fc_mwhtylye_d','fc_mwhtylyr_e'], Date.parse('2026-11-15T12:47:07.715Z')],
    ['S3', ['fc_mwhu30ew_f','fc_mwhu30fc_g'], Date.parse('2026-11-15T12:50:47.017Z')],
  ];
  const poolOf = {};
  for (const tag of ['S1', 'S2']) {
    const p = join(SCRATCH, `sim-chosen-${tag}.json`);
    poolOf[tag] = existsSync(p) ? new Set(JSON.parse(readFileSync(p, 'utf8'))) : null;
  }
  const bigrams = (s) => { const t = new Set(); for (let i = 0; i < s.length - 1; i++) t.add(s.slice(i, i + 2)); return t; };
  const jac = (a, b) => {
    const A = bigrams(a), B = bigrams(b);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter += 1;
    return inter / (A.size + B.size - inter || 1);
  };
  console.log('\n===== dup screen: incoming vs all active facts (as of now) =====');
  for (const [tag, ids, flushMs] of windows) {
    const active = db
      .prepare(`SELECT id, statement FROM facts WHERE soul_id = ? AND user_id = ? AND status = 'active' AND created_at < ?`)
      .all(SOUL, USER, flushMs + 60_000)
      .map((r) => ({ id: String(r.id), statement: String(r.statement) }));
    for (const id of ids) {
      const row = db.prepare('SELECT statement FROM facts WHERE id = ?').get(id);
      if (!row) { console.log(`${tag} ${id}: MISSING`); continue; }
      const incoming = String(row.statement);
      const scored = active
        .filter((f) => f.id !== id)
        .map((f) => ({ ...f, j: jac(incoming, f.statement) }))
        .filter((f) => f.j >= 0.18)
        .sort((l, r) => r.j - l.j)
        .slice(0, 3);
      const pool = poolOf[tag];
      const marks = scored.map((f) => `${f.j.toFixed(2)} ${f.id}${pool ? (pool.has(f.id) ? '[IN-POOL]' : '[out-pool]') : ''} ${f.statement.slice(0, 60)}`);
      console.log(`${tag} ${id}: ${marks.length ? '' : 'no match >=0.18'}`);
      for (const m of marks) console.log(`    ${m}`);
      console.log(`    incoming: ${incoming}`);
    }
  }
}

db.close();
console.log('\n[done]');
