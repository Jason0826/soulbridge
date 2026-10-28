/**
 * Identity and location (ADR 0020).
 *
 * Cross-tool only works if every host resolves the same person: the database
 * lives in the user's home (not the cwd), and the soul/user/device identity
 * lives in a config file that all hosts read.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface SoulConfig {
  soulId: string;
  userId: string;
  name: string;
  deviceId: string;
}

export const DEFAULT_SOUL_ID = 'xiaoling';
export const DEFAULT_USER_ID = 'local';
export const DEFAULT_NAME = '小灵';

export function soulbridgeHome(): string {
  return process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
}

export function configPath(): string {
  return join(soulbridgeHome(), 'config.json');
}

export function defaultDbPath(): string {
  return join(soulbridgeHome(), 'soul.db');
}

export function newDeviceId(): string {
  return `dev_${randomBytes(4).toString('hex')}`;
}

/** DB location: explicit flag > env > home. Never the cwd. */
export function resolveDbPath(explicit?: string): string {
  return explicit ?? process.env.SOULBRIDGE_DB ?? defaultDbPath();
}

export function loadConfig(): SoulConfig | null {
  const file = configPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SoulConfig>;
    if (!parsed.soulId || !parsed.userId) return null;
    return {
      soulId: parsed.soulId,
      userId: parsed.userId,
      name: parsed.name ?? DEFAULT_NAME,
      deviceId: parsed.deviceId ?? newDeviceId(),
    };
  } catch {
    return null;
  }
}

export function saveConfig(config: SoulConfig): void {
  const home = soulbridgeHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Read the config, creating or completing it when needed.
 * Env overrides win, but are not persisted (an override is per-process).
 */
export function ensureConfig(overrides: Partial<SoulConfig> = {}): SoulConfig {
  const loaded = loadConfig();
  const env: Partial<SoulConfig> = {};
  if (process.env.SOULBRIDGE_SOUL) env.soulId = process.env.SOULBRIDGE_SOUL;
  if (process.env.SOULBRIDGE_USER) env.userId = process.env.SOULBRIDGE_USER;
  if (process.env.SOULBRIDGE_NAME) env.name = process.env.SOULBRIDGE_NAME;

  const merged: SoulConfig = {
    soulId: overrides.soulId ?? env.soulId ?? loaded?.soulId ?? DEFAULT_SOUL_ID,
    userId: overrides.userId ?? env.userId ?? loaded?.userId ?? DEFAULT_USER_ID,
    name: overrides.name ?? env.name ?? loaded?.name ?? DEFAULT_NAME,
    deviceId: overrides.deviceId ?? loaded?.deviceId ?? newDeviceId(),
  };

  const changed =
    !loaded ||
    loaded.soulId !== merged.soulId ||
    loaded.userId !== merged.userId ||
    loaded.name !== merged.name ||
    loaded.deviceId !== merged.deviceId;
  if (changed) saveConfig(merged);

  return merged;
}
