# Task 59.0 Onboarding Requirements

## Scope

Implement FR-87: a two-step onboarding flow in Next.js App Router.

- `/onboarding`: Step 1, two equally weighted tiles, `VERIFIED` and `SELF-REPORTED`.
- `/onboarding/waiting`: Step 2, mode-specific setup for script install or self-reported ingestion.
- Client components use `sessionStorage` only for the selected UI mode; server state remains authoritative via `profile.mode` and `onboarded_at`.

## API Contracts

- `GET /api/me`: authenticated user state, profile handle, mode, onboarding step, and masked access key metadata.
- `POST /api/access-keys/generate`: creates scoped keys. Plaintext is returned exactly once and stored hashed by the API.
- `GET /api/onboarding/waiting`: SSE stream for script path. Emits log events and `first_session` with a profile handle.
- `GET /api/profile/:handle`: polling fallback when SSE fails. Poll every 5s and redirect once sessions exist.
- `POST /api/script/sessions`: script path ingestion, escalates profile to `script_verified` on first successful batch.
- `POST /api/self-reported/sessions`: manual path ingestion, stamps `self_reported` and never escalates to verified.

## Components

- `apps/web/components/onboarding-tabs.tsx`: Step 1 mode tiles, selected border/pip, Next button, sessionStorage persistence.
- `apps/web/components/onboarding-script-install.tsx`: script command, copy action, SSE log, pulsing status, polling fallback, profile redirect.
- `apps/web/components/onboarding-self-reported.tsx`: endpoint URL, bearer token, JSON payload template, copy actions, test command guidance.
- `apps/web/components/access-key-modal.tsx`: one-time plaintext key reveal, copy/download, warning banner, saved confirmation checkbox.
- `apps/web/lib/types/onboarding.ts`: shared mode, access key, SSE, and page data types.

## Visual Binding Notes

- Dark-only design: page background `#0A0A0A`, elevated surfaces `#111111`/`#161616`, hairlines `#1F1F1F`, accent `#B6FF3C`.
- Tile selection per V-3: acid-lime 1px border, 8px lime corner pip, unselected tile dimmed.
- Step 2 per V-4: allcaps lime eyebrow, monospace command/template blocks, copy buttons, live log, pulsing lime dot.
- Waiting state per V-13/T-2: dot and ready state visible within 500ms; fallback polling starts if SSE is unavailable.
- Access key modal per V-10: plaintext key shown exactly once by the API response, copy/download buttons, warning banner, checkbox-gated Done button.

## Acceptance Criteria

- Step 1 renders two clickable options and does not auto-advance.
- Step 2a renders script install CTA, copy command, SSE live log, and fallback polling.
- Step 2b renders endpoint URL, bearer token, and valid JSON payload template, each copyable.
- `first_session` events redirect to `/u/{handle}`.
- Invalid mode, unauthenticated access, and missing access key states are handled explicitly.
- Playwright covers Mode A and Mode B flows, copy actions, SSE/polling behavior, and visual baselines.
- Backend integration tests cover SSE headers, access key format/masking, mode escalation, and audit events.

## Blockers

No planning blockers identified. Existing backend and frontend baseline must be inspected before implementation to reuse local conventions.
