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
  kind: 'rule' | 'profile';
  /** Raw trigger JSON, when this is a rule. */
  trigger?: string;
  /** One sentence of what to do, when this is a rule. */
  action?: string;
}

const CLASSIFIED = /^(规则|画像)\s*[:：]\s*(.+)$/;

/**
 * Parse the classifier's answer:
 *
 *   规则: fc_x | {"any":["json","package.json"]} | 用 edit 工具改 JSON
 *   画像: fc_y
 *
 * A rule whose trigger does not parse is downgraded to a profile item rather than
 * becoming an always-on rule — the point of the split is that rules must be
 * situation-specific.
 */
export function parseRuleClassifications(raw: string): RuleClassification[] {
  const out: RuleClassification[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const match = CLASSIFIED.exec(line.trim());
    if (!match) continue;
    const parts = match[2].split('|').map((part) => part.trim());
    const id = parts[0];
    if (!id || !/^fc_/.test(id)) continue;
    if (match[1] === '画像') {
      out.push({ id, kind: 'profile' });
      continue;
    }
    const trigger = parts[1];
    const action = parts[2];
    if (!trigger || !parseTrigger(trigger)) {
      out.push({ id, kind: 'profile' });
      continue;
    }
    out.push({ id, kind: 'rule', trigger, action: action || undefined });
  }
  return out;
}