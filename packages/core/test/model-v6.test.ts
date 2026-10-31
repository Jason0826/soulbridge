import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';

const S = { soulId: 's1', userId: 'u1' };

test('putEntity: one row per (type, name), lastMentionedAt moves', () => {
  const store = openSqlite(':memory:');
  const a = store.putEntity({ ...S, type: 'person', name: '小林', seenAt: 1000 });
  const b = store.putEntity({ ...S, type: 'person', name: '小林', seenAt: 2000, aliases: ['小林姐'] });
  assert.equal(a.id, b.id, 'same name and type is the same entity');
  assert.equal(b.lastMentionedAt, 2000);
  assert.deepEqual(b.aliases, ['小林姐']);
  assert.equal(store.findEntities({ ...S, name: '小林' }).length, 1);
  assert.equal(store.findEntities({ ...S, name: '小' }).length, 1, 'substring search works');
  store.close();
});

test('putFact: slots of every kind round-trip', () => {
  const store = openSqlite(':memory:');
  const person = store.putEntity({ ...S, type: 'person', name: '小林' });
  const company = store.putEntity({ ...S, type: 'thing', name: '某公司' });
  const question = store.putFact({ ...S, statement: '问她怎么了', atText: '上周' });
  const fact = store.putFact({
    ...S,
    statement: '小林上周被裁员了',
    typeName: '裁员',
    at: 1000,
    atText: '上周',
    status: 'none',
    source: 'told',
    slots: [
      { slot: '被裁员者', value: { kind: 'entity', entityId: person.id } },
      { slot: '裁员方', value: { kind: 'entity', entityId: company.id } },
      { slot: '裁员人数', value: { kind: 'number', value: 300 } },
      { slot: '内容', value: { kind: 'text', value: '整个部门' } },
      { slot: '回应', value: { kind: 'fact', factId: question.id } },
    ],
  });
  assert.equal(fact.slots.length, 5);
  assert.equal(fact.source, 'told');
  assert.equal(fact.atText, '上周');
  const num = fact.slots.find((s) => s.slot === '裁员人数');
  assert.deepEqual(num?.value, { kind: 'number', value: 300 });
  const ref = fact.slots.find((s) => s.slot === '回应');
  assert.deepEqual(ref?.value, { kind: 'fact', factId: question.id }, 'a slot can point at another fact');
  store.close();
});

test('facts: entity filter answers "about her" without any ranking', () => {
  const store = openSqlite(':memory:');
  const her = store.putEntity({ ...S, type: 'person', name: '小林' });
  const other = store.putEntity({ ...S, type: 'person', name: '老王' });
  store.putFact({ ...S, statement: '小林被裁员', at: 1000, slots: [{ slot: '被裁员者', value: { kind: 'entity', entityId: her.id } }] });
  store.putFact({ ...S, statement: '小林搬了家', at: 3000, slots: [{ slot: '搬家者', value: { kind: 'entity', entityId: her.id } }] });
  store.putFact({ ...S, statement: '老王退休了', at: 2000, slots: [{ slot: '退休者', value: { kind: 'entity', entityId: other.id } }] });

  const hers = store.facts({ ...S, entityId: her.id });
  assert.equal(hers.length, 2);
  assert.deepEqual(
    hers.map((f) => f.statement),
    ['小林搬了家', '小林被裁员'],
    'newest first',
  );
  assert.equal(store.facts({ ...S, entityId: her.id, since: 2000 }).length, 1);
  assert.equal(store.facts({ ...S, holder: 'self' }).length, 0);
  store.close();
});

test('gaps: ordered by tension, closable, and tied to a person', () => {
  const store = openSqlite(':memory:');
  const her = store.putEntity({ ...S, type: 'person', name: '小林' });
  store.putGap({ ...S, aboutEntityId: her.id, topic: '她后来有着落吗', tension: 0.2, openedAt: 1000 });
  const urgent = store.putGap({ ...S, aboutEntityId: her.id, topic: '她身体好点没', tension: 0.9, openedAt: 2000 });

  const open = store.openGaps(S.soulId, S.userId);
  assert.equal(open.length, 2);
  assert.equal(open[0].id, urgent.id, 'highest tension first');

  const answer = store.putFact({ ...S, statement: '她找到工作了', at: 3000 });
  store.closeGap(urgent.id, answer.id, 3000);
  const after = store.openGaps(S.soulId, S.userId);
  assert.equal(after.length, 1);
  assert.equal(after[0].topic, '她后来有着落吗');
  store.close();
});
