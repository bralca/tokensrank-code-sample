# Development

## Script Privacy Checks

The local script must preserve the privacy allowlist from PRD NFR-19: it can ship aggregate usage only, never prompts, responses, file paths, hostnames, project names, git/diff data, or tool invocation details.

Run the TypeScript scanner with line-numbered diagnostics:

```bash
pnpm privacy:check
```

Run the Bats forbidden-keys suite:

```bash
pnpm privacy:test
```

Run both checks before committing script-agent changes:

```bash
pnpm privacy:check-all
```

The pre-commit hook runs `lint-staged`, which invokes `scripts/check-script-privacy.ts` for staged changes to `packages/script/bin/agent.mjs`. CI runs the TypeScript check first and then the Bats check on Linux.
