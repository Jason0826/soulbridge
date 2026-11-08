/**
 * Rule matching (ADR 0033).
 *
 * A rule is not a memory: it constrains behaviour, so it should appear when its
 * situation applies and stay out of the way otherwise. Always-on rules become
 * wallpaper, which is how a lesson turns into a paragraph the model skips.
 *
 * The whole thing is a pure function over (rule, user message, session state) so
 * it can be tested without a database or a model call.
 */
import { PROFILE_DIMENSIONS } from './consolidate.ts';

export interface RuleTrigger {
  /** Substring keywords; any one is enough. */
  any?: string[];
  /** Case-insensitive regex source; any match is enough. */
  regex?: string;
  /** A counter flag maintained by the adapter, e.g. `long-session`. */
  state?: string;
}

export interface Rule {
  id: string;
  statement: string;
  trigger: RuleTrigger;
  scope?: string;
  confidence?: number;
  /**
   * One neutral line that indexes this rule for the always-on catalog (0029).
   *
   * A rule has two representations: the index line says "this exists" and the
   * statement says what to do. Absent means the rule predates the catalog or the
   * classifier did not answer that column — it stays out of the catalog, which is
   * visible as a count, not filled in with a cut-down statement.
   */
  index?: string;
  /**
   * How often this rule has been surfaced. The catalog's only computed rank:
   * 复现频率 is measurable (`recall_count`), while scope is not modelled yet.
   */
  recallCount?: number;
}

/**
 * Parse the stored trigger. Malformed JSON means "no trigger", not "always":
 * a rule that fires on everything is worse than a rule that never fires.
 */
export function parseTrigger(raw: string): RuleTrigger | null {
  try {
    const parsed = JSON.parse(String(raw ?? ''));
    if (!parsed || typeof parsed !== 'object') return null;
    const out: RuleTrigger = {};
    if (Array.isArray(parsed.any)) {
      const any = parsed.any.map((item: unknown) => String(item ?? '').trim()).filter(Boolean);
      if (any.length > 0) out.any = any;
    }
    if (typeof parsed.regex === 'string' && parsed.regex.trim()) out.regex = parsed.regex.trim();
    if (typeof parsed.state === 'string' && parsed.state.trim()) out.state = parsed.state.trim();
    return out.any || out.regex || out.state ? out : null;
  } catch {
    return null;
  }
}

/** Content conditions are OR-ed; a state condition must also hold when present. */
function contentMatches(trigger: RuleTrigger, text: string): boolean {
  if (!trigger.any && !trigger.regex) return false;
  const haystack = text.toLowerCase();
  if (trigger.any?.some((keyword) => haystack.includes(keyword.toLowerCase()))) return true;
  if (trigger.regex) {
    try {
      if (new RegExp(trigger.regex, 'i').test(text)) return true;
    } catch {
      // A broken regex must not throw on every turn; it simply never matches.
      return false;
    }
  }
  return false;
}

/**
 * Does this rule apply to the current message?
 *
 * With both content and state conditions, both must hold: a rule that mentions
 * both is meant for a narrower situation, and over-firing is the failure that
 * pushes a rule into the wallpaper class.
 */
export function fires(rule: Rule, text: string, state: Record<string, boolean> = {}): boolean {
  const trigger = rule.trigger ?? {};
  const hasContent = Boolean(trigger.any || trigger.regex);
  const hasState = Boolean(trigger.state);
  if (!hasContent && !hasState) return false; // no trigger = never fires
  if (hasContent && !contentMatches(trigger, String(text ?? ''))) return false;
  if (hasState && !state[trigger.state as string]) return false;
  return true;
}

/** The rules to inject: only the ones that fire, strongest first, capped. */
export function selectRules(
  rules: Rule[],
  text: string,
  state: Record<string, boolean> = {},
  limit = 5,
): Rule[] {
  return rules
    .filter((rule) => fires(rule, text, state))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, Math.max(0, limit));
}

/* ------------------------------------------------------------------ *
 * Classifying lessons: rule (with a trigger) or profile (about a person)
 * ------------------------------------------------------------------ */

