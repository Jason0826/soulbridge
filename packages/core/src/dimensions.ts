/**
 * The profile dimension vocabulary, declared once.
 *
 * A dimension is a noun we ship to two model stages and to the merge parser: the
 * classifier decides which lens a lesson belongs to, the merge decides which lens a
 * line belongs to, and the parser rejects anything else. Those three must agree, so
 * the names AND their admission criteria live here and nowhere else — prompts render
 * this, they do not retype it.
 *
 * The definitions are borrowed from measurement traditions on purpose:
 * 价值观 ← Schwartz; 人际关系 ← interpersonal circumplex (warmth × dominance);
 * 生活兴趣 ← RIASEC; 情绪 ← core affect. 边界 has no taxonomy — it quotes the words.
 * These are admission criteria for a sentence, not a personality theory.
 */

export const PROFILE_DIMENSIONS = [
  '价值观',
  '工作方式',
  '沟通偏好',
  '情绪',
  '人际关系',
  '生活兴趣',
  '边界',
] as const;

export type ProfileDimension = (typeof PROFILE_DIMENSIONS)[number];

/** What counts as a line in each dimension, and what does not. */
export const PROFILE_DIMENSION_DEFINITIONS: Record<ProfileDimension, string> = {
  价值观: '超越具体情境、值得追求的目标（Schwartz）。"想把事做对"算；"这个接口用 POST"不算。',
  工作方式: '面对任务时的稳定做法。"先验证再动手"算；"这次改了 A 文件"不算。',
  沟通偏好: '希望信息以什么形式、什么节奏出现。"整轮对话当整体"算。',
  情绪: '对具体事件的感受与强度。"被反复确认会烦"算；"今天天气"不算。',
  人际关系: '与特定人的位置和距离（温暖 × 支配）。"她最近压力大"算。',
  生活兴趣: '自愿投入时间的事。"喜欢爬山"算。',
  边界: '明确说过的"不要"。没有公认分类学，必须贴着原话，不许概括。',
};

export function isProfileDimension(value: unknown): value is ProfileDimension {
  return typeof value === 'string' && (PROFILE_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * Render the definitions block both prompts embed.
 *
 * Generated from the declaration above so a new dimension cannot be added to the
 * vocabulary without appearing in the prompt (and vice versa).
 */
export function renderDimensionDefinitions(): string {
  const lines = PROFILE_DIMENSIONS.map((dimension) => `- ${dimension}：${PROFILE_DIMENSION_DEFINITIONS[dimension]}`);
  return `<dimensions>
每个维度是什么，决定什么算一条、什么不算：
${lines.join('\n')}
</dimensions>`;
}

/** The "维度=价值观|工作方式|…" line, generated rather than retyped. */
export function dimensionChoices(): string {
  return `维度=${PROFILE_DIMENSIONS.join('|')}`;
}
