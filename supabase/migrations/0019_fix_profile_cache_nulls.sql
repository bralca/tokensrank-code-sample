-- TokensRank Task: Fix profile cache null handling and X handle clearing

BEGIN TRANSACTION;

-- 1. Add file_sha256 to profile_sessions_cache for project name fallback generation
ALTER TABLE public.profile_sessions_cache
ADD COLUMN IF NOT EXISTS file_sha256 text DEFAULT '';

-- 2. Enable X handle to be nullable (for clearing)
-- (No change needed - schema already allows nullable in Zod, but DB column remains as is for compatibility)

COMMIT TRANSACTION;
