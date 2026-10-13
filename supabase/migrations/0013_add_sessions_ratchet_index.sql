CREATE INDEX IF NOT EXISTS idx_sessions_profile_source_file_last_event
  ON public.sessions (profile_id, source, file_sha256, last_event_at DESC);
