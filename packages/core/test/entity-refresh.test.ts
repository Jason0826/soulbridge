/**
 * Refreshing an entity must not erase it (review finding: aliases/attrs overwritten).
 *
 * `putEntity` is called every time a known name shows up again, often with just the
 * name. The upsert wrote `excluded.aliases` unconditionally, so the second mention
 * cleared the nickname and the attributes, and `latestAbout` lost its alias match —
 * the person stopped being recognized except by their full name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';

const base = { soulId: 's1', userId: 'u1' };

test('entity: a name-only refresh keeps aliases and attrs', () => {
  const store = openSqlite(':memory:');
  store.putEntity({ ...base, type: 'person', name: '小林', aliases: ['阿林'], attrs: { age: 30 } });
  store.putEntity({ ...base, type: 'person', name: '小林' });

  const entity = store.findEntities({ ...base, limit: 10 })[0];
  assert.deepEqual(entity.aliases, ['阿林']);
  assert.deepEqual(entity.attrs, { age: 30 });
  store.close();
});

test('entity: a refresh with a new alias adds it instead of replacing', () => {
  const store = openSqlite(':memory:');
  store.putEntity({ ...base, type: 'person', name: '小林', aliases: ['阿林'] });
  store.putEntity({ ...base, type: 'person', name: '小林', aliases: ['小林同学', '阿林'] });

  const entity = store.findEntities({ ...base, limit: 10 })[0];
  assert.deepEqual(entity.aliases, ['阿林', '小林同学']);
  store.close();
});

test('entity: attrs merge, new keys win', () => {
  const store = openSqlite(':memory:');
  store.putEntity({ ...base, type: 'person', name: '小林', attrs: { age: 30, city: '杭州' } });
  store.putEntity({ ...base, type: 'person', name: '小林', attrs: { city: '上海' } });

  const entity = store.findEntities({ ...base, limit: 10 })[0];
  assert.deepEqual(entity.attrs, { age: 30, city: '上海' });
  store.close();
});

test('entity: the alias still resolves after a refresh', () => {
  const store = openSqlite(':memory:');
  const entity = store.putEntity({ ...base, type: 'person', name: '小林', aliases: ['阿林'] });
  store.putFact({
    ...base,
    statement: '阿林在十月换了工作',
    typeName: '事件',
    holder: 'world',
    slots: [{ slot: '关于', value: { kind: 'entity', entityId: entity.id } }],
  });
  store.putEntity({ ...base, type: 'person', name: '小林' });

  assert.equal(store.latestAbout('s1', 'u1', '阿林').length, 1);
  store.close();
});
