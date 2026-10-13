import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

type EnvBlocks = {
  api: Map<string, string>;
  web: Map<string, string>;
};

const requiredApiKeys = [
  'NODE_ENV',
  'LOG_LEVEL',
  'HOST',
  'PORT',
  'ALLOWED_ORIGINS',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_PURGE_TOKEN',
  'CACHE_TTL_SECONDS',
  'NEXT_PUBLIC_API_BASE',
];

const requiredWebKeys = [
  'NODE_ENV',
  'PORT',
  'HOSTNAME',
  'NEXT_TELEMETRY_DISABLED',
  'NEXT_PUBLIC_API_BASE',
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
];

function parseProductionExample(contents: string): EnvBlocks {
  const blocks: EnvBlocks = {
    api: new Map<string, string>(),
    web: new Map<string, string>(),
  };
  let currentBlock: keyof EnvBlocks | null = null;

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      if (trimmed.includes('API env:')) {
        currentBlock = 'api';
      }

      if (trimmed.includes('Web env:')) {
        currentBlock = 'web';
      }

      continue;
    }

    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);

    if (!match || !currentBlock) {
      throw new Error(`Invalid production env example line: ${line}`);
    }

    blocks[currentBlock].set(match[1], match[2]);
  }

  return blocks;
}

function expectKeys(block: Map<string, string>, keys: string[]): void {
  for (const key of keys) {
    expect(block.get(key), `missing ${key}`).toBeTruthy();
  }
}

describe('deployment artifact validation', () => {
  it('validates the production Caddyfile with Caddy', () => {
    const output = execFileSync('caddy', ['validate', '--config', resolve(repoRoot, 'Caddyfile')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(output).toContain('Valid configuration');
  });

  it('loads the PM2 ecosystem config and pins web/API process contracts', () => {
    const ecosystem = require(resolve(repoRoot, 'ecosystem.config.cjs'));

    expect(ecosystem.apps).toHaveLength(2);
    expect(ecosystem.apps.map((app: { name: string }) => app.name)).toEqual([
      'tokensrank-web',
      'tokensrank-api',
    ]);

    const web = ecosystem.apps.find((app: { name: string }) => app.name === 'tokensrank-web');
    const api = ecosystem.apps.find((app: { name: string }) => app.name === 'tokensrank-api');

    expect(web).toMatchObject({
      script: './node_modules/next/dist/bin/next',
      args: 'start',
      exec_mode: 'fork',
      env_file: '/etc/tokensrank/web.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '127.0.0.1',
      },
    });
    expect(api).toMatchObject({
      script: 'dist/index.js',
      exec_mode: 'fork',
      env_file: '/etc/tokensrank/api.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
        HOST: '127.0.0.1',
      },
    });
  });

  it('parses .env.production.example into safe API and web env contracts', () => {
    const envFile = readFileSync(resolve(repoRoot, '.env.production.example'), 'utf8');
    const { api, web } = parseProductionExample(envFile);

    expectKeys(api, requiredApiKeys);
    expectKeys(web, requiredWebKeys);
    expect(api.get('NODE_ENV')).toBe('production');
    expect(api.get('PORT')).toBe('3001');
    expect(api.get('HOST')).toBe('127.0.0.1');
    expect(api.get('CACHE_TTL_SECONDS')).toBe('3600');
    expect(web.get('NODE_ENV')).toBe('production');
    expect(web.get('PORT')).toBe('3000');
    expect(web.get('HOSTNAME')).toBe('127.0.0.1');
    expect(web.get('NEXT_PUBLIC_API_BASE')).toBe('https://api.tokensrank.ai');
    expect(web.has('SUPABASE_SERVICE_ROLE_KEY')).toBe(false);
    expect(web.has('ADMIN_PURGE_TOKEN')).toBe(false);
    expect(web.has('FRAUD_MAX_TOTAL_TOKENS')).toBe(false);
  });
});
