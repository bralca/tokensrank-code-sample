# TokensRank Script Package

The script package extracts aggregate token usage from local Claude and Codex JSONL files and sends only the allowlisted session payload to TokensRank.

## Privacy Testing

Privacy is enforced in two layers:

- Static analysis: `pnpm --filter @tokensrank/script test:forbidden-keys` runs `test/forbidden-keys.bats` against `bin/agent.mjs`. It fails on source references to forbidden extraction fields such as prompt or response content, file paths, directory/project paths, hostnames/IPs, git metadata, terminal commands, and command fields. The positive check also verifies the agent still references allowlisted `input_tokens`, `output_tokens`, and `sessionId` fields.
- Runtime validation: `pnpm --filter @tokensrank/script test:privacy` runs `test/privacy.test.ts` against synthetic Claude and Codex fixtures that contain private data. The test calls the real extractors, validates the outgoing payload with `IngestRequestSchema.safeParse()`, and asserts the JSON payload contains none of the forbidden fixture keywords.

Allowed outbound session fields are limited to source, session ID, model, first/last event timestamps, input/output token counts, cache token counts, reasoning token counts, turn count, and file SHA-256. Client metadata is limited to version, install ID, platform, and architecture.

Forbidden patterns include prompt or response text, `message.content`, `response_text`, file paths, project or workspace names, hostnames, IP addresses, terminal commands, git diffs/history, tool calls, and secrets. These patterns exist because the script runs on developer machines and must never exfiltrate local code, prompts, paths, host identity, or credentials.

When adding a new forbidden pattern:

1. Add representative private data to `test/fixtures/claude-with-prompts.jsonl` or `test/fixtures/codex-with-paths.jsonl`.
2. Add or update the matching static pattern in `test/forbidden-keys.bats`.
3. Add a runtime assertion in `test/privacy.test.ts` proving the extracted payload omits the pattern.
4. Run `pnpm --filter @tokensrank/script test:forbidden-keys` and `pnpm --filter @tokensrank/script test:privacy`.
