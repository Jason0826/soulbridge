/**
 * Context assembly: turn structured state into the text a host agent injects.
 *
 * Three rules:
 *  - never cut a sentence in half (drop whole memories instead)
 *  - every injected memory id is reported in `used`, so injection is auditable
 *  - the affect section is opt-in by confidence, capped in size, and only ever
 *    contains whitelisted sentences (ADR 0014)
 */
import type { ContextRequest, ContextResult, Emotion } from './types.ts';
import type { SoulStore } from './store.ts';
import { rank } from './scoring.ts';
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

  const since = identity ? timeTogether(identity.createdAt, now) : '你刚开始认识这个用户';
  sections.push(`<soul name="${name}">\n你是${name}，一个持续成长的伙伴。${since}。\n</soul>`);

  const styles = styleDirectives(emotion);
  if (styles.length > 0) {
    sections.push(`<style>\n${styles.map((s) => `- ${s}`).join('\n')}\n</style>`);
  }

  // Affect: newest sample only, and only when it is confident and recent enough.
  let affectMeta: ContextResult['affect'];
  const [latest] = store.recentAffect(request.soulId, request.userId, now - AFFECT_WINDOW_MS);
  if (latest) {
    const directives = selectDirectives(latest);
    if (directives.length > 0) {
      const section =
        `<affect confidence="${latest.confidence.toFixed(2)}" analyzer="${latest.analyzer}">\n` +
        `${directives.map((d) => `- ${d.text}`).join('\n')}\n</affect>`;
      const usedSoFar = sections.join('\n\n').length;
      if (section.length <= AFFECT_BUDGET && usedSoFar + section.length + 2 <= maxChars) {
        sections.push(section);
        affectMeta = { confidence: latest.confidence, directives: directives.map((d) => d.id) };
      }
    }
  }

  const candidates = store
    .query({ soulId: request.soulId, userId: request.userId })
    .filter(
      (memory) =>
        (request.types === undefined || request.types.includes(memory.type)) &&
        (request.minImportance === undefined || memory.importance >= request.minImportance),
    );
  const ranked = rank(candidates, request.query ?? '', now);
  const maxItems = request.maxItems ?? Number.POSITIVE_INFINITY;

  let chars = sections.join('\n\n').length;
  let dropped = 0;
  const lines: string[] = [];
  const used: string[] = [];

  for (const { memory } of ranked) {
    if (lines.length >= maxItems) {
      dropped += 1;
      continue;
    }
    const line = `- [${memory.type}] ${memory.content}`;
    const cost = line.length + 1 + 10; // line + newline + section overhead share
    if (chars + cost > maxChars) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used.push(memory.id);
    chars += cost;
  }

  if (lines.length > 0) sections.push(`<memories>\n${lines.join('\n')}\n</memories>`);

  const text = sections.join('\n\n');
  if (request.track !== false && used.length > 0) store.touch(used, now);

  const result: ContextResult = { text, used, dropped, chars: text.length };
  if (affectMeta) result.affect = affectMeta;
  return result;
}
