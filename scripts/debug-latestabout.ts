import { openSqlite } from '../packages/core/src/sqlite.ts';
import { Soul } from '../packages/core/src/index.ts';
import { bm25, buildCorpusStats, tokenize } from '../packages/core/src/scoring.ts';

const store = openSqlite(':memory:');
const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
const a = store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: 'a', seenAt: 1 });
const now = Date.parse('2026-11-02T00:00:00Z');
const day = 86_400_000;
for (const [id, daysAgo] of [['practiced', 30], ['fresh', 30]] as const) {
  store.putFact({
    soulId: 's1', userId: 'u1', id, statement: 'a搬了家', at: now - daysAgo * day,
    slots: [{ slot: '对象', value: { kind: 'entity', entityId: a.id } }],
  });
}
for (let i = 0; i < 20; i += 1) store.recordRecalls(['practiced'], now);

for (const id of ['practiced', 'fresh']) {
  const fact = store.fact(id);
  console.log(id, 'recallCount=', fact?.recallCount, 'at=', fact?.at);
}
const facts = store.latestAbout('s1', 'u1', 'a', { limit: 10, now });
console.log('raw order:', facts.map((f) => f.id));
const queryTokens = tokenize('a搬家');
const stats = buildCorpusStats(facts.map((f) => tokenize(f.statement)));
for (const f of facts) {
  const rel = bm25(queryTokens, tokenize(f.statement), stats);
  const age = Math.max(0, (now - (f.at ?? f.createdAt)) / day);
  const decay = 1 / Math.sqrt(1 + age);
  const practice = 1 + 0.2 * Math.log(1 + f.recallCount);
  console.log(f.id, 'rel=', rel.toFixed(3), 'decay=', decay.toFixed(3), 'practice=', practice.toFixed(3), 'score=', (rel * decay * practice).toFixed(4));
}
console.log('ranked:', soul.latestAbout('a', { query: 'a搬家', limit: 2 }).map((f) => f.id));
store.close();
