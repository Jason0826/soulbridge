#!/usr/bin/env node
/**
 * POC: LLM distillation vs rule extraction.
 *
 *   node scripts/poc-distill.mjs                                  # rule arm (offline)
 *   POC_LLM_URL=... POC_LLM_MODEL=... [POC_LLM_KEY=...] node scripts/poc-distill.mjs --llm
 *
 * The task both arms are scored on is the product question, not a toy:
 *   "given this user sentence, what single memory (if any) should be stored?"
 *
 * Labels are explicit per fixture (`expect: store | null`), so precision and
 * recall are mechanical. Quality of a stored memory is scored separately:
 * short (<= 40 chars), keeps a request marker, free of complaint markers, and
 * faithful (every bigram appears in the source, so nothing is invented).
 */
import { ruleExtract, llmExtractTurn } from '../dist/packages/core/src/reflect.js';

const DIRECTIVE = /(先|需要|要|必须|应该|请|别|不要|务必|记得|need to|should|must|please)/i;
const COMPLAINT = /(又|失败|啊|不能让我|气|烦|崩溃|挂了)/;
const SHORT_LIMIT = 40;

/** Real sentences from this project's conversation, labelled by hand. */
export const FIXTURES = [
  { id: 'f01', kind: 'complaint', expect: 'null', text: '你的重启脚本又失败了，有crash。。你调调好，每次不能让我手动fix啊' },
  { id: 'f02', kind: 'mixed', expect: 'store', text: '误判倒也谈不上，这些词你是要放到情景里面才有意义，每次有可能是抱怨，也有可能真的是策略，比如你每次在做改动之前，都需要让我解释说明，为什么、怎么做、会有什么影响' },
  { id: 'f03', kind: 'instruction', expect: 'store', text: '以后提交前先跑 make check，能省一轮 CI' },
  { id: 'f04', kind: 'preference', expect: 'store', text: '我习惯做事情要严谨，要考虑全面' },
  { id: 'f05', kind: 'discussion', expect: 'null', text: '理论上规则和模型各有优劣，具体要看召回率和维护成本' },
  { id: 'f06', kind: 'instruction', expect: 'store', text: '以后我们有什么想法先做最小验证，用数据结果说话，而不是推测' },
  { id: 'f07', kind: 'indirect', expect: 'store', text: '这个以后能不能注意一下，别每次都让我说一遍' },
  { id: 'f08', kind: 'english', expect: 'store', text: 'From now on you must run the tests before every commit' },
  { id: 'f09', kind: 'reordered', expect: 'store', text: '需要你每次改完都跑一遍测试，然后再提交' },
  { id: 'f10', kind: 'long', expect: 'store', text: '我觉得这个地方可以再想想，因为现在的实现有点绕，而且性能和可读性都要考虑，所以以后你改这块之前先跟我确认一下方案，再动手' },
  { id: 'f11', kind: 'sarcasm', expect: 'null', text: '真棒，又崩了，这是第五次了' },
  { id: 'f12', kind: 'statement', expect: 'store', text: '这个文件里存的是 schema 版本号，升级时要先备份' },
];

function bigrams(text) {
  const clean = text.replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < clean.length; i++) out.add(clean.slice(i, i + 2));
  return out;
}

function faithful(output, source) {
  const src = bigrams(source);
  for (const gram of bigrams(output)) if (!src.has(gram)) return false;
  return true;
}

function quality(output, source) {
  if (!output) return { short: false, directive: false, clean: false, faithful: false };
  return {
    short: output.length <= SHORT_LIMIT,
    directive: DIRECTIVE.test(output),
    clean: !COMPLAINT.test(output),
    faithful: faithful(output, source),
  };
}

/** Adapter for this POC: an OpenAI-compatible endpoint behind the core port. */
function endpointLlm() {
  const url = process.env.POC_LLM_URL;
  const model = process.env.POC_LLM_MODEL;
  if (!url || !model) return null;
  return async (prompt) => {
    const response = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.POC_LLM_KEY ? { authorization: `Bearer ${process.env.POC_LLM_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return payload.choices?.[0]?.message?.content ?? '';
  };
}

async function llmArm(text, llm) {
  try {
    const draft = await llmExtractTurn(text, llm);
    return draft ? draft.content : null;
  } catch {
    return null; // transport failure; the production path would fall back to rules
  }
}
function ruleArm(text) {
  const drafts = ruleExtract([{ role: 'user', content: text }]);
  return drafts.length > 0 ? drafts[0].content : null;
}

async function main() {
  const useLlm = process.argv.includes('--llm');
  const arms = useLlm ? ['rule', 'llm'] : ['rule'];
  const rows = [];
  const llm = useLlm ? endpointLlm() : null;
  if (useLlm && !llm) throw new Error('POC_LLM_URL / POC_LLM_MODEL not set');

  for (const fixture of FIXTURES) {
    const row = { fixture, rule: ruleArm(fixture.text), llm: null, error: null };
    if (useLlm) {
      try {
        row.llm = await llmArm(fixture.text, llm);
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error);
      }
    }
    rows.push(row);
  }

  console.log(`\nPOC distillation — ${FIXTURES.length} fixtures, arms: ${arms.join(', ')}\n`);
  console.log('| id | kind | expect | arm | stored | len | short | dir | clean | faithful |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');

  const stats = {};
  for (const arm of arms) stats[arm] = { tp: 0, fp: 0, fn: 0, short: 0, directive: 0, clean: 0, faithful: 0, kept: 0 };

  for (const row of rows) {
    for (const arm of arms) {
      const output = row[arm];
      const expected = row.fixture.expect;
      const stored = output !== null && output !== undefined;
      const s = quality(output, row.fixture.text);
      const t = stats[arm];
      if (stored && expected === 'store') t.tp += 1;
      if (stored && expected === 'null') t.fp += 1;
      if (!stored && expected === 'store') t.fn += 1;
      if (stored) {
        t.kept += 1;
        for (const key of ['short', 'directive', 'clean', 'faithful']) if (s[key]) t[key] += 1;
      }
      console.log(
        `| ${row.fixture.id} | ${row.fixture.kind} | ${expected} | ${arm} | ${output ?? (row.error ? `error:${row.error}` : 'null')} | ` +
          `${output ? output.length : 0} | ${s.short ? '✓' : '·'} | ${s.directive ? '✓' : '·'} | ${s.clean ? '✓' : '·'} | ${s.faithful ? '✓' : '·'} |`,
      );
    }
  }

  console.log('\n## Summary\n');
  for (const arm of arms) {
    const t = stats[arm];
    const precision = t.tp + t.fp > 0 ? t.tp / (t.tp + t.fp) : 1;
    const recall = t.tp + t.fn > 0 ? t.tp / (t.tp + t.fn) : 0;
    console.log(
      `${arm.padEnd(5)} store-decision P=${precision.toFixed(2)} R=${recall.toFixed(2)} (tp ${t.tp} fp ${t.fp} fn ${t.fn}) · ` +
        `kept ${t.kept} · short ${t.short}/${t.kept} · directive ${t.directive}/${t.kept} · ` +
        `clean ${t.clean}/${t.kept} · faithful ${t.faithful}/${t.kept}`,
    );
  }
  if (!useLlm) console.log('\n(llm arm skipped: set POC_LLM_URL/POC_LLM_MODEL and pass --llm)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
