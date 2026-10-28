/**
 * The analyzer port (ADR 0015).
 *
 * Rules are the default; a small model can be plugged in without touching
 * core. Async analyzers MUST be cancellable by timeout at the call site and
 * MUST be degradable to the lexicon analyzer.
 */
import type { AffectSignal } from '../types.ts';

export interface AffectAnalyzer {
  readonly id: string;
  analyze(text: string): AffectSignal | Promise<AffectSignal>;
}
