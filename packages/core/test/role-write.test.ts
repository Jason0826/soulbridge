import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const base = { soulId: 's1', userId: 'u1' };

test('role: the model decides it, and a missing role is an observation', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });

  const rule = soul.recordFact({ ...base, statement: '改 JSON 用 edit 工具', role: 'rule' });
  assert.equal(rule.role, 'rule');

  // The old behaviour inferred a role from the Chinese type label. That inference is gone:
  // a label alone no longer promotes a fact into rules()/profile()/conclusions().
  const labelled = soul.recordFact({ ...base, statement: '某种被标成规则的观察', typeName: '规则' });
  assert.equal(labelled.role, 'observation');

  store.close();
});

test('role: an unknown role is a caller bug, not something to guess quietly', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  assert.throws(
    () => soul.recordFact({ ...base, statement: '角色写错', role: 'rule-of-thumb' as never }),
    /invalid fact role/,
  );
  store.close();
});

test('status: an unclassified lesson becomes a candidate, not a hidden type', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const fact = soul.recordFact({ ...base, statement: '这条一时分不清是规则还是画像' });
  soul.markUnclassified(fact.id);
  assert.equal(store.fact(fact.id)?.status, 'candidate');
  assert.equal(soul.rules().length, 0, 'candidate 不参与规则注入');
  store.close();
});
