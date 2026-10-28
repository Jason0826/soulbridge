import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { buildContext, AFFECT_WINDOW_MS } from '../src/context.ts';
import { PROTOCOL_VERSION } from '../src/types.ts';
import type { AffectSignal, Memory } from '../src/types.ts';

const NOW = Date.parse('2026-10-28T02:00:00Z');

function signal(overrides: Partial<AffectSignal> = {}): AffectSignal {
  return {
    analyzer: 'lexicon',
    hits: [
      { term: '难过', category: 'sadness', intensity: 8, polarity: 'negative', negated: false, position: 0 },
    ],
    dominant: 'sadness',
    intensity: 8,
    valence: -1,
    arousal: 0.9,
    features: { fillers: 0, hedges: 0, vague: 0, tokens: 12, density: 1 },
    confidence: 0.9,
    abstain: false,
    ...overrides,
  };
}

function memory(id: string): Memory {
  return {
    id,
    soulId: 'xiaoling',
    userId: 'u1',
    type: 'fact',
    content: `记忆 ${id}`,
    importance: 6,
    vividness: 0.8,
    recallCount: 0,
    status: 'active',
    visibility: 'private',
    keywords: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test('T12 协议版本：0.2', () => {
  assert.equal(PROTOCOL_VERSION, '0.2');
});

test('T7 注入：高置信负面情绪会注入，且预算不被突破', () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW - 86_400_000 });
  store.put(memory('m1'));
  store.saveAffect('xiaoling', 'u1', signal(), NOW);

  const result = buildContext(store, { soulId: 'xiaoling', userId: 'u1', maxChars: 1200 }, NOW);
  assert.match(result.text, /<affect confidence="0.90"/);
  assert.ok(result.chars <= 1200);
  assert.ok(!result.text.includes('…'));
  assert.deepEqual(result.affect?.directives, ['negative_high']);
  store.close();
});

test('T7 预算太小：情绪段整段丢弃，不做半截', () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });
  store.saveAffect('xiaoling', 'u1', signal(), NOW);

  const result = buildContext(store, { soulId: 'xiaoling', userId: 'u1', maxChars: 120 }, NOW);
  assert.ok(!result.text.includes('<affect'), '放不下就不注入');
  assert.equal(result.affect, undefined);
  store.close();
});

test('注入门槛：置信度不足不注入', () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });
  store.saveAffect('xiaoling', 'u1', signal({ confidence: 0.55 }), NOW);
  const result = buildContext(store, { soulId: 'xiaoling', userId: 'u1' }, NOW);
  assert.ok(!result.text.includes('<affect'));
  store.close();
});

test('过期采样不注入（超过窗口）', () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });
  store.saveAffect('xiaoling', 'u1', signal(), NOW - AFFECT_WINDOW_MS - 60_000);
  const result = buildContext(store, { soulId: 'xiaoling', userId: 'u1' }, NOW);
  assert.ok(!result.text.includes('<affect'));
  store.close();
});

test('T10 不桥接：情绪六维与 affect 无关', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soulbridge-nobridge-'));
  const loud = openSqlite(join(dir, 'a.db'));
  const plain = openSqlite(join(dir, 'b.db'));

  const angry = new Soul({
    store: loud,
    soulId: 'xiaoling',
    userId: 'u1',
    analyzer: { id: 'fake', analyze: () => signal({ intensity: 9, valence: -1, confidence: 1 }) },
  });
  const calm = new Soul({ store: plain, soulId: 'xiaoling', userId: 'u1' });

  const a = await angry.observe({ role: 'user', content: '继续' });
  const b = await calm.observe({ role: 'user', content: '继续' });

  assert.deepEqual(a.emotion, b.emotion, '情绪不能被 affect 改写');
  assert.equal(loud.emotion('xiaoling', 'u1').tension, plain.emotion('xiaoling', 'u1').tension);
  loud.close();
  plain.close();
  rmSync(dir, { recursive: true, force: true });
});

test('observe 降级：分析器抛错时退化为规则，不阻塞', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({
    store,
    soulId: 'xiaoling',
    userId: 'u1',
    analyzer: {
      id: 'broken',
      analyze: () => {
        throw new Error('endpoint down');
      },
    },
  });
  const result = await soul.observe({ role: 'user', content: '我不开心' });
  assert.equal(result.affect.analyzer, 'lexicon');
  assert.equal(result.affect.dominant, 'joy');
  store.close();
});

test('适配层：track=false 预览上下文不增加召回次数', () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });
  store.put(memory('m1'));

  const preview = buildContext(store, { soulId: 'xiaoling', userId: 'u1', track: false }, NOW);
  const afterPreview = store.query({ soulId: 'xiaoling', userId: 'u1' })[0];
  assert.equal(preview.used.length, 1);
  assert.equal(afterPreview.recallCount, 0, '预览不应计入召回');

  buildContext(store, { soulId: 'xiaoling', userId: 'u1' }, NOW);
  const afterReal = store.query({ soulId: 'xiaoling', userId: 'u1' })[0];
  assert.equal(afterReal.recallCount, 1, '默认仍然计入召回');
  store.close();
});

test('T26 导出/导入：round-trip 且重复导入幂等', () => {
  const source = openSqlite(':memory:');
  source.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });
  source.put(memory('m1'));
  source.put(memory('m2'));
  source.saveAffect('xiaoling', 'u1', signal(), NOW);

  const lines: string[] = [];
  for (const m of source.query({ soulId: 'xiaoling', userId: 'u1' })) {
    lines.push(JSON.stringify({ type: 'memory', memory: m }));
  }
  const [sample] = source.recentAffect('xiaoling', 'u1', 0);
  lines.push(JSON.stringify({ type: 'affect', at: NOW, signal: { ...sample, at: NOW } }));

  const target = openSqlite(':memory:');
  target.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });
  const importOnce = () => {
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type === 'memory') target.put(record.memory as Memory);
      else if (record.type === 'affect') target.saveAffect('xiaoling', 'u1', record.signal as AffectSignal, Number(record.at));
    }
  };

  importOnce();
  importOnce();

  assert.equal(target.count('xiaoling', 'u1'), 2, '记忆按 id 去重');
  assert.equal(target.recentAffect('xiaoling', 'u1', 0).length, 1, '采样按 (at, analyzer) 去重');
  source.close();
  target.close();
});

test('策略/认知条目不会被 observe 覆盖（协议约束）', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  const strategy = { ...memory('s1'), type: 'strategy' as const, content: '以后提交前先跑测试' };
  store.put(strategy);
  await soul.observe({ role: 'user', content: '继续' });
  const kept = store.query({ soulId: 'xiaoling', userId: 'u1' }).find((m) => m.id === 's1');
  assert.equal(kept?.content, '以后提交前先跑测试');
  store.close();
});
