# TokensRank

An experiment in understanding AI coding-tool usage: how token usage, model mix, estimated API value and observed code activity change over time.

I’m currently exploring this project. It has a working local dashboard and a separately deployable public leaderboard. The focus is making the measurements explainable and letting people inspect exactly what they share. Token volume and lines of code are activity measures, not evidence of productivity or code quality.

## What it does

- Import Claude, Codex and OpenCode usage into a local SQLite database.
- Explore token totals, model mix, sessions and estimated API-equivalent cost over time.
- Inspect the evidence behind the totals and optionally relate usage to GitHub code activity.
- Preview an aggregate export, then explicitly confirm publication to a separately hosted profile and leaderboard.

The design question I’m exploring is how to make AI coding activity useful to inspect without exporting raw conversations or presenting usage volume as productivity.

## How it fits together

| Component | Responsibility |
| --- | --- |
| `apps/web` | Next.js dashboard, evidence views, export review and public profiles |
| `apps/local-api` | Fastify API running on the user’s computer; local refresh, dashboard queries and publication confirmation |
| `packages/local-core` | Usage ingestion, SQLite persistence, rollups, pricing and aggregate exports |
| `apps/api` | Hosted Fastify API for authentication, validated publishing and leaderboard queries |
| `packages/shared` | Shared contracts, validation and metrics helpers |
| `supabase/migrations` | PostgreSQL schema, constraints, functions and access policies |

The local dashboard works independently of the hosted service. Publication receipts bind approval to a particular export and expire after use; the public payload omits prompts, commands, filesystem paths and raw conversations.

## Try the local dashboard

Use **Node.js 22** (tested with 22.23.3) and **pnpm 10.27.0**. The Node version is pinned in `.nvmrc`; the SQLite dependency has not been validated on newer Node majors.

```sh
git clone https://github.com/bralca/tokensrank-code-sample.git
cd tokensrank-code-sample
nvm install             # if you use nvm; installs the pinned version
corepack enable
pnpm install --frozen-lockfile
cp .env.local.example .env.local
pnpm dev:local
```

Open <http://localhost:3000/local>. No Supabase account or hosted API credentials are needed for the private dashboard. It reads supported usage files already on your computer; without those files the dashboard is empty. Data is stored locally in `~/.tokensrank/`. Initial imports can take time for large histories.

Claude, Codex and OpenCode usage is normalized using the pinned [ccusage](https://github.com/ryoppippi/ccusage) dependency. TokensRank adds SQLite storage, import bookkeeping, pricing reconciliation, evidence views, optional GitHub attribution and the reviewed publishing flow. The application uses TypeScript, Next.js, Fastify, SQLite and PostgreSQL/Supabase.

To use a different local database, set `TOKENSRANK_DATA_DIR` before starting. This changes where TokensRank stores data; it does not change the usage sources it discovers. Public sharing needs a separately configured hosted service and GitHub sign-in. The private dashboard does not publish automatically.

## Code worth starting with

- [Reviewed publication receipts](apps/local-api/src/publish-receipt.ts) and [tests](apps/local-api/src/publish-receipt.test.ts): bind a proposed export to a fixed snapshot, require explicit confirmation, expire it and prevent reuse.
- [Usage ingestion](packages/local-core/src/ingest.ts), [ccusage integration](packages/local-core/src/ccusage.ts) and [ingestion tests](packages/local-core/src/ingest.test.ts): reconcile multiple sources, handle repeated imports and preserve useful evidence without treating missing data as a successful import.
- [Public export construction](packages/local-core/src/publish.ts) and [tests](packages/local-core/src/publish.test.ts): create an aggregate payload without prompts, commands, paths or raw conversations.
- [Local-to-public publishing tests](apps/api/test/local-publish): exercise real PostgreSQL migrations and HTTP requests, including atomic replacement, verification, privacy, ranking and cache invalidation.

## Verify a checkout

After installing dependencies and copying the local environment example:

```sh
pnpm lint                 # lint and workspace type checking
pnpm test:unit             # core, API and local application tests
pnpm --filter @tokensrank/web test:unit
pnpm privacy:check
pnpm check:secrets
pnpm audit --prod
pnpm build
pnpm test:local:browser    # real local API + web app, synthetic data
```

The browser check uses Chromium by default (`pnpm exec playwright install chromium`); set `TOKENSRANK_BROWSER_CHANNEL=chrome` to use installed Google Chrome. It uses a temporary SQLite database and does not publish anything or import your usage history.

To verify publishing without connecting to a hosted account, install PostgreSQL and PostgREST, then run:

```sh
pnpm test:publish:local
```

This creates a disposable database, applies the migrations and tests the real SQL/HTTP publishing path. See [local publishing](docs/LOCAL_PUBLISHING.md) for tool paths and the optional two-app setup.

## Status and limits

- The local dashboard works from a repository checkout. A standalone installer is not shipped.
- Costs are estimated API-equivalent values, not subscription bills.
- Publishing is optional. Each export requires review and confirmation; code attribution is separately optional.
- Hosted deployment, GitHub OAuth and production credentials must be configured independently. A local test passing does not establish that the public service is deployed.
- GitHub attribution uses recorded evidence and confidence levels; it cannot prove that every changed line was generated by AI.
- Hosted tests create fixture accounts and require a dedicated test project. CI runs them only when `TOKENSRANK_HOSTED_TESTS=true` is explicitly configured as a repository variable.

See [verification results](docs/CODE_SAMPLE_READINESS.md) for what was checked, the runtime used and remaining limitations.

## Credentials

Keep credentials in ignored local environment files or the operating system credential store. Only placeholder environment examples belong in Git. `pnpm check:secrets` scans tracked and non-ignored source files; run a history scan separately before publishing an existing repository. The shareable snapshot is prepared without private development history or archived planning conversations.
