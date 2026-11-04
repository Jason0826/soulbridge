/**
 * Which retrieval primitive a question needs (0020).
 *
 * The mistake this file exists to prevent: treating "上次" as a retrieval method.
 * "上次和 a 吃饭" and "上次和 c 吃饭" are different questions with the same words
 * around them — the subject decides what is fetched, and "上次" only says to order
 * it newest-first. So the router looks for a subject first, and falls back to
 * conversation continuity, then to a time window, then to plain relevance.
 *
 * Rules, not a model: a wrong guess here degrades to relevance search, and never
 * to "answer about somebody else", which is the one failure worse than silence.
 */

import { TIME_CUE, findWindow } from './time.ts';
import type { TimeWindow } from './time.ts';

export type RetrievalPrimitive = 'entity' | 'continuity' | 'time' | 'related';

export interface RetrievalPlan {
  primitive: RetrievalPrimitive;
  /** The entity the question is about, when one is named. */
  subject?: string;
  /** The span a time question asked about, when its cue can be placed on a calendar. */
  window?: TimeWindow;
  reason: string;
}

const CONTINUITY = /上次|刚才|上回|接着|继续|说到哪|聊到哪/;

/** "和/跟/与/同 X" — how a companion question names the other person. */
const WITH_SUBJECT = /(?:和|跟|与|同)\s*([A-Za-z0-9][A-Za-z0-9_]*|[\u4e00-\u9fa5]{1,4})/;
/** The name ends where the predicate begins. */
const PREDICATE_START = /[说聊吃见去在是了的吧呢啊吗过还就都也等到]/;
/** Pronouns are not lookup keys: 我 is the user, 你 is the assistant. */
const NOT_A_NAME = new Set(['我', '你', '您', '他', '她', '它', '我们', '你们', '他们', '她们']);
/** Function words inside a candidate: "上次一样" and "他一起" are phrases, not names. */
const FUNCTION_WORD = /[这那次样起一我你他她它们的]/;

/** Escape a name before it goes into a RegExp. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does the message actually mention this known entity?
 *
 * A Latin name must stand on its own: the entity "a" is a substring of "package",
 * so `includes` routed ordinary technical messages to `<about name="a">` and
 * suppressed the related-conversation block on most turns. A one-character CJK name
 * is noise (小 is in 小林), but a one-character Latin name is fine when it is a
 * whitespace-delimited token — "上次和 a 吃饭" is a real subject.
 */
function mentions(question: string, name: string): boolean {
  if (/^[A-Za-z0-9_]+$/.test(name)) {
    return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(name)}([^A-Za-z0-9_]|$)`, 'i').test(question);
  }
  return [...name].length >= 2 && question.includes(name);
}

/**
 * A named subject the store may not know yet.
 *
 * An unknown name is still a subject: "上次和 c 吃饭" must come back empty, not be
 * treated as "where were we last time" and answered with somebody else's topic.
 * The name stops at the first predicate character, so 小林吃饭 yields 小林.
 *
 * Rejected on purpose: a fragment with no predicate after it ("和数据保持一致" →
 * 数据保持), and any fragment containing a function word ("上次一样", "他一起").
 * Guessing a subject is worse than falling through to relevance search.
 */
export function subjectCandidate(text: string): string | undefined {
  const match = WITH_SUBJECT.exec(String(text ?? ''));
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;

  // A Latin name is delimited by whitespace ("上次和 c 吃饭"), so it needs no
  // predicate boundary; a CJK run does ("小林吃饭" must stop at 吃).
  let name: string;
  if (/^[A-Za-z0-9_]+$/.test(raw)) {
    name = raw;
  } else {
    const cut = raw.search(PREDICATE_START);
    // No predicate boundary means the conjunction was not naming a person.
    if (cut <= 0) return undefined;
    name = raw.slice(0, cut).trim();
  }
  if (!name || NOT_A_NAME.has(name) || FUNCTION_WORD.test(name)) return undefined;
  return name;
}

/**
 * Pick a primitive from the question and the entities we know.
 *
 * Longest name first: 小林 must win over 小, and 核桃暗号 over 核桃. A name that is
 * merely a substring of another word is a false positive the caller cannot
 * recover from, so this stays deliberately literal.
 */
export function planRetrieval(text: string, entityNames: string[], now = Date.now()): RetrievalPlan {
  const question = String(text ?? '');
  const names = [...new Set(entityNames.filter(Boolean))].sort((a, b) => [...b].length - [...a].length);
  const subject = names.find((name) => mentions(question, name));
  if (subject) return { primitive: 'entity', subject, reason: `mentions "${subject}"` };

  // An unknown name is an unknown subject, not an absent one. Looking it up
  // returns nothing, which is the honest answer.
  const unnamed = subjectCandidate(question);
  if (unnamed) return { primitive: 'entity', subject: unnamed, reason: `unknown subject "${unnamed}"` };

  if (CONTINUITY.test(question)) return { primitive: 'continuity', reason: 'continuity cue, no subject' };
  if (TIME_CUE.test(question)) {
    // A time question and a window are not the same thing: "那天" is a cue no calendar
    // can place, and the caller must be able to tell "nothing happened then" from
    // "I could not work out when". So the cue routes, the window is optional.
    const window = findWindow(question, now);
    return window
      ? { primitive: 'time', window, reason: `time window "${window.cue}"` }
      : { primitive: 'time', reason: 'time cue, no window' };
  }
  return { primitive: 'related', reason: 'no subject, no cue' };
}
