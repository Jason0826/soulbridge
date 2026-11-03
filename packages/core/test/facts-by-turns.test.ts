import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';

const base = { soulId: 's1', userId: 'u1' };

test('factsByTurns: a retracted fact is not evidence for later consolidation', () => {
  const store = openSqlite(':memory:');
  store.putTurn({
    ...base,
    id: 'turn-1',
    sessionId: 'sess',
    turnNo: 1,
    startedAt: 1,
    userText: '在 A 公司',
    steps: [{ idx: 0, kind: 'text', text: '记下了', at: 2 }],
  });
  const oldFact = store.putFact({
    ...base,
    statement: '小林在 A 公司',
    sourceTurnId: 'turn-1',
    source: 'told',
    confidence: 0.8,
  });
  const newer = store.putFact({
    ...base,
    statement: '小林去了 B 公司',
    sourceTurnId: 'turn-1',
    source: 'told',
    confidence: 0.9,
  });
  store.supersedeFact(oldFact.id, newer.id);

  const ids = store.factsByTurns(['turn-1']).map((fact) => fact.id);
  assert.deepEqual(ids, [newer.id], '被取代的事实不能再当归纳材料');
  store.close();
});
