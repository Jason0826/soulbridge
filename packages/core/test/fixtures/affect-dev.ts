/**
 * Dev split — 40 cases. These may be looked at while tuning (ADR 0016).
 * The holdout split must stay untouched until acceptance.
 */
import type { AffectCase } from './types.ts';

export const DEV_CASES: AffectCase[] = [
  // explicit (10)
  { text: '我很开心', bucket: 'explicit', dominant: 'joy', polarity: 'positive', minIntensity: 6, maxIntensity: 6 },
  { text: '今天特别兴奋', bucket: 'explicit', dominant: 'joy', polarity: 'positive', minIntensity: 9, maxIntensity: 9 },
  { text: '有点难过', bucket: 'explicit', dominant: 'sadness', polarity: 'negative', minIntensity: 4, maxIntensity: 4 },
  { text: '非常焦虑', bucket: 'explicit', dominant: 'fear', polarity: 'negative', minIntensity: 9, maxIntensity: 9 },
  { text: '烦躁', bucket: 'explicit', dominant: 'anger', polarity: 'negative', minIntensity: 6, maxIntensity: 6 },
  { text: '我真生气', bucket: 'explicit', dominant: 'anger', polarity: 'negative', minIntensity: 5, maxIntensity: 5 },
  { text: '有点害怕', bucket: 'explicit', dominant: 'fear', polarity: 'negative', minIntensity: 4, maxIntensity: 4 },
  { text: '恶心', bucket: 'explicit', dominant: 'disgust', polarity: 'negative', minIntensity: 7, maxIntensity: 7 },
  { text: '震惊', bucket: 'explicit', dominant: 'surprise', polarity: 'neutral', minIntensity: 8, maxIntensity: 8 },
  { text: '我很快乐', bucket: 'explicit', dominant: 'joy', polarity: 'positive', minIntensity: 7, maxIntensity: 7 },

  // negation (7)
  { text: '我不开心', bucket: 'negation', polarity: 'negative', negated: true, minIntensity: 4, maxIntensity: 4 },
  { text: '我不太高兴', bucket: 'negation', polarity: 'negative', negated: true, minIntensity: 4, maxIntensity: 4 },
  { text: '不生气', bucket: 'negation', polarity: 'neutral', negated: true, minIntensity: 4, maxIntensity: 4 },
  { text: '别难过', bucket: 'negation', polarity: 'neutral', negated: true, minIntensity: 4, maxIntensity: 4 },
  { text: '我没生气', bucket: 'negation', polarity: 'neutral', negated: true, minIntensity: 4, maxIntensity: 4 },
  { text: '不是很开心', bucket: 'negation', polarity: 'negative', negated: true, minIntensity: 5, maxIntensity: 5 },
  { text: '不再喜欢', bucket: 'negation', polarity: 'negative', negated: true, minIntensity: 5, maxIntensity: 5 },

  // degree (6)
  { text: '有点开心', bucket: 'degree', dominant: 'joy', minIntensity: 4, maxIntensity: 4 },
  { text: '比较开心', bucket: 'degree', dominant: 'joy', minIntensity: 6, maxIntensity: 6 },
  { text: '非常开心', bucket: 'degree', dominant: 'joy', minIntensity: 7, maxIntensity: 7 },
  { text: '极度开心', bucket: 'degree', dominant: 'joy', minIntensity: 8, maxIntensity: 8 },
  { text: '稍微有点难过', bucket: 'degree', dominant: 'sadness', minIntensity: 4, maxIntensity: 4 },
  { text: '相当生气', bucket: 'degree', dominant: 'anger', minIntensity: 6, maxIntensity: 6 },

  // punctuation / repetition (3)
  { text: '崩溃！！！', bucket: 'punctuation', dominant: 'anger', minIntensity: 9, maxIntensity: 9 },
  { text: '恼火……', bucket: 'punctuation', dominant: 'anger', minIntensity: 8, maxIntensity: 8 },
  { text: '崩溃崩溃崩溃', bucket: 'punctuation', dominant: 'anger', minIntensity: 9, maxIntensity: 9 },

  // implicit withdrawal (4) — must abstain, never claim an emotion
  { text: '行吧', bucket: 'implicit', dominant: null, abstain: true, maxConfidence: 0.5 },
  { text: '随便', bucket: 'implicit', dominant: null, abstain: true, maxConfidence: 0.5 },
  { text: '算了', bucket: 'implicit', dominant: null, abstain: true, maxConfidence: 0.5 },
  { text: '你定吧', bucket: 'implicit', dominant: null, abstain: true, maxConfidence: 0.5 },

  // sarcasm (3) — no explicit emotion word; the rule engine must stay silent
  { text: '太好了，又崩了', bucket: 'sarcasm', dominant: null },
  { text: '真是绝了，又是我', bucket: 'sarcasm', dominant: null },
  { text: '真棒，第三次了', bucket: 'sarcasm', dominant: null },

  // neutral (7)
  { text: '今天天气不错', bucket: 'neutral', dominant: null },
  { text: '这个函数返回布尔值', bucket: 'neutral', dominant: null },
  { text: '帮我看下日志', bucket: 'neutral', dominant: null },
  { text: '把配置改成 JSON 格式', bucket: 'neutral', dominant: null },
  { text: '明天上午十点开会', bucket: 'neutral', dominant: null },
  { text: '文档在 docs 目录', bucket: 'neutral', dominant: null },
  { text: '提交一下代码', bucket: 'neutral', dominant: null },
];
