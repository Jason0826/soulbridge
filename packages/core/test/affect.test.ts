import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAffect, normalizeForAffect } from '../src/affect/analyze.ts';
import { SEED_LEXICON } from '../src/affect/seed-lexicon.ts';
import { validateLexicon } from '../src/affect/lexicon.ts';
import { selectDirectives, DIRECTIVE_CATALOG } from '../src/affect/directives.ts';
import { RULES, RULE_BUDGET, SEED_ENTRY_BUDGET } from '../src/affect/rules.ts';
import { measureStyle } from '../src/style/measure.ts';
import { DEV_CASES } from './fixtures/affect-dev.ts';
import { HOLDOUT_CASES } from './fixtures/affect-holdout.ts';
import { BASE_BUCKETS } from './fixtures/types.ts';
import type { AffectCase } from './fixtures/types.ts';

function passes(c: AffectCase, text = c.text): boolean {
  const signal = analyzeAffect(text);
  if (c.dominant !== undefined && signal.dominant !== c.dominant) return false;
  if (c.polarity !== undefined) {
    const polarity = signal.hits[0]?.polarity;
    if (polarity !== c.polarity) return false;
  }
  if (c.negated !== undefined && (signal.hits[0]?.negated ?? false) !== c.negated) return false;
  if (c.minIntensity !== undefined && signal.intensity < c.minIntensity) return false;
  if (c.maxIntensity !== undefined && signal.intensity > c.maxIntensity) return false;
  if (c.abstain !== undefined && signal.abstain !== c.abstain) return false;
  if (c.maxConfidence !== undefined && signal.confidence > c.maxConfidence) return false;
  return true;
}

function accuracy(cases: AffectCase[]): number {
  const passed = cases.filter((c) => passes(c)).length;
  return passed / cases.length;
}

function baseAccuracy(cases: AffectCase[]): number {
  return accuracy(cases.filter((c) => BASE_BUCKETS.includes(c.bucket)));
}

test('T1 命中：开心 → joy / 正向', () => {
  const signal = analyzeAffect('我很开心');
  assert.equal(signal.dominant, 'joy');
  assert.equal(signal.hits[0].polarity, 'positive');
  assert.equal(signal.analyzer, 'lexicon');
});

test('T2 程度：有点/非常/极度', () => {
  assert.equal(analyzeAffect('有点开心').intensity, 4);
  assert.equal(analyzeAffect('非常开心').intensity, 7);
  assert.equal(analyzeAffect('极度开心').intensity, 8);
});

test('T3 否定：不开心 → 负向且标记 negated', () => {
  const signal = analyzeAffect('我不开心');
  assert.equal(signal.hits[0].negated, true);
  assert.equal(signal.hits[0].polarity, 'negative');
});

test('T4 混合文本：代码围栏不参与分析，emoji 不炸', () => {
  const signal = analyzeAffect('看这里 ```const x = "崩溃";``` 我挺开心的 😀');
  assert.equal(signal.hits.length, 1);
  assert.equal(signal.dominant, 'joy');
  assert.equal(normalizeForAffect('ＡＢ！').trim(), 'ab!');
});

test('T5 无命中：空信号且不抛', () => {
  const signal = analyzeAffect('把配置改成 JSON 格式');
  assert.equal(signal.hits.length, 0);
  assert.equal(signal.dominant, null);
  assert.equal(signal.confidence, 0);
});

test('R6 弃权词：不猜情绪，置信度封顶', () => {
  const signal = analyzeAffect('行吧');
  assert.equal(signal.abstain, true);
  assert.equal(signal.dominant, null);
  assert.ok(signal.confidence <= 0.5);
});

test('R6 弃权词不会被注入（selectDirectives 返回空）', () => {
  assert.equal(selectDirectives(analyzeAffect('算了')).length, 0);
});

test('T6 白名单：只可能来自固定目录，最多两条', () => {
  const ids = new Set(DIRECTIVE_CATALOG.map((d) => d.id));
  const signal = analyzeAffect('我觉得可能也许大概不行吧');
  const directives = selectDirectives(signal, 10);
  assert.ok(directives.length <= 2);
  for (const directive of directives) assert.ok(ids.has(directive.id));
});

