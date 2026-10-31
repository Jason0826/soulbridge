#!/usr/bin/env node
/**
 * S1 观察报告：把"每天攒一点感觉"变成"跑一条命令"。
 *
 * 只读：只解析 ~/.soulbridge 下的 plugin.log 与 soul.db，不写任何东西。
 * 输出 Markdown 到 stdout（可重定向存盘）。
 *
 * 用法：node scripts/observation-report.mjs [--days 7] [--db <path>] [--log <path>]
 *
 * 重要：判据 1/3 的真值只有用户能判。本脚本给的是**代理指标与可抽查样本**，
 * 不是结论——报告里对每一项都标了"能自动算"还是"要人判"。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const HOME = join(homedir(), '.soulbridge');
const logPath = arg('--log', join(HOME, 'plugin.log'));
const dbPath = arg('--db', join(HOME, 'soul.db'));
const days = Number(arg('--days', '7'));
const since = Date.now() - days * 86_400_000;

const out = [];
const say = (s = '') => out.push(s);

if (!existsSync(logPath)) {
  console.error(`找不到日志：${logPath}`);
  process.exit(1);
}

const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
const at = (line) => {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(line);
  return m ? Date.parse(m[1]) : null;
};
const recent = lines.filter((l) => {
  const t = at(l);
  return t !== null && t >= since;
});

const count = (needle) => recent.filter((l) => l.includes(needle)).length;
const userMsgs = count('user/message source=user');
const injects = count('prestep: inject');
const noRelated = count('prestep: no related memory');
const skipped = count('prestep: skipped');
const accounted = injects + noRelated + skipped;
const echoWrites = recent.filter((l) => l.includes('observe') && l.includes('source=memory-context')).length;
const llmFailed = count('llm=failed');
const observes = count('observe ok:');
const corrections = count('correction recorded');
const recallCalls = count('tool soul_recall:');

// 版本分界
const applyLines = recent.filter((l) => l.includes('apply() called'));
const lastApply = applyLines[applyLines.length - 1] ?? '(无)';

// 数据库
let db = null;
try {
  const { DatabaseSync } = await import('node:sqlite');
  if (existsSync(dbPath)) db = new DatabaseSync(dbPath, { readOnly: true });
} catch {
  db = null;
}
const one = (sql) => (db ? db.prepare(sql).get() : null);
const all = (sql) => (db ? db.prepare(sql).all() : []);

say(`# S1 观察报告 · 近 ${days} 天`);
say();
say(`生成时间：${new Date().toISOString()}`);
say(`日志：${logPath}`);
say(`库：${db ? dbPath : '（未找到）'}`);
say();

say('## 一、工程底线（能自动算）');
say();
say(`- 注入账目：${userMsgs} 条用户消息 → 有内容注入 ${injects} · 无相关记忆 ${noRelated} · 跳过 ${skipped}`);
say(
  `  - 说明：pre-step 按 **turn** 去重（同一 turn 只跑一次），所以"注入次数 < 消息条数"是设计行为，不是漏注入。`,
);
say(`  - 真正的违反是"同一个 turn 出现两次 inject"——日志不带 session，暂无法自动验证（已知局限）。`);
say(`- 注入不回写：${echoWrites} 条 ${echoWrites === 0 ? '✓' : '✗'}`);
say(`- 蒸馏失败：llm=failed ${llmFailed} / observe ${observes} ${observes > 0 ? `（${((llmFailed / observes) * 100).toFixed(1)}%）` : ''} ${observes > 0 && llmFailed / observes < 0.05 ? '✓ 低于 5%' : '⚠ 超阈值'}`);
say(`- 当前插件版本：${lastApply}`);
say();

say('## 二、判据 1「不用重复说」（代理指标，真值要你判）');
say();
if (db) {
  const mem = one('SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL');
  const dup = all(
    `SELECT lower(trim(content)) AS c, COUNT(*) AS n FROM memories
     WHERE deleted_at IS NULL GROUP BY c HAVING n > 1`,
  );
  say(`- 活跃记忆：**${mem.n}** 条`);
  say(`- 完全重复的条目：**${dup.length}** 组`);
  say();
  say('> 代理口径：完全重复会被去重闸门拦下，所以这里通常为 0。**"你是否被迫重复"只有你能判**。');
} else {
  say('- 无数据库，跳过');
}
say();

say('## 三、判据 2「记忆真被用上」（给抽查样本，不下结论）');
say();
say(`- 近 ${days} 天注入轮次：**${injects}** 次`);
say(`- 最近 8 次注入：`);
for (const l of recent.filter((x) => x.includes('prestep: inject')).slice(-8)) {
  say(`  - \`${l.slice(0, 60)}\``);
}
say();
say('> 抽查方法：从上面挑一次，回看那一轮我的回答有没有主动带上记忆内容。**只有你能判。**');
say();

say('## 四、判据 3「没记岔」（数据源：纠正证据）');
say();
say(`- 近 ${days} 天记录的纠正：**${corrections}** 条（日志）`);
if (db) {
  const total = one('SELECT COUNT(*) AS n FROM corrections');
  const strict = one("SELECT COUNT(*) AS n FROM corrections WHERE rule LIKE 'rule:%'");
  say(`- 库里的纠正证据：**${total.n}** 行；其中显式纠正（\`rule:\` 层）**${strict.n}** 行`);
  say(`- \`structural:\` 层不计入判据 3。2026-10-31 抽查 28 行：25 行是句子含"不/没/不是"的正常提问，精度约 11%`);
  const byRule = all(
    "SELECT rule, COUNT(*) AS n FROM corrections WHERE rule LIKE 'rule:%' GROUP BY rule ORDER BY n DESC",
  );
  for (const r of byRule) say(`  - ${r.rule}：${r.n}`);
}
say();
say('> "记岔了几次"仍要你判；上面只统计显式纠正，结构层噪声不计入。');
say();

say('## 五、判据 4「可查证」（能自动算）');
say();
if (db) {
  const mem = one("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND status = 'active'");
  say(`- 可查记忆：**${mem.n}** 条（active 且未删除）`);
}
say(`- 近 ${days} 天 \`soul_recall\` 调用：**${recallCalls}** 次`);
say();

say('## 六、副产品：情绪与采样');
say();
if (db) {
  const a = one('SELECT COUNT(*) AS n FROM affect_samples');
  const sig = one('SELECT COUNT(*) AS n FROM affect_samples WHERE confidence >= 0.6');
  say(`- affect 采样 ${a.n} 条，其中过门槛 ${sig.n} 条（${a.n > 0 ? ((sig.n / a.n) * 100).toFixed(1) : 0}%）`);
  const e = one('SELECT * FROM emotions');
  if (e) {
    say(`- 情绪状态：bond=${e.bond} tension=${e.tension} passion=${e.passion} selfRegard=${e.self_regard}`);
  }
}
say();
say('> 判据 1 与 3 的最终判定只能由用户给出（S1 阶段文件：判据 1/3 "只能由你判定"）。');

if (db) db.close();
console.log(out.join('\n'));
