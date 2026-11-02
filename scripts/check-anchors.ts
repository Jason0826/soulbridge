import { join } from 'node:path';
import { homedir } from 'node:os';
import { openSqlite } from '../packages/core/src/sqlite.ts';
import { Soul } from '../packages/core/src/index.ts';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const store = openSqlite(join(HOME, 'soul.db'));
const soul = new Soul({ store, soulId: 'xiaoling', userId: 'local' });

console.log('memories rows:', store.query({ soulId: 'xiaoling', userId: 'local' }).length);

const ctx = soul.context({ track: false, includeSoul: false, includeStyle: false, types: ['strategy', 'fact', 'trait'], minImportance: 8, maxItems: 3 });
console.log('--- injected anchors ---');
console.log(ctx.text);
console.log('used:', ctx.used.join(','), 'dropped:', ctx.dropped);
store.close();
