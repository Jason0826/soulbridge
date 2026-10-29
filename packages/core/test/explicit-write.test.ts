import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

function soul() {
  const store = openSqlite(':memory:');
  return { store, instance: new Soul({ store, soulId: 'xiaoling', userId: 'u1' }) };
}

test('rememberExplicit：合法内容写入并返回 id', () => {
  const { store, instance } = soul();
  const result = instance.rememberExplicit({ content: '发布窗口是每周三', type: 'fact' });
  assert.equal(result.ok, true);
  assert.ok(result.id);
  assert.equal(store.count('xiaoling', 'u1'), 1);
  store.close();
});

test('rememberExplicit：超长内容被闸门拒绝，不写入', () => {
  const { store, instance } = soul();
  const result = instance.rememberExplicit({ content: 'x'.repeat(501), type: 'fact' });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /length/);
  assert.equal(store.count('xiaoling', 'u1'), 0);
  store.close();
});

test('rememberExplicit：纯标点被拒', () => {
  const { store, instance } = soul();
  const result = instance.rememberExplicit({ content: '……！！', type: 'fact' });
  assert.equal(result.ok, false);
  assert.equal(store.count('xiaoling', 'u1'), 0);
  store.close();
});

test('rememberExplicit：同内容不重复写，返回 duplicate', () => {
  const { store, instance } = soul();
  const first = instance.rememberExplicit({ content: '提交前先跑测试', type: 'strategy' });
  const second = instance.rememberExplicit({ content: '提交前先跑测试', type: 'strategy' });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal(store.count('xiaoling', 'u1'), 1);
  store.close();
});

test('rememberExplicit：类型必须在可抽取集合内', () => {
  const { store, instance } = soul();
  const result = instance.rememberExplicit({ content: '一段经历', type: 'episodic' });
  assert.equal(result.ok, false);
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
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  const first = soul.rememberExplicit({ content: '记住：测试工具', type: 'fact' });
  const second = soul.rememberExplicit({
    content: '「测试工具」是用户要求记住的一条内容；具体指代尚未说明，待确认后补充。',
    type: 'fact',
  });
  assert.equal(second.duplicate, true, '改写应被判为重复');
  assert.equal(second.id, first.id);
  assert.equal(store.count('xiaoling', 'u1'), 1);
  store.close();
});

test('rememberExplicit：无关内容在窗口内仍可写入', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  soul.rememberExplicit({ content: '记住：测试工具', type: 'fact' });
  const other = soul.rememberExplicit({ content: '发布窗口是每周三', type: 'fact' });
  assert.equal(other.ok, true);
  assert.equal(other.duplicate, undefined);
  assert.equal(store.count('xiaoling', 'u1'), 2);
  store.close();
});

test('rememberExplicit：窗口可关闭', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1', dedupeWindowMs: 0 });
  soul.rememberExplicit({ content: '记住：测试工具', type: 'fact' });
  const second = soul.rememberExplicit({ content: '测试工具的具体用法待确认', type: 'fact' });
  assert.equal(second.duplicate, undefined, '关闭窗口后不按改写去重');
  assert.equal(store.count('xiaoling', 'u1'), 2);
  store.close();
});