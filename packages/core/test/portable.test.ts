import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const base = { soulId: 's1', userId: 'u1' };

test('portable: the bundle carries archive, summary and injection', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putTurn({
    ...base,
    id: 't1',
    sessionId: 'sess',
    turnNo: 1,
    startedAt: 1000,
    userText: '改 JSON 别用字符串替换',
    steps: [{ idx: 0, kind: 'text', text: '好的', at: 1100 }],
  });
  const rule = soul.recordFact({ ...base, statement: '改 JSON 用 edit 工具', role: 'rule' });
  store.addSlots(rule.id, [{ slot: '触发', value: { kind: 'text', value: '改 json' } }]);
  soul.rememberEntity('小林', 'person', { aliases: ['阿林'] });

  const bundle = soul.portableBundle(2000);

  assert.equal(bundle.schemaVersion, 1);
  assert.ok(bundle.archive.length >= 3, 'entity + fact + turn at least');
  assert.match(bundle.summary, /## 规则（1）/);
  assert.match(bundle.summary, /改 JSON 用 edit 工具/);
  assert.match(bundle.summary, /小林 · person（别名：阿林）/);
  assert.match(bundle.injection, /<soul/);
  store.close();
});

test('portable: raw turns are in the archive even though they are never in the summary', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putTurn({
    ...base,
    id: 't1',
    sessionId: 'sess',
    turnNo: 1,
    startedAt: 1000,
    userText: '原始对话必须留在档案里',
    steps: [],
  });
  const bundle = soul.portableBundle(2000);
  const turns = bundle.archive.map((line) => JSON.parse(line)).filter((row) => row.record === 'turn');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].userText, '原始对话必须留在档案里');
  assert.doesNotMatch(bundle.summary, /原始对话必须留在档案里/, '摘要不是原文堆放处');
  store.close();
});
