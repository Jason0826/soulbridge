/** 一次性：把 state.md 里超过 7 天的 2026-11-09 条目（7 条）移入归档。
 *  行级手术，三道闸：条目数=7、每条尾随空行、移完后 state.md 无残留。 */
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = 'docs/state.md';
const archivePath = 'docs/state-archive/2026-11.md';

const lines = readFileSync(statePath, 'utf8').split('\n');
const hits = [];
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].startsWith('**2026-11-10 ')) hits.push(i);
}
if (hits.length !== 7) {
  console.error(`abort: expected 7 entries, found ${hits.length}`);
  process.exit(1);
}
for (const i of hits) {
  if ((lines[i + 1] ?? '').trim() !== '') {
    console.error(`abort: line ${i + 1} not followed by a blank line`);
    process.exit(1);
  }
}
const moved = [];
for (let k = hits.length - 1; k >= 0; k -= 1) {
  const i = hits[k];
  moved.unshift(lines[i]);
  lines.splice(i, 2); // 条目行 + 尾随空行
}
const out = lines.join('\n');
if (out.includes('**2026-11-10 ')) {
  console.error('abort: entries remain in state.md');
  process.exit(1);
}
writeFileSync(statePath, out, 'utf8');

const arch = readFileSync(archivePath, 'utf8');
const section =
  '\n## 日期条目（2026-11-10 · 7 条 · 2026-11-18 移入）\n\n' + moved.join('\n\n') + '\n';
writeFileSync(archivePath, arch.replace(/\n?$/, '\n') + section, 'utf8');

console.log(`moved ${moved.length} entries · state.md now ${lines.length} lines · archive +${section.split('\n').length} lines`);
