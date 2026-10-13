import { setupTestSchema } from '../apps/api/test/integration/setup';

const schemas = ['tokensrank_test_w0', 'tokensrank_test_w1', 'tokensrank_test_w2', 'tokensrank_test_w3'];
const retryDelaysMs = [250, 500, 1000] as const;

async function main(): Promise<void> {
  for (const schema of schemas) {
    await setupSchemaWithRetry(schema);
  }

  console.log(`test schemas reset: ${schemas.join(', ')}`);
}

async function setupSchemaWithRetry(schema: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await setupTestSchema(schema);
      return;
    } catch (error) {
      lastError = error;

      const delay = retryDelaysMs[attempt];

      if (delay === undefined) {
        break;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

void main();
