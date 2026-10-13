# Frontend Bundle Audit

## Overview (NFR-9)

NFR-9 requires that the Supabase service-role key never appears in frontend JavaScript bundles. The service-role key bypasses RLS and belongs only in backend runtime environments such as `apps/api/.env` or `/etc/tokensrank/api.env`.

The web app enforces this with a build-time audit that scans compiled Next.js output and fails when forbidden secret patterns are found.

## How it works

The audit script lives at `apps/web/scripts/check-no-service-role-leak.ts` and exports `scanDirectory(dirPath)`.

The scanner recursively reads `.js`, `.mjs`, and `.json` files, then reports each violation with:

- File path
- Line number
- Pattern name
- Redacted line context

`apps/web/next.config.ts` registers a production client-build plugin that runs the scanner against `.next` after Webpack emits the client bundle. If the scanner returns any violations, `next build` fails with exit code `1`.

## Running locally

Build and audit the web app:

```bash
cd apps/web
npm run build
```

Run the audit independently against the latest `.next` output:

```bash
cd apps/web
npm run audit:bundle
```

Run the integration coverage:

```bash
cd apps/api
pnpm test:integration frontend-bundle-audit
```

## CI integration

GitHub Actions runs an explicit bundle audit step after `Build web app`:

```bash
cd apps/web && npm run audit:bundle
```

The CI step fails the workflow if the script exits with code `1`, blocking pull requests and main-branch pushes that leak forbidden patterns into the compiled frontend bundle.

## Troubleshooting

If the audit fails, inspect the reported file path, line number, and pattern name. Do not move backend secrets into `NEXT_PUBLIC_*` variables to bypass the failure.

Use these checks:

- Confirm `apps/web/.env*` files contain only public frontend values.
- Keep `SUPABASE_SERVICE_ROLE_KEY` in backend-only env files.
- Check for accidental imports from `apps/api` or backend-only modules into `apps/web`.
- Rebuild before rerunning the audit so `.next` is current.

For local diagnostics only, set `TOKENSRANK_SKIP_BUNDLE_AUDIT=1` to bypass the build hook, then run `npm run audit:bundle` manually against the bundle you want to inspect.

## Patterns checked

The audit currently blocks:

- `SUPABASE_SERVICE_ROLE_KEY`
- `SUBABASE_SERVICE_ROLE_KEY`
- `sk_live_`
- `sk_test_`
- JWT-like values starting with `eyJhbGciOi`

`NEXT_PUBLIC_*` names are allowed when they do not contain forbidden secret values. Public Supabase URL and anon publishable key values are expected in the frontend bundle.
