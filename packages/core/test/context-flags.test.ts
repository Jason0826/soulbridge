import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

function seed() {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.ensureSoul({ soulId: 's1', name: '小灵', createdAt: Date.now() });
  soul.rememberExplicit({ type: 'strategy', content: '改动前先解释为什么' });
  return { store, soul };
}

test('context: includeAnchors=false keeps the memories block out', () => {
  const { store, soul } = seed();
  const full = soul.context({ track: false });
  assert.match(full.text, /<memories>/);

  const without = soul.context({ track: false, includeAnchors: false });
  assert.doesNotMatch(without.text, /<memories>/, 'Soul.context must forward the new option');
  assert.match(without.text, /<soul /);
  store.close();
});

test('context: includeSoul/includeStyle=false yields the anchors alone', () => {
  const { store, soul } = seed();
  const anchors = soul.context({ track: false, includeSoul: false, includeStyle: false });
  assert.doesNotMatch(anchors.text, /<soul /);
  assert.doesNotMatch(anchors.text, /<style>/);
  assert.match(anchors.text, /<memories>/);
  store.close();
});
