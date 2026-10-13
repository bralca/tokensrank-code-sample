# Local dashboard and public publishing

TokensRank keeps two existing data stores:

1. **Local dashboard:** SQLite in `~/.tokensrank/tokensrank.db`, containing imported usage and local code evidence.
2. **Public dashboard:** Supabase, receiving the selected aggregate export and checking shipped-code claims through GitHub.

Running the public dashboard on localhost still uses the Supabase project configured in `.env.local`. It does not create a new database.

## Start both applications

From the repository root:

```sh
pnpm db:check
pnpm dev:both
```

| Application | Address | Data source |
| --- | --- | --- |
| Local dashboard | http://localhost:3100/local/profile | Local SQLite |
| Local publishing | http://localhost:3100/local/publish | Local SQLite |
| Public dashboard | http://localhost:3200/me | Configured Supabase project |
| Local API | http://localhost:3101 | Local SQLite |
| Public API | http://localhost:3201 | Configured Supabase project |

Stop an existing preview before starting the command; it checks that these ports are free. Separate Next.js build directories keep the two web applications independent. Ctrl+C stops the processes started by this command on macOS/Linux.

Use `SUPABASE_SCHEMA=public` for normal development. The `tokensrank_test_*` schemas belong to test suites. `dev:both` checks the required database objects and a nonempty pricing catalog before starting. `pnpm pricing:sync` refreshes the reference catalog when needed; it does not reset usage. Database migrations require `SUPABASE_PROJECT_ID`, `SUPABASE_DB_PASSWORD` and `psql`; `MIGRATION_FILE=supabase/migrations/<file>.sql pnpm db:migrate` applies the named migration. Without `MIGRATION_FILE`, the command applies only the latest file, not the entire migration history. Fresh projects need the ordered migration chain first.

The development Supabase project already has the existing GitHub OAuth application configured. Its allowed redirects include `http://localhost:3200/auth/callback` and `http://127.0.0.1:3200/auth/callback`. Use localhost consistently across both dashboards.

## Connect, review and publish

1. From the public leaderboard, choose **Share your usage**. `/join` explains the local/private calculation and contains real checkout instructions. The `--publish` launcher flag opens the guided flow directly without publishing.
2. In the local wizard, read or refresh local usage. This only updates SQLite; no account is needed to calculate your numbers.
3. Connect your public GitHub account in the connection window. The account returns to the wizard automatically. A manual connection-code fallback remains available.
4. Review the sharing receipt. Code contributions are optional and off by default. Daily usage/model counts and pricing metadata are included; individual session records are not.
5. Check the confirmation and choose **Confirm & publish**. The page follows upload, verification and public-profile preparation, including failures. Once ready, open the profile or leaderboard.

The old `/me/import` browser upload entry now redirects to this guided setup, so it cannot bypass the receipt. Hosted schema-v1 API compatibility remains for existing clients.

A receipt freezes the exact payload on the local server for 15 minutes. It is bound to the saved destination and connection, replaced when scope changes, and consumed once. The send endpoint requires that receipt ID plus explicit confirmation; it cannot rebuild and silently send a newer snapshot. The receipt can be downloaded before approving it.

Connections expire after 30 days. Reconnect through the same guided window. The destination is saved in SQLite and the token stays in the operating system credential store. Changing the destination requires a new connection. Scheduled refreshes never publish, including when an older configuration requests automatic publishing.

Local imports run at startup and every 15 minutes by default, while the local app is running. Settings can pause or change this interval. Updates do not run after the process exits. GitHub code sync is optional and runs only when a local GitHub account is connected. Usage can be viewed and reviewed while the slower private code analysis finishes.

Tokens are grouped by UTC date, tool and model. A session is counted once, on its last active UTC day, even when it spans dates or models. The separate daily session counts keep the receipt, public chart and leaderboard consistent without transmitting session IDs. “Today” means the current UTC calendar day; seven- and thirty-day views include today. The public Activity tab shows daily totals, while individual session details remain in the local dashboard.

