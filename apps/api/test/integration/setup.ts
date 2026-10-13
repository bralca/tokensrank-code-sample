import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createPostgresClient, quoteIdentifier } from '../../src/lib/postgres';

const workerSchemaPrefix = 'tokensrank_test_w';
const workerSchemaCount = 4;

function loadRootEnv(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  for (const name of ['.env.local', '.env']) {
    let contents: string;
    try { contents = readFileSync(resolve(root, name), 'utf8'); }
    catch (error) {
      if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    for (const line of contents.split(/\r?\n/u)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
      if (match?.[1] && process.env[match[1]] === undefined) {
        process.env[match[1]] = (match[2] ?? '').replace(/^['"]|['"]$/gu, '');
      }
    }
  }
}

loadRootEnv();

export function resolveWorkerIndex(workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'): number {
  const parsedWorkerId = Number.parseInt(workerId, 10);

  if (!Number.isFinite(parsedWorkerId) || parsedWorkerId < 0) {
    return 0;
  }

  return parsedWorkerId % workerSchemaCount;
}

export function resolveTestSchema(workerId?: string): string {
  return `${workerSchemaPrefix}${resolveWorkerIndex(workerId)}`;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[test] Missing required environment variable: ${name}`);
  }

  return value;
}

async function ensureLeaderboardPreviousTable(schema: string): Promise<void> {
  const client = await createPostgresClient();
  const quotedSchema = quoteIdentifier(schema);

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${quotedSchema}.leaderboard_previous (
        profile_id uuid PRIMARY KEY REFERENCES ${quotedSchema}.profiles(id) ON DELETE CASCADE,
        rank integer NOT NULL CHECK (rank > 0),
        total_tokens bigint NOT NULL DEFAULT 0,
        refreshed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON ${quotedSchema}.leaderboard_previous TO anon, authenticated, service_role
    `);
    await client.query("NOTIFY pgrst, 'reload schema'");
  } finally {
    await client.end();
  }

  const restClient = createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      db: {
        schema,
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          'Accept-Profile': schema,
          'Content-Profile': schema,
        },
      },
    },
  );

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { error } = await restClient
      .from('leaderboard_previous')
      .select('profile_id', { head: true, count: 'exact' });

    if (!error) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }
}

export function createServiceRoleClient() {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

export function createDisposableAnonClient(schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema()) {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_ANON_KEY'),
    {
      db: {
        schema,
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          'Accept-Profile': schema,
          'Content-Profile': schema,
        },
      },
    },
  );
}

export async function setupTestSchema(schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema()): Promise<string> {
  const serviceClient = createServiceRoleClient();
  const { data, error } = await serviceClient.rpc('reset_test_schema', {
    schema_name: schema,
  });

  if (error) {
    if (error.message.includes('"leaderboard_lifetime" is not a table')) {
      await teardownTestSchema(schema);

      const retry = await serviceClient.rpc('reset_test_schema', {
        schema_name: schema,
      });

      if (!retry.error) {
        await ensureLeaderboardPreviousTable(schema);

        return String(retry.data ?? schema);
      }

      throw new Error(`[test] reset_test_schema failed for ${schema}: ${retry.error.message}`);
    }

    throw new Error(`[test] reset_test_schema failed for ${schema}: ${error.message}`);
  }

  await ensureLeaderboardPreviousTable(schema);

  return String(data ?? schema);
}

export async function teardownTestSchema(schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema()): Promise<string> {
  const serviceClient = createServiceRoleClient();
  const { data, error } = await serviceClient.rpc('teardown_test_schema', {
    schema_name: schema,
  });

  if (error) {
    throw new Error(`[test] teardown_test_schema failed for ${schema}: ${error.message}`);
  }

  return String(data ?? schema);
}
