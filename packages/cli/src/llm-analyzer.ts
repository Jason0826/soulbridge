/**
 * Optional LLM-backed affect analyzer (ADR 0015).
 *
 * Deliberately lives in the CLI package, not in core: core must stay pure and
 * offline. Opt-in only; every failure is thrown so the caller can degrade to
 * the lexicon analyzer. The raw text never leaves the machine unless the user
 * configured an endpoint.
 */
import type { AffectAnalyzer, AffectCategory, AffectSignal } from '../../core/src/index.ts';
import { emptyAffect } from '../../core/src/index.ts';

export interface LlmAnalyzerOptions {
  /** Base URL, e.g. http://localhost:11434/v1 (Ollama) or any OpenAI-compatible endpoint. */
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Confidence is capped so a self-assured model cannot bypass the injection gate. */
  maxConfidence?: number;
}

const CATEGORIES: AffectCategory[] = ['joy', 'anger', 'sadness', 'fear', 'disgust', 'surprise'];

const SYSTEM_PROMPT = [
  '你是情感分类器。只输出 JSON，不要解释。',
  'JSON 结构：{"dominant":"joy|anger|sadness|fear|disgust|surprise|null","intensity":0-9,"valence":-1..1,"arousal":0..1,"confidence":0..1}',
  '规则：只根据用户这句话判断；没有明显情绪时 dominant 为 null、confidence <= 0.3；不要猜测对方的人格。',
].join('\n');

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function parseJsonBlock(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model did not return JSON');
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function createLlmAnalyzer(options: LlmAnalyzerOptions): AffectAnalyzer {
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxConfidence = options.maxConfidence ?? 0.85;
  const endpoint = `${options.url.replace(/\/$/, '')}/chat/completions`;

  return {
    id: 'llm',
    async analyze(text: string): Promise<AffectSignal> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: text.slice(0, 2000) },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`llm analyze failed: HTTP ${response.status}`);

        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) throw new Error('llm analyze returned empty content');

        const parsed = parseJsonBlock(content) as Record<string, unknown>;
        const dominant =
          typeof parsed.dominant === 'string' && CATEGORIES.includes(parsed.dominant as AffectCategory)
            ? (parsed.dominant as AffectCategory)
            : null;
        const intensity = clamp(Number(parsed.intensity ?? 0), 0, 9);
        const confidence = clamp(Number(parsed.confidence ?? 0), 0, maxConfidence);

        const signal = emptyAffect('llm');
        return {
          ...signal,
          dominant,
          intensity,
          valence: clamp(Number(parsed.valence ?? 0), -1, 1),
          arousal: clamp(Number(parsed.arousal ?? 0), 0, 1),
          confidence: dominant ? confidence : Math.min(confidence, 0.3),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Build the analyzer from env vars, or null when not configured. */
export function llmAnalyzerFromEnv(): AffectAnalyzer | null {
  const url = process.env.SOULBRIDGE_AFFECT_LLM_URL;
  if (!url) return null;
  return createLlmAnalyzer({
    url,
    model: process.env.SOULBRIDGE_AFFECT_LLM_MODEL ?? 'qwen3:1.7b',
    apiKey: process.env.SOULBRIDGE_AFFECT_LLM_KEY,
    timeoutMs: Number(process.env.SOULBRIDGE_AFFECT_LLM_TIMEOUT ?? 3000),
  });
}
