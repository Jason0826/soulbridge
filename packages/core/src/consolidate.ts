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
 */
export function conclusionSlots(evidence: string[]): { slot: string; value: SlotValue }[] {
  return evidence.map((factId) => ({ slot: '证据', value: { kind: 'fact', factId } }));
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
