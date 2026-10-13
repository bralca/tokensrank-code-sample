import { adminClient } from '../clients/supabase';
import { syncProfileContrib } from '../services/github-pull';

// One-off: re-pull the full prod-branch history (5y) for an already-connected
// profile, since the on-connect backfill only ran for the old 90-day window.
// Usage: HANDLE=bralca tsx src/scripts/backfill-contrib.ts
const FIVE_YEARS_MS = 1825 * 24 * 60 * 60 * 1000;

(async () => {
  const handle = process.env.HANDLE ?? 'bralca';
  const { data: profile } = await adminClient.from('profiles').select('id').eq('handle', handle).maybeSingle();
  if (!profile) throw new Error(`profile not found: ${handle}`);

  const { data: identity } = await adminClient
    .from('github_identities')
    .select('login,provider_token,verified_emails')
    .eq('profile_id', profile.id)
    .maybeSingle();
  if (!identity?.provider_token) throw new Error('no github identity / provider_token');

  const { data: repos } = await adminClient
    .from('connected_repos')
    .select('repo_id,full_name,prod_branch,enabled')
    .eq('profile_id', profile.id)
    .eq('enabled', true);
  if (!repos || repos.length === 0) throw new Error('no enabled connected repos');

  const result = await syncProfileContrib({
    profileId: profile.id,
    login: identity.login,
    token: identity.provider_token,
    sinceIso: new Date(Date.now() - FIVE_YEARS_MS).toISOString(),
    verifiedEmails: identity.verified_emails ?? [],
    repos: repos.map((r) => ({ repo_id: r.repo_id, full_name: r.full_name, prod_branch: r.prod_branch })),
  });
  // eslint-disable-next-line no-console
  console.log('BACKFILL', JSON.stringify(result));
  process.exit(0);
})().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('BACKFILL_FAILED', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
