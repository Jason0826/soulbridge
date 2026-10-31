import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, upgradeToV5 } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

test('putTurn: steps keep order, reasoning keeps size but not text', () => {
  const store = openSqlite(':memory:');
  store.putTurn({
    soulId: 's1',
    userId: 'u1',
    sessionId: 'sess-1',
    turnNo: 7,
    startedAt: 1000,
    endedAt: 9000,
    userText: '帮我看看这个 bug',
    status: 'closed',
    steps: [
      { idx: 0, kind: 'reasoning', text: '想了很多', at: 1100 },
      { idx: 1, kind: 'tool', toolName: 'pwsh', toolArgsChars: 120, ok: true, at: 2000 },
      { idx: 2, kind: 'text', text: '找到了，是空指针', at: 3000 },
    ],
  });

  const steps = store.stepsOf('tn_sess-1_7');
  assert.equal(steps.length, 3);
  assert.deepEqual(
    steps.map((s) => s.kind),
    ['reasoning', 'tool', 'text'],
    'steps come back in order',
  );
  assert.equal(steps[1].toolName, 'pwsh');
  assert.equal(steps[1].ok, true);

  const pairs = store.recallTurnPairs({ soulId: 's1', userId: 'u1', query: '', limit: 5 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].assistantText, '找到了，是空指针', 'text steps are what search and injection see');
  store.close();
});

test('recallTurnPairs: finds a turn by its text step', () => {
  const store = openSqlite(':memory:');
  store.putTurn({
    soulId: 's1',
    userId: 'u1',
    sessionId: 'sess-1',
    turnNo: 1,
    startedAt: 1000,
    userText: '周末去哪玩',
    steps: [{ idx: 0, kind: 'text', text: '可以去爬山，天气不错', at: 1100 }],
  });
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const found = soul.recallTurnPairs('爬山', 5);
  assert.equal(found.length, 1);
  assert.match(found[0].assistantText, /爬山/);
  store.close();
});

test('upgrade to v5: legacy turn_pairs become turns with one text step', () => {
  const file = `C:/Users/DELL/AppData/Local/Temp/soulbridge-v5-${process.pid}-${Date.now()}.db`;
  openSqlite(file).close(); // full v5 schema first

  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO turn_pairs VALUES ('tp_old','s1','u1','sess-old',3,500,'老的一轮','老的回答','{}',500)`);
  upgradeToV5(raw);
  const migrated = raw.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number };
  assert.equal(Number(migrated.n), 1, 'legacy row migrated');
  raw.close();

  const store = openSqlite(file);
  const pairs = store.recallTurnPairs({ soulId: 's1', userId: 'u1', query: '', limit: 5 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].userText, '老的一轮');
  assert.equal(pairs[0].assistantText, '老的回答');
  const steps = store.stepsOf('tp_old');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, 'text');
  store.close();
});