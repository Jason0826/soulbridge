import { readFileSync, writeFileSync } from 'node:fs';
const path = 'packages/core/src/sqlite.ts';
let text = readFileSync(path, 'utf8');
const before = text;

text = text.replace('export const SCHEMA_VERSION = 8;', 'export const SCHEMA_VERSION = 9;');
text = text.replace(
  '  at_end         INTEGER,',
  "  at_end         INTEGER,\n  at_precision   TEXT NOT NULL DEFAULT 'unknown',",
);
text = text.replace(
  '    atEnd: row.at_end === null ? undefined : Number(row.at_end),',
  "    atEnd: row.at_end === null ? undefined : Number(row.at_end),\n    atPrecision: (row.at_precision ?? 'unknown') as Fact['atPrecision'],",
);
text = text.replace(
  'if (version < 8) upgradeToV8(db);',
  'if (version < 8) upgradeToV8(db);\n  if (version < 9) upgradeToV9(db);',
);
text = text.replace(
  'export function upgradeToV8(db: DatabaseSync): void {',
  [
    'export function upgradeToV9(db: DatabaseSync): void {',
    '  // Time became locatability (ADR 0032): a fact may be known to exist without a',
    '  // date, and that is a value — unknown — not a reason to discard it.',
    "  ensureColumn(db, 'facts', 'at_precision', \"TEXT NOT NULL DEFAULT 'unknown'\");",
    '}',
    '',
    'export function upgradeToV8(db: DatabaseSync): void {',
  ].join('\n'),
);

if (text === before) {
  console.log('no changes made');
} else {
  writeFileSync(path, text, 'utf8');
  console.log('updated sqlite.ts');
}
