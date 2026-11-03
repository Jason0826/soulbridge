/**
 * Explicit writes go to facts, like every other write path (ADR 0032).
 *
 * These tests used to assert rows in the retired `memories` table. The contract they
 * describe is unchanged — shape checks, dedupe by content, paraphrase window — only
 * the representation moved. `list()` is the observation surface that follows it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

function soul(options: { dedupeWindowMs?: number } = {}) {
  const store = openSqlite(':memory:');
  return { store, instance: new Soul({ store, soulId: 'xiaoling', userId: 'u1', ...options }) };
}

/** How many facts the soul holds. */
const held = (instance: Soul) => instance.list(1000).length;

test('rememberExplicit：合法内容写入并返回 id', () => {
  const { store, instance } = soul();
  const result = instance.rememberExplicit({ content: '发布窗口是每周三', type: 'fact' });
  assert.equal(result.ok, true);
  assert.ok(result.id);
  assert.equal(held(instance), 1);
  assert.ok(instance.list().some((m) => m.content === '发布窗口是每周三'));
  store.close();
});

test('rememberExplicit：超长内容被拒，不写入', () => {
  const { store, instance } = soul();
  const result = instance.rememberExplicit({ content: 'x'.repeat(501), type: 'fact' });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /length/);
  assert.equal(held(instance), 0);
  store.close();
});

test('rememberExplicit：纯标点被拒', () => {
  const { store, instance } = soul();
  const result = instance.rememberExplicit({ content: '……！！', type: 'fact' });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /letters or digits/);
  assert.equal(held(instance), 0);
  store.close();
});

test('rememberExplicit：同内容不重复写，返回 duplicate', () => {
  const { store, instance } = soul();
  const first = instance.rememberExplicit({ content: '提交前先跑测试', type: 'strategy' });
  const second = instance.rememberExplicit({ content: '提交前先跑测试', type: 'strategy' });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal(held(instance), 1);
  store.close();
});

test('rememberExplicit：类型映射到事实的类型名，而不是被拒', () => {
  const { store, instance } = soul();
  // The old gate refused episodic rows because the memories table had a fixed set.
  // A fact type name is free text, so the value is carried instead of dropped.
  const result = instance.rememberExplicit({ content: '一段经历', type: 'episodic' });
  assert.equal(result.ok, true);
  assert.ok(instance.list().some((m) => m.content === '一段经历'));
  store.close();
});

test('rememberExplicit 的写入会被 list 看到、被 context 注入（重要度够）', () => {
  const { store, instance } = soul();
  instance.rememberExplicit({ content: '发布窗口是每周三', type: 'fact', importance: 8 });
  assert.ok(instance.list().some((m) => m.content.includes('发布窗口')));
  assert.ok(instance.context({ track: false }).text.includes('发布窗口'));
  store.close();
});

test('rememberExplicit：同轮改写不产生第二条（窗口内共享片段）', () => {
  const { store, instance } = soul();
  const first = instance.rememberExplicit({ content: '记住：测试工具', type: 'fact' });
  const second = instance.rememberExplicit({
    content: '「测试工具」是用户要求记住的一条内容；具体指代尚未说明，待确认后补充。',
    type: 'fact',
  });
  assert.equal(second.duplicate, true, '改写应被判为重复');
  assert.equal(second.id, first.id);
  assert.equal(held(instance), 1);
  store.close();
});

test('rememberExplicit：无关内容在窗口内仍可写入', () => {
  const { store, instance } = soul();
  instance.rememberExplicit({ content: '记住：测试工具', type: 'fact' });
  const other = instance.rememberExplicit({ content: '发布窗口是每周三', type: 'fact' });
  assert.equal(other.ok, true);
  assert.equal(other.duplicate, undefined);
  assert.equal(held(instance), 2);
  store.close();
});

test('rememberExplicit：窗口可关闭', () => {
  const { store, instance } = soul({ dedupeWindowMs: 0 });
  instance.rememberExplicit({ content: '记住：测试工具', type: 'fact' });
  const second = instance.rememberExplicit({ content: '测试工具的具体用法待确认', type: 'fact' });
  assert.equal(second.duplicate, undefined, '关闭窗口后不按改写去重');
  assert.equal(held(instance), 2);
  store.close();
});
