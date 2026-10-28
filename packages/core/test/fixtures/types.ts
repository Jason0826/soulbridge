/** Golden-set case shape (dev + holdout). */
import type { AffectCategory } from '../../src/types.ts';

export type Bucket = 'explicit' | 'negation' | 'degree' | 'punctuation' | 'implicit' | 'sarcasm' | 'neutral';

export interface AffectCase {
  text: string;
  bucket: Bucket;
  /** undefined = do not check */
  dominant?: AffectCategory | null;
  polarity?: 'positive' | 'negative' | 'neutral';
  minIntensity?: number;
  maxIntensity?: number;
  negated?: boolean;
  abstain?: boolean;
  maxConfidence?: number;
}

export const BASE_BUCKETS: Bucket[] = ['explicit', 'negation', 'degree', 'punctuation'];
