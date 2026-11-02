/**
 * Consolidation: several facts become one conclusion, with the evidence kept.
 *
 * Two ideas are borrowed rather than invented here:
 *
 *   - AIS / attribution (Rashkin et al. 2021): every sentence must be
 *     attributable to identified sources. A conclusion cites fact ids, and one
 *     citation is not enough — that is a fact, not a conclusion.
 *   - Chain-of-Verification (Dhuliawala et al. 2023): verifying a draft against
 *     its sources works better when the check is independent of the draft. The
 *     model writes conclusions in one call and answers "do these facts directly
 *     support it?" in a second, without the first answer in view.
 *
 * The gate below is deliberately deterministic: evidence count, evidence
 * existence, statement shape, and over-generalisation are all checkable without
 * a model. The model only does what code cannot — compress meaning.
 */
import type { ConclusionDraft, Fact, SlotValue } from './types.ts';

/** Words that turn a specific observation into a rule about everything. */
const ABSOLUTE = /一切|所有|总是|从不|永远|从来|任何人|任何事/g;

export interface ConclusionGateInput {
  draft: ConclusionDraft;
  /** Facts the model was shown; evidence must come from here. */
  allowed: Set<string>;
  /** Existing conclusion the draft claims to replace, if any. */
  existing?: Fact | null;
}

export type ConclusionGateResult =
  | { ok: true; statement: string; evidence: string[]; confidence: number }
  | { ok: false; reason: string };

export function gateConclusion(input: ConclusionGateInput): ConclusionGateResult {
  const statement = String(input.draft.statement ?? '').trim();
  const evidence = [...new Set((input.draft.evidence ?? []).map((id) => String(id).trim()).filter(Boolean))];

  if (statement.length < 8) return { ok: false, reason: 'statement too short' };
  if (statement.length > 80) return { ok: false, reason: 'statement too long' };
  // One citation is an observation. Two is the smallest thing that deserves the
  // word "conclusion", and it is the rule this whole stage is built on.
  if (evidence.length < 2) return { ok: false, reason: `needs >=2 evidence (got ${evidence.length})` };

  const foreign = evidence.filter((id) => !input.allowed.has(id));
  if (foreign.length > 0) return { ok: false, reason: `evidence not in batch: ${foreign.join(',')}` };

  // Over-generalisation: an absolute word that also appears in the evidence is
  // quoting the user; one that appears only in the conclusion is the model
  // inflating two observations into a rule.
  const absolute = statement.match(ABSOLUTE);
  if (absolute) {
    const quoted = new Set(absolute.filter((word) => input.allowed.size > 0 && input.draft.evidenceText?.includes(word)));
    const invented = absolute.filter((word) => !quoted.has(word));
    if (invented.length > 0) return { ok: false, reason: `over-generalised: ${invented.join('、')}` };
  }

  const confidence = Math.min(1, Math.max(0, Number(input.draft.confidence ?? 0.6)));
  return { ok: true, statement, evidence, confidence };
}

/**
 * The fact a conclusion becomes.
 *
 * No new table: a conclusion is a fact whose type is 结论, whose holder is the
 * soul itself, and whose evidence is a `fact` slot per citation. That keeps
 * retrieval, export and supersede working unchanged.
 *
 * A conclusion also carries the entities its evidence mentions, under `关于`.
 * Without that it cannot be recalled when the conversation turns to that person —
 * the one question the whole layer exists to answer.
 */
export function conclusionSlots(
  evidence: string[],
  entities: string[] = [],
): { slot: string; value: SlotValue }[] {
  return [
    ...evidence.map((factId) => ({ slot: '证据', value: { kind: 'fact' as const, factId } })),
    ...entities.map((entityId) => ({ slot: '关于', value: { kind: 'entity' as const, entityId } })),
  ];
}

const RECORD = /^结论\s*[:：]\s*(.+)$/;
const VERDICT = /^判定\s*[:：]\s*(.+)$/;

