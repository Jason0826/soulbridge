export type { AffectAnalyzer } from './port.ts';
export {
  analyzeAffect,
  lexiconAnalyzer,
  emptyAffect,
  AffectBudgetError,
  normalizeForAffect,
  tokenizeForAffect,
  MAX_INPUT_CHARS,
} from './analyze.ts';
export type { AnalyzeOptions } from './analyze.ts';
export { SEED_LEXICON } from './seed-lexicon.ts';
export { validateLexicon, DEGREE_DELTA, NEGATORS, ABSTAIN_TERMS } from './lexicon.ts';
export type { Lexicon, LexiconEntry, DegreeWords } from './lexicon.ts';
export { DIRECTIVE_CATALOG, selectDirectives } from './directives.ts';
export type { Directive, DirectiveId } from './directives.ts';
