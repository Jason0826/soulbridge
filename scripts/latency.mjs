/**
 * Model call latency, measured from the plugin log.
 *
 * The timeouts in the adapter should follow this distribution, not a guess: the first
 * version used 60s because it "felt right". This script exists so changing it again
 * is a decision with numbers attached.
 *
 *   node scripts/latency.mjs
 *   node scripts/latency.mjs --days 7
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const logFile = join(HOME, 'plugin.log');
const daysArg = process.argv.indexOf('--days');
const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 30;
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

const samples = [];
let failed = 0;
for (const line of readFileSync(logFile, 'utf8').split(/\r?\n/)) {
  if (!line.includes('llm probe: end')) continue;
  const stamp = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(line);
  if (stamp && Date.parse(stamp[1]) < cutoff) continue;
  const ms = /ms=(\d+)/.exec(line);
  if (!ms) continue;
  if (line.includes('end fail')) failed += 1;
  else samples.push(Number(ms[1]));
}

if (samples.length === 0) {
  console.log('no calls in range');
  process.exit(0);
}
samples.sort((a, b) => a - b);
const at = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
const over = (ms) => samples.filter((value) => value > ms).length;

console.log(`window: ${days} day(s) · calls: ${samples.length} · failed: ${failed}`);
console.log(`p50 ${at(0.5)}ms`);
console.log(`p90 ${at(0.9)}ms`);
console.log(`p95 ${at(0.95)}ms`);
console.log(`p99 ${at(0.99)}ms`);
console.log(`max ${samples[samples.length - 1]}ms`);
console.log(`over 30s: ${over(30_000)} · over 60s: ${over(60_000)} · over 90s: ${over(90_000)}`);
console.log(`suggested call timeout: ${Math.max(2 * at(0.99), 30_000)}ms (2x p99, floor 30s)`);
