/**
 * A lesson is a candidate until classification places it (brief 0018 §九 3 step A).
 *
 * The failure this pins down: when the model named `角色=lesson` itself, the commit
 * gate stored the row as `active` and skipped the classification queue entirely —
 * the lesson was injected as background text and never became a rule. Only the
 * `原则候选` flag (a second way of saying the same thing) reached the queue. Two
 * representations of one decision, one of them silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite } from '../src/sqlite.ts';
import { validateDraft } from '../src/extract.ts';
import { Soul } from '../src/index.ts';

const base = { soulId: 's1', userId: 'u1' };

test('write: an explicitly roled lesson is a candidate, exactly like 原则候选', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, ...base });
  const at = Date.parse('2026-11-07T10:00:00Z');
  const parsed = validateDraft(
    {
      operations: [
        {
          op: 'add',
          fact: {
            statement: '改动之前先把影响面说清楚',
            source: 'experienced',
            confidence: 0.9,
            at,
            role: 'lesson',
          },
        },
      ],
    },
    Date.now(),
    undefined,
  );
  const result = soul.commitDrafts(parsed.draft!, { turnId: 't1' });
  assert.equal(result.facts.length, 1);
  const [fact] = result.facts;
  assert.equal(fact.role, 'lesson');
  // Held, not injected: the classifier has not placed it yet.
  assert.equal(fact.status, 'candidate');
  assert.equal(soul.rules().length, 0, 'a candidate is not a rule before classification');
  store.close();
});

test('classification: a classified rule is active and fires; a profile line joins the profile layer', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, ...base });
  const rule = soul.recordFact({ ...base, statement: '改 JSON 用 edit 工具', role: 'rule' });
  const profile = soul.recordFact({ ...base, statement: '用户要机制不要 hope', role: 'profile' });

  // Both arrive as candidates: the classifier, not the writer, decides the layer.
  store.setFactStatus(rule.id, 'candidate');
  store.setFactStatus(profile.id, 'candidate');

  soul.markRule(rule.id, { trigger: '{"any":["json"]}', action: '用 edit 工具改 JSON' });
  assert.equal(store.fact(rule.id)?.status, 'active', 'a placed rule is in use');
  assert.deepEqual(soul.rules().map((item) => item.id), [rule.id]);
  assert.equal(soul.rules()[0].trigger.any?.[0], 'json');

  soul.markProfile(profile.id, { dimension: '工作方式' });
  assert.equal(store.fact(profile.id)?.status, 'active', 'a placed profile item is in use');
  assert.deepEqual(soul.profileItems().map((item) => item.id), [profile.id]);
  store.close();
});

test('rules: a rule derived from an old lesson still fires when newer facts pile up', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, ...base });
  const rule = soul.recordFact({
    ...base,
    statement: '门禁用 exit code 判，不用人读文本',
    role: 'rule',
    validFrom: Date.parse('2026-11-01T00:00:00Z'),
  });
  store.addSlots(rule.id, [{ slot: '触发', value: { kind: 'text', value: '{"any":["门禁"]}' } }]);
  // The classifier retags an older lesson while the store keeps growing: 600 newer
  // observations push the rule out of the newest-window the reader used to scan.
  for (let i = 0; i < 600; i += 1) {
    soul.recordFact({ ...base, statement: `更晚的观察 ${i}`, validFrom: Date.parse('2026-11-07T00:00:00Z') });
  }
  assert.deepEqual(soul.rules().map((item) => item.id), [rule.id], 'a rule is a rule, however old');
  store.close();
});

test('profile: a line derived from an old lesson reaches the profile layer and is injected', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, ...base });
  const line = soul.recordFact({
    ...base,
    statement: '用户要机制不要 hope',
    role: 'profile',
    validFrom: Date.parse('2026-11-01T00:00:00Z'),
  });
  for (let i = 0; i < 600; i += 1) {
    soul.recordFact({ ...base, statement: `更晚的观察 ${i}`, validFrom: Date.parse('2026-11-07T00:00:00Z') });
  }
  // Two readers, both used in production: the merge input and the per-turn injection.
  assert.deepEqual(soul.profileItems().map((item) => item.id), [line.id]);
  assert.deepEqual(soul.profile().map((item) => item.id), [line.id]);
  store.close();
});

test('upgrade to v16: lessons written before the fix stop being injected as anchors', () => {
  const file = join(tmpdir(), `soulbridge-v16-${process.pid}-${Date.now()}.db`);
  openSqlite(file).close();

  const raw = new DatabaseSync(file);
  const insert = raw.prepare(
    `INSERT INTO facts (id, soul_id, user_id, statement, holder, role, status, confidence, source, created_at)
     VALUES (?, 's1', 'u1', ?, 'world', ?, ?, 1, 'told', 1)`,
  );
  insert.run('f_legacy_lesson', '旧教训：先验证再动手', 'lesson', 'active');
  insert.run('f_rule', '规则：用 edit 改 JSON', 'rule', 'active');
  insert.run('f_candidate_lesson', '已是候选的教训', 'lesson', 'candidate');
  // Pin the version the rows were written under: reopening must run v16, not re-run
  // whatever version this checkout happens to be on.
  raw.prepare("UPDATE schema_meta SET v = '15' WHERE k = 'schema_version'").run();
  raw.close();

  // The real open path, not a direct migration call: "what the plugin sees after an
  // upgrade" is the behaviour that has to change.
  const store = openSqlite(file);
  const statuses = store
    .facts({ soulId: 's1', userId: 'u1', limit: 10 })
    .map((fact) => [fact.id, String(fact.status)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  store.close();

  assert.deepEqual(statuses, [
    ['f_candidate_lesson', 'candidate'],
    ['f_legacy_lesson', 'candidate'],
    ['f_rule', 'active'],
  ]);
});
