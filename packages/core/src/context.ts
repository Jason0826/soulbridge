/**
 * Context assembly: turn structured state into the text a host agent injects.
 *
 * Two rules:
 *  - never cut a sentence in half (drop whole memories instead)
 *  - every injected memory id is reported in `used`, so injection is auditable
 */
import type { ContextRequest, ContextResult, Emotion } from './types.ts';
import type { SoulStore } from './store.ts';
import { rank } from './scoring.ts';

export const DEFAULT_MAX_CHARS = 1200;

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

  const candidates = store.query({ soulId: request.soulId, userId: request.userId });
  const ranked = rank(candidates, request.query ?? '', now);

  let chars = sections.join('\n\n').length;
  let dropped = 0;
  const lines: string[] = [];
  const used: string[] = [];

  for (const { memory } of ranked) {
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
  if (used.length > 0) store.touch(used, now);

  return { text, used, dropped, chars: text.length };
}