Disconnect revokes the token when the public server is reachable and removes it from this computer. If unreachable, the remote token retains its original expiry.

## What the repaired publishing path does

The public API stores the run and its aggregate payload in a private queue before acknowledging receipt. Verification retries transient errors without penalizing trust. Each completed publication replaces all eight aggregate groups in one database transaction. A durable follow-up job rebuilds the public summary, so a process restart does not lose the work.

A repeated reference to the same commit no longer duplicates model LOC. References from the same model are combined; code credit shared across models is allocated by linked tokens, with equal shares when no token evidence is available. Rounding preserves the integer total. This is attribution of shared commit credit, not line-by-line proof of which model wrote each line.

Failed code claims follow the existing trust policy. Temporary infrastructure failures do not count as failed claims. A successful nonempty publication updates the public profile's verified status. Previous public aggregates survive a failed replacement.

Exports have a 32 MB limit. The guided flow uses schema v2: raw prompts, commands, file contents, transcripts, absolute paths, session IDs, session timelines and source-file hashes are excluded. Code-enabled receipts additionally contain selected repository identities, production branches and aggregate code counts. Older schema-v1 clients remain compatible with the hosted API, but the new local receipt endpoint only accepts v2. A successful replacement clears old session rollups as part of its transaction.

Local and hosted GitHub checks now count raw additions with the same rename and pagination rules; the separate 2,000-lines-per-commit ranking cap stays intact. Versioned caches prevent old local diff counts from being reused as remote evidence. Legacy penalties caused by the previous raw-versus-capped comparison are invalidated without approving or republishing those runs. GitHub rate limits release the local refresh job with a retry time; model-price fetches time out and retain saved prices.

## Repeat the automated publishing tests

Install PostgreSQL and PostgREST, then run:

```sh
pnpm test:publish:local
```

The runner creates a disposable PostgreSQL directory on random loopback ports, applies the migration chain, runs real SQL/HTTP publishing checks, and removes that directory. It does not read `.env.local`, use the application's SQLite database, or connect to Supabase. Only GitHub responses and browser session authentication are fixtures in this suite.

If the tools are not on your path, set `TOKENSRANK_POSTGRES_BIN` to PostgreSQL's `bin` directory and `TOKENSRANK_POSTGREST_BIN` to the PostgREST executable. PostgREST's [official installation instructions](https://docs.postgrest.org/en/stable/explanations/install.html) cover supported packages and binaries.

An optional `TOKENSRANK_TEST_PAYLOAD=/absolute/path/to/export.json` also tests a saved aggregate export, entirely inside that disposable local database. Without it, that one optional test is skipped.

## Reset operational data deliberately

`pnpm db:reset:operational` is a read-only inventory by default. To perform a reset, stop the apps, then use `pnpm db:reset:operational --apply --project <configured-project-id>`. This removes all authentication users and allowlisted operational records in `public` and the existing TokensRank test schemas. It preserves schemas, OAuth provider settings, badge definitions and model pricing. Unknown tables stop the reset for review.

The tool creates a private custom-format database backup under `~/.tokensrank/backups/` and validates its archive listing before deleting anything. Its PostgreSQL client must support the server version; use `TOKENSRANK_PG_BIN=/path/to/postgresql/bin` when necessary. These backups contain private data and must not be committed. This command does not reset local SQLite or original usage files.

## Verified September 14 state

The authorized reset backed up both local SQLite stores and Supabase, then cleared operational data. The running local app now uses the normal `~/.tokensrank/tokensrank.db`, rebuilt from the original usage files. Both apps run on localhost; the public API uses the existing Supabase project's `public` schema. All 87 pricing entries and 16 badge definitions were preserved.

Browser QA completed real GitHub sign-in, automatic return to the local wizard, receipt download, explicit confirmation and publication. The recreated real account is now the sole public profile, with rank #1 and a working daily chart. Individual session tables in Supabase remain empty. See [release readiness](RELEASE_READINESS_2026-09-14.md) for evidence and the remaining launch work.
