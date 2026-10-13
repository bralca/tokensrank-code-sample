# Audit Integration Contract

`writeAuditEvent` is the service boundary for audit events.

It persists a row into `audit_events` and emits a structured log. Persistence is
soft: a DB error is logged as `audit.insert_failed` and swallowed so audit
logging never breaks the calling request.

## Call Shape

```ts
await writeAuditEvent({
  event_type: 'fraud.rejected',
  severity: 'warn',
  profile_id: profileId,
  payload: {
    reason_code: 'future_timestamp',
    session_id: session.session_id,
    details: gateDetails,
  },
  requestLog: request.log,
});
```

Allowed severities are `info`, `warn`, and `critical`. Any other value is rejected before logging.

## Fraud Service

- Fraud rejections use `event_type: 'fraud.rejected'` and `severity: 'warn'`.
- Fingerprint drift uses `event_type: 'fraud.fingerprint_drift'` and `severity: 'warn'` or `critical`.
- Put the machine-readable rejection code in `payload.reason_code`.
- Include supporting evidence such as `session_id`, z-scores, and counts inside `payload`.

## Profile And Key Operations

- Routine profile, mode, access-key, badge, and cache events use `severity: 'info'`.
- Security-significant repeated abuse or manual-review cases use `severity: 'critical'`.
- System-level events may omit `profile_id`; the service writes `null` for that column.

## Logging

Pass `requestLog: request.log` from Fastify handlers. The request logger carries request-scoped bindings such as `request_id`, so `audit.recorded` (success) and `audit.insert_failed` (soft failure) log lines remain correlated with the request.

## Failure Behavior

`writeAuditEvent` returns `Promise<void>` and never throws. It validates severity, inserts into `audit_events` (via the provided `supabaseClient`, defaulting to the admin client), and on any DB error logs `audit.insert_failed` and resolves.

## Storage Column

Rows are written to `audit_events` with columns `event_type`, `severity`, `profile_id`, and a JSONB `payload`.
