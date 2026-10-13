export type OGProfile = {
  handle: string;
  display_name: string;
  total_tokens: number;
  cost_usd_total?: number | null;
  avatar_url: string;
  mode: 'script_verified' | 'self_reported';
  rank?: number;
};

export type OGCardProps = {
  profile: OGProfile;
};