/**
 * Parse the draft answer: one conclusion per line.
 *
 *   结论: 用户讨厌同一件事反复交代 | 证据=fc_a1,fc_a2 | 置信=0.8 | 取代=fc_c1
 *   无
 */
export function parseConclusionDraft(raw: string): ConclusionDraft | null {
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(无|none|nothing)[。.]?$/i.test(trimmed)) return null;
    const match = RECORD.exec(trimmed);
    if (!match) continue;
    const parts = match[1].split('|').map((part) => part.trim());
    const statement = parts[0] ?? '';
    const field = (name: string): string | undefined => {
      const hit = parts.slice(1).find((part) => part.startsWith(`${name}=`) || part.startsWith(`${name}：`));
      return hit?.slice(name.length + 1).trim();
    };
    const evidence = (field('证据') ?? '')
      .split(/[,，、;；\s]+/)
      .map((id) => id.trim())
      .filter(Boolean);
    const confidence = Number(field('置信') ?? field('confidence') ?? '0.6');
    return {
      statement,
      evidence,
      confidence: Number.isFinite(confidence) ? confidence : 0.6,
      supersedes: field('取代') || undefined,
    };
  }
  return null;
}

export interface VerificationDraft {
  verdict: 'supported' | 'partial' | 'unsupported';
  reason?: string;
}

/**
 * Parse the verification answer:
 *
 *   判定: 支持 | 依据=fc_a1,fc_a2 | 理由=两条事实都提到"反复交代"
 *   判定: 不支持 | 理由=只有 fc_a1 提到，fc_a2 说的是工具切换
 */
export function parseVerificationDraft(raw: string): VerificationDraft | null {
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = VERDICT.exec(trimmed);
    if (!match) continue;
    const body = match[1];
    const reason = /理由\s*[:：=]\s*(.+)$/.exec(body)?.[1]?.trim();
    const head = body.split('|')[0] ?? '';
    if (/不支持|unsupported|否/.test(head)) return { verdict: 'unsupported', reason };
    if (/部分|partial/.test(head)) return { verdict: 'partial', reason };
    if (/支持|supported|是/.test(head)) return { verdict: 'supported', reason };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Duplicate handling: the new conclusion vs the conclusions we hold
 * ------------------------------------------------------------------ */

/**
 * Normalise a statement for the one check a rule can make safely.
 *
 * This is deliberately narrow: it only catches text that is *the same text*, so a
 * hit cannot be wrong. Everything about meaning is the model's call, because
 * "same topic, different words" is exactly where string matching lies.
 */
export function normalizeStatement(statement: string): string {
  return String(statement ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，。、；：！？,.;:!?"'“”‘’（）()【】\[\]…—–\-\/\\]+/g, '');
}

export interface ConclusionRelation {
  kind: 'duplicate' | 'refine' | 'conflict' | 'unrelated';
  target?: string;
  reason?: string;
}

const RELATION = /^关系\s*[:：]\s*(.+)$/;
const FACT_ID = /(fc_[a-z0-9_]+)/i;

/**
 * Parse the relation check:
 *
 *   关系: 重复 fc_abc | 理由=说的是同一件事，只是措辞不同
 *   关系: 细化 fc_abc | 理由=新结论多了"只在紧急时"
 *   关系: 矛盾 fc_abc | 理由=一个说喜欢重复讲，一个说讨厌
 *   关系: 无关
 *
 * A named id that we do not hold is not an error — the caller treats it as
 * unrelated, which only ever writes the new conclusion and never deletes one.
 */
export function parseRelationDraft(raw: string): ConclusionRelation | null {
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const match = RELATION.exec(line.trim());
    if (!match) continue;
    const body = match[1];
    const head = body.split('|')[0] ?? '';
    const target = FACT_ID.exec(body)?.[1];
    const reason = /理由\s*[:：=]\s*(.+)$/.exec(body)?.[1]?.trim();
    if (/重复|duplicate/i.test(head)) return { kind: 'duplicate', target, reason };
    if (/细化|refine/i.test(head)) return { kind: 'refine', target, reason };
    if (/矛盾|conflict/i.test(head)) return { kind: 'conflict', target, reason };
    if (/无关|unrelated/i.test(head)) return { kind: 'unrelated', reason };
  }
  return null;
}
/**
 * Read a verifier's answer, keeping "we could not read it" separate from "no".
 *
 * An empty or unparseable reply is not evidence against a conclusion — it is the
 * documented stream-gone failure. Collapsing it to `unsupported` silently discards
 * a draft that was never actually checked (and before this, it also lost the
 * thread). Only a parsed verdict may drop a conclusion.
 */
export function readVerification(
  raw: string,
): { kind: 'verdict'; verdict: VerificationDraft } | { kind: 'retry'; reason: string } {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'retry', reason: 'empty reply' };
  const verdict = parseVerificationDraft(text);
  if (!verdict) return { kind: 'retry', reason: 'unparseable verdict' };
  return { kind: 'verdict', verdict };
}
/* ------------------------------------------------------------------ *
 * Profile merging
 * ------------------------------------------------------------------ */

