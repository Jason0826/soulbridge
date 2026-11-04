/**
 * Promotion: which experiences may become a lesson (brief 0023, T1).
 *
 * The failure this prevents: every observation was promoted on its first occurrence,
 * so 61 rules came from 128 lessons and 84% of them never fired. The literature's
 * point is that an experience becomes a stable belief through reinstatement or
 * consequence, not on first mention — so the flag and the trigger are tested here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLineDraft, validateDraft } from '../src/extract.ts';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const base = { soulId: 's1', userId: 'u1' };

test('extraction: 原则候选=是 marks the fact, anything else leaves it unmarked', () => {
  const draft = validateDraft(
    {
      facts: [
        { statement: '用户要求改动前先说明影响', source: 'experienced', confidence: 0.9, principle: true },
        { statement: '用户今天改了 A 文件', source: 'experienced', confidence: 0.8 },
      ],
    },
    Date.now(),
    undefined,
  );
  assert.equal(draft.draft?.facts[0].principle, true);
  // Absent means no: a default-yes would promote every observation.
  assert.equal(draft.draft?.facts[1].principle, undefined);
});

test('extraction line: the keyed field is read from the table, not from the slot list', () => {
  type Line = { operations: Array<{ fact: { principle?: boolean; slots?: Array<{ slot: string }> } }> };
  const raw = '事实: 用户要求改动前先说明影响 | 要求 | | | experienced | 0.9 | 持有=用户 | 精度=unknown | 原则候选=是 | 对象=用户';
  const parsed = parseLineDraft(raw) as Line;
  const fact = parsed.operations[0].fact;
  assert.equal(fact.principle, true);
  const slots = (fact.slots ?? []).map((slot) => slot.slot);
  // It must not leak into the slot list as a stray slot named 原则候选.
  assert.deepEqual(slots, ['对象']);
  // 否 is the safe default, not a promotion.
  const no = parseLineDraft('事实: 用户今天改了文件 | 修改 | | | experienced | 0.8 | 持有=world | 精度=unknown | 原则候选=否') as Line;
  assert.equal(no.operations[0].fact.principle, undefined);
});

test('promotion: the commit gate writes the flag onto the fact it stores', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  // Operations, not the flat `facts` view: the commit gate iterates operations.
  // A date is what makes the row admissible at all ("no slots and no time" is skipped).
  const at = Date.parse('2026-11-02T10:00:00Z');
  const parsed = validateDraft(
    {
      operations: [
        {
          op: 'add',
          fact: {
            statement: '用户要求改动前先说明为什么和影响面再动手',
            source: 'experienced',
            confidence: 0.9,
            at,
            principle: true,
          },
        },
        {
          op: 'add',
          fact: {
            statement: '用户今天把配置文件的读取顺序调整了一下',
            source: 'experienced',
            confidence: 0.8,
            at,
          },
        },
      ],
    },
    Date.now(),
    undefined,
  );
  soul.commitDrafts(parsed.draft!, { turnId: 't1' });
  // The flag has to survive the gate: a parsed flag that never reaches the row is
  // the same as no flag, and the promotion rule reads the row.
  assert.deepEqual(
    soul.promotionCandidates('t1').map((fact) => fact.statement),
    ['用户要求改动前先说明为什么和影响面再动手'],
  );
  store.close();
});

test('promotion: only flagged lessons of a corrected turn are candidates', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const at = Date.parse('2026-11-02T10:00:00Z');
  store.putTurn({ ...base, id: 't1', sessionId: 'sess', turnNo: 1, startedAt: at, userText: '不对，应该先说影响再动手', steps: [] });
  store.putFact({ ...base, id: 'f_lesson', statement: '改动前先说明影响', sourceTurnId: 't1', validFrom: at, typeName: '要求', holder: 'world', role: 'lesson', status: 'candidate' });
  store.putFact({ ...base, id: 'f_plain', statement: '用户今天改了 A 文件', sourceTurnId: 't1', validFrom: at, typeName: '修改', holder: 'world' });
  store.putTurn({ ...base, id: 't2', sessionId: 'sess', turnNo: 2, startedAt: at + 1000, userText: '继续', steps: [] });
  store.putFact({ ...base, id: 'f_other', statement: '另一轮的判断', sourceTurnId: 't2', validFrom: at, typeName: '要求', holder: 'world', role: 'lesson', status: 'candidate' });

  // No correction yet: the turn is ordinary, so nothing is promoted.
  assert.equal(soul.wasCorrectedTurn('t1'), false);
  soul.recordCorrection({ userText: '不对，应该先说影响再动手', assistantText: '好的' });
  assert.equal(soul.wasCorrectedTurn('t1'), true);
  // A different turn is not the corrected one, even with the same lesson flag.
  assert.equal(soul.wasCorrectedTurn('t2'), false);

  assert.deepEqual(soul.promotionCandidates('t1').map((fact) => fact.id), ['f_lesson']);
  store.close();
});

test('commit: a JSON-shaped draft is not silently dropped by an empty operations array', () => {
  // validateDraft always returns operations (empty when the input had none), so
  // `draft.operations ?? facts` left the legacy facts unwritten — with no skipped
  // entry, no error and by='llm'. Facts written by the JSON fallback just vanished.
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const draft = validateDraft(
    {
      entities: [{ name: '小林', type: 'person' }],
      facts: [
        {
          statement: '小林在十月被裁员一次',
          source: 'told',
          confidence: 0.8,
          at: Date.now(),
          slots: [{ slot: '被裁员者', entity: '小林' }],
        },
      ],
    },
    Date.now(),
    undefined,
  );
  assert.deepEqual(draft.draft?.operations, []);
  const result = soul.commitDrafts(draft.draft!, { turnId: 't1' });
  assert.equal(result.facts.length, 1);
  assert.deepEqual(result.skipped, []);
  store.close();
});
