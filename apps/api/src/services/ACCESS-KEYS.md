# Access Keys Service

`access-keys.ts` contains pure helpers for creating, hashing, validating, and
verifying TokensRank access keys. It does not read or write the database.

## Function Signatures

```ts
type AccessKeyScope = 'script' | 'self_reported';

type GeneratedAccessKey = {
  plaintext: string;
  key_sha256: string;
  key_prefix: string;
  scope: AccessKeyScope;
};

function generateAccessKey(scope: AccessKeyScope): GeneratedAccessKey;
function verifyAccessKey(plaintext: string, storedKeySha256: string, expectedScope?: AccessKeyScope): boolean;
function computeKeyHash(plaintext: string): string;
function isValidKeyFormat(plaintext: string, expectedScope?: AccessKeyScope): boolean;
function extractScopeFromKey(plaintext: string): AccessKeyScope | null;
```

## Behavior

- `generateAccessKey` creates `tr_<scope>_<32 base64url chars>` using
  `randomBytes(24).toString('base64url')`, computes the SHA-256 storage hash,
  sets `key_prefix` to the first 11 plaintext characters, and returns the full
  generated shape.
- `computeKeyHash` returns `createHash('sha256').update(plaintext).digest('hex')`
  as a 64-character lowercase hex string.
- `isValidKeyFormat` validates the full plaintext format with
  `/^tr_(script|self_reported)_[A-Za-z0-9_-]{32}$/` and can enforce an expected
  scope.
- `verifyAccessKey` fails closed for invalid plaintext or stored-hash formats,
  then compares the computed and stored hashes with `timingSafeEqual`.
- `extractScopeFromKey` returns `script`, `self_reported`, or `null` after full
  format validation. It uses regex capture rather than splitting the random
  segment, because base64url allows `_`.

## Integration Points

- `POST /api/access-keys/generate` should call `generateAccessKey(scope)`, insert
  only `key_sha256`, `key_prefix`, and `scope` into `access_keys`, then return
  `plaintext` exactly once in the creation response.
- `requireAccessKey` middleware should validate the bearer token format, call
  `computeKeyHash(plaintext)`, look up `access_keys.key_sha256` where
  `revoked_at IS NULL`, and enforce the endpoint scope.
- Script ingestion middleware for `POST /api/script/sessions` should require
  `extractScopeFromKey(plaintext) === 'script'`.
- Self-reported ingestion middleware for `POST /api/self-reported/sessions`
  should require `extractScopeFromKey(plaintext) === 'self_reported'`.
- Any code that has a stored hash and plaintext candidate can use
  `verifyAccessKey(plaintext, key_sha256, expectedScope)` for a constant-time
  verification step.

## Security Considerations

- Plaintext access keys are returned once at creation. Do not persist, log, or
  re-display them.
- Persist only `key_sha256`, `key_prefix`, `scope`, and metadata such as
  `created_at`, `last_used_at`, and `revoked_at`.
- Hash comparisons use `timingSafeEqual` to avoid revealing which hashes match.
- Scope validation is required before route handlers perform ingestion work.
  Script keys cannot be downgraded into self-reported keys, and self-reported
  keys cannot be used to escalate a profile into script-verified mode.
- Revocation must be implemented as a soft delete with `revoked_at`; do not hard
  delete keys that may be needed for audit trails.
