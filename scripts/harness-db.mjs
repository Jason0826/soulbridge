/**
 * 测试库与生产库的边界 —— 一条规则配一个检查。
 *
 * 生产库的文件名是 soul.db（插件 resolveDbPath、README 口径一致），实验数据一律进
 * harness.db。book-feed / book-qa / 之后的合成实验脚本都从这里取库路径：
 * 解析路径 + 拒绝生产库这一件事只在这一处声明。
 */
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const soulbridgeHome = () => process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');

/**
 * 显式 --db 优先，默认 <home>/harness.db。
 * 指向 soul.db（无论哪个目录）一律 exit 2 —— 实验数据与生产物理隔离，
 * 不靠"记得小心"，靠这道挡在开库之前的门。
 */
export function resolveHarnessDb(explicit) {
  const dbPath = explicit ?? join(soulbridgeHome(), 'harness.db');
  if (basename(dbPath) === 'soul.db') {
    console.error(`refused: ${dbPath} is the production db (soul.db); harness data goes to harness.db — pass --db <other.db> if you really mean it`);
    process.exit(2);
  }
  return dbPath;
}
