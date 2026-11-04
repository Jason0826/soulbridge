/**
 * A date that does not exist must not be invented (review finding: rollover).
 *
 * `Date.parse('2026-02-31T00:00:00Z')` returns 2026-03-03 without error, and the old
 * parser kept precision=day — a confidently wrong date that joins time retrieval as if
 * it were exact. The same roll happened in the rules extractor ("2月31日").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLineDraft, extractByRules, parseIsoDate, calendarDate } from '../src/extract.ts';

function factOf(line: string) {
  const rows = parseLineDraft(line);
  const operations = (rows?.operations ?? []) as Array<{ fact: Record<string, unknown> }>;
  return operations[0]?.fact;
}

test('date: a non-existent day is rejected, not rolled', () => {
  assert.equal(parseIsoDate('2026-02-31'), undefined);
  assert.equal(parseIsoDate('2026-04-31'), undefined);
  assert.equal(parseIsoDate('2026-13-01'), undefined);
  assert.equal(parseIsoDate('2027-02-29'), undefined, '2027 不是闰年');
  assert.equal(parseIsoDate('2028-02-29'), Date.UTC(2028, 1, 29), '2028 是闰年');
  assert.equal(parseIsoDate('2026-02-28'), Date.UTC(2026, 1, 28));
  assert.equal(calendarDate(2026, 2, 31), undefined);
});

test('date: an impossible date in a fact line is dropped and precision downgrades', () => {
  const noText = factOf('事实: 用户在二月底做了某件事 | 事件 | 2026-02-31 | | told | 0.8 | 持有=world | 精度=day');
  assert.equal(noText.valid_from, undefined, '不存在的日期不能落库');
  assert.equal(noText.valid_from_precision, 'unknown', '没有原话时只能是 unknown');

  const withText = factOf('事实: 用户在二月底做了某件事 | 事件 | 2026-02-31 | 二月底 | told | 0.8 | 持有=world | 精度=day');
  assert.equal(withText.valid_from, undefined);
  assert.equal(withText.valid_from_precision, 'relative', '有原话就降级为 relative，而不是丢掉精度');
  assert.equal(withText.valid_from_text, '二月底');
});

test('date: a valid date keeps day precision even when the model omitted it', () => {
  const fact = factOf('事实: 小林被裁员 | 裁员 | 2026-10-24 | 上周 | told | 0.8 | 持有=world');
  assert.equal(fact.valid_from, Date.UTC(2026, 9, 24));
  assert.equal(fact.valid_from_precision, 'day');
});

test('date: the rules extractor rejects 2月31日 instead of rolling to March', () => {
  const at = new Date('2026-11-05T00:00:00Z').getTime();
  const good = extractByRules('3月5日和小林吃了火锅', at);
  assert.equal(good.facts[0]?.validFrom, Date.UTC(2026, 2, 5));
  assert.equal(good.facts[0]?.validFromPrecision, 'day');

  const bad = extractByRules('2月31日和小林吃了火锅', at);
  assert.equal(bad.facts[0]?.validFrom, undefined);
  assert.equal(bad.facts[0]?.validFromText, '2月31日');
});
