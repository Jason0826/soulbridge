import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLineDraft, validateDraft } from '../src/extract.ts';

test('lines: a filled template becomes a draft', () => {
  const raw = [
    '实体: 小林 | person | 同事',
    '事实: 小林在 2026-10-24 那周被裁员 | 裁员 | 2026-10-24 | 上周 | told | 0.8 | 被裁员者=@小林;人数=300',
    '缺口: 小林后来有着落吗 | 0.6 | 小林',
  ].join('\n');

  const parsed = parseLineDraft(raw);
  assert.ok(parsed, 'records are found');
  const { draft, error } = validateDraft(parsed);
  assert.equal(error, undefined);
  assert.equal(draft?.entities.length, 1);
  assert.equal(draft?.facts.length, 1);
  const fact = draft?.facts[0];
  assert.equal(fact?.statement, '小林在 2026-10-24 那周被裁员');
  assert.equal(fact?.atText, '上周');
  assert.equal(fact?.source, 'told');
  assert.equal(fact?.slots.length, 2);
  assert.deepEqual(fact?.slots[0].value, { kind: 'entity', entityName: '小林', entityType: 'person' }, '@ 才是实体引用');
  assert.deepEqual(fact?.slots[1].value, { kind: 'number', value: 300 });
  assert.equal(draft?.gaps[0].topic, '小林后来有着落吗');
});

test('lines: one bad record does not sink the good ones', () => {
  const raw = ['这不是一行记录', '事实: 小林找到新工作 | 就业 | | 今天 | told | 0.7 | 入职者=小林', '|||'].join('\n');
  const { draft } = validateDraft(parseLineDraft(raw));
  assert.equal(draft?.facts.length, 1, 'the malformed lines are skipped, the fact survives');
});

test('lines: 无 is an answer, not a failure', () => {
  const { draft, error } = validateDraft(parseLineDraft('无'));
  assert.equal(error, undefined);
  assert.equal(draft?.facts.length, 0);
  assert.equal(draft?.by, 'llm');
});

test('lines: prose with no records yields null, so the caller can fall back', () => {
  assert.equal(parseLineDraft('好的，我来帮你抽取。'), null);
});

test('lines: a JSON answer still parses through the fallback', () => {
  assert.equal(parseLineDraft('{"entities":[],"operations":[],"gaps":[]}'), null);
});
