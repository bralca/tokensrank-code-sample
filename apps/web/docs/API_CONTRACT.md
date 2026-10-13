# Frontend API Contract

Binding rule: Frontend never calls Supabase directly for app data. Supabase JS may only be used for auth-specific browser flows when explicitly required; leaderboard, profile, access-key, onboarding, and ingestion data goes through the Fastify API.

## API Helpers

Use `apiFetch<T>(path, options?)` from `apps/web/app/lib/api` in browser-capable code and shared frontend utilities.

```ts
const response = await apiFetch<{ data: { updated: boolean } }>('/api/me/profile', {
  method: 'PATCH',
  body: JSON.stringify({ displayName: 'Alex' }),
});
```

Use `serverApiFetch<T>(path, options?)` from `apps/web/app/lib/api-server` in server components and server actions. Pass `requestHeaders: await headers()` so HttpOnly cookies are forwarded to Fastify.

```ts
const me = await serverApiFetch<GetMeResponse>('/api/me', {
  requestHeaders: await headers(),
  next: { tags: ['me'] },
});
```

Both helpers prepend `NEXT_PUBLIC_API_BASE`, default to `credentials: 'include'`, send `Accept: application/json`, add `Content-Type: application/json` when a body exists, and throw `ApiError`/`ApiFetchError` for non-2xx responses.

## Error Envelope

Fastify errors must use:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Request body failed schema validation",
    "details": {}
  }
}
```

Supported frontend-handled codes include `invalid_request`, `schema_invalid`, `unauthorized`, `invalid_credentials`, `email_taken`, `password_breached`, `invalid_handle`, `handle_taken`, `key_not_found`, `rate_limited`, `csrf_violation`, `profile_update_failed`, and `profile_unavailable`.

Handle errors by checking `error instanceof ApiError`, then branch on `error.code` or `error.status`.

## Cookie Behavior

Browser calls rely on backend-set HttpOnly cookies:

- `tr_at`: access token, path `/`, used by `/api/me` and profile/access-key mutations.
- `tr_rt`: refresh token, path `/api/auth/refresh`.

Client code must not read these cookies. Server components forward them with `serverApiFetch(..., { requestHeaders: await headers() })`.

## Cache Tags

Mutation responses may include `x-cache-tags` as a comma-separated list. Frontend helpers call `revalidateTag()` on the server for each tag.

| Endpoint | Expected Tags | Invalidates |
| --- | --- | --- |
| `PATCH /api/me/profile` | `profile`, `leaderboard`, `me` | Public profile pages, leaderboard rows, `/me` hydration |
| `POST /api/access-keys/generate` | `me` | `/me` hydration and settings access-key lists |
| `DELETE /api/access-keys/:key_id` | `me` | `/me` hydration and settings access-key lists |

Read pages must tag their fetches with the generic tag they need invalidated when they use Next's fetch cache. Public profile pages use `profile`; authenticated account pages use `me`. The homepage leaderboard uses `cache: 'no-store'` at the Next layer and relies on the Fastify LRU cache so `/api/admin/cache/purge` and ingestion cache-version bumps are visible on the next SSR request.

## Typed Mutations

Use the wrappers in `apps/web/app/lib/api/profile.ts` for profile-related mutations:

```ts
await updateProfileMutation({ displayName: 'Alex', shareProjects: true });
const key = await generateAccessKeyMutation({ scope: 'script' });
await revokeAccessKeyMutation(key.data.id);
```

Wrappers preserve `ApiError` so UI code can map stable backend codes to friendly copy without parsing raw fetch responses.
