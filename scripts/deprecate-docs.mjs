/**
 * Mark superseded design documents so nobody implements them again.
 *
 * History is kept — deleting a superseded design loses the reason it failed. What
 * each file gets is a banner at the top and a status line that says what replaced
 * it. The banner is the part a reader actually sees before copying anything.
 *
 *   node scripts/deprecate-docs.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SUPERSEDED = [
  ['docs/briefs/0010-memory-unit.md', '0014 轮与步骤 + 0017 主题线索', '记忆单位不是一问一答，是 turns/steps，归纳单位是线索。'],
  ['docs/rfcs/0007-turn-pair.md', '0014 轮与步骤', 'turn_pair 只作为历史表保留，新写入走 turns + steps。'],
  ['docs/briefs/0011-conversation-layer.md', '0017 主题线索', '会话不等于话题，边界按线索而不是会话。'],
  ['docs/briefs/0012-people-layer.md', 'ADR 0032 两层记忆', '人物层并入 holder 结构，不再单列。'],
  ['docs/briefs/0013-event-model.md', 'ADR 0032 两层记忆', '事件不再需要 kind 枚举，靠 holder + 时间定位。'],
  ['docs/spec/model.v0.md', 'ADR 0032 两层记忆', '事实模型改为世界层/人物层两层，时间改为可定位精度。'],
  ['docs/briefs/0007-retrieval-scoring.md', '0019 记忆选择 + 0020 检索漏斗', '排序改为相关 × 幂律衰减 × 练习，不再用加权和。'],
  ['docs/briefs/0009-schema-redesign.md', 'ADR 0032 两层记忆', 'schema 已按两层与时间精度重新定义。'],
];

for (const [file, by, why] of SUPERSEDED) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('已废弃（2026-11-02）')) {
    console.log(`skip ${file}`);
    continue;
  }
  const banner = [
    '> **⚠ 已废弃（2026-11-02）** —— 本文的设计已被 **' + by + '** 取代。',
    '> ' + why,
    '> 保留仅作历史记录，**不要按本文实现**。当前权威文档见 [docs/README.md](../README.md)。',
    '',
    '',
  ].join('\n');
  const withBanner = banner + text;
  const withStatus = withBanner.replace(/^- 状态：.*$/m, `- 状态：**Superseded（2026-11-02，→ ${by}）**`);
  writeFileSync(file, withStatus, 'utf8');
  console.log(`marked ${file}`);
}
