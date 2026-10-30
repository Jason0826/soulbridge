import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCorrection } from '../src/reflect.ts';
import { AMBIGUOUS_CASES, CLEAR_NO, CLEAR_YES, CORRECTION_CASES } from './fixtures/correction-golden.ts';

/**
 * 当前只有 L1（7 短语正则）可测。这组测试先把基线钉住：
 * 召回可以是 0，但精度不能破——L1 命中就必须真是纠正。
 * L2/L3 上线后，把召回阈值补进这里的断言。
 */
test('黄金集完整性：id 唯一、文本非空、分组齐全', () => {
  const ids = new Set(CORRECTION_CASES.map((c) => c.id));
  assert.equal(ids.size, CORRECTION_CASES.length, 'id 重复');
  for (const c of CORRECTION_CASES) {
    assert.ok(c.text.trim().length > 0, `${c.id} 文本为空`);
    assert.ok(c.note.trim().length > 0, `${c.id} 缺少标注理由`);
  }
  assert.ok(CLEAR_YES.length >= 5, `clear-yes 只有 ${CLEAR_YES.length} 条，样本太少`);
  assert.ok(CLEAR_NO.length >= 10, `clear-no 只有 ${CLEAR_NO.length} 条`);
  assert.equal(AMBIGUOUS_CASES.length, 2);
});

test('L1 基线：命中必须都是真纠正（精度 = 100%）', () => {
  const fired = CORRECTION_CASES.filter((c) => isCorrection(c.text));
  const wrong = fired.filter((c) => c.label === 'no' && c.bucket !== 'ambiguous');

  const recall = (CLEAR_YES.filter((c) => isCorrection(c.text)).length / CLEAR_YES.length) * 100;
  const ambig = AMBIGUOUS_CASES.filter((c) => isCorrection(c.text)).length;

  console.log(
    `L1  clear-yes 召回 ${recall.toFixed(0)}% (${CLEAR_YES.filter((c) => isCorrection(c.text)).length}/${CLEAR_YES.length})` +
      ` · clear-no 误报 ${wrong.length} · ambiguous 命中 ${ambig}/${AMBIGUOUS_CASES.length}`,
  );

  assert.deepEqual(
    wrong.map((c) => c.id),
    [],
    'L1 在明确不是纠正的句子上命中了，精度被破坏',
  );
});

test('L1 现状：明确纠正上的召回为 0（这是要改的基线，不是目标）', () => {
  const hit = CLEAR_YES.filter((c) => isCorrection(c.text)).length;
  assert.equal(hit, 0, `L1 现在命中了 ${hit} 条——若已改进，请更新本测试并把阈值写进 briefs/0008`);
});
