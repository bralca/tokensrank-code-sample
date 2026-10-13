# Security Headers

TokensRank uses layered security headers. Caddy owns transport and site-wide
browser policy at the reverse proxy. Fastify owns API response hardening through
`@fastify/helmet`.

## Layer Ownership

| Header | Value | Layer | Reason |
| --- | --- | --- | --- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Caddy and Fastify Helmet | Caddy enforces HSTS at the edge; Fastify emits the same header on direct API responses as defense-in-depth. |
| `Content-Security-Policy` | Deployment policy | Caddy | CSP is a site-wide browser policy and should stay centralized with the reverse proxy configuration. |
| `X-Content-Type-Options` | `nosniff` | Fastify Helmet for API, Caddy for proxied/static responses | Prevents MIME sniffing on API responses and static assets. |
| `X-Frame-Options` | `SAMEORIGIN` on API responses | Fastify Helmet | Prevents cross-origin framing of API responses. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Fastify Helmet for API, Caddy for proxied/static responses | Limits referrer leakage when users navigate away from TokensRank. |
| `X-Powered-By` | absent | Fastify | Fastify does not emit this header, and tests guard that it stays absent. |

## Caddy Responsibilities

Caddy terminates TLS, redirects HTTP to HTTPS, and emits HSTS/CSP policy. This
keeps NFR-11 behavior consistent across the apex, `www`, and API subdomains.
Fastify mirrors the HSTS value for API responses so local and direct API header
audits exercise the same transport policy.

## Fastify Responsibilities

`apps/api/src/plugins/security-headers.ts` registers `@fastify/helmet` with:

- `xContentTypeOptions: true`
- `xFrameOptions: { action: 'sameorigin' }`
- `referrerPolicy: { policy: 'strict-origin-when-cross-origin' }`
- `contentSecurityPolicy: false`
- `hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }`

The plugin is registered before CORS, auth, rate limit, and routes so headers
are applied to successful responses and error responses, including 404s.

## OG Image Routes

`/api/og/*` needs no security-header exemption. These headers are transparent
HTTP response headers and do not change the image-generation pipeline, PNG
payload, cache behavior, or Satori rendering. Caddy-owned HSTS/CSP still applies
at the deployed edge, and Fastify-owned headers apply to the API response.

## Local Verification

Start the API locally, then inspect headers:

```bash
set -a; source .env; set +a
PORT=3001 NODE_ENV=development pnpm --filter @tokensrank/api exec tsx src/server.ts
```

In another shell:

```bash
curl -I http://localhost:3001/health
curl -I http://localhost:3001/api/leaderboard
curl -I http://localhost:3001/api/og/profile/example
```

Expected Fastify headers:

```text
strict-transport-security: max-age=31536000; includeSubDomains; preload
x-content-type-options: nosniff
x-frame-options: SAMEORIGIN
referrer-policy: strict-origin-when-cross-origin
```

Expected local Fastify-only behavior:

```text
content-security-policy: absent
x-powered-by: absent
```

Run the integration guard:

```bash
NODE_ENV=test pnpm --filter @tokensrank/api exec vitest run --config vitest.integration.config.ts test/integration/security-headers.spec.ts
```
