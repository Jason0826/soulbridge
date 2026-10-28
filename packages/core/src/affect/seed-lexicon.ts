/**
 * Seed lexicon, written for this project (MIT).
 *
 * Hard budget (ADR 0016): <= 120 emotion entries. Growing this list is not a
 * fix for a missing case; if the budget is exhausted, the next step is the
 * model adapter, not more words.
 *
 * Structure follows the DUTIR taxonomy (7 categories, intensity 1-9); no word
 * list from that resource is copied here (ADR 0013).
 */
import type { Lexicon } from './lexicon.ts';

export const SEED_LEXICON: Lexicon = {
  version: '1.0',
  lang: 'zh',
  entries: {
    // joy
    开心: { category: 'joy', intensity: 5, polarity: 'positive' },
    高兴: { category: 'joy', intensity: 5, polarity: 'positive' },
    快乐: { category: 'joy', intensity: 6, polarity: 'positive' },
    愉快: { category: 'joy', intensity: 6, polarity: 'positive' },
    欣喜: { category: 'joy', intensity: 7, polarity: 'positive' },
    兴奋: { category: 'joy', intensity: 8, polarity: 'positive' },
    雀跃: { category: 'joy', intensity: 8, polarity: 'positive' },
    满足: { category: 'joy', intensity: 6, polarity: 'positive' },
    欣慰: { category: 'joy', intensity: 6, polarity: 'positive' },
    骄傲: { category: 'joy', intensity: 7, polarity: 'positive' },
    自豪: { category: 'joy', intensity: 7, polarity: 'positive' },
    踏实: { category: 'joy', intensity: 6, polarity: 'positive' },
    安心: { category: 'joy', intensity: 5, polarity: 'positive' },
    释然: { category: 'joy', intensity: 6, polarity: 'positive' },
    轻松: { category: 'joy', intensity: 5, polarity: 'positive' },
    幸福: { category: 'joy', intensity: 8, polarity: 'positive' },
    喜欢: { category: 'joy', intensity: 6, polarity: 'positive' },
    热爱: { category: 'joy', intensity: 8, polarity: 'positive' },
    享受: { category: 'joy', intensity: 6, polarity: 'positive' },
    舒畅: { category: 'joy', intensity: 6, polarity: 'positive' },
    痛快: { category: 'joy', intensity: 7, polarity: 'positive' },
    期待: { category: 'joy', intensity: 6, polarity: 'positive' },

    // anger
    生气: { category: 'anger', intensity: 5, polarity: 'negative' },
    愤怒: { category: 'anger', intensity: 8, polarity: 'negative' },
    恼火: { category: 'anger', intensity: 7, polarity: 'negative' },
    烦躁: { category: 'anger', intensity: 6, polarity: 'negative' },
    不爽: { category: 'anger', intensity: 5, polarity: 'negative' },
    窝火: { category: 'anger', intensity: 7, polarity: 'negative' },
    暴躁: { category: 'anger', intensity: 7, polarity: 'negative' },
    火大: { category: 'anger', intensity: 7, polarity: 'negative' },
    抓狂: { category: 'anger', intensity: 8, polarity: 'negative' },
    崩溃: { category: 'anger', intensity: 9, polarity: 'negative' },

    // sadness
    难过: { category: 'sadness', intensity: 5, polarity: 'negative' },
    伤心: { category: 'sadness', intensity: 6, polarity: 'negative' },
    失落: { category: 'sadness', intensity: 6, polarity: 'negative' },
    委屈: { category: 'sadness', intensity: 6, polarity: 'negative' },
    沮丧: { category: 'sadness', intensity: 6, polarity: 'negative' },
    低落: { category: 'sadness', intensity: 5, polarity: 'negative' },
    心疼: { category: 'sadness', intensity: 7, polarity: 'negative' },
    心累: { category: 'sadness', intensity: 7, polarity: 'negative' },
    疲惫: { category: 'sadness', intensity: 6, polarity: 'negative' },
    无力: { category: 'sadness', intensity: 6, polarity: 'negative' },
    绝望: { category: 'sadness', intensity: 9, polarity: 'negative' },
    郁闷: { category: 'sadness', intensity: 6, polarity: 'negative' },
    烦闷: { category: 'sadness', intensity: 6, polarity: 'negative' },
    压抑: { category: 'sadness', intensity: 7, polarity: 'negative' },
    憋屈: { category: 'sadness', intensity: 7, polarity: 'negative' },
    心酸: { category: 'sadness', intensity: 7, polarity: 'negative' },
    落寞: { category: 'sadness', intensity: 7, polarity: 'negative' },
    孤独: { category: 'sadness', intensity: 7, polarity: 'negative' },

    // fear
    害怕: { category: 'fear', intensity: 5, polarity: 'negative' },
    恐惧: { category: 'fear', intensity: 8, polarity: 'negative' },
    焦虑: { category: 'fear', intensity: 7, polarity: 'negative' },
    紧张: { category: 'fear', intensity: 6, polarity: 'negative' },
    担心: { category: 'fear', intensity: 6, polarity: 'negative' },
    不安: { category: 'fear', intensity: 6, polarity: 'negative' },
    慌张: { category: 'fear', intensity: 6, polarity: 'negative' },
    忐忑: { category: 'fear', intensity: 6, polarity: 'negative' },
    心慌: { category: 'fear', intensity: 6, polarity: 'negative' },
    畏惧: { category: 'fear', intensity: 7, polarity: 'negative' },
    惶恐: { category: 'fear', intensity: 7, polarity: 'negative' },

    // disgust
    讨厌: { category: 'disgust', intensity: 5, polarity: 'negative' },
    厌恶: { category: 'disgust', intensity: 7, polarity: 'negative' },
    反感: { category: 'disgust', intensity: 6, polarity: 'negative' },
    恶心: { category: 'disgust', intensity: 7, polarity: 'negative' },
    嫌弃: { category: 'disgust', intensity: 6, polarity: 'negative' },
    鄙视: { category: 'disgust', intensity: 7, polarity: 'negative' },
    受不了: { category: 'disgust', intensity: 6, polarity: 'negative' },
    排斥: { category: 'disgust', intensity: 6, polarity: 'negative' },

    // surprise
    惊讶: { category: 'surprise', intensity: 6, polarity: 'neutral' },
    震惊: { category: 'surprise', intensity: 8, polarity: 'neutral' },
    吃惊: { category: 'surprise', intensity: 6, polarity: 'neutral' },
    意外: { category: 'surprise', intensity: 5, polarity: 'neutral' },
    诧异: { category: 'surprise', intensity: 6, polarity: 'neutral' },
    目瞪口呆: { category: 'surprise', intensity: 8, polarity: 'neutral' },
  },

  fillers: [
    '嗯', '啊', '呃', '额', '那个', '就是', '然后', '这个',
    '对吧', '是吧', '反正', '基本上', '总之', '所以说', '其实', '说实话',
  ],

  hedges: [
    '可能', '也许', '大概', '应该', '我觉得', '好像', '似乎', '或许',
    '不一定', '差不多', '算是', '感觉', '可能吧', '不确定', '大概率', '有可能',
  ],

  vague: {
    开心: ['欣喜', '雀跃', '兴奋'],
    难过: ['心酸', '失落', '委屈'],
    害怕: ['恐惧', '焦虑', '不安'],
    生气: ['愤怒', '恼火', '气愤'],
    不舒服: ['压抑', '烦躁', '疲惫'],
    很好: ['出色', '精彩', '优秀'],
    不好: ['糟糕', '恶劣', '拙劣'],
    喜欢: ['热爱', '着迷', '钟爱'],
    讨厌: ['厌恶', '反感', '排斥'],
    问题: ['症结', '隐患', '瓶颈'],
    东西: ['物件', '成果', '产出'],
    方面: ['维度', '层面', '环节'],
    觉得: ['认为', '判断', '确信'],
    想: ['渴望', '期待', '向往'],
    做: ['执行', '落实', '推进'],
    看: ['观察', '审视'],
    说: ['表达', '阐述'],
    快: ['迅速', '飞速'],
    大: ['巨大', '庞大'],
    多: ['大量', '充裕'],
  },

  degree: {
    weak: ['有点', '稍微', '略微', '些许', '稍稍'],
    medium: ['比较', '挺', '相当', '蛮', '还算', '很'],
    strong: ['非常', '特别', '十分', '格外', '越来越'],
    extreme: ['极度', '极其', '无比', '超级', '太'],
  },
};
