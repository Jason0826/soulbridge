/**
 * Does a rule fire only when its situation applies? (ADR 0033 acceptance #2)
 *
 * Runs the real rules from the live store against sample messages with the same
 * matcher the plugin uses, so "no match → nothing injected" is checked against data
 * rather than asserted about code.
 *
 *   node scripts/check-rules.mjs
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openSqlite } from '../packages/core/src/sqlite.ts';
import { Soul } from '../packages/core/src/index.ts';
import { selectRules } from '../packages/core/src/rules.ts';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const store = openSqlite(join(HOME, 'soul.db'));
const soul = new Soul({ store, soulId: 'xiaoling', userId: 'local' });

const rules = soul.rules();
console.log(`rules with a usable trigger: ${rules.length}\n`);

const cases = [
  ['今天天气不错', {}],
  ['你觉得这个想法怎么样', {}],
  ['把 package.json 的版本号改一下', {}],
  ['排查一下这个报错，先保存原始输出', {}],
  ['聊聊这本书里的人物关系', {}],
];

for (const [text, state] of cases) {
  const fired = selectRules(rules, text, state, 5);
  console.log(`"${text}"`);
  console.log(`  fired: ${fired.length === 0 ? '（无）' : fired.map((rule) => rule.id).join(', ')}`);
  for (const rule of fired) console.log(`    - ${rule.statement.slice(0, 50)}`);
}
store.close();
