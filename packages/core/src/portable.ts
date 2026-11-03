/**
 * Portable bundle: the whole record, a human-readable summary, and the injection text.
 *
 * Three layers, because they answer different questions (spec/vocabulary.v1 §7):
 *   archive   — everything, including raw exchanges; the recipient can rebuild the store.
 *   summary   — what a person can read in a minute: rules, profile, conclusions, promises,
 *               entities, open gaps. No ids unless they help.
 *   injection — what the model would see right now; the smallest useful transfer.
 *
 * Nothing here filters by importance. An export that silently drops "unimportant" rows
 * cannot be the source of truth, and importance is a semantic judgement we do not store.
 */
import type { PortableDump, PortableBundle } from './types.ts';

export function buildPortableSummary(dump: PortableDump, soulId: string, userId: string, now: number): string {
  const lines: string[] = [];
  lines.push(`# soulbridge 档案 · ${userId}`);
  lines.push('');
  lines.push(`- soul: ${soulId}`);
  lines.push(`- 导出时间: ${new Date(now).toISOString()}`);
  lines.push(
    `- 规模: 事实 ${dump.facts.length} · 实体 ${dump.entities.length} · 线索 ${dump.threads.length} · 轮次 ${dump.turns.length} · 缺口 ${dump.gaps.length}`,
  );
  lines.push('');

  const byRole = (role: string) => dump.facts.filter((fact) => fact.role === role && fact.status === 'active');
  const slotText = (fact: (typeof dump.facts)[number], name: string) => {
    const slot = fact.slots.find((item) => item.slot === name);
    return slot?.value.kind === 'text' ? slot.value.value : undefined;
  };

  const rules = byRole('rule');
  if (rules.length > 0) {
    lines.push(`## 规则（${rules.length}）`);
    for (const rule of rules) {
      const trigger = slotText(rule, '触发');
      const action = slotText(rule, '动作') ?? rule.statement;
      lines.push(trigger ? `- 当 ${trigger}：${action}` : `- ${action}`);
    }
    lines.push('');
  }

  const profile = byRole('profile');
  if (profile.length > 0) {
    lines.push(`## 画像（${profile.length}）`);
    for (const line of profile) lines.push(`- ${line.statement}`);
    lines.push('');
  }

  const judgments = byRole('judgment');
  if (judgments.length > 0) {
    lines.push(`## 结论（${judgments.length}）`);
    for (const line of judgments.slice(0, 30)) lines.push(`- ${line.statement}`);
    lines.push('');
  }

  const promises = byRole('promise');
  if (promises.length > 0) {
    lines.push(`## 承诺（${promises.length}）`);
    for (const line of promises) lines.push(`- ${line.statement}`);
    lines.push('');
  }

  if (dump.entities.length > 0) {
    lines.push(`## 实体（${dump.entities.length}）`);
    for (const entity of dump.entities.slice(0, 50)) {
      const aliases = entity.aliases.length > 0 ? `（别名：${entity.aliases.join('、')}）` : '';
      lines.push(`- ${entity.name} · ${entity.type}${aliases}`);
    }
    lines.push('');
  }

  const openGaps = dump.gaps.filter((gap) => gap.status === 'open');
  if (openGaps.length > 0) {
    lines.push(`## 未闭合的缺口（${openGaps.length}）`);
    for (const gap of openGaps.slice(0, 20)) lines.push(`- ${gap.topic}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** One JSON object per line, tagged so a reader can stream it without a schema. */
export function buildArchiveLines(dump: PortableDump): string[] {
  const lines: string[] = [];
  // `record` is the discriminator, not `type`: Entity has its own `type` field, and a
  // spread after the tag would silently overwrite it.
  for (const entity of dump.entities) lines.push(JSON.stringify({ record: 'entity', ...entity }));
  for (const fact of dump.facts) lines.push(JSON.stringify({ record: 'fact', ...fact }));
  for (const thread of dump.threads) lines.push(JSON.stringify({ record: 'thread', ...thread }));
  for (const gap of dump.gaps) lines.push(JSON.stringify({ record: 'gap', ...gap }));
  for (const turn of dump.turns) lines.push(JSON.stringify({ record: 'turn', ...turn }));
  for (const step of dump.steps) lines.push(JSON.stringify({ record: 'step', ...step }));
  for (const correction of dump.corrections) lines.push(JSON.stringify({ record: 'correction', ...correction }));
  return lines;
}

export function buildPortableBundle(
  dump: PortableDump,
  soulId: string,
  userId: string,
  injection: string,
  now: number,
): PortableBundle {
  return {
    schemaVersion: 1,
    exportedAt: now,
    soulId,
    userId,
    summary: buildPortableSummary(dump, soulId, userId, now),
    injection,
    archive: buildArchiveLines(dump),
  };
}
