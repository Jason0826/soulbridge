/**
 * Time normalisation: turn what someone said ("上周三", "下午") into a date the store can use.
 *
 * This is calendar arithmetic, not interpretation — the semantic part (did it happen? was the
 * expression vague?) stays with the model and with `valid_from_precision`. Rules that shape this file:
 *
 *   - the result is always a *day start* in local time; "下午" does not become 14:00;
 *   - ranges keep both ends (`at` / `atEnd`) and say `range`;
 *   - an impossible date ("2026-02-31") resolves to nothing instead of rolling over;
 *   - an expression we do not know stays `unknown` — the caller keeps `atText`, no invention.
 *
 * Weeks start on Monday (the convention the conversations use), and "下周" is next calendar
 * week, not seven days from today.
 */

import type { AtPrecision } from './config/status.ts';

export interface ResolvedTime {
  at?: number;
  atEnd?: number;
  precision: AtPrecision;
  /** What part of the phrase was understood, for the trace. */
  matched?: string;
}

const UNKNOWN: ResolvedTime = { precision: 'unknown' };

const DAY = 86_400_000;

function startOfDay(now: number, offsetDays = 0): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime() + offsetDays * DAY;
}

function startOfWeek(now: number, offsetWeeks = 0): number {
  const date = new Date(startOfDay(now));
  const weekday = (date.getDay() + 6) % 7; // Monday = 0 … Sunday = 6
  return startOfDay(date.getTime() - weekday * DAY + offsetWeeks * 7 * DAY);
}

function startOfMonth(now: number, offsetMonths = 0): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth() + offsetMonths, 1).getTime();
}

function startOfYear(now: number, offsetYears = 0): number {
  const date = new Date(now);
  return new Date(date.getFullYear() + offsetYears, 0, 1).getTime();
}

/** A real day on the calendar, or undefined — 2026-02-31 is not a day. */
export function parseIsoDay(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined;
  }
  return date.getTime();
}

const DAY_WORDS: Record<string, number> = { 今天: 0, 昨天: -1, 前天: -2, 明天: 1, 后天: 2 };
const WEEKDAY_WORDS: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
const WEEK_WORDS: Record<string, number> = { 上周: -1, 上星期: -1, 这周: 0, 本周: 0, 这个星期: 0, 这星期: 0, 下周: 1, 下星期: 1 };
const MONTH_WORDS: Record<string, number> = { 上个月: -1, 上月: -1, 这个月: 0, 本月: 0, 下个月: 1, 下月: 1 };
const YEAR_WORDS: Record<string, number> = { 去年: -1, 前年: -2, 今年: 0, 明年: 1 };
const PERIOD_WORDS = ['早上', '上午', '中午', '下午', '傍晚', '晚上', '夜里', '凌晨'];

/** Resolve one time expression against `now`. Unknown stays unknown. */
export function resolveRelativeTime(input: string, now = Date.now()): ResolvedTime {
  let text = (input ?? '').trim();
  if (!text) return UNKNOWN;

  // A period of day narrows nothing further: the day is the answer, the hour is not invented.
  let periodMatched: string | undefined;
  for (const word of PERIOD_WORDS) {
    if (text.startsWith(word)) {
      periodMatched = word;
      text = text.slice(word.length).trim();
      break;
    }
  }

  if (text) {
    const iso = parseIsoDay(text);
    if (iso !== undefined) return { at: iso, precision: 'day', matched: text };

    const day = DAY_WORDS[text];
    if (day !== undefined) return { at: startOfDay(now, day), precision: 'day', matched: text };

    const weekday = /^(上周|上星期|这周|本周|这个星期|这星期|下周|下星期)([一二三四五六日天])$/.exec(text);
    if (weekday) {
      const weekOffset = WEEK_WORDS[weekday[1]];
      const dayOffset = WEEKDAY_WORDS[weekday[2]];
      return { at: startOfWeek(now, weekOffset) + dayOffset * DAY, precision: 'day', matched: text };
    }

    if (/^(上周末|这周末|本周末|下周末)$/.test(text)) {
      const weekOffset = text.startsWith('上') ? -1 : text.startsWith('下') ? 1 : 0;
      return { at: startOfWeek(now, weekOffset) + 5 * DAY, precision: 'day', matched: text };
    }

    const week = WEEK_WORDS[text];
    if (week !== undefined) {
      const start = startOfWeek(now, week);
      return { at: start, atEnd: start + 7 * DAY, precision: 'range', matched: text };
    }

    const month = MONTH_WORDS[text];
    if (month !== undefined) {
      const start = startOfMonth(now, month);
      const end = startOfMonth(now, month + 1);
      return { at: start, atEnd: end, precision: 'range', matched: text };
    }

    const year = YEAR_WORDS[text];
    if (year !== undefined) {
      const start = startOfYear(now, year);
      return { at: start, atEnd: startOfYear(now, year + 1), precision: 'range', matched: text };
    }
  }

  if (periodMatched) {
    // "下午" alone: today is the only defensible reading, and the precision says "day".
    return { at: startOfDay(now), precision: 'day', matched: periodMatched };
  }

  return UNKNOWN;
}

/** The cue vocabulary of a question: what makes "上周发生了什么" a time question. */
export const TIME_CUE = /上周|上星期|昨天|前天|今天|那天|当时|上个月|月初|去年|\d{1,2}月\d{1,2}[日号]/;

/** A half-open span `[from, to)` a question asked about. */
export interface TimeWindow {
  from: number;
  to: number;
  /** The cue as written, for the trace and the block header. */
  cue: string;
}

/**
 * Resolve the first time cue in a question into a window (brief 0027 §八, reader 1).
 *
 * One expression per question: "昨天和上周" asks two things, and one window is this
 * primitive's unit. The cue is used as written — "上周三" resolves as the whole week
 * rather than risking a wrong day, because a wider window over-fetches while a
 * narrower one misses the answer. Cues no calendar can place ("那天", "月初") return
 * undefined: the caller keeps its fallback and the log says why.
 */
export function findWindow(text: string, now = Date.now()): TimeWindow | undefined {
  const match = TIME_CUE.exec(String(text ?? ''));
  if (!match) return undefined;
  const cue = match[0];
  const resolved = resolveRelativeTime(cue, now);
  if (resolved.at === undefined) return undefined;
  return { from: resolved.at, to: resolved.atEnd ?? resolved.at + DAY, cue };
}
