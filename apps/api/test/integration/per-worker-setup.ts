import { beforeAll } from 'vitest';
import { resolveTestSchema, setupTestSchema, teardownTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();

process.env.SUPABASE_SCHEMA = schema;

beforeAll(async () => {
  if (schema === 'public') {
    return;
  }

  try {
    await setupTestSchema(schema);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('"leaderboard_lifetime" is not a table')) {
      throw error;
    }

    await teardownTestSchema(schema);
    await setupTestSchema(schema);
  }
});
