/**
 * "No answer" is not "zero" (review finding: empty confidence became 0).
 *
 * The text path took `Number(confidence)`; an empty column yields `0`, so a fact the
 * model was unsure about ranked below everything — the opposite of an honest unknown.
 * The JSON path already used the midpoint, so the two shapes disagreed about the same
 * silence. Both now share one constant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLineDraft, validateDraft, UNKNOWN_CONFIDENCE } from '../src/extract.ts';

function factsOf(raw: string) {
  const rows = parseLineDraft(raw);
  const operations = (rows?.operations ?? []) as Array<{ fact: Record<string, unknown> }>;
  return operations.map((op) => op.fact);
}

test('extract: an empty confidence column is unknown, not zero', () => {
  const [fact] = factsOf('事实: 用户喜欢爬山 | 偏好 | | | told | | 持有=用户');
  assert.equal(fact.confidence, UNKNOWN_CONFIDENCE);
});

test('extract: an explicit zero is still honoured', () => {
  const [fact] = factsOf('事实: 用户可能会来 | 事件 | | | told | 0 | 持有=world');
  assert.equal(fact.confidence, 0);
});

test('extract: garbage in the column is unknown, not zero and not NaN', () => {
  const [fact] = factsOf('事实: 用户喜欢爬山 | 偏好 | | | told | 也许 | 持有=用户');
  assert.equal(fact.confidence, UNKNOWN_CONFIDENCE);
});

test('extract: the text and JSON shapes agree about a missing confidence', () => {
  const parsed = validateDraft({ facts: [{ statement: '用户喜欢爬山', type_name: '偏好', holder: '用户' }] });
  // A JSON answer with only `facts` fills the flat view; `operations` stays empty and
  // the commit gate reads `facts` in that case (the silent-drop bug from earlier).
  const fromJson = parsed.draft?.facts?.[0] as { confidence?: number } | undefined;
  assert.ok(fromJson, 'JSON facts are parsed');
  const [fromText] = factsOf('事实: 用户喜欢爬山 | 偏好 | | | told | | 持有=用户');
  assert.equal(fromJson.confidence, fromText.confidence);
  assert.equal(fromJson.confidence, UNKNOWN_CONFIDENCE);
});