export interface ProfileLine {
  statement: string;
  sources: string[];
}

const PROFILE_LINE = /^画像\s*[:：]\s*(.+)$/;
/** Hedged lines describe a mood, not a person; the merge has not happened yet. */
const PROFILE_HEDGE = /有时候|有时|通常|大部分时候|一般来说|一般说/;
/** Over-generalisation: no single set of observations supports an "always". */
const PROFILE_ABSOLUTE = /一切|所有|总是|从不/;
/** A fragment has no subject; completing it would be invention. */
const PROFILE_FRAGMENT = /^(每次|因为|然后|所以|但是|而且|并且)/;
/** One judgment per line. A semicolon is how three unrelated points get welded together. */
const PROFILE_MULTI_CLAUSE = /[；;]/;

function profileBigrams(text: string): Set<string> {
  const clean = text.replace(/[\s，。、；：！？,.;:!?"'（）()]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

function profileSimilarity(a: string, b: string): number {
  const left = profileBigrams(a);
  const right = profileBigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Parse the merged profile.
 *
 * Three things are rejected by code rather than hoped for: a line with no source is
 * an assumption, a hedged or absolute line is a failed merge, and a fragment is not
 * a judgment. Near-duplicates are folded, because "the same thing said twice" is the
 * exact failure the merge exists to fix.
 *
 * What code cannot check is direction ("先" becoming "后"). That needs the separate
 * verification pass, and it is why this parser is not the last gate.
 */
export function parseProfileMerge(raw: string, allowed: Set<string>): ProfileLine[] {
  const out: ProfileLine[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const match = PROFILE_LINE.exec(line.trim());
    if (!match) continue;
    const [statementPart, ...fields] = match[1].split('|').map((part) => part.trim());
    const statement = (statementPart ?? '').trim();
    if (statement.length < 6 || statement.length > 32) continue;
    if (PROFILE_MULTI_CLAUSE.test(statement)) continue;
    if (PROFILE_HEDGE.test(statement) || PROFILE_ABSOLUTE.test(statement)) continue;
    if (PROFILE_FRAGMENT.test(statement)) continue;
    const sourceField = fields.find((field) => field.startsWith('来源'));
    const sources = (sourceField?.replace(/^来源\s*[=＝]\s*/, '') ?? '')
      .split(/[,，、;；\s]+/)
      .map((id) => id.trim())
      .filter((id) => allowed.has(id));
    if (sources.length === 0) continue;
    const duplicate = out.some((kept) => profileSimilarity(kept.statement, statement) >= 0.7);
    if (duplicate) continue;
    out.push({ statement, sources });
  }
  return out;
}