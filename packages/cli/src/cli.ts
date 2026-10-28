#!/usr/bin/env node
/**
 * Minimal CLI. No framework, no dependencies.
 *
 *   soulbridge init
 *   soulbridge remember "以后提交前先跑 make check" --type strategy
 *   soulbridge context --query "提交前要做什么"
 *   soulbridge observe "我不太开心"
 *   soulbridge affect "我不太开心"
 *   soulbridge reflect --text "..."
 *   soulbridge export --out soulbridge.jsonl
 *   soulbridge import --in soulbridge.jsonl
 *   soulbridge stats
 *   soulbridge demo
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  AffectAnalyzer,
  AffectSignal,
  Lexicon,
  MemoryType,
  Soul as SoulType,
  Turn,
} from '../../core/src/index.ts';

// node:sqlite prints an ExperimentalWarning the moment it loads. Replace the default
// printer with a filter: the CLI's own output stays clean, other warnings still show.
// Must run before the dynamic import below, which is why that import is dynamic.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.message.includes('SQLite is an experimental feature')) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const {
  openSqlite,
  Soul,
  ensureConfig,
  resolveDbPath,
  analyzeAffect,
  validateLexicon,
  parseSteering,
  normalizeForDedupe,
  parseTranscriptJsonl,
} = await import('../../core/src/index.ts');
const { llmAnalyzerFromEnv } = await import('./llm-analyzer.ts');

interface Parsed {
  cmd: string;
  positional: string[];
  flags: Record<string, string>;
}

function parse(argv: string[]): Parsed {
  const [cmd = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = 'true';
    }
  }

  return { cmd, positional, flags };
}

function lexiconAnalyzerFrom(path: string): AffectAnalyzer {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateLexicon(raw);
  if (errors.length > 0) throw new Error(`invalid lexicon (${path}): ${errors.slice(0, 3).join('; ')}`);
  const lexicon = raw as Lexicon;
  return { id: 'lexicon', analyze: (text: string) => analyzeAffect(text, { lexicon }) };
}

function pickAnalyzer(flags: Record<string, string>): AffectAnalyzer | undefined {
  let analyzer: AffectAnalyzer | undefined;
  if (flags.lexicon) analyzer = lexiconAnalyzerFrom(flags.lexicon);
  if (flags.analyzer === 'llm') {
    const llm = llmAnalyzerFromEnv();
    if (llm) analyzer = llm;
    else process.stderr.write('soulbridge: SOULBRIDGE_AFFECT_LLM_URL not set; using the lexicon analyzer\n');
  }
  return analyzer;
}

interface Opened {
  soul: SoulType;
  dbPath: string;
  deviceId: string;
}

function open(flags: Record<string, string>): Opened {
  const config = ensureConfig();
  const dbPath = resolveDbPath(flags.db);
  mkdirSync(dirname(dbPath), { recursive: true });

  const soul = new Soul({
    store: openSqlite(dbPath),
    soulId: config.soulId,
    userId: config.userId,
    name: config.name,
    deviceId: config.deviceId,
    analyzer: pickAnalyzer(flags),
  });
  return { soul, dbPath, deviceId: config.deviceId };
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function demo(): Promise<void> {
  const dir = resolve(process.cwd(), '.soulbridge');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'demo.db');
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });

  const seed = openSqlite(file);
  seed.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: Date.now() - 3 * 86_400_000 });
  seed.close();

  const soul = new Soul({ store: openSqlite(file), soulId: 'xiaoling', userId: 'demo', name: '小灵' });

  process.stdout.write('=== 第 1 次会话（刚认识，还没有记忆）===\n');
  process.stdout.write(`${soul.context().text}\n\n`);

  process.stdout.write('=== 会话结束，反思 ===\n');
  const result = await soul.reflect([
    { role: 'user', content: '以后提交前先跑 make check，别等 CI 挂了再修' },
    { role: 'assistant', content: '好，记住了。' },
    { role: 'user', content: '我喜欢简洁的回答，不要铺垫' },
    { role: 'user', content: '不对，这个方案是错的' },
  ]);
  process.stdout.write(`写入 ${result.memories} 条记忆，情绪 ${JSON.stringify(result.emotion)}\n\n`);

  process.stdout.write('=== 用户说了一句带情绪的话（observe）===\n');
  const observed = await soul.observe({ role: 'user', content: '我特别难过，这个方案又被拒了' });
  process.stdout.write(
    `affect: ${observed.affect.dominant ?? 'none'} / 强度 ${observed.affect.intensity} / 置信 ${observed.affect.confidence}\n\n`,
  );

  process.stdout.write('=== 第 2 次会话：开场（含情绪段）===\n');
  process.stdout.write(`${soul.context({ query: '提交前要做什么' }).text}\n\n`);

  process.stdout.write('=== stats ===\n');
  out(soul.stats());
  process.stdout.write(`\n数据库：${file}\n`);
}

function exportJsonl(soul: SoulType, deviceId: string): string {
  const lines: string[] = [
    JSON.stringify({
      type: 'header',
      version: 1,
      soulId: soul.soulId,
      userId: soul.userId,
      deviceId,
      exportedAt: Date.now(),
    }),
  ];

  const memories = soul.store.query({
    soulId: soul.soulId,
    userId: soul.userId,
    status: ['active', 'superseded', 'archived'],
    limit: 100_000,
  });
  for (const memory of memories) lines.push(JSON.stringify({ type: 'memory', memory }));

  const samples = soul.store.recentAffect(soul.soulId, soul.userId, 0);
  for (const sample of samples) {
    const withAt = sample as AffectSignal & { at?: number };
    lines.push(JSON.stringify({ type: 'affect', at: withAt.at ?? 0, signal: sample }));
  }

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parse(process.argv.slice(2));

  switch (cmd) {
    case 'init': {
      const config = ensureConfig();
      const { dbPath } = open(flags);
      out({ ok: true, db: dbPath, config });
      return;
    }

    case 'remember': {
      const content = positional.join(' ').trim();
      if (!content) throw new Error('usage: soulbridge remember "内容" [--type T] [--importance N]');
      const { soul } = open(flags);
      const id = soul.remember(content, {
        type: (flags.type as MemoryType | undefined) ?? 'fact',
        importance: flags.importance ? Number(flags.importance) : undefined,
      });
      out({ ok: true, id });
      return;
    }

    case 'context': {
      const { soul } = open(flags);
      const result = soul.context({
        query: flags.query,
        maxChars: flags.max ? Number(flags.max) : undefined,
      });
      out(result);
      return;
    }

    case 'recall': {
      const query = positional.join(' ').trim();
      if (!query) throw new Error('usage: soulbridge recall "查询" [--limit N]');
      const { soul } = open(flags);
      const hits = soul.recall(query, flags.limit ? Number(flags.limit) : 5);
      out(
        hits.map((h) => ({
          id: h.memory.id,
          type: h.memory.type,
          content: h.memory.content,
          score: Number(h.score.toFixed(3)),
        })),
      );
      return;
    }

    case 'observe': {
      const content = positional.join(' ').trim();
      if (!content) throw new Error('usage: soulbridge observe "一句话"');
      const { soul } = open(flags);
      out(await soul.observe({ role: 'user', content }));
      return;
    }

    case 'affect': {
      const text = positional.join(' ').trim();
      if (!text) throw new Error('usage: soulbridge affect "文本" [--analyzer lexicon|llm] [--lexicon path]');
      const analyzer = pickAnalyzer(flags);
      out(analyzer ? await analyzer.analyze(text) : analyzeAffect(text));
      return;
    }

    case 'reflect': {
      const text = flags.file ? readFileSync(flags.file, 'utf8') : (flags.text ?? '');
      if (!text.trim()) throw new Error('usage: soulbridge reflect --text "..." | --file transcript.txt');
      const turns: Turn[] = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(user|assistant|助手|用户)\s*[:：]\s*(.*)$/i);
          if (!match) return { role: 'user', content: line } as Turn;
          const role = /^(assistant|助手)$/i.test(match[1]) ? 'assistant' : 'user';
          return { role, content: match[2] } as Turn;
        });
      const { soul } = open(flags);
      out(await soul.reflect(turns));
      return;
    }

    case 'export': {
      const file = flags.out;
      if (!file) throw new Error('usage: soulbridge export --out soulbridge.jsonl');
      const { soul, deviceId } = open(flags);
      const body = exportJsonl(soul, deviceId);
      const target = resolve(file);
      writeFileSync(target, body, 'utf8');
      out({ ok: true, file: target, lines: body.trimEnd().split('\n').length });
      return;
    }

    case 'import': {
      // Steering file (AGENTS.md / CLAUDE.md) → memories (ADR 0022).
      if (flags.from) {
        const file = resolve(flags.from);
        const drafts = parseSteering(readFileSync(file, 'utf8'));
        const { soul } = open(flags);
        const dryRun = flags['dry-run'] === 'true';
        const existing = new Set(
          soul.store
            .query({ soulId: soul.soulId, userId: soul.userId, limit: 100_000 })
            .map((m) => normalizeForDedupe(m.content)),
        );
        let written = 0;
        let skipped = 0;
        for (const draft of drafts) {
          const key = normalizeForDedupe(draft.text);
          if (!key || existing.has(key)) {
            skipped += 1;
            continue;
          }
          existing.add(key);
          if (!dryRun) soul.remember(draft.text, { type: draft.type, importance: draft.importance });
          written += 1;
        }
        out({ ok: true, source: file, kind: 'steering', parsed: drafts.length, written, skipped, dryRun });
        return;
      }

      const file = flags.in;
      if (!file) throw new Error('usage: soulbridge import --from <steering.md> | --in <export.jsonl>');
      const { soul, deviceId } = open(flags);
      let memories = 0;
      let affects = 0;
      for (const line of readFileSync(resolve(file), 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.type === 'memory' && record.memory) {
          soul.store.put(record.memory as never);
          memories += 1;
        } else if (record.type === 'affect' && record.signal) {
          soul.store.saveAffect(
            soul.soulId,
            soul.userId,
            record.signal as AffectSignal,
            Number(record.at ?? 0),
            deviceId,
          );
          affects += 1;
        }
      }
      out({ ok: true, kind: 'jsonl', memories, affects });
      return;
    }

    case 'ingest': {
      const file = flags.file;
      if (!file) throw new Error('usage: soulbridge ingest --file transcript.jsonl [--dry-run]');
      const { turns, skipped } = parseTranscriptJsonl(readFileSync(resolve(file), 'utf8'));
      const { soul } = open(flags);
      const dryRun = flags['dry-run'] === 'true';

      if (!dryRun) {
        for (const turn of turns) {
          if (turn.role !== 'user') continue;
          const signal = await soul.analyze(turn.content);
          try {
            soul.store.saveAffect(soul.soulId, soul.userId, signal, turn.at ?? Date.now(), soul.deviceId);
          } catch {
            // Evaluation data is best-effort; ingestion must still complete.
          }
        }
      }

      const reflected = dryRun ? null : await soul.reflect(turns);
      out({ ok: true, file: resolve(file), turns: turns.length, skipped, reflected, dryRun });
      return;
    }

    case 'stats': {
      const { soul, dbPath } = open(flags);
      out({ db: dbPath, ...soul.stats() });
      return;
    }

    case 'demo':
      await demo();
      return;

    default:
      process.stdout.write(
        [
          'soulbridge — 给任何 agent 装上一个人格层',
          '',
          'commands:',
          '  init                            初始化配置与数据库',
          '  remember <text> [--type T]      显式记住一条',
          '  context [--query Q] [--max N]   生成注入文本',
          '  observe <text>                  观察一轮（含情绪分析）',
          '  affect <text> [--analyzer llm]  只做情绪分析',
          '  recall <q> [--limit N]          召回',
          '  reflect --text|--file           会话反思',
          '  export --out <file>             导出 JSONL',
          '  import --in <file>              导入 JSONL',
          '  import --from <steering.md>     导入 AGENTS.md / CLAUDE.md',
          '  ingest --file <transcript.jsonl> 会话转写 → 记忆与情绪采样',
          '  stats                           看状态',
          '  demo                            端到端演示（无需模型）',
          '',
          'env: SOULBRIDGE_DB, SOULBRIDGE_SOUL, SOULBRIDGE_USER, SOULBRIDGE_NAME,',
          '     SOULBRIDGE_AFFECT_LLM_URL / _MODEL / _KEY / _TIMEOUT',
          '',
        ].join('\n'),
      );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`soulbridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