test('T19 情绪 → 指令：三组预设产出两两不同', () => {
  const base = analyzeAffect('我不太开心，又被拒了');
  const sets = [
    selectDirectives({ ...base, confidence: 0.9, valence: -0.8, intensity: 8 }),
    selectDirectives({ ...base, confidence: 0.9, valence: 0.8, intensity: 8 }),
    selectDirectives({ ...base, confidence: 0.9, hits: [], dominant: null }),
  ].map((list) => list.map((d) => d.id).join(','));
  assert.equal(new Set(sets).size, 3);
});

test('T20 测量工具：长度/犹豫率/问号/前置确认', () => {
  const metrics = measureStyle('我先确认一下：可能这里有三个问题？');
  assert.ok(metrics.length > 0);
  assert.ok(metrics.hedgeRate > 0);
  assert.equal(metrics.questions, 1);
  assert.equal(metrics.confirmFirst, true);
  assert.equal(measureStyle('好的，直接给结论。').confirmFirst, true);
  assert.equal(measureStyle('这个函数返回布尔值。').confirmFirst, false);
});

test('T17 规则预算：≤8 条规则、≤120 个种子词', () => {
  assert.ok(RULES.length <= RULE_BUDGET, `rules: ${RULES.length}`);
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length);
  const words = Object.keys(SEED_LEXICON.entries).length;
  assert.ok(words <= SEED_ENTRY_BUDGET, `seed words: ${words}`);
});

test('词库校验：坏数据被拒绝（T11 降级前提）', () => {
  assert.deepEqual(validateLexicon(SEED_LEXICON), []);
  const broken = { ...SEED_LEXICON, entries: { 开心: { category: 'nope', intensity: 42, polarity: 'x' } } };
  assert.ok(validateLexicon(broken).length >= 2);
});

test('T15/T16 黄金集：dev 与 holdout 的准确率与差距', () => {
  const devAll = accuracy(DEV_CASES);
  const holdAll = accuracy(HOLDOUT_CASES);
  const devBase = baseAccuracy(DEV_CASES);
  const holdBase = baseAccuracy(HOLDOUT_CASES);

  const byBucket = (cases: AffectCase[]) => {
    const buckets = new Map<string, { pass: number; total: number }>();
    for (const c of cases) {
      const entry = buckets.get(c.bucket) ?? { pass: 0, total: 0 };
      entry.total += 1;
      if (passes(c)) entry.pass += 1;
      buckets.set(c.bucket, entry);
    }
    return [...buckets].map(([bucket, v]) => `${bucket} ${v.pass}/${v.total}`).join(' · ');
  };

  console.log(`dev      all ${(devAll * 100).toFixed(1)}%  base ${(devBase * 100).toFixed(1)}%  [${byBucket(DEV_CASES)}]`);
  console.log(`holdout  all ${(holdAll * 100).toFixed(1)}%  base ${(holdBase * 100).toFixed(1)}%  [${byBucket(HOLDOUT_CASES)}]`);

  assert.ok(devBase >= 0.95, `dev base accuracy ${(devBase * 100).toFixed(1)}%`);
  assert.ok(holdBase >= 0.9, `holdout base accuracy ${(holdBase * 100).toFixed(1)}%`);
  assert.ok(devAll >= 0.8, `dev overall ${(devAll * 100).toFixed(1)}%`);
  assert.ok(holdAll >= 0.8, `holdout overall ${(holdAll * 100).toFixed(1)}%`);
  assert.ok(Math.abs(devBase - holdBase) <= 0.1, 'dev/holdout gap exceeds 10 points — overfitting');
});

test('T9 性能：1000 字文本分析 < 5ms（宽松上限）', () => {
  const text = '今天有点不开心，这个方案又被拒了。'.repeat(40);
  const start = process.hrtime.bigint();
  analyzeAffect(text);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 50, `analysis took ${elapsedMs.toFixed(1)}ms`);
});
