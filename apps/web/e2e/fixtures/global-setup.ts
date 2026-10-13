import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { FullConfig } from '@playwright/test';

const workerSchemas = ['tokensrank_test_w0', 'tokensrank_test_w1', 'tokensrank_test_w2', 'tokensrank_test_w3'];

type RpcClient = {
  rpc: (
    fn: string,
    args: { schema_name: string },
  ) => PromiseLike<{ error: { message: string } | null }>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function loadRootEnv(): void {
  const envPath = resolve(__dirname, '../../../../.env');

  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;

    if (key && process.env[key] === undefined) {
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  }
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[e2e] Missing required environment variable: ${name}`);
  }

  return value;
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  loadRootEnv();

  const serviceClient = createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );

  for (const schema of workerSchemas) {
    await resetWorkerSchema(serviceClient, schema);
    await waitForSchemaCache(schema);
  }
}

async function waitForSchemaCache(schema: string): Promise<void> {
  const schemaClient = createClient(
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
  let lastError: { message: string } | null = null;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { error } = await schemaClient
      .from('profiles')
      .select('id', { head: true, count: 'exact' })
      .limit(1);

    if (!error) {
      return;
    }

    lastError = error;
    await sleep(250);
  }

  throw new Error(
    `[e2e] PostgREST schema cache did not expose ${schema}.profiles: ${lastError?.message ?? 'unknown error'}`,
  );
}

async function resetWorkerSchema(
  serviceClient: RpcClient,
  schema: string,
): Promise<void> {
  const { error } = await serviceClient.rpc('reset_test_schema', {
    schema_name: schema,
  });

  if (!error) {
    return;
  }

  const canRecoverWithTeardown = error.message.includes('"leaderboard_lifetime" is not a table')
    || error.message.includes('pg_type_typname_nsp_index');

  if (!canRecoverWithTeardown) {
    throw new Error(`[e2e] reset_test_schema failed for ${schema}: ${error.message}`);
  }

  const teardown = await serviceClient.rpc('teardown_test_schema', {
    schema_name: schema,
  });

  if (teardown.error) {
    throw new Error(`[e2e] teardown_test_schema failed for ${schema}: ${teardown.error.message}`);
  }

  const retry = await serviceClient.rpc('reset_test_schema', {
    schema_name: schema,
  });

  if (retry.error) {
    throw new Error(`[e2e] reset_test_schema failed for ${schema}: ${retry.error.message}`);
  }
}
