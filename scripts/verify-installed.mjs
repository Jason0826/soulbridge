/**
 * Assert against the INSTALLED artifacts, not the source tree.
 *
 * Four times today a change looked done and was not: a duplicate guard, a
 * missing dist file, a cached pnpm copy, and an options object dropped by a
 * hand-written field list. Version numbers did not catch any of them; loading
 * the installed copy did.
 *
 * Usage: node --experimental-strip-types scripts/verify-installed.mjs [profileDir]
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const profile = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop');
const coreDir = join(profile, 'node_modules', 'soulbridge');
const pluginDir = join(profile, 'node_modules', 'dsh-plugin-soulbridge');
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function version(dir, label) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) throw new Error(`${label} not installed at ${dir}`);
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

const coreVersion = version(coreDir, 'core');
const pluginVersion = version(pluginDir, 'plugin');
console.log(`installed: core ${coreVersion} / plugin ${pluginVersion}`);

const coreEntry = join(coreDir, 'dist', 'packages', 'core', 'src', 'index.js');
const sqliteEntry = join(coreDir, 'dist', 'packages', 'core', 'src', 'sqlite.js');
check('core dist entry exists', () => {
  if (!existsSync(coreEntry)) throw new Error(`missing ${coreEntry}`);
  if (!existsSync(sqliteEntry)) throw new Error(`missing ${sqliteEntry}`);
});

const { openSqlite } = await import(pathToFileURL(sqliteEntry).href);
const { Soul } = await import(pathToFileURL(coreEntry).href);

// The live database, never opened: `openSqlite` runs migrations, so verifying the
// installed copy used to migrate production as a side effect. On 2026-11-07 that
// demoted the legacy lessons (v16) while the host was still running the old binary —
// the DB became newer than the process that owns it. A snapshot is enough for every
// check below, and a snapshot cannot be upgraded.
const liveDb = join(homedir(), '.soulbridge', 'soul.db');
const dbFile = join(tmpdir(), `soulbridge-verify-${process.pid}-${Date.now()}.db`);
let store;
try {
  const source = new DatabaseSync(liveDb, { readOnly: true });
  // VACUUM INTO takes a consistent snapshot including whatever is in the WAL.
  source.exec(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`);
  source.close();
  store = openSqlite(dbFile);
} catch (error) {
  console.log(`  FAIL  live database snapshot — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const soul = new Soul({ store, soulId: 'xiaoling', userId: 'local' });

check('section excludes anchors (includeAnchors:false)', () => {
  const { text } = soul.context({ track: false, includeAnchors: false });
  if (/<memories>/.test(text)) throw new Error('system prompt still carries the memories block');
  if (!/<soul /.test(text)) throw new Error('identity block missing');
  return `${text.length} chars`;
});

check('anchors can be fetched alone', () => {
  const { text } = soul.context({ track: false, includeSoul: false, includeStyle: false });
  if (/<soul |<style>/.test(text)) throw new Error('identity/style leaked into the anchors block');
  return `${(text.match(/^- \[/gm) ?? []).length} items`;
});

const promptsEntry = join(coreDir, 'dist', 'packages', 'core', 'src', 'prompts.js');
check('extraction prompt module exists', () => {
  if (!existsSync(promptsEntry)) throw new Error('prompts.js missing from dist');
});
const { renderExtractionPrompt } = await import(pathToFileURL(promptsEntry).href);
check('extraction prompt renders with the observation date', () => {
  const prompt = renderExtractionPrompt({ text: '测试', now: Date.now() });
  if (!prompt.includes('<observation-date>')) throw new Error('prompt lost its date anchor');
  if (!prompt.includes('<examples>')) throw new Error('prompt lost its examples');
  return `${prompt.length} chars`;
});

const pluginEntry = join(pluginDir, 'index.js');
await import(pathToFileURL(pluginEntry).href).then(
  (mod) => check('plugin loads and exports apply()', () => {
    if (typeof mod.apply !== 'function') throw new Error('apply is not a function');
  }),
  (error) => check('plugin loads and exports apply()', () => {
    throw error;
  }),
);

store.close();
try {
  rmSync(dbFile, { force: true });
} catch {
  /* a Windows handle can keep the snapshot alive; it is in tmp */
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall checks passed against the installed artifacts');
