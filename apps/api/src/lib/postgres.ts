import { Client } from 'pg';

type PostgresConfig = {
  connectionString?: string;
  database?: string;
  host?: string;
  password?: string;
  port?: number;
  user?: string;
  ssl: {
    rejectUnauthorized: boolean;
  };
};

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[postgres] Missing required environment variable: ${name}`);
  }

  return value;
}

function buildPostgresConfig(): PostgresConfig {
  if (process.env.SUPABASE_DB_URL) {
    return {
      connectionString: process.env.SUPABASE_DB_URL,
      ssl: {
        rejectUnauthorized: false,
      },
    };
  }

  const projectId = readRequiredEnv('SUPABASE_PROJECT_ID');

  return {
    host: `db.${projectId}.supabase.co`,
    port: Number.parseInt(process.env.SUPABASE_DB_PORT || '5432', 10),
    user: process.env.SUPABASE_DB_USER || 'postgres',
    password: readRequiredEnv('SUPABASE_DB_PASSWORD'),
    database: process.env.SUPABASE_DB_NAME || 'postgres',
    ssl: {
      rejectUnauthorized: false,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Opens a direct Postgres connection for operations Supabase PostgREST cannot
 * express, such as `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
 */
export async function createPostgresClient(): Promise<Client> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const client = new Client(buildPostgresConfig());

    try {
      await client.connect();

      const readOnlyResult = await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only');
      const transactionReadOnly = readOnlyResult.rows[0]?.transaction_read_only;

      if (transactionReadOnly === 'off') {
        return client;
      }

      lastError = new Error('[postgres] Connected to a read-only Postgres session');
      await client.end();
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
    }

    await delay(250 * (attempt + 1));
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function getActiveDatabaseSchema(): string {
  return process.env.SUPABASE_SCHEMA || 'public';
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
