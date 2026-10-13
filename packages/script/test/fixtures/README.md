# Script Privacy Fixtures

These JSON Lines fixtures intentionally mix allowlisted usage fields with forbidden private data. They are used to prove that the script extractor emits only aggregate session payloads.

## Files

- `claude-with-prompts.jsonl`: Claude-style transcript events with allowed `message.usage.*`, `message.model`, `timestamp`, and `sessionId` fields, plus forbidden `message.content`, `response_text`, `file_paths`, `project_name`, host, command, and tool-call data.
- `codex-with-paths.jsonl`: Codex-style rollout events with allowed `payload.info.last_token_usage.*`, `payload.model`, `type`, `payload.type`, and `timestamp` fields, plus forbidden paths, hostnames, commands, prompts, responses, passwords, IPs, and git diff text.

## Privacy Contract

Tests may read these fixture files directly, but extracted payloads must never contain prompt or response text, file paths, project names, hostnames, IP addresses, terminal commands, git metadata, tool invocations, or secrets. Only token counts, model names, timestamps, session IDs, file hashes, source names, and turn counts are expected in outgoing payloads.

Validate fixture syntax with:

```bash
cat packages/script/test/fixtures/*.jsonl | jq .
```
