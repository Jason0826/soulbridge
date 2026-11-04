import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const base = { soulId: 's1', userId: 'u1' };

test('person card: resolves by alias and returns recent facts plus open questions', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const her = soul.rememberEntity('小林', 'person', { aliases: ['阿林'] });
  soul.recordFact({
    statement: '小林在 2026-10-24 那周被裁员',
    validFrom: Date.parse('2026-10-24T00:00:00Z'),
    validFromText: '2026-10-24',
    source: 'told',
    confidence: 0.8,
    slots: [{ slot: '被裁员者', value: { kind: 'entity', entityId: her.id } }],
  });
  store.putGap({
    ...base,
    id: 'g1',
    aboutEntityId: her.id,
    topic: '小林后来有着落吗',
    tension: 0.6,
    openedAt: Date.now(),
  });

  const card = soul.personCard('阿林');
  assert.equal(card.entity?.id, her.id, 'aliases resolve to the same person');
  assert.equal(card.recent.length, 1);
  assert.match(card.recent[0].statement, /被裁员/);
  assert.deepEqual(card.openGaps.map((gap) => gap.topic), ['小林后来有着落吗']);
  store.close();
});

test('person card: an unknown name is null, not an invented person', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const card = soul.personCard('从未出现的人');
  assert.equal(card.entity, null);
  assert.deepEqual(card.recent, []);
  store.close();
});
