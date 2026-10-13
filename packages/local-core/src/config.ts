import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';

import {
  LocalScheduleConfigSchema,
  type LocalScheduleConfig,
} from '@tokensrank/shared';

export const LOCAL_CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_LOCAL_SCHEDULE_CONFIG: LocalScheduleConfig = {
  enabled: true,
  interval_minutes: 15,
  auto_publish: false,
};

export type LocalConfig = {
  schema_version: typeof LOCAL_CONFIG_SCHEMA_VERSION;
  install_id: string;
  installed_at: string;
  updated_at: string;
  schedule: LocalScheduleConfig;
};

function nowIso(): string {
  return new Date().toISOString();
}

function defaultLocalConfig(timestamp = nowIso()): LocalConfig {
  return {
    schema_version: LOCAL_CONFIG_SCHEMA_VERSION,
    install_id: randomUUID(),
    installed_at: timestamp,
    updated_at: timestamp,
    schedule: DEFAULT_LOCAL_SCHEDULE_CONFIG,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizeLocalConfig(raw: unknown): LocalConfig {
  const fallback = defaultLocalConfig();
  const value = asRecord(raw);
  const installId = typeof value.install_id === 'string' && value.install_id.length > 0
    ? value.install_id
    : fallback.install_id;
  const installedAt = typeof value.installed_at === 'string' && value.installed_at.length > 0
    ? value.installed_at
    : fallback.installed_at;
  const updatedAt = typeof value.updated_at === 'string' && value.updated_at.length > 0
    ? value.updated_at
    : fallback.updated_at;
  const schedule = LocalScheduleConfigSchema.safeParse(value.schedule);

  return {
    schema_version: LOCAL_CONFIG_SCHEMA_VERSION,
    install_id: installId,
    installed_at: installedAt,
    updated_at: updatedAt,
    schedule: schedule.success ? schedule.data : DEFAULT_LOCAL_SCHEDULE_CONFIG,
  };
}

function readRawConfig(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) {
    return null;
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  return asRecord(raw);
}

export function readLocalConfig(configPath: string): LocalConfig | null {
  const raw = readRawConfig(configPath);
  if (!raw) {
    return null;
  }

  return normalizeLocalConfig(raw);
}

export function writeLocalConfig(configPath: string, config: LocalConfig): LocalConfig {
  const existing = readRawConfig(configPath) ?? {};
  const normalized = normalizeLocalConfig({
    ...config,
    updated_at: nowIso(),
  });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  const nextConfig = {
    ...existing,
    ...normalized,
  };

  writeFileSync(tempPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, configPath);
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // Windows does not map POSIX modes directly; keychain storage still keeps secrets out of this file.
  }

  return normalized;
}

export function ensureLocalConfig(configPath: string): LocalConfig {
  const existing = readLocalConfig(configPath);
  if (existing) {
    const raw = readRawConfig(configPath) ?? {};
    const hasCurrentSchema = raw.schema_version === LOCAL_CONFIG_SCHEMA_VERSION;
    const hasValidSchedule = LocalScheduleConfigSchema.safeParse(raw.schedule).success;
    if (!hasCurrentSchema || !hasValidSchedule) {
      return writeLocalConfig(configPath, existing);
    }

    return existing;
  }

  return writeLocalConfig(configPath, defaultLocalConfig());
}

export function updateLocalScheduleConfig(configPath: string, schedule: LocalScheduleConfig): LocalConfig {
  const parsed = LocalScheduleConfigSchema.parse(schedule);
  const current = ensureLocalConfig(configPath);

  return writeLocalConfig(configPath, {
    ...current,
    schedule: parsed,
  });
}
