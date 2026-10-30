/**
 * 纠正检测黄金集（2026-10-30 人工标注）。
 *
 * 来源：一次真实会话里的 19 条用户发言，标签由用户逐条确认。
 * 分组不是为了好看，是为了让指标不被污染：
 *   - clear     ：明确纠正 / 明确不是纠正 —— 主指标只在这里算
 *   - ambiguous ：疑似（求证式否定、元层面质疑）—— 单独统计，抓到了算加分，抓不到不扣分
 *
 * 为什么要有这一集：旧判定是一个 7 短语正则，在 clear-yes 上召回为 0。
 * 没有这把尺子，任何"改好了"的说法都无法验证。
 */
export type CorrectionLabel = 'yes' | 'no';
export type CorrectionBucket = 'clear-yes' | 'clear-no' | 'ambiguous';

export interface CorrectionCase {
  id: string;
  /** 用户原话，不做任何改写——改写会让 golden set 失真 */
  text: string;
  label: CorrectionLabel;
  bucket: CorrectionBucket;
  /** 人读的标注理由 */
  note: string;
}

export const CORRECTION_CASES: CorrectionCase[] = [
  // ---------- clear-yes：明确纠正 ----------
  {
    id: 'deepinfer-not-rl',
    text: '我想的是deepinfer的做法',
    label: 'yes',
    bucket: 'clear-yes',
    note: '把"滑动窗口有界重放"从我理解的 RL replay 纠正为 DeepInfer 的 SWA 重放；无一字否定词',
  },
  {
    id: 'repeat-mistake',
    text: '这算不算你重复犯了错',
    label: 'yes',
    bucket: 'clear-yes',
    note: '归因式质疑：指出我重复了上次的失败模式',
  },
  {
    id: 'steering-is-personal',
    text: '这些steering不也是个人经验吗？为什么不能写进soulbridge？好的经验应该可以保持可迁移性吧',
    label: 'yes',
    bucket: 'clear-yes',
    note: '反驳我上一轮的结论（"项目约定该放仓库"）',
  },
  {
    id: 'thought-is-portable',
    text: '那这个思想是经验，可迁移的哇，很多时候，我觉得更宝贵的是思想，如何思考才是核心，落地只是实施的问题',
    label: 'yes',
    bucket: 'clear-yes',
    note: '纠正我"脚本不可迁移 ⇒ 经验也不可迁移"的推论',
  },
  {
    id: 'work-dialogue-is-usage',
    text: '我觉得有问题，聊项目设计也是日常使用啊，从对话中可以学习到我的风格，我思考问题的角度什么的，不能狭隘的理解了解我就一定是生活向的',
    label: 'yes',
    bucket: 'clear-yes',
    note: '明确否定我的判断并给出替代框架',
  },
  {
    id: 'why-corrections-zero',
    text: '另外，我明明纠正过你，为什么correction还是0',
    label: 'yes',
    bucket: 'clear-yes',
    note: '元纠正：指出纠正检测本身失效',
  },

  // ---------- clear-no：明确不是纠正 ----------
  { id: 'who-are-you', text: 'hello，你是谁', label: 'no', bucket: 'clear-no', note: '开场' },
  {
    id: 'what-are-we-doing',
    text: '我们正在做的事情你知道是什么吗',
    label: 'no',
    bucket: 'clear-no',
    note: '考察记忆，不是纠正',
  },
  { id: 'observe-first', text: '先观察吧', label: 'no', bucket: 'clear-no', note: '决定下一步' },
  {
    id: 'suggestion-good',
    text: '我觉得你给的建议不错，先聊聊吧',
    label: 'no',
    bucket: 'clear-no',
    note: '认可 + 推进',
  },
  {
    id: 'continue-design',
    text: '或许我们可以继续s1之后的设计，同时也是测试了，对吗',
    label: 'no',
    bucket: 'clear-no',
    note: '提议',
  },
  {
    id: 'formula-choice',
    text: '你认可这种公式吗？我们的设计可不可以采用这种公式，还是说自己再设计一套计算逻辑',
    label: 'no',
    bucket: 'clear-no',
    note: '征求意见，二选一是开放问题不是否定',
  },
  {
    id: 'bounded-replay-idea',
    text: '先写，我突然想到大模型底层算法里有个叫滑动窗口有界重放，是否对我们能有一些启发呢',
    label: 'no',
    bucket: 'clear-no',
    note: '补充想法',
  },
  {
    id: 're-survey-state',
    text: '核实梳理现在的状态，我们现在有了更好的理论支撑应该可以有更好的设计',
    label: 'no',
    bucket: 'clear-no',
    note: '要求执行，不是纠正',
  },
  {
    id: 'script-portable',
    text: '这个脚本是可跨工具复用的吗',
    label: 'no',
    bucket: 'clear-no',
    note: '提问',
  },
  {
    id: 'review-loop',
    text: '可以，我们是不是可以在不断的实践中去完善soulbridge的设计，比如加入需要的字段表征等，定时的review',
    label: 'no',
    bucket: 'clear-no',
    note: '提议机制',
  },
  {
    id: 'current-data',
    text: '看一下当然数据情况呢',
    label: 'no',
    bucket: 'clear-no',
    note: '要求看数据（原文"当然"为笔误，保留不改）',
  },

  // ---------- ambiguous：疑似 ----------
  {
    id: 'affect-not-done',
    text: '不过关于情绪似乎并没有做好对吗',
    label: 'no',
    bucket: 'ambiguous',
    note: '求证式否定：提出判断并求证，包在问句里的不同意',
  },
  {
    id: 'fields-or-redesign',
    text: '跑，问个问题，你是依赖当然已有的字段做的评估，还是你是根据我们需求结合理论支撑，重新设计的',
    label: 'no',
    bucket: 'ambiguous',
    note: '元层面质疑：问的是方法，隐含"你的做法可能有问题"',
  },
];

