/**
 * The layer names a lesson can be classified into — declared once.
 *
 * These labels travel three ways: the classifier is told to emit them, the parser
 * matches them, and the store writes them as `type_name`. A copy anywhere else means
 * a rename turns into "one stage writes a label the next stage does not read".
 */
export const CLASSIFY_LABELS = {
  rule: '规则',
  profile: '画像',
  pending: '待修',
} as const;

export type ClassifyLabel = (typeof CLASSIFY_LABELS)[keyof typeof CLASSIFY_LABELS];

/** The judgment a conclusion is stored as. */
export const CONCLUSION_TYPE = '结论';

/**
 * The fact type names that are injected as always-on anchors.
 *
 * Kept here because the set is shared by the context builder and by profile/rule
 * readers; retyping it in a second filter is how a layer silently drops out.
 */
export const ANCHOR_TYPES: readonly string[] = ['结论', '教训', '原则', '性格'];

/**
 * How a fact that came from my own reply is marked in injection (ADR 0035).
 *
 * Two renderers write fact lines — the core's `<memories>` block and the plugin's `<about>`
 * block — and both must use the same marker, or the same fact reads differently depending on
 * which path surfaced it. Declared here, imported by both.
 */
export const INFERRED_MARKER = '我: ';

/**
 * One explanation per block, not one per line.
 *
 * 341 of 646 facts are inferred, so a sentence on every line would double the injection.
 */
export const SOURCE_NOTES =
  '<source-notes>以「我:」开头的是我上一轮说的话，未经用户确认；没标的都是用户说的。</source-notes>';
