/**
 * Context assembly: turn structured state into the text a host agent injects.
 *
 * Three rules:
 *  - never cut a sentence in half (drop whole memories instead)
 *  - every injected memory id is reported in `used`, so injection is auditable
 *  - the affect section is opt-in by confidence, capped in size, and only ever
 *    contains whitelisted sentences (ADR 0014)
 *  - every dynamic value is escaped before it joins a block: a statement containing
 *    `</memories>` otherwise ends the envelope and can forge a `<rules>` block
 */
import type { ContextRequest, ContextResult, Emotion } from './types.ts';
import type { SoulStore } from './store.ts';
import { FACT_STATUS } from './config/status.ts';
import { ANCHOR_TYPES } from './config/labels.ts';
import { escapeAttr, escapeBlockText } from './inject-text.ts';
import { selectDirectives } from './affect/directives.ts';

export const DEFAULT_MAX_CHARS = 1200;
/** Characters reserved for the affect section; if it does not fit, it is dropped whole. */
export const AFFECT_BUDGET = 160;
/** Only the most recent user turn counts; older samples are for evaluation, not injection. */
export const AFFECT_WINDOW_MS = 30 * 60 * 1000;

/** Emotion → concrete behavioural instruction. Values are -2..+2. */
export function styleDirectives(emotion: Emotion): string[] {
  const out: string[] = [];
  if (emotion.tension > 1.0) out.push('回答前先确认理解，避免草率结论');
  if (emotion.selfRegard < -0.5) out.push('对自己的输出多检查一遍');
  if (emotion.curiosity > 0.5) out.push('可以主动提问，探索延伸');
  if (emotion.bond > 0.8) out.push('像朋友一样聊天，少一点客套');
  if (emotion.contentment > 1.2) out.push('不要过度确认，直接给结论');
  return out;
}

function timeTogether(createdAt: number, now: number): string {
  const days = Math.floor((now - createdAt) / 86_400_000);
  if (days <= 0) return '今天是第一次见面';
  return `你已经和用户相处了 ${days} 天`;
}

export function buildContext(
  store: SoulStore,
  request: ContextRequest,
  now: number = Date.now(),
): ContextResult {
  const identity = store.identity(request.soulId);
  const name = identity?.name ?? request.soulId;
  const emotion = store.emotion(request.soulId, request.userId);
  const maxChars = request.maxChars ?? DEFAULT_MAX_CHARS;

  const sections: string[] = [];

  if (request.includeSoul !== false) {
    const since = identity ? timeTogether(identity.createdAt, now) : '你刚开始认识这个用户';
    // The name comes from configuration, but every attribute goes through one rule.
    const safeName = escapeAttr(name);
    sections.push(`<soul name="${safeName}">\n你是${safeName}，一个持续成长的伙伴。${since}。\n</soul>`);
  }

  const styles = request.includeStyle === false ? [] : styleDirectives(emotion);
  if (styles.length > 0) {
    sections.push(`<style>\n${escapeBlockText(styles.map((s) => `- ${s}`).join('\n'))}\n</style>`);
  }

  // Affect: newest sample only, and only when it is confident and recent enough.
  // Excluded on request: a stable prompt cannot carry a value that changes every turn.
  let affectMeta: ContextResult['affect'];
  const [latest] = request.includeAffect === false ? [] : store.recentAffect(request.soulId, request.userId, now - AFFECT_WINDOW_MS);
  if (latest) {
    const directives = selectDirectives(latest);
    if (directives.length > 0) {
      const section =
        `<affect confidence="${latest.confidence.toFixed(2)}" analyzer="${escapeAttr(latest.analyzer)}">\n` +
        `${escapeBlockText(directives.map((d) => `- ${d.text}`).join('\n'))}\n</affect>`;
      const usedSoFar = sections.join('\n\n').length;
      if (section.length <= AFFECT_BUDGET && usedSoFar + section.length + 2 <= maxChars) {
        sections.push(section);
        affectMeta = { confidence: latest.confidence, directives: directives.map((d) => d.id) };
      }
    }
  }

  // Anchors come from two places during the migration: concluded judgments and
  // lessons are facts now (ADR 0032), while the legacy `memories` table is still
  // read until its rows have been migrated and deleted. The union keeps the
  // injection stable across that switch instead of dropping every lesson at once.
  // The anchor vocabulary is declared in config/labels.ts; this file only filters.
  // A fact carrying the 锚点 slot is explicit ("the user asked me to remember this"),
  // so it is injected whatever its type name — otherwise an explicit note typed as
  // 事实 would be stored and never surface.
  const anchorTypes = new Set(ANCHOR_TYPES);
  const explicitAnchor = (fact: { slots?: Array<{ slot: string; value: { kind: string; value?: unknown } }> }) =>
    (fact.slots ?? []).some(
      (slot) => slot.slot === '锚点' && slot.value.kind === 'text' && slot.value.value === '是',
    );
  type Anchor = { id: string; label: string; text: string; score: number };
  const anchors: Anchor[] = store
    .facts({ soulId: request.soulId, userId: request.userId, limit: 300 })
    .filter(
      (fact) =>
        fact.status !== FACT_STATUS.superseded &&
        (anchorTypes.has(fact.typeName ?? '') || explicitAnchor(fact)),
    )
    .map((fact) => ({ id: fact.id, label: fact.typeName ?? '事实', text: fact.statement, score: fact.confidence }));
  for (const memory of store.query({ soulId: request.soulId, userId: request.userId })) {
    if (request.types !== undefined && !request.types.includes(memory.type)) continue;
    if (request.minImportance !== undefined && memory.importance < request.minImportance) continue;
    anchors.push({ id: memory.id, label: memory.type, text: memory.content, score: memory.importance / 10 });
  }
  anchors.sort((a, b) => b.score - a.score);

  const maxItems = request.maxItems ?? Number.POSITIVE_INFINITY;

  let chars = sections.join('\n\n').length;
  let dropped = 0;
  const lines: string[] = [];
  const used: string[] = [];

  for (const anchor of anchors) {
    if (lines.length >= maxItems) {
      dropped += 1;
      continue;
    }
    // Escaping can lengthen a line (one `&lt;` is four characters), so cost is charged
    // on the escaped text — the budget has to measure what actually gets injected.
    const line = `- [${escapeBlockText(anchor.label)}] ${escapeBlockText(anchor.text)}`;
    const cost = line.length + 1 + 10; // line + newline + section overhead share
    if (chars + cost > maxChars) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used.push(anchor.id);
    chars += cost;
  }

  if (request.includeAnchors !== false && lines.length > 0) sections.push(`<memories>\n${lines.join('\n')}\n</memories>`);

  const text = sections.join('\n\n');
  if (request.track !== false && used.length > 0) store.touch(used, now);

  const result: ContextResult = { text, used, dropped, chars: text.length };
  if (affectMeta) result.affect = affectMeta;
  return result;
}
