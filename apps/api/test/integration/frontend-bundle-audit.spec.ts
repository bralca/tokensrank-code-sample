import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanDirectory } from '../../../web/scripts/check-no-service-role-leak';

async function createTempBundle(files: Record<string, string>): Promise<string> {
  const dirPath = await mkdtemp(path.join(tmpdir(), 'tokensrank-bundle-audit-'));

  for (const [fileName, content] of Object.entries(files)) {
    await writeFile(path.join(dirPath, fileName), content, 'utf8');
  }

  return dirPath;
}

async function scanTempBundle(files: Record<string, string>) {
  const dirPath = await createTempBundle(files);

  try {
    return await scanDirectory(dirPath);
  } finally {
    await rm(dirPath, { recursive: true, force: true });
  }
}

describe('frontend bundle audit', () => {
  it('passes against the clean built Next.js output', async () => {
    const violations = await scanDirectory(path.resolve('../web/.next'));

    expect(violations).toEqual([]);
  });

  it('detects SUPABASE_SERVICE_ROLE_KEY references with line context', async () => {
    const violations = await scanTempBundle({
      'bundle.js': 'console.log("safe");\nconst key = "SUPABASE_SERVICE_ROLE_KEY";\n',
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      lineNumber: 2,
      patternName: 'SUPABASE_SERVICE_ROLE_KEY',
      context: 'const key = "SUPABASE_SERVICE_ROLE_KEY";',
    });
  });

  it('detects OpenAI production and test key prefixes', async () => {
    const violations = await scanTempBundle({
      'chunk.mjs': 'const live = "sk_live_example";\nconst test = "sk_test_example";\n',
    });

    expect(violations.map((violation) => violation.patternName).sort()).toEqual(['sk_live_', 'sk_test_']);
    expect(violations.every((violation) => !violation.context.includes('example'))).toBe(true);
  });

  it('allows NEXT_PUBLIC values that are intended for frontend bundles', async () => {
    const violations = await scanTempBundle({
      'env.json': JSON.stringify({
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_example',
        NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      }),
    });

    expect(violations).toEqual([]);
  });

  it('detects JWT token patterns in bundle files', async () => {
    const violations = await scanTempBundle({
      'server.js': 'const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";\n',
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.patternName).toBe('jwt_token');
    expect(violations[0]?.context).toContain('[redacted:jwt_token]');
  });
});
