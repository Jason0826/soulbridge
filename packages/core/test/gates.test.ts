import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { gateDrafts, MAX_CONTENT_CHARS, MAX_DRAFTS_PER_TURN, reflect } from '../src/reflect.ts';

test('闸门 shape：超长内容被拒，说明原因', () => {
  const { accepted, rejected } = gateDrafts([
    { type: 'fact', content: 'x'.repeat(MAX_CONTENT_CHARS + 1), importance: 6 },
  ]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].gate, 'shape');
  assert.match(rejected[0].reason, /length/);
});

test('闸门 semantic：只有标点的内容被拒', () => {
  const { accepted, rejected } = gateDrafts([{ type: 'fact', content: '……！！', importance: 6 }]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].gate, 'semantic');
});

test('闸门 budget：单轮超过上限的部分被拒', () => {
  const drafts = Array.from({ length: MAX_DRAFTS_PER_TURN + 2 }, (_, i) => ({
    type: 'fact' as const,
    content: `第 ${i} 条事实内容`,
    importance: 6,
  }));
  const { accepted, rejected } = gateDrafts(drafts);
  assert.equal(accepted.length, MAX_DRAFTS_PER_TURN);
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].gate, 'budget');
});

test('闸门 shape：不可抽取的类型被拒', () => {
  const { rejected } = gateDrafts([{ type: 'episodic', content: '一段经历', importance: 6 }]);
  assert.equal(rejected[0].gate, 'shape');
});

test('observe 不再写记忆：写入路径已迁到 extract/commitDrafts', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });

  const hit = await soul.observe({ role: 'user', content: '以后提交前先跑测试' });
  // The verb kept its name and its affect side, but memory writing moved: one
  // representation (facts) and one prompt, not two pipelines.
  assert.equal(hit.committed, false);
  assert.equal(hit.written, 0);
  assert.deepEqual(hit.rejections, []);
  assert.equal(store.count('xiaoling', 'u1'), 0);
  assert.equal(soul.list(100).length, 0, '也不应该悄悄写进 facts');
  store.close();
});

test('reflect 不再谎报 superseded', async () => {
  const store = openSqlite(':memory:');
  const result = await reflect(store, {
    soulId: 'xiaoling',
    userId: 'u1',
    turns: [{ role: 'user', content: '以后提交前先跑测试' }],
    updateEmotion: false,
  });
  assert.equal(result.superseded, null, '未实现就说 null，不报 0');
  assert.equal(result.committed, true);
  store.close();
});
