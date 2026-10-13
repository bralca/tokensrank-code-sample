import { redirect } from 'next/navigation';
import type { LocalSetupStatus } from '@tokensrank/shared';

import { apiFetch } from '../lib/api';

export default async function LocalEntryPage() {
  let target = '/local/setup';
  try {
    const status = await apiFetch<LocalSetupStatus>('/local/setup/status', { cache: 'no-store' });
    if (status.onboarding.completed_at && status.profile_ready) {
      target = '/local/profile';
    }
  } catch {
    // If the local API is still booting, show onboarding; it has its own loading and error states.
  }

  redirect(target);
}
