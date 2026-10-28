/**
 * Portable transcript ingestion (ADR 0023).
 *
 * Host session stores are private and change shape without notice (the DSH
 * store is a multi-frame zstd container whose later frames are not decodable
 * with a standard decompressor). Rather than reverse-engineering it, the
 * adapter contract is a plain JSONL file that any host can export.
 *
 * Accepted line shapes (first match wins):
 *   {"role":"user","content":"…"}
 *   {"type":"user","text":"…"}
 *   {"message":{"role":"user","content":"…"}}
 *   {"role":"user","content":[{"type":"text","text":"…"}]}
 *
 * Everything else (headers, tool calls, tool results, reasoning) is skipped.
 */
import type { Turn } from '../types.ts';

export interface TranscriptParseResult {
  turns: Turn[];
  skipped: number;
}

const MAX_TURNS = 5000;
const MAX_CONTENT = 20_000;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

function roleOf(record: Record<string, unknown>): 'user' | 'assistant' | null {
  const nested = record.message && typeof record.message === 'object'
    ? (record.message as Record<string, unknown>)
    : null;
  const role = record.role ?? nested?.role ?? record.type;

  if (role === 'user' || role === 'human') return 'user';
  if (role === 'assistant' || role === 'ai' || role === 'model') return 'assistant';
  return null;
}

export function parseTranscriptJsonl(text: string): TranscriptParseResult {
  const turns: Turn[] = [];
  let skipped = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      skipped += 1;
      continue;
    }

    const role = roleOf(record);
    if (!role) {
      skipped += 1;
      continue;
    }

    const nested = record.message && typeof record.message === 'object'
      ? (record.message as Record<string, unknown>)
      : null;
    const content = textOf(record.content ?? record.text ?? nested?.content).trim();
    if (!content) {
      skipped += 1;
      continue;
    }

    const at = typeof record.at === 'number' ? record.at : undefined;
    const last = turns.at(-1);
    if (last && last.role === role && last.content === content) continue;

    turns.push({ role, content: content.slice(0, MAX_CONTENT), ...(at === undefined ? {} : { at }) });
    if (turns.length >= MAX_TURNS) break;
  }

  return { turns, skipped };
}
