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

export type RetrievalPrimitive = 'entity' | 'continuity' | 'time' | 'related';

export interface RetrievalPlan {
  primitive: RetrievalPrimitive;
  /** The entity the question is about, when one is named. */
  subject?: string;
  reason: string;
}

const CONTINUITY = /上次|刚才|上回|接着|继续|说到哪|聊到哪/;
const TIME_CUE = /上周|上星期|昨天|前天|今天|那天|当时|上个月|月初|去年|\d{1,2}月\d{1,2}[日号]/;

/**
 * Pick a primitive from the question and the entities we know.
 *
 * Longest name first: 小林 must win over 小, and 核桃暗号 over 核桃. A name that is
 * merely a substring of another word is a false positive the caller cannot
 * recover from, so this stays deliberately literal.
 */
/** "和/跟/与/同 X" — how a companion question names the other person. */
const WITH_SUBJECT = /(?:和|跟|与|同)\s*([A-Za-z0-9][A-Za-z0-9_]*|[\u4e00-\u9fa5]{1,4})/;
/** The name ends where the predicate begins. */
const PREDICATE_START = /[说聊吃见去在是了的吧呢啊吗过还就都也等到]/;
/** Pronouns are not lookup keys: 我 is the user, 你 is the assistant. */
const NOT_A_NAME = new Set(['我', '你', '您', '他', '她', '它', '我们', '你们', '他们', '她们']);

/**
 * A named subject the store may not know yet.
 *
 * An unknown name is still a subject: "上次和 c 吃饭" must come back empty, not be
 * treated as "where were we last time" and answered with somebody else's topic.
 * The name stops at the first predicate character, so 小林吃饭 yields 小林, and a
 * pronoun yields nothing because 你 and 我 are not lookup keys.
 */
export function subjectCandidate(text: string): string | undefined {
  const match = WITH_SUBJECT.exec(String(text ?? ''));
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  const cut = raw.search(PREDICATE_START);
  const name = cut > 0 ? raw.slice(0, cut) : cut === 0 ? '' : raw;
  if (!name || NOT_A_NAME.has(name)) return undefined;
  return name;
}

/**
 * Pick a primitive from the question and the entities we know.
 *
 * Longest name first: 小林 must win over 小, and 核桃暗号 over 核桃. A name that is
 * merely a substring of another word is a false positive the caller cannot
 * recover from, so this stays deliberately literal.
 */
export function planRetrieval(text: string, entityNames: string[]): RetrievalPlan {
  const question = String(text ?? '');
  const names = [...new Set(entityNames.filter(Boolean))].sort((a, b) => b.length - a.length);
  const subject = names.find((name) => name.length >= 1 && question.includes(name));
  if (subject) return { primitive: 'entity', subject, reason: `mentions "${subject}"` };

  // An unknown name is an unknown subject, not an absent one. Looking it up
  // returns nothing, which is the honest answer.
  const unnamed = subjectCandidate(question);
  if (unnamed) return { primitive: 'entity', subject: unnamed, reason: `unknown subject "${unnamed}"` };

  if (CONTINUITY.test(question)) return { primitive: 'continuity', reason: 'continuity cue, no subject' };
  if (TIME_CUE.test(question)) return { primitive: 'time', reason: 'time cue, no subject' };
  return { primitive: 'related', reason: 'no subject, no cue' };
}
