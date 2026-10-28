/**
 * Holdout split — 20 cases (ADR 0016).
 *
 * Do not tune rules against these. If dev and holdout diverge by more than ten
 * points, the rule set is overfitting and the next step is the model adapter,
 * not another rule.
 */
import type { AffectCase } from './types.ts';

export const HOLDOUT_CASES: AffectCase[] = [
  // explicit (5)
  { text: '我很高兴', bucket: 'explicit', dominant: 'joy', polarity: 'positive', minIntensity: 6, maxIntensity: 6 },
  { text: '特别失落', bucket: 'explicit', dominant: 'sadness', polarity: 'negative', minIntensity: 8, maxIntensity: 8 },
  { text: '真讨厌', bucket: 'explicit', dominant: 'disgust', polarity: 'negative', minIntensity: 5, maxIntensity: 5 },
  { text: '有点紧张', bucket: 'explicit', dominant: 'fear', polarity: 'negative', minIntensity: 5, maxIntensity: 5 },
  { text: '极度震惊', bucket: 'explicit', dominant: 'surprise', polarity: 'neutral', minIntensity: 9, maxIntensity: 9 },

  // negation (4)
  { text: '我不快乐', bucket: 'negation', polarity: 'negative', negated: true, minIntensity: 5, maxIntensity: 5 },
  { text: '不讨厌', bucket: 'negation', polarity: 'neutral', negated: true, minIntensity: 4, maxIntensity: 4 },
  { text: '没那么害怕', bucket: 'negation', polarity: 'neutral', negated: true, minIntensity: 4, maxIntensity: 4 },
  { text: '别生气', bucket: 'negation', polarity: 'neutral', negated: true, minIntensity: 4, maxIntensity: 4 },

  // degree (3)
  { text: '稍微有点生气', bucket: 'degree', dominant: 'anger', minIntensity: 4, maxIntensity: 4 },
  { text: '十分开心', bucket: 'degree', dominant: 'joy', minIntensity: 7, maxIntensity: 7 },
  { text: '特别难过', bucket: 'degree', dominant: 'sadness', minIntensity: 7, maxIntensity: 7 },

  // punctuation (2)
  { text: '崩溃！！', bucket: 'punctuation', dominant: 'anger', minIntensity: 9, maxIntensity: 9 },
  { text: '恼火……', bucket: 'punctuation', dominant: 'anger', minIntensity: 8, maxIntensity: 8 },

  // implicit (3)
  { text: '都行', bucket: 'implicit', dominant: null, abstain: true, maxConfidence: 0.5 },
  { text: '无所谓', bucket: 'implicit', dominant: null, abstain: true, maxConfidence: 0.5 },
  { text: '看着办', bucket: 'implicit', dominant: null, abstain: true, maxConfidence: 0.5 },

  // sarcasm (2)
  { text: '好得很，又挂了', bucket: 'sarcasm', dominant: null },
  { text: '完美，第五次了', bucket: 'sarcasm', dominant: null },

  // neutral (1)
  { text: '重启服务', bucket: 'neutral', dominant: null },
];
