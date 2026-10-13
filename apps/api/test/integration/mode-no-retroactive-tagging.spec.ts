import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { determineIngestionMode, escalateProfileMode, type IngestionMode } from '../../src/services/mode';
import {
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const createdUserIds = new Set<string>();

async function createSelfReportedProfile(label: string) {
  const fixture = await createAccessKeyFixture('script', label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function insertSession(profileId: string, label: string, ingestionMode: IngestionMode) {
  const admin = createSchemaServiceRoleClient();
  const { data, error } = await admin
    .from('sessions')
    .insert({
      profile_id: profileId,
      source: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      session_id: `mode-${label}`,
      file_sha256: crypto.createHash('sha256').update(`mode-${label}`).digest('hex'),
      first_event_at: '2026-04-27T10:00:00.000Z',
      last_event_at: '2026-04-27T10:05:00.000Z',
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 2,
      ingestion_mode: ingestionMode,
    })
    .select('id, ingestion_mode, updated_at')
    .single();

  if (error || !data) {
    throw new Error(`[mode-retroactive-test] session insert failed: ${error?.message ?? 'missing session'}`);
  }

  return data as { id: string; ingestion_mode: IngestionMode; updated_at: string };
}

async function getSession(sessionId: string) {
  const admin = createSchemaServiceRoleClient();
  const { data, error } = await admin
    .from('sessions')
    .select('id, ingestion_mode, updated_at')
    .eq('id', sessionId)
    .single();

  if (error || !data) {
    throw new Error(`[mode-retroactive-test] session lookup failed: ${error?.message ?? 'missing session'}`);
  }

  return data as { id: string; ingestion_mode: IngestionMode; updated_at: string };
}

async function getProfileMode(profileId: string) {
  const admin = createSchemaServiceRoleClient();
  const { data, error } = await admin
    .from('profiles')
    .select('mode')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[mode-retroactive-test] profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return (data as { mode: IngestionMode | null }).mode;
}

afterEach(async () => {
  await deleteAuthUsers(createdUserIds);
  createdUserIds.clear();
});

describe('mode escalation does not retroactively tag sessions', () => {
  it('leaves old sessions unchanged and stamps new sessions from endpoint', async () => {
    const fixture = await createSelfReportedProfile('no_retroactive');
    const admin = createSchemaServiceRoleClient();
    const oldSession = await insertSession(
      fixture.profileId,
      'old-self-reported',
      determineIngestionMode('self-reported'),
    );

    const escalation = await escalateProfileMode(admin, fixture.profileId, 'script_verified');
    const oldSessionAfterEscalation = await getSession(oldSession.id);
    const newSession = await insertSession(
      fixture.profileId,
      'new-script-verified',
      determineIngestionMode('script'),
    );

    expect(escalation).toEqual({
      escalated: true,
      previousMode: 'self_reported',
      currentMode: 'script_verified',
    });
    expect(await getProfileMode(fixture.profileId)).toBe('script_verified');
    expect(oldSessionAfterEscalation).toEqual(oldSession);
    expect(newSession.ingestion_mode).toBe('script_verified');
  });
});
