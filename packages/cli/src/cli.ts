#!/usr/bin/env node
/**
 * Minimal CLI. No framework, no dependencies.
 *
 *   soulkit init
 *   soulkit remember "以后提交前先跑 make check" --type strategy --importance 8
 *   soulkit context --query "提交前要做什么"
 *   soulkit recall "测试"
 *   soulkit reflect --text "..."      (or --file transcript.txt)
 *   soulkit stats
 *   soulkit demo
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { MemoryType, Turn } from '../../core/src/index.ts';
import type { Soul as SoulType } from '../../core/src/index.ts';

// node:sqlite prints an ExperimentalWarning the moment it loads. Replace the default
// printer with a filter: the CLI's own output stays clean, other warnings still show.
// Must run before the dynamic import below, which is why that import is dynamic.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.message.includes('SQLite is an experimental feature')) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const { openSqlite, Soul } = await import('../../core/src/index.ts');

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

function dbFile(): string {
  const file = process.env.SOULKIT_DB ?? resolve(process.cwd(), '.soulkit', 'soul.db');
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

function open(file?: string, createdAt?: number): { soul: SoulType; file: string } {
  const target = file ?? dbFile();
  const store = openSqlite(target);
  const soul = new Soul({
    store,
    soulId: process.env.SOULKIT_SOUL ?? 'xiaoling',
    userId: process.env.SOULKIT_USER ?? 'local',
    name: process.env.SOULKIT_NAME ?? '小灵',
    createdAt,
  });
  return { soul, file: target };
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function demo(): Promise<void> {
  const dir = resolve(process.cwd(), '.soulkit');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'demo.db');
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });

  // Backdate the birthday so the demo shows a relationship that has time in it.
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

  process.stdout.write('=== 第 2 次会话：开场（无查询，按重要度注入全部）===\n');
  process.stdout.write(`${soul.context().text}\n\n`);

  process.stdout.write('=== 同一会话中，用户问「提交前要做什么」（有查询，只注入相关的）===\n');
  process.stdout.write(`${soul.context({ query: '提交前要做什么' }).text}\n\n`);

  process.stdout.write('=== stats ===\n');
  out(soul.stats());
  process.stdout.write(`\n数据库：${file}\n`);
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parse(process.argv.slice(2));

  switch (cmd) {
    case 'init': {
      const { soul, file } = open();
      out({ ok: true, db: file, ...soul.stats() });
      return;
    }

    case 'remember': {
      const content = positional.join(' ').trim();
      if (!content) throw new Error('usage: soulkit remember "内容" [--type T] [--importance N]');
      const { soul } = open();
      const id = soul.remember(content, {
        type: (flags.type as MemoryType | undefined) ?? 'fact',
        importance: flags.importance ? Number(flags.importance) : undefined,
      });
      out({ ok: true, id });
      return;
    }

    case 'context': {
      const { soul } = open();
      const result = soul.context({
        query: flags.query,
        maxChars: flags.max ? Number(flags.max) : undefined,
      });
      out(result);
      return;
    }

    case 'recall': {
      const query = positional.join(' ').trim();
      if (!query) throw new Error('usage: soulkit recall "查询" [--limit N]');
      const { soul } = open();
      const hits = soul.recall(query, flags.limit ? Number(flags.limit) : 5);
      out(hits.map((h) => ({ id: h.memory.id, type: h.memory.type, content: h.memory.content, score: Number(h.score.toFixed(3)) })));
      return;
    }

    case 'observe': {
      const content = positional.join(' ').trim();
      if (!content) throw new Error('usage: soulkit observe "一句话"');
      const { soul } = open();
      out(soul.observe({ role: 'user', content }));
      return;
    }

    case 'reflect': {
      const text = flags.file ? readFileSync(flags.file, 'utf8') : (flags.text ?? '');
      if (!text.trim()) throw new Error('usage: soulkit reflect --text "..." | --file transcript.txt');
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
      const { soul } = open();
      out(await soul.reflect(turns));
      return;
    }

    case 'stats': {
      const { soul, file } = open();
      out({ db: file, ...soul.stats() });
      return;
    }

    case 'demo':
      await demo();
      return;

    default:
      process.stdout.write(
        [
          'soulkit — 给任何 agent 装上一个人格层',
          '',
          'commands:',
          '  init                            初始化数据库',
          '  remember <text> [--type T]      显式记住一条',
          '  context [--query Q] [--max N]   生成注入文本',
          '  recall <q> [--limit N]          召回',
          '  observe <text>                  观察一轮',
          '  reflect --text|--file           会话反思',
          '  stats                           看状态',
          '  demo                            端到端演示（无需模型）',
          '',
          'env: SOULKIT_DB, SOULKIT_SOUL, SOULKIT_USER, SOULKIT_NAME',
          '',
        ].join('\n'),
      );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`soulkit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
