import { adminClient } from '../clients/supabase';
import { withPostgrestSchemaRetry } from '../lib/postgrest-schema-retry';
import { updateProfile, type UpdateProfileResult } from './profile';
import type { ProfileUpdate } from '@tokensrank/shared';

export type ProfileHydrationProfile = {
  id: string;
  user_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  x_handle: string | null;
  mode: 'script_verified' | 'self_reported' | null;
  verified: boolean;
  onboarded_at: string | null;
  share_projects: boolean | null;
  created_at: string;
  updated_at: string;
};

export type ProfileHydrationAccessKey = {
  id: string;
  key_prefix: string;
  scope: 'script' | 'self_reported';
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type ProfileHydrationIngestionRun = {
  id: string;
  ingestion_mode: 'script_verified' | 'self_reported';
  status: 'processing' | 'completed' | 'partial' | 'failed';
  session_count: number;
  duplicate_count: number;
  rejected_count: number;
  started_at: string;
  finished_at: string | null;
};

export class ProfileService {
  async updateProfile(userId: string, update: ProfileUpdate): Promise<UpdateProfileResult> {
    return await updateProfile(userId, update);
  }

  /**
   * Loads the profile row owned by a Supabase Auth user ID.
   *
   * @param userId Supabase Auth user ID from the verified JWT.
   * @returns The matching profile row, or null when no profile exists.
   */
  async getProfileByUserId(userId: string): Promise<ProfileHydrationProfile | null> {
    const { data } = await withPostgrestSchemaRetry(async () => {
      const response = await adminClient
        .from('profiles')
        .select([
          'id',
          'user_id',
          'handle',
          'display_name',
          'avatar_url',
          'bio',
          'x_handle',
          'mode',
          'verified',
          'onboarded_at',
          'share_projects',
          'created_at',
          'updated_at',
        ].join(','))
        .eq('user_id', userId)
        .maybeSingle<ProfileHydrationProfile>();

      if (response.error) {
        throw response.error;
      }

      return response;
    }, {
      context: 'profile.get_by_user_id',
      event: 'profile.schema_retry',
    });

    return data;
  }

  /**
   * Loads access-key metadata for a profile without selecting secret hashes.
   *
   * @param profileId Profile ID that owns the access keys.
   * @returns Access-key metadata ordered from newest to oldest.
   */
  async getAccessKeysByProfileId(profileId: string): Promise<ProfileHydrationAccessKey[]> {
    const { data } = await withPostgrestSchemaRetry(async () => {
      const response = await adminClient
        .from('access_keys')
        .select('id,key_prefix,scope,last_used_at,revoked_at,created_at')
        .eq('profile_id', profileId)
        .order('created_at', { ascending: false })
        .returns<ProfileHydrationAccessKey[]>();

      if (response.error) {
        throw response.error;
      }

      return response;
    }, {
      context: 'profile.access_keys',
      event: 'profile.schema_retry',
    });

    return data ?? [];
  }

  /**
   * Loads recent ingestion runs for the authenticated profile dashboard.
   *
   * @param profileId Profile ID that owns the ingestion runs.
   * @param limit Maximum number of recent runs to return.
   * @returns Recent ingestion runs ordered from newest to oldest.
   */
  async getRecentIngestionRuns(
    profileId: string,
    limit = 5,
  ): Promise<ProfileHydrationIngestionRun[]> {
    const { data } = await withPostgrestSchemaRetry(async () => {
      const response = await adminClient
        .from('ingestion_runs')
        .select([
          'id',
          'ingestion_mode',
          'status',
          'session_count',
          'duplicate_count',
          'rejected_count',
          'started_at',
          'finished_at',
        ].join(','))
        .eq('profile_id', profileId)
        .order('started_at', { ascending: false })
        .limit(limit)
        .returns<ProfileHydrationIngestionRun[]>();

      if (response.error) {
        throw response.error;
      }

      return response;
    }, {
      context: 'profile.recent_ingestion_runs',
      event: 'profile.schema_retry',
    });

    return data ?? [];
  }
}

export const profileService = new ProfileService();
