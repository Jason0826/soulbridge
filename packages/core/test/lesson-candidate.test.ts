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

  // A rule arrives as a candidate: it has no 触发 slot yet, so it cannot fire (0018 §九 3 B).
  assert.equal(rule.status, 'candidate', 'a rule is a candidate until its trigger exists');
  // A profile line is a description, not an instruction: it is in use on write.
  assert.equal(profile.status, 'active');
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
  // The classifier is what gives a rule its trigger and puts it in use.
  soul.markRule(rule.id, { trigger: '{"any":["门禁"]}' });
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

  // f_rule is demoted by v17 in the same open: it has no 触发 slot, so it could
  // never fire and is a candidate like the lessons (0018 §九 3 B). The v17 test
  // below covers the shape of that decision; this one pins that the chain runs.
  assert.deepEqual(statuses, [
    ['f_candidate_lesson', 'candidate'],
    ['f_legacy_lesson', 'candidate'],
    ['f_rule', 'candidate'],
  ]);
});

test('upgrade to v17: an active rule that cannot fire becomes a candidate, a usable one stays', () => {
  const file = join(tmpdir(), `soulbridge-v17-${process.pid}-${Date.now()}.db`);
  openSqlite(file).close();

  const raw = new DatabaseSync(file);
  const insert = raw.prepare(
    `INSERT INTO facts (id, soul_id, user_id, statement, holder, role, status, confidence, source, created_at)
     VALUES (?, 's1', 'u1', ?, 'world', 'rule', 'active', 1, 'told', 1)`,
  );
  const slot = raw.prepare(
    `INSERT INTO fact_slots (fact_id, slot, value_type, value_text) VALUES (?, '触发', 'text', ?)`,
  );
  // Three shapes the reader treats differently: absent, unparseable, usable.
  insert.run('f_no_trigger', '判断层的准入条件是证据不少于两条');
  insert.run('f_bad_trigger', '新会话开场先读交接');
  slot.run('f_bad_trigger', 'not json at all');
  insert.run('f_empty_trigger', '改 JSON 用 edit 工具');
  slot.run('f_empty_trigger', '{}');
  insert.run('f_good_trigger', '门禁用 exit code 判');
  slot.run('f_good_trigger', '{"any":["门禁"]}');
  raw.prepare("UPDATE schema_meta SET v = '16' WHERE k = 'schema_version'").run();
  raw.close();

  const store = openSqlite(file);
  const statuses = store
    .facts({ soulId: 's1', userId: 'u1', limit: 10 })
    .map((fact) => [fact.id, String(fact.status)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  // The rule layer reads what can fire; a demoted row is somebody's decision to make.
  const soul = new Soul({ store, ...base });
  const firing = soul.rules().map((rule) => rule.id);
  store.close();

  assert.deepEqual(statuses, [
    ['f_bad_trigger', 'candidate'],
    ['f_empty_trigger', 'candidate'],
    ['f_good_trigger', 'active'],
    ['f_no_trigger', 'candidate'],
  ]);
  assert.deepEqual(firing, ['f_good_trigger'], 'only a rule with a trigger is in the layer');
});

test('backlog: a rule candidate waits with the lessons instead of sitting in the rule layer', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, ...base });
  const lesson = soul.recordFact({ ...base, statement: '先看见红再修', role: 'lesson' });
  const rule = soul.recordFact({ ...base, statement: '用户认为 valid_until 等于事件发生时间', role: 'rule' });
  assert.equal(rule.status, 'candidate', 'a rule with no trigger is waiting, not in use');
  const backlog = soul.promotionBacklog().map((fact) => fact.id);
  assert.deepEqual(backlog.sort(), [lesson.id, rule.id].sort(), 'the queue takes candidates, whatever role');
  store.close();
});
