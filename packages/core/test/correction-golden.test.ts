import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCorrection } from '../src/reflect.ts';
import {
  AMBIGUOUS_CASES,
  CLEAR_NO,
  CLEAR_YES,
  CORRECTION_CASES,
  PREVIOUS_REPLY,
} from './fixtures/correction-golden.ts';
import type { CorrectionCase } from './fixtures/correction-golden.ts';

const verdictOf = (c: CorrectionCase) => detectCorrection(c.text, PREVIOUS_REPLY[c.id]);

/**
 * 基线（2026-10-30，L1 只有 7 短语正则）：
 *   clear-yes 召回 0/6 · clear-no 误报 0
 * L1+L2 之后，召回必须上去，精度不能破。
 * 阈值写死在这里：召回不够会红，精度破了更会红。
 */
test('黄金集完整性：id 唯一、文本非空、每条都有上一轮上下文', () => {
  const ids = new Set(CORRECTION_CASES.map((c) => c.id));
  assert.equal(ids.size, CORRECTION_CASES.length, 'id 重复');
  for (const c of CORRECTION_CASES) {
    assert.ok(c.text.trim().length > 0, `${c.id} 文本为空`);
    assert.ok(c.note.trim().length > 0, `${c.id} 缺少标注理由`);
    assert.ok(PREVIOUS_REPLY[c.id], `${c.id} 缺少上一轮上下文，L2 无法测`);
  }
  assert.ok(CLEAR_YES.length >= 5, `clear-yes 只有 ${CLEAR_YES.length} 条`);
  assert.ok(CLEAR_NO.length >= 10, `clear-no 只有 ${CLEAR_NO.length} 条`);
  assert.equal(AMBIGUOUS_CASES.length, 2);
});

test('精度：明确不是纠正的句子，一条都不许命中', () => {
  const wrong = CLEAR_NO.filter((c) => verdictOf(c).isCorrection);
  assert.deepEqual(wrong.map((c) => c.id), [], 'clear-no 出现误报，精度被破坏');
});

test('召回：L1+L2 在明确纠正上 ≥ 2/6', () => {
  const hits = CLEAR_YES.filter((c) => verdictOf(c).isCorrection);
  const byLayer = hits.reduce<Record<string, number>>((acc, c) => {
    const layer = verdictOf(c).layer;
    acc[layer] = (acc[layer] ?? 0) + 1;
    return acc;
  }, {});
  const missed = CLEAR_YES.filter((c) => !verdictOf(c).isCorrection).map((c) => c.id);

  console.log(
    `L1+L2  clear-yes 召回 ${hits.length}/${CLEAR_YES.length}` +
      ` (rule ${byLayer.rule ?? 0} · structural ${byLayer.structural ?? 0})` +
      ` · 未命中 ${missed.length ? missed.join(',') : '无'}`,
  );

  assert.ok(
    hits.length >= 2,
    `召回退化了：${hits.length}/6。基线是 2/6，修好之前不该更低`,
  );
});

test('疑似组只报数，不作为门槛', () => {
  const hit = AMBIGUOUS_CASES.filter((c) => verdictOf(c).isCorrection).map((c) => c.id);
  console.log(`ambiguous 命中 ${hit.length}/${AMBIGUOUS_CASES.length}${hit.length ? ` (${hit.join(',')})` : ''}`);
});
