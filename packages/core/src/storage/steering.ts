/**
 * Steering-file import (ADR 0022).
 *
 * AGENTS.md / CLAUDE.md are good at *shared, reviewed* conventions. We do not
 * replace them; we read them once and turn the stable statements into
 * memories that can travel across tools.
 *
 * Parsing is deliberately conservative: bullets and short standalone lines
 * only. Code fences, tables, badges and links are skipped — importing a
 * hundred lines of YAML is worse than importing nothing.
 */
import type { MemoryType } from '../types.ts';

export interface SteeringDraft {
  text: string;
  type: MemoryType;
  importance: number;
  line: number;
}

export const STEERING_MAX_DRAFTS = 200;
const MIN_LENGTH = 8;
const MAX_LENGTH = 240;

/** Lowercase, strip punctuation and whitespace — for duplicate detection only. */
export function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .slice(0, 400);
}

function classify(text: string): { type: MemoryType; importance: number } {
  // Preference first: "我喜欢 X，不要 Y" is a trait, not a rule.
  if (/(我喜欢|偏好|习惯|倾向|prefer|i like)/i.test(text)) {
    return { type: 'trait', importance: 6 };
  }
  if (/(必须|禁止|不要|务必|一律|每次|never|must|always|shall)/i.test(text)) {
    return { type: 'strategy', importance: 8 };
  }
  if (/(项目|仓库|目录|技术栈|使用|基于|project|repo|stack)/i.test(text)) {
    return { type: 'fact', importance: 6 };
  }
  return { type: 'fact', importance: 5 };
}

function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

function clean(line: string): string {
  return line
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

function isSkippable(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^#{1,6}\s/.test(trimmed)) return true;
  if (/^\|/.test(trimmed)) return true;
  if (/^!\[/.test(trimmed)) return true;
  if (/^<[^>]+>$/.test(trimmed)) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^[-*_]{3,}$/.test(trimmed)) return true;
  return false;
}

/**
 * Extract memory candidates from a steering file.
 * Headings are dropped on purpose: they carry structure, not statements.
 */
export function parseSteering(text: string): SteeringDraft[] {
  const body = stripFences(text);
  const drafts: SteeringDraft[] = [];
  const seen = new Set<string>();

  body.split(/\r?\n/).forEach((raw, index) => {
    if (isSkippable(raw)) return;

    const bullet = /^\s*(?:[-*+]|\d+[.)]|\[[ xX]\])\s+/.test(raw);
    const content = clean(raw);
    // Bullets are intentional statements; free paragraphs need more substance.
    const minLength = bullet ? MIN_LENGTH : 12;
    if (content.length < minLength || content.length > MAX_LENGTH) return;
    // Paragraphs are noisier than bullets; require a statement-like shape.
    if (!bullet && !/[。.!！?？:]$/.test(content)) return;
    if (!bullet && !/[\u4e00-\u9fa5]/.test(content) && content.split(/\s+/).length < 4) return;

    const key = normalizeForDedupe(content);
    if (!key || seen.has(key)) return;
    seen.add(key);

    const { type, importance } = classify(content);
    drafts.push({ text: content, type, importance, line: index + 1 });
  });

  return drafts.slice(0, STEERING_MAX_DRAFTS);
}
