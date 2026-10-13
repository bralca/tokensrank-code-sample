import type { UsageImportProvider, UsageImportSource } from '@tokensrank/shared';

export type LocalCoreOptions = {
  dataDir?: string;
  databasePath?: string;
  homeDir?: string;
};

export type NormalizedUsageEvent = {
  event_id: string;
  source: UsageImportSource;
  provider: UsageImportProvider;
  event_kind: string;
  session_id: string;
  source_event_id?: string;
  event_at: string;
  model: string;
  model_source: 'explicit' | 'session_context' | 'unknown';
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  source_file_hash: string;
  source_file_size?: number;
  line_number?: number;
  parser_version: string;
  metadata?: Record<string, unknown>;
};

export type NormalizedToolEvent = {
  event_id: string;
  source: UsageImportSource;
  provider?: UsageImportProvider;
  session_id: string;
  event_at: string;
  model?: string;
  model_source?: 'explicit' | 'session_context' | 'unknown';
  tool_name?: string;
  command_kind?: 'git_commit' | 'git_inspection' | 'git_other' | 'shell_other' | 'unknown_command';
  evidence_origin?: string;
  cwd?: string;
  commit_sha?: string;
  confidence: number;
  metadata?: Record<string, unknown>;
};

export type SourceFileSummary = {
  source: UsageImportSource;
  path: string;
  path_hash?: string;
  source_file_hash: string;
  source_file_size: number;
  line_count: number;
  parsed_event_count: number;
  ignored_line_count: number;
  warning_count: number;
  parser_version: string;
  metadata?: Record<string, unknown>;
};

export type ParsedUsageFile = {
  file: SourceFileSummary;
  events: NormalizedUsageEvent[];
  tool_events: NormalizedToolEvent[];
  warnings: string[];
};

export type IngestRunResult = {
  run_id: string;
  status: 'completed' | 'partial' | 'failed';
  files_seen: number;
  files_parsed: number;
  events_seen: number;
  events_inserted: number;
  events_deduped: number;
  warnings: string[];
  started_at: string;
  finished_at: string;
};

export type PricingRow = {
  provider: string;
  model_id: string;
  name: string | null;
  family: string | null;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  cache_write_per_mtok: number | null;
  source_last_updated: string | null;
  content_hash: string;
  fetched_at?: string;
};

export type LocalRepoSelection = {
  id: string;
  selected: boolean;
  prod_branch: string | null;
};

export type GithubCodeDailyRow = {
  date: string;
  repo_id: number;
  full_name: string;
  prod_branch: string;
  github_shipped_loc: number;
  github_commit_count: number;
  verified_at: string;
};

export type AiLinkedCodeDailyRow = {
  date: string;
  repo_id: number;
  full_name: string;
  linked_shipped_loc: number;
  linked_commit_count: number;
  linked_tokens: number;
  high_confidence_commit_count: number;
  median_link_confidence: number;
};

export type GithubVerificationResult = {
  verified_repo_count: number;
  github_total_loc: number;
  github_total_commits: number;
  ai_linked_loc: number;
  ai_linked_commits: number;
  last_verified_at: string | null;
  invariant_violations: string[];
};
