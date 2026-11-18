/**
 * 行为红测（quality ② 处置）：可写清单补「目的」类 + 决定归属 —— old/new 同后端对照。
 *
 * old 提示词 = 在渲染结果上逆向替换本次新增（md→generated 是纯文本嵌入，字节等价，
 * 零动文件）。模型 deepseek-flash（生产 config.model 同款，官方端点直连）temp0；
 * v6 教训：temp0 仍有 run-to-run 方差，每格 3 跑。
 *
 * 用法: node _scratch/purpose-red.mjs [runs]     默认 3
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { renderExtractionPrompt } from '../packages/core/src/prompts.ts';

const RUNS = Number(process.argv[2] ?? 3);
const NOW = Date.parse('2026-11-15T14:00:00+08:00');

const NEW_HEADING = '只在这五种情况下写事实：';
const OLD_HEADING = '只在这四种情况下写事实：';
const NEW_ATTRIBUTION = `2. 一个决定，以及做这个决定的理由；文本把决定或事件挂在哪个对象上（哪次发版、
   哪条线）就把归属写进陈述本身（“拍板删切片，属 0.0.127 发版”），别放进槽位
   ——槽位只放参与者；拆成互不相干的两条也归不到一起`;
const OLD_ATTRIBUTION = '2. 一个决定，以及做这个决定的理由';
const NEW_PURPOSE = `5. 一个目的：谁想达到什么（“我想装到电视上”“为的是孩子自己能解锁”）——
   目的跟人和事走，是“为什么”的证据；同一句话里带着对我的要求时，
   要求不写、目的照写`;

function toOld(prompt) {
  let out = prompt.replace(NEW_HEADING, OLD_HEADING);
  out = out.replace(NEW_ATTRIBUTION, OLD_ATTRIBUTION);
  const at = out.indexOf(NEW_PURPOSE);
  if (at < 0) throw new Error('purpose block not found in rendered prompt');
  out = out.slice(0, at) + out.slice(at + NEW_PURPOSE.length + 1); // +1 = trailing \n
  for (const gone of [NEW_HEADING, NEW_ATTRIBUTION, NEW_PURPOSE, '一个目的：']) {
    if (out.includes(gone)) throw new Error(`old prompt still contains: ${gone}`);
  }
  for (const kept of [OLD_HEADING, OLD_ATTRIBUTION, '只在这四种情况下写事实']) {
    if (!out.includes(kept)) throw new Error(`old prompt lost: ${kept}`);
  }
  return out;
}

// ---- 真实输入（生产同款） ----
const db = new DatabaseSync('C:/Users/DELL/.soulbridge/soul.db', { readOnly: true });
const unitTurns = db
  .prepare('SELECT turn_no, user_text, assistant_text, started_at FROM turns WHERE thread_id = ? ORDER BY turn_no')
  .all('th_mwhchza6_u6da')
  .map((r, index) => ({
    turnNo: index + 1,
    userText: String(r.user_text),
    assistantText: String(r.assistant_text ?? ''),
    startedAt: Number(r.started_at),
  }));
const s1turn = db.prepare('SELECT user_text, assistant_text FROM turns WHERE id = ?').get('tp_mwhtbh1o_xvee');
db.close();
if (unitTurns.length !== 10) throw new Error(`expected the 10-turn StudyOnTV unit, got ${unitTurns.length}`);
if (!s1turn) throw new Error('turn tp_mwhtbh1o_xvee missing');

const scenarios = [
  {
    // 生产实证：06:33 段抽出 10 轮里的所有事实，turn48「我想装电视上」0 条——目的类缺失。
    name: 'A purpose-real（10 轮真实段）',
    input: { turns: unitTurns, now: NOW },
    // 目的 = 陈述里带意图词（想/打算/目的是/为的是）且指向装/电视；裸「要」太宽
    // （“要求”类事实会误命中），不收。
    judge: (facts) => facts.some((line) => /(?:想|打算|目的是|为的是)/.test(line) && /(?:电视|装)/.test(line)),
  },
  {
    // 反例闸：纯请求不许因为「要求不写、目的照写」而放进来。
    name: 'B neg-request（纯请求）',
    input: { text: '你帮我把那个表重新跑一遍', now: NOW },
    judge: (facts) => facts.length === 0,
  },
  {
    // 反例闸：纯提问仍是对话动作。
    name: 'C neg-question（纯提问）',
    input: { text: 'adb是什么', now: NOW },
    judge: (facts) => facts.length === 0,
  },
  {
    // 生产实证：turn1372 段抽出「拍板删切片」与「0.0.127 发版」两条互不相干的事实。
    // 判定 = 归属在**陈述本身**（verify 只渲染 id | statement，槽位不可见——
    // 冒烟第一版模型把归属写进槽位，那一格是假绿，判定已收紧）。
    name: 'D attrib-real（turn1372 真实交换）',
    input: { text: String(s1turn.user_text), assistantText: String(s1turn.assistant_text), now: NOW },
    judge: (facts) =>
      facts.some((line) => {
        const statement = line.replace(/^\s*事实[:：]\s*/, '').split(' | ')[0];
        return statement.includes('0.0.127') && /切片|拍板/.test(statement);
      }),
  },
];

// ---- 模型调用（book-llm 先例：同 key、temp0、3 次重试上限） ----
const yaml = readFileSync('D:/DSH/home/.credentials.yaml', 'utf8');
const key = yaml.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m)?.[1];
if (!key) throw new Error('no DEEPSEEK_API_KEY');
async function callModel(prompt) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const body = { model: 'deepseek-flash', temperature: 0, messages: [{ role: 'user', content: prompt }] };
      let res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok && res.status === 400) {
        delete body.temperature; // 某些模型拒 temperature（book-llm 对 reasoner 的处理）
        res = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const payload = await res.json();
      const text = payload.choices?.[0]?.message?.content;
      if (!text) throw new Error('empty completion');
      return text;
    } catch (error) {
      last = error;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw last;
}

const factLines = (raw) => raw.split('\n').filter((line) => /^\s*事实[:：]/.test(line));

// ---- 主流程 ----
const results = [];
for (const scenario of scenarios) {
  const promptNew = renderExtractionPrompt(scenario.input);
  const promptOld = toOld(promptNew);
  for (const [version, prompt] of [['old', promptOld], ['new', promptNew]]) {
    for (let run = 1; run <= RUNS; run += 1) {
      const raw = await callModel(prompt);
      const facts = factLines(raw);
      const pass = scenario.judge(facts);
      results.push({ scenario: scenario.name, version, run, pass, facts });
      console.log(`\n=== ${scenario.name} | ${version} | run${run} | ${pass ? 'PASS' : 'FAIL'} | facts=${facts.length}`);
      for (const line of facts) console.log(`    ${line}`);
      if (facts.length === 0) console.log(`    （无事实）raw-head: ${raw.replace(/\n/g, ' ').slice(0, 120)}`);
    }
  }
}

console.log('\n===== 汇总 =====');
for (const scenario of scenarios) {
  for (const version of ['old', 'new']) {
    const cell = results.filter((r) => r.scenario === scenario.name && r.version === version);
    console.log(`${scenario.name.padEnd(34)} ${version}  ${cell.filter((r) => r.pass).length}/${cell.length}`);
  }
}
