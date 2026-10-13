import { describe, expect, it } from 'vitest';
// @ts-expect-error The standalone scanner is a plain Node.js module.
import { credentialFindings } from './check-secrets.mjs';

describe('shareable source credential scan', () => {
  it('detects embedded Supabase JWTs without returning the credential', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'HS256' })}.${encode({ role: 'service_role' })}.${'synthetic-signature'}`;
    const result = credentialFindings(`example\n${token}`);
    expect(result).toEqual([{ rule: 'embedded-supabase-jwt', line: 2 }]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('accepts environment placeholders and ordinary token metrics', () => {
    expect(credentialFindings('SUPABASE_SERVICE_ROLE_KEY=your-service-role-key\nconst dailyTokens90d = [];')).toEqual([]);
  });
});