export const CLEAR_CASES = CORRECTION_CASES.filter((c) => c.bucket.startsWith('clear'));
export const AMBIGUOUS_CASES = CORRECTION_CASES.filter((c) => c.bucket === 'ambiguous');
export const CLEAR_YES = CORRECTION_CASES.filter((c) => c.bucket === 'clear-yes');
export const CLEAR_NO = CORRECTION_CASES.filter((c) => c.bucket === 'clear-no');

/**
 * 每条的"上一轮助手回复"，L2 结构判定的输入。
 *
 * 这些是**构造**的：真实对话里每轮都有上下文，但黄金集只保存了用户原话。
 * 取值来自我当时真实的说法，压缩成一句。用户原话一字未改，只有这里是我补的。
 */
export const PREVIOUS_REPLY: Record<string, string> = {
  'deepinfer-not-rl': '我按强化学习里的 experience replay 来理解"有界重放"。',
  'repeat-mistake': '我改完只验证了局部，没有做整体核对。',
  'steering-is-personal': '项目约定应放仓库的 steering 文件，soulbridge 不接管。',
  'thought-is-portable': '脚本不可迁移，所以经验也难以跨工具携带。',
  'work-dialogue-is-usage': '这 34 条消息里绝大多数是项目设计的记忆，不是关于你的记忆。',
  'why-corrections-zero': 'corrections 表一直是 0 行。',
  'who-are-you': '我是小灵，一个持续成长的伙伴。',
  'what-are-we-doing': '当前在 S1 观察期，只修 bug 不加功能。',
  'observe-first': '建议接下来继续观察，攒真实使用数据。',
  'suggestion-good': '建议先做 A，再决定 B。',
  'continue-design': 'S1 结束之后可以开始下一阶段的设计。',
  'formula-choice': '这类公式是心理学借来的骨架，常数需要自己标定。',
  'bounded-replay-idea': '评估 harness 的骨架写好了，可以开始实施。',
  're-survey-state': '下一步建议停手观察，别再产出文档。',
  'script-portable': '这个脚本与仓库结构是绑定的。',
  'review-loop': '接下来建议停手观察。',
  'current-data': '我先汇总一下当前的数据情况。',
  'affect-not-done': '情绪链路是通的，只是触发得少。',
  'fields-or-redesign': '我按现有字段做了评估，结论是三个分量几乎没有分辨率。',
};
