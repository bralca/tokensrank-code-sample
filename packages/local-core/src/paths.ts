import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { LocalCoreOptions } from './types.js';

export function resolveHomeDir(options: LocalCoreOptions = {}): string {
  return options.homeDir ?? homedir();
}

export function resolveDataDir(options: LocalCoreOptions = {}): string {
  return options.dataDir ?? join(resolveHomeDir(options), '.tokensrank');
}

export function resolveDatabasePath(options: LocalCoreOptions = {}): string {
  return options.databasePath ?? join(resolveDataDir(options), 'tokensrank.db');
}

export function resolveConfigPath(options: LocalCoreOptions = {}): string {
  return join(resolveDataDir(options), 'config.json');
}

export function ensureLocalDataDirs(options: LocalCoreOptions = {}): { dataDir: string; logsDir: string; databasePath: string; configPath: string } {
  const dataDir = resolveDataDir(options);
  const logsDir = join(dataDir, 'logs');

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

  return {
    dataDir,
    logsDir,
    databasePath: resolveDatabasePath(options),
    configPath: resolveConfigPath(options),
  };
}