export interface RuleClassification {
  id: string;
  /**
   * `pending` is a third bucket on purpose: a lesson that is neither clearly a
   * triggered rule nor clearly a statement about the person must not be forced into
   * either. As a rule it would become wallpaper; as a profile line it would put an
   * imperative into the description of a person.
   *
   * `index` is not a classification: the row is already a rule and only owes its
   * catalog line (0029). It exists so backfilling the index goes through the same
   * queue and the same prompt instead of a second model caller.
   */
  kind: 'rule' | 'profile' | 'pending' | 'index';
  /** Trigger JSON built by this parser, never authored by the model. */
  trigger?: string;
  /** One sentence of what to do, when this is a rule. */
  action?: string;
  /**
   * One neutral line, when this is a rule or an `index` answer.
   *
   * Optional even on an `index` answer: an empty column is reported by the caller
   * instead of being written as a blank catalog line.
   */
  index?: string;
  /**
   * Which lens the person statement belongs to, when this is a profile item.
   *
   * Absent when the model did not say or named something that is not a dimension:
   * the merge step refuses to merge unlabelled items rather than guess, so a wrong
   * dimension here would silently file the judgment under the wrong lens.
   */
  dimension?: string;
  /** Why it could not be classified, when pending. */
  reason?: string;
}

const CLASSIFIED = /^(规则|画像|待修|索引)\s*[:：]\s*(.+)$/;
const KEY_FIELD = /^(关键词|正则|状态|动作|原因|维度|索引)\s*[=＝]\s*(.*)$/;

/**
 * Parse the classifier's answer. Line-table, not JSON — the model fills fields and
 * the code assembles the trigger, because we already know model-authored JSON is a
 * hope (the extractor was moved off it for the same reason).
 *
 *   规则: fc_x | 关键词=json,package.json | 动作=用 edit 工具改 JSON | 索引=改 JSON 要防 BOM
 *   规则: fc_y | 正则=\.json\b
 *   规则: fc_z | 状态=long-session
 *   画像: fc_p
 *   待修: fc_q | 原因=不知道什么时候该用
 *   索引: fc_r | 索引=会话里直接跑重启脚本会被连坐杀掉
 *
 * A 规则 with no usable condition becomes 待修, not 画像: the two failures have
 * different consequences and only one of them pollutes the profile. The 索引 line
 * is a separate answer by design: a rule already placed only owes its catalog line
 * (0029), and re-classifying it would rewrite a trigger nobody asked about.
 */
export function parseRuleClassifications(raw: string): RuleClassification[] {
  const out: RuleClassification[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const match = CLASSIFIED.exec(line.trim());
    if (!match) continue;
    const parts = match[2].split('|').map((part) => part.trim());
    const id = parts[0];
    if (!id || !/^fc_/.test(id)) continue;
    const kindLabel = match[1];

    const fields = new Map<string, string>();
    for (const part of parts.slice(1)) {
      const field = KEY_FIELD.exec(part);
      if (field) fields.set(field[1], field[2].trim());
    }

    if (kindLabel === '索引') {
      const index = fields.get('索引') ?? '';
      out.push({ id, kind: 'index', ...(index ? { index } : {}) });
      continue;
    }
    if (kindLabel === '画像') {
      const dimension = fields.get('维度');
      // A dimension the merge step does not know is not a dimension; keeping it out
      // leaves the item unlabelled, which is visible, instead of mislabelled.
      const known = dimension && (PROFILE_DIMENSIONS as readonly string[]).includes(dimension);
      out.push({ id, kind: 'profile', ...(known ? { dimension } : {}) });
      continue;
    }
    if (kindLabel === '待修') {
      out.push({ id, kind: 'pending', reason: fields.get('原因') });
      continue;
    }

    const keywords = (fields.get('关键词') ?? '')
      .split(/[,，、;；\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const regex = fields.get('正则');
    const state = fields.get('状态');
    const trigger: RuleTrigger = {};
    if (keywords.length > 0) trigger.any = keywords;
    if (regex) trigger.regex = regex;
    if (state) trigger.state = state;
    if (!trigger.any && !trigger.regex && !trigger.state) {
      out.push({ id, kind: 'pending', reason: '规则缺少触发条件' });
      continue;
    }
    out.push({
      id,
      kind: 'rule',
      trigger: JSON.stringify(trigger),
      action: fields.get('动作') || undefined,
      ...(fields.get('索引') ? { index: fields.get('索引') } : {}),
    });
  }
  return out;
}