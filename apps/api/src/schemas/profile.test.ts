import { describe, expect, it } from 'vitest';

import { AccessKeySecretSchema } from '@tokensrank/shared';

const validBase64Url = 'abcDEF123_-abcDEF123_-abcDEF123_';

describe('AccessKeySecretSchema plaintext format', () => {
  it.each([
    `tr_script_${validBase64Url}`,
    `tr_self_reported_${validBase64Url}`,
  ])('accepts valid access key %s', (accessKey) => {
    expect(AccessKeySecretSchema.safeParse(accessKey).success).toBe(true);
  });

  it.each([
    `tr_admin_${validBase64Url}`,
    `tr_script_${validBase64Url.slice(0, 31)}`,
    `tr_script_${validBase64Url}a`,
    `tr_script_${validBase64Url.slice(0, 31)}!`,
    `tokensrank_script_${validBase64Url}`,
    `tr_self-reported_${validBase64Url}`,
  ])('rejects invalid access key %s', (accessKey) => {
    const result = AccessKeySecretSchema.safeParse(accessKey);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Access key must match tr_<scope>_<32 base64url characters>',
          }),
        ]),
      );
    }
  });
});
