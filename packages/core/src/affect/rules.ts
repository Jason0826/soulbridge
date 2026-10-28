/**
 * Rule registry (ADR 0016).
 *
 * The budget is part of the design: eight rules, no exceptions. New cases are
 * not fixed by adding a ninth rule — that is the signal to move to the model
 * adapter instead. Every rule listed here must have a test and an ablation
 * number in spec/affect.v0.md.
 */
export interface RuleDescriptor {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

export const RULES: readonly RuleDescriptor[] = [
  { id: 'R1', name: 'lexicon-hit', summary: '字典命中给出类别与基础强度' },
  { id: 'R2', name: 'negation', summary: '前 3 个 token 内的否定词翻转极性/降强度' },
  { id: 'R3', name: 'degree', summary: '前 2 个 token 内的程度词调整强度' },
  { id: 'R4', name: 'punctuation', summary: '连续 !! ?? …… 提升 arousal' },
  { id: 'R5', name: 'repetition', summary: '重复字符提升强调与强度' },
  { id: 'R6', name: 'abstain', summary: '弃权短语标记为 abstain，置信度封顶 0.5，不注入' },
  { id: 'R7', name: 'code-fence', summary: '代码围栏与 shell 行跳过分析' },
  { id: 'R8', name: 'short-input', summary: '≤3 token 时置信度减半' },
] as const;

export const RULE_BUDGET = 8;
export const SEED_ENTRY_BUDGET = 120;
