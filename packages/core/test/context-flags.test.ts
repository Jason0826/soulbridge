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

test('context: includeAffect=false keeps the affect block out of a stable prompt', () => {
  const { store, soul } = seed();
  // A confident, directive-producing sample. Without the flag it is injected.
  store.saveAffect(
    's1',
    'u1',
    {
      analyzer: 'model',
      hits: [{ word: '累', category: 'sadness', weight: 1 } as never],
      dominant: 'sadness',
      intensity: 7,
      valence: -0.6,
      arousal: 0.4,
      features: { fillers: 0, hedges: 0, vague: 0, tokens: 10, density: 1 },
      confidence: 0.9,
      abstain: false,
    },
    Date.now(),
  );
  const withAffect = soul.context({ track: false, includeAnchors: false });
  assert.match(withAffect.text, /<affect /, 'a confident sample is injected by default');

  const without = soul.context({ track: false, includeAnchors: false, includeAffect: false });
  assert.doesNotMatch(without.text, /<affect/, 'the section must be able to exclude affect');
  assert.equal(without.affect, undefined);
  store.close();
});
