/**
 * Shared model access for the book-experiment scripts (feed / qa / judge).
 *
 * The key comes from DSH's own credential file — it is already configured there
 * (`refs.DEEPSEEK_API_KEY`), so the experiment does not grow a second place to
 * keep secrets. Env overrides first: BOOK_LLM_KEY / BOOK_LLM_URL / BOOK_LLM_MODEL.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function readApiKey() {
  if (process.env.BOOK_LLM_KEY) return { key: process.env.BOOK_LLM_KEY, from: 'env BOOK_LLM_KEY' };
  const candidates = [
    process.env.DSH_CREDENTIALS,
    'D:/DSH/home/.credentials.yaml',
    join(homedir(), '.dsh', 'home', '.credentials.yaml'),
    join(homedir(), '.soulbridge', '.credentials.yaml'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const match = readFileSync(candidate, 'utf8').match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
      if (match) return { key: match[1], from: candidate };
    } catch {
      // next candidate; the error below lists what was tried
    }
  }
  console.error(`no API key: set BOOK_LLM_KEY, or one of these credential files to exist:\n  ${candidates.join('\n  ')}`);
  process.exit(2);
}

/** A temperature-0 chat completion with bounded retries (AGENTS 15: 上限). */
export function createLlm({ onRaw } = {}) {
  const { key, from } = readApiKey();
  const url = process.env.BOOK_LLM_URL ?? 'https://api.deepseek.com';
  const model = process.env.BOOK_LLM_MODEL ?? 'deepseek-chat';
  const llm = async (prompt) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          // reasoner rejects temperature, so it is omitted there — the judge runs on
          // a different model than the answerer on purpose (0015 §8: 自评不算).
          body: JSON.stringify({ model, ...(model.includes('reasoner') ? {} : { temperature: 0 }), messages: [{ role: 'user', content: prompt }] }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 160)}`);
        const payload = await response.json();
        const text = payload.choices?.[0]?.message?.content;
        if (!text) throw new Error('empty completion');
        if (onRaw) onRaw(text);
        return text;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    throw lastError;
  };
  llm.info = `model=${model} key from ${from}`;
  return llm;
}
