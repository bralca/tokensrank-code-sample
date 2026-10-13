import type {
  LocalIngestionRunStatus,
  LocalOnboardingStatus,
  LocalPricingStatus,
  LocalSetupStatus,
} from '@tokensrank/shared';

import type { LocalStore } from './db.js';
import { deleteSyncState, nowIso, readSyncState, writeSyncState } from './db.js';
import { discoverUsageSources, listStoredRepos } from './discovery.js';
import { getGithubIdentity, verifyGithubInvariants } from './github.js';
import { listOperationRuns } from './operations.js';
import { readGithubToken } from './secrets.js';

const ONBOARDING_STATUS_KEY = 'local_onboarding_status';

export function readLocalOnboardingStatus(store: LocalStore): LocalOnboardingStatus {
  return readSyncState<LocalOnboardingStatus>(store.db, ONBOARDING_STATUS_KEY, {
    completed_at: null,
    completed_version: null,
    last_completed_step: null,
  });
}

export function completeLocalOnboarding(
  store: LocalStore,
  options: { completedVersion?: string; lastCompletedStep?: string } = {},
): LocalOnboardingStatus {
  const status: LocalOnboardingStatus = {
    completed_at: nowIso(),
    completed_version: options.completedVersion ?? 'local-v2',
    last_completed_step: options.lastCompletedStep ?? 'ready',
  };
  writeSyncState(store.db, ONBOARDING_STATUS_KEY, status);
  return status;
}

export function resetLocalOnboarding(store: LocalStore): LocalOnboardingStatus {
  deleteSyncState(store.db, ONBOARDING_STATUS_KEY);
  return readLocalOnboardingStatus(store);
}

function pricingStatus(store: LocalStore): LocalPricingStatus {
  const row = store.db.prepare('SELECT COUNT(*) AS count FROM model_pricing').get() as { count: number };
  const status = readSyncState<LocalPricingStatus>(store.db, 'pricing_status', {
    row_count: row.count,
    fetched_at: null,
    source: row.count > 0 ? 'bundled_snapshot' : 'empty',
    last_error: null,
  });
  if (status.row_count === row.count) return status;
  return {
    ...status,
    row_count: row.count,
    source: row.count > 0 && status.source === 'empty' ? 'bundled_snapshot' : status.source,
  };
}

function ingestionStatus(store: LocalStore): LocalIngestionRunStatus {
  const row = store.db.prepare(`
    SELECT run_id, status, started_at, finished_at, error
    FROM ingestion_runs
    ORDER BY started_at DESC
    LIMIT 1
  `).get() as {
    run_id: string;
    status: 'running' | 'completed' | 'partial' | 'failed' | 'interrupted';
    started_at: string;
    finished_at: string | null;
    error: string | null;
  } | undefined;

  if (!row) {
    return {
      run_id: 'none',
      status: 'idle',
      started_at: null,
      finished_at: null,
      files_seen: 0,
      files_parsed: 0,
      events_seen: 0,
      events_inserted: 0,
      events_deduped: 0,
      warnings: [],
    };
  }

  const counts = store.db.prepare(`
    SELECT
      COALESCE((SELECT COUNT(*) FROM source_files), 0) AS files_parsed,
      COALESCE((SELECT SUM(parsed_event_count) FROM source_files), 0) AS events_seen,
      COALESCE((SELECT COUNT(*) FROM usage_session_model_rollups), 0) AS events_inserted
  `).get() as { files_parsed: number; events_seen: number; events_inserted: number };

  return {
    run_id: row.run_id,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    files_seen: counts.files_parsed,
    files_parsed: counts.files_parsed,
    events_seen: Number(counts.events_seen ?? 0),
    events_inserted: Number(counts.events_inserted ?? 0),
    events_deduped: Math.max(0, Number(counts.events_seen ?? 0) - Number(counts.events_inserted ?? 0)),
    warnings: row.error ? row.error.split('\n').slice(0, 50) : [],
  };
}

export async function getLocalSetupStatus(store: LocalStore): Promise<LocalSetupStatus> {
  const githubToken = await readGithubToken();
  const github = githubToken ? getGithubIdentity(store.db) : null;
  const usageSources = await discoverUsageSources({ dataDir: store.dataDir, databasePath: store.databasePath });
  const repos = listStoredRepos(store.db);
  const pricing = pricingStatus(store);
  const ingestion = ingestionStatus(store);
  const operations = listOperationRuns(store.db);
  const githubVerification = verifyGithubInvariants(store.db);
  const profileReady = ingestion.events_inserted > 0;
  const onboarding = readLocalOnboardingStatus(store);

  return {
    step: !github
      ? 'github_auth'
      : repos.length === 0
        ? 'discovery'
        : repos.some((repo) => repo.selected)
          ? profileReady ? 'ready' : 'ingestion'
          : 'repo_selection',
    data_dir: store.dataDir,
    database_path: store.databasePath,
    config_path: store.configPath,
    logs_path: store.logsDir,
    github,
    usage_sources: usageSources,
    repos,
    pricing,
    github_verification: githubVerification,
    ingestion,
    operations,
    profile_ready: profileReady,
    onboarding,
  };
}
