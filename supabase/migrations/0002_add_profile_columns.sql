-- Add profile hydration fields used by GET /api/me.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS onboarded_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS share_projects boolean DEFAULT false;
