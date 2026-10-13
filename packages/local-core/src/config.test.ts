import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readLocalConfig, updateLocalScheduleConfig } from './config.js';
import { openLocalStore } from './db.js';

describe('local config file', () => {
  it('creates a stable config.json with local schedule settings', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-config-'));
    const first = openLocalStore({ dataDir });
    const configPath = first.configPath;

    try {
      const config = readLocalConfig(configPath);
      expect(config?.schema_version).toBe(1);
      expect(config?.install_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(config?.schedule).toEqual({
        enabled: true,
        interval_minutes: 15,
        auto_publish: false,
      });
      expect(JSON.parse(await readFile(configPath, 'utf8'))).not.toHaveProperty('github_token');

      const fileMode = (await stat(configPath)).mode & 0o777;
      expect(fileMode).toBe(0o600);

      updateLocalScheduleConfig(configPath, {
        enabled: true,
        interval_minutes: 120,
        auto_publish: true,
      });

      const updated = readLocalConfig(configPath);
      expect(updated?.install_id).toBe(config?.install_id);
      expect(updated?.schedule).toEqual({
        enabled: true,
        interval_minutes: 120,
        auto_publish: true,
      });
    } finally {
      first.close();
    }

    const reopened = openLocalStore({ dataDir });
    try {
      const config = readLocalConfig(reopened.configPath);
      expect(config?.schedule.auto_publish).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it('adds local config fields without deleting legacy script config fields', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-config-'));
    const configPath = path.join(dataDir, 'config.json');

    await writeFile(configPath, `${JSON.stringify({
      access_key: 'tr_script_legacy',
      profile_handle: 'bralca',
      install_id: '1226c82c-2d68-40d2-910d-65f1ceff69a5',
      installed_at: '2026-04-29T20:31:57.000Z',
    }, null, 2)}\n`, { mode: 0o600 });

    const store = openLocalStore({ dataDir });
    try {
      updateLocalScheduleConfig(store.configPath, {
        enabled: true,
        interval_minutes: 240,
        auto_publish: false,
      });

      const raw = JSON.parse(await readFile(store.configPath, 'utf8')) as Record<string, unknown>;
      expect(raw.access_key).toBe('tr_script_legacy');
      expect(raw.profile_handle).toBe('bralca');
      expect(raw.install_id).toBe('1226c82c-2d68-40d2-910d-65f1ceff69a5');
      expect(raw.schema_version).toBe(1);
      expect(raw.schedule).toEqual({
        enabled: true,
        interval_minutes: 240,
        auto_publish: false,
      });
    } finally {
      store.close();
    }
  });
});
