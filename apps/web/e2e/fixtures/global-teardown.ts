import { createClient } from '@supabase/supabase-js';
import type { FullConfig } from '@playwright/test';

const workerSchemas = ['tokensrank_test_w0', 'tokensrank_test_w1', 'tokensrank_test_w2', 'tokensrank_test_w3'];

function hasSupabaseEnv(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export default async function globalTeardown(_config: FullConfig): Promise<void> {
  if (!hasSupabaseEnv()) {
    return;
  }

  const serviceClient = createClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );

  for (const schema of workerSchemas) {
    await serviceClient.rpc('teardown_test_schema', {
      schema_name: schema,
    });
  }
}
