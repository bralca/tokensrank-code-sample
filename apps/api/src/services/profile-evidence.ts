import { ProfileEvidenceSchema, type ProfileWindow } from '@tokensrank/shared';
import { adminClient } from '../clients/supabase';
import { usageWindowStart } from './leaderboard';

export async function loadProfileEvidence(profileId:string,window:ProfileWindow) {
  const {data,error}=await adminClient.rpc('query_profile_evidence',{
    p_profile_id:profileId,p_start_date:usageWindowStart(window),
  });
  if(error) throw new Error(`[profile] Evidence unavailable: ${error.message}`);
  return data ? ProfileEvidenceSchema.parse(data) : undefined;
}
