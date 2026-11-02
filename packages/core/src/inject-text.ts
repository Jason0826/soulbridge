/**
 * One escape point for text that goes inside an injection block.
 *
 * Blocks are plain `<tag>…</tag>` envelopes, so content containing `</tag>` ends the
 * block early — a pasted message, a fact statement or an entity name can forge a
 * `<rules>` block, and `<rules>` is read as a requirement, not as background. The
 * defence is structural, not a prompt instruction: every dynamic value passes through
 * here before it is concatenated.
 *
 * Newlines and ordinary punctuation stay readable; only the characters that can
 * change structure are replaced.
 */

/** Text inside a block: `<` and `>` cannot form a tag any more. */
export function escapeBlockText(text: string): string {
  return String(text ?? '')
    // Control characters (except tab/newline) are invisible noise in a prompt.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Attribute value: quotes and newlines would end the attribute early. */
export function escapeAttr(text: string): string {
  return escapeBlockText(text).replace(/"/g, '&quot;').replace(/\r?\n/g, ' ');
}
