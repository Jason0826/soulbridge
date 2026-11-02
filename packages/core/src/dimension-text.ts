/**
 * Decoders for the dimension vocabulary.
 *
 * `config/dimensions.ts` holds the data and nothing else; everything that turns that
 * data into text or validates an answer lives here. The split is what makes the
 * config folder safe to edit: no behaviour hides in a definition file, and the
 * check in health-check enforces it.
 */
import { PROFILE_DIMENSIONS, PROFILE_DIMENSION_DEFINITIONS } from './config/dimensions.ts';
import type { ProfileDimension } from './config/dimensions.ts';

export function isProfileDimension(value: unknown): value is ProfileDimension {
  return typeof value === 'string' && (PROFILE_DIMENSIONS as readonly string[]).includes(value);
}

/** The definitions block both prompts embed, generated from the declaration. */
export function renderDimensionDefinitions(): string {
  const lines = PROFILE_DIMENSIONS.map(
    (dimension) => `- ${dimension}：${PROFILE_DIMENSION_DEFINITIONS[dimension]}`,
  );
  return `<dimensions>
每个维度是什么，决定什么算一条、什么不算：
${lines.join('\n')}
</dimensions>`;
}

/** The dimension choice line, generated rather than retyped. */
export function dimensionChoices(): string {
  return `维度=${PROFILE_DIMENSIONS.join('|')}`;
}
