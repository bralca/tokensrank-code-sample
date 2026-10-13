import { createHash } from 'node:crypto';
import { PublishReceipts } from './publish-receipt.js';
import { readPublicPresence } from './public-presence.js';
import 'dotenv/config';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ProfileWindowSchema,
  LOCAL_PUBLISH_BODY_LIMIT_BYTES,
  LocalOnboardingCompleteRequestSchema,
  type LocalOperationRun,
  type LocalOperationType,
  type LocalScheduleConfig,
  type LocalScheduleStatus,
  type LocalPricingStatus,
  type LocalVersionStatus,
  type PublishLocalResponse,
  type LocalPublishPayload,
} from '@tokensrank/shared';

import {
  buildLocalProfile,
  buildPublishPayload,
  checkLocalVersionStatus,
  completeLocalOnboarding,
  connectGithubWithToken,
  DEFAULT_LOCAL_SCHEDULE_CONFIG,
  defaultVersionStatus,
  discoverLocalRepos,
  discoverUsageFiles,
  getLocalSetupStatus,
  getGithubIdentity,
  ingestUsageFiles,
  listStoredRepos,
  markInterruptedIngestionRuns,
  markInterruptedOperationRuns,
  openLocalStore,
  pollGithubDeviceFlow,
  readPublishToken,
  readLocalConfig,
  readSyncState,
  rebuildAiCommitLinks,
  rebuildLocalProfileSummary,
  rebuildUsageRollups,
  resetLocalOnboarding,
  seedBundledPricing,
  completeOperation,
  failOperation,
  latestRunningOperation,
  listOperationRuns,
  startOperation,
  startGithubDeviceFlow,
  storeSecret,
  clearSecret,
  syncGithubCodeTotals,
  syncModelPricingLocalSafe,
  updateOperation,
  updateLocalScheduleConfig,
  upsertDiscoveredRepos,
  writeSyncState,
} from '@tokensrank/local-core';

import { connectedPublishBase, normalizePublishBase, publishFetch, readPublishConnection, savePublishConnection } from './publish-connection.js';

const PORT = Number.parseInt(process.env.LOCAL_API_PORT || process.env.PORT || '3001', 10);
const HOST = process.env.LOCAL_API_HOST || '127.0.0.1';
const LOCAL_PACKAGE_NAME = process.env.TOKENSRANK_LOCAL_PACKAGE_NAME ?? 'tokensrank-local';
const LOCAL_VERSION = process.env.TOKENSRANK_LOCAL_VERSION ?? process.env.npm_package_version ?? '0.0.1';
const DEFAULT_HOSTED_API_BASE = 'https://api.tokensrank.ai';

const store = openLocalStore({
  ...(process.env.TOKENSRANK_DATA_DIR ? { dataDir: process.env.TOKENSRANK_DATA_DIR } : {}),
  ...(process.env.TOKENSRANK_DB_PATH ? { databasePath: process.env.TOKENSRANK_DB_PATH } : {}),
  ...(process.env.TOKENSRANK_HOME_DIR ? { homeDir: process.env.TOKENSRANK_HOME_DIR } : {}),
});
seedBundledPricing(store.db);
markInterruptedIngestionRuns(store.db);
markInterruptedOperationRuns(store.db);

const TokenBodySchema = z.object({
  token: z.string().min(1).optional(),
}).strict().default({});

const IngestBodySchema = z.object({
  file_paths: z.array(z.string().min(1)).optional(),
}).strict().default({});

const RepoSelectionBodySchema = z.object({
  repos: z.array(z.object({
    id: z.string().min(1),
    selected: z.boolean(),
    prod_branch: z.string().min(1).nullable().optional(),
  }).strict()),
}).strict();

const PublishConnectBodySchema = z.object({
  code: z.string().min(16),
  hosted_api_base: z.string().url().optional(),
}).strict();

const PublishSendBodySchema = z.object({
  receipt_id: z.string().uuid(),
  confirmed: z.literal(true),
}).strict();
const publishReceipts = new PublishReceipts();

const ScheduleConfigBodySchema = z.object({
  enabled: z.boolean().optional(),
  interval_minutes: z.number().int().min(15).max(1440).optional(),
  auto_publish: z.boolean().optional(),
}).strict();

const ScheduleRunBodySchema = z.object({
  hosted_api_base: z.string().url().optional(),
}).strict().default({});

let scheduleTimer: NodeJS.Timeout | null = null;
let scheduleRunning = false;
let startupRefreshRunning = false;
let manualIngestRunning = false;

type HostedPublishStatus = {
  data?: {
    publish_run?: Record<string, unknown>;
    trust?: Record<string, unknown> | null;
  };
  error?: {
    code?: string;
    message?: string;
  };
};

type LocalPublishHistoryEntry = {
  publish_run_id: string;
  sent_at: string;
  hosted_api_base: string;
  verification_status: string;
  accepted_usage_days: number;
  accepted_sessions: number;
  accepted_code_days: number;
  remote_github_shipped_loc_total: number;
  remote_github_commit_total: number;
  pricing_mismatch_count: number;
  completed_at: string | null;
  rank_eligible: boolean | null;
  deboost_multiplier: number | string | null;
  error: string | null;
};

const PUBLISH_HISTORY_LIMIT = 25;

function errorEnvelope(code: string, message: string, details?: unknown) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

type OperationTask = (operation: LocalOperationRun) => Promise<Record<string, unknown> | void>;

function operationEnvelope(operation: LocalOperationRun, alreadyRunning = false) {
  return {
    data: {
      operation,
      operation_id: operation.operation_id,
      status: operation.status,
      already_running: alreadyRunning,
    },
  };
}

function startBackgroundOperation(
  input: {
    type: LocalOperationType;
    label: string;
    stage?: string;
    message?: string | null;
    total?: number | null;
    dedupe?: boolean;
  },
  task: OperationTask,
): { operation: LocalOperationRun; alreadyRunning: boolean } {
  const existing = input.dedupe === false ? null : latestRunningOperation(store.db, input.type);
  if (existing) {
    return { operation: existing, alreadyRunning: true };
  }

  const operation = startOperation(store.db, {
    type: input.type,
    label: input.label,
    stage: input.stage ?? 'starting',
    progressPercent: 0,
    total: input.total ?? null,
    message: input.message ?? null,
  });

  void task(operation)
    .then((result) => {
      completeOperation(store.db, operation.operation_id, {
        stage: 'completed',
        message: `${operation.label} complete.`,
        result: result ?? {},
      });
    })
    .catch((error) => {
      failOperation(store.db, operation.operation_id, error, {
        stage: 'failed',
        message: `${operation.label} failed.`,
      });
    });

  return { operation, alreadyRunning: false };
}

function progressFromCounts(current: number, total: number, start: number, span: number): number {
  if (total <= 0) return start;
  return start + (span * Math.max(0, Math.min(1, current / total)));
}

function requestedProfileWindow(request: FastifyRequest) {
  const query = request.query as { window?: unknown } | undefined;
  const parsed = ProfileWindowSchema.safeParse(query?.window ?? 'all');
  return parsed.success ? parsed.data : 'all';
}

function publicOrigins(): string[] {
  return [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.NEXT_PUBLIC_SITE_URL,
  ].filter((value): value is string => Boolean(value));
}

function hostedApiBase(value?: string | null): string {
  return normalizePublishBase(value ?? readPublishConnection(store.db)?.hosted_api_base ?? process.env.TOKENSRANK_HOSTED_API_BASE ?? DEFAULT_HOSTED_API_BASE);
}

function localTokenAuthEnabled(): boolean {
  return process.env.TOKENSRANK_LOCAL_ALLOW_TOKEN_AUTH === 'true';
}

function localUpdateCheckDisabled(): boolean {
  if (process.env.TOKENSRANK_LOCAL_UPDATE_CHECK === 'true') return false;
  if (process.env.TOKENSRANK_LOCAL_UPDATE_CHECK === 'false') return true;
  return LOCAL_PACKAGE_NAME === 'tokensrank-local' && LOCAL_VERSION === '0.0.1';
}

function cachedLocalVersionStatus(): LocalVersionStatus {
  return {
    package_name: LOCAL_PACKAGE_NAME,
    current_version: LOCAL_VERSION,
    latest_version: LOCAL_VERSION,
    update_available: false,
    checked_at: new Date().toISOString(),
    source: 'cached',
    release_url: null,
    last_error: null,
  };
}

function readScheduleConfig(): LocalScheduleConfig {
  return { ...(readLocalConfig(store.configPath)?.schedule ?? DEFAULT_LOCAL_SCHEDULE_CONFIG), auto_publish: false };
}

function readVersionStatus(): LocalVersionStatus {
  if (localUpdateCheckDisabled()) {
    const status = readSyncState<LocalVersionStatus | null>(store.db, 'local_version_status', null);
    if (!status || status.last_error || status.package_name !== LOCAL_PACKAGE_NAME || status.current_version !== LOCAL_VERSION) {
      return cachedLocalVersionStatus();
    }
    return status;
  }

  return readSyncState<LocalVersionStatus>(
    store.db,
    'local_version_status',
    defaultVersionStatus({
      packageName: LOCAL_PACKAGE_NAME,
      currentVersion: LOCAL_VERSION,
    }),
  );
}

function hasLocalUsageEvents(): boolean {
  const row = store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number };
  return row.count > 0;
}

function repriceExistingUsage(): void {
  if (!hasLocalUsageEvents()) return;
  // ccusage owns these counters and costs; raw evidence must not replace its totals.
  if (store.db.prepare("SELECT 1 FROM usage_session_rollups WHERE ccusage_version IS NOT NULL LIMIT 1").get()) return;
  rebuildUsageRollups(store.db);
  rebuildLocalProfileSummary(store.db);
}

async function syncPricingAndMaybeReprice(options: { repriceExisting?: boolean } = {}): Promise<LocalPricingStatus> {
  seedBundledPricing(store.db);
  const status = await syncModelPricingLocalSafe(store.db);
  if (options.repriceExisting) {
    repriceExistingUsage();
  }
  return status;
}

async function runUsageIngestOperation(
  operation: LocalOperationRun,
  filePaths?: string[],
): Promise<Record<string, unknown>> {
  manualIngestRunning = true;
  try {
    updateOperation(store.db, operation.operation_id, {
      stage: 'syncing_pricing',
      progressPercent: 3,
      message: 'Refreshing model pricing before import.',
    });
    seedBundledPricing(store.db);

    updateOperation(store.db, operation.operation_id, {
      stage: 'discovering_files',
      progressPercent: 8,
      message: 'Finding local Claude, Codex, and OpenCode usage files.',
    });
    const files = filePaths ?? await discoverUsageFiles();

    updateOperation(store.db, operation.operation_id, {
      stage: 'reading_files',
      progressPercent: 10,
      current: 0,
      total: files.length,
      message: `${files.length.toLocaleString()} files queued.`,
    });

    const ingestResult = await ingestUsageFiles(store.db, files, {
      runId: operation.operation_id,
      onProgress: (progress) => {
        if (progress.stage === 'usage_ready') updateScheduleStatus({ usage_updated_at: new Date().toISOString() });
        if (progress.stage === 'reading_files') {
          updateOperation(store.db, operation.operation_id, {
            stage: 'reading_files',
            progressPercent: progressFromCounts(progress.files_scanned, progress.files_total, 10, 70),
            current: progress.files_scanned,
            total: progress.files_total,
            message: `${progress.files_scanned.toLocaleString()} / ${progress.files_total.toLocaleString()} files scanned`,
            result: {
              files_parsed: progress.files_parsed,
              events_seen: progress.events_seen,
              events_inserted: progress.events_inserted,
              warnings: progress.warnings,
            },
          });
        } else if (progress.stage === 'rebuilding_rollups') {
          updateOperation(store.db, operation.operation_id, {
            stage: 'rebuilding_rollups',
            progressPercent: 8,
            message: 'Reading local usage totals.',
          });
        } else if (progress.stage === 'linking_commits') {
          updateOperation(store.db, operation.operation_id, {
            stage: 'linking_commits',
            progressPercent: 93,
            message: 'Linking direct commit evidence to local repos.',
          });
        }
      },
    });

    return {
      files_seen: ingestResult.files_seen,
      files_parsed: ingestResult.files_parsed,
      events_inserted: ingestResult.events_inserted,
      events_deduped: ingestResult.events_deduped,
      warnings: ingestResult.warnings.length,
    };
  } finally {
    manualIngestRunning = false;
  }
}

async function runGithubSyncOperation(operation: LocalOperationRun): Promise<Record<string, unknown>> {
  const result = await syncGithubCodeTotals(store.db, {
    onProgress: (progress) => {
      if (progress.stage === 'matching_repos') {
        updateOperation(store.db, operation.operation_id, {
          stage: 'matching_repos',
          progressPercent: 5,
          current: 0,
          total: progress.repos_total,
          message: `Checking ${progress.repos_total.toLocaleString()} selected GitHub repo${progress.repos_total === 1 ? '' : 's'}.`,
        });
        return;
      }
      if (progress.stage === 'listing_commits') {
        updateOperation(store.db, operation.operation_id, {
          stage: 'listing_commits',
          progressPercent: progressFromCounts(progress.repos_synced, Math.max(1, progress.repos_total), 10, 20),
          current: progress.repos_synced,
          total: progress.repos_total,
          message: progress.current_repo ? `Listing production commits for ${progress.current_repo}.` : 'Listing production commits.',
        });
        return;
      }
      if (progress.stage === 'fetching_commit_details') {
        updateOperation(store.db, operation.operation_id, {
          stage: 'fetching_commit_details',
          progressPercent: progress.commits_total > 0
            ? progressFromCounts(progress.commits_processed, progress.commits_total, 30, 55)
            : progressFromCounts(progress.repos_synced, Math.max(1, progress.repos_total), 30, 55),
          current: progress.commits_processed,
          total: progress.commits_total,
          message: progress.current_repo
            ? `Fetching commit details for ${progress.current_repo}.`
            : 'Fetching commit details.',
          result: {
            repos_synced: progress.repos_synced,
            commits_processed: progress.commits_processed,
            commits_total: progress.commits_total,
            errors: progress.errors,
          },
        });
        return;
      }
      if (progress.stage === 'rebuilding_links') {
        updateOperation(store.db, operation.operation_id, {
          stage: 'rebuilding_links',
          progressPercent: 92,
          message: 'Rebuilding shipped-code and AI-linked LOC rollups.',
        });
      }
    },
  });

  const errors = readSyncState<string[]>(store.db, 'github_repo_sync_errors', []);
  if (errors.length) throw new Error(errors[0]);

  return {
    verified_repo_count: result.verified_repo_count,
    github_total_loc: result.github_total_loc,
    github_total_commits: result.github_total_commits,
    ai_linked_loc: result.ai_linked_loc,
    ai_linked_commits: result.ai_linked_commits,
    invariant_violations: result.invariant_violations,
  };
}

async function runDiscoveryOperation(operation: LocalOperationRun): Promise<Record<string, unknown>> {
  updateOperation(store.db, operation.operation_id, {
    stage: 'scanning_repos',
    progressPercent: 20,
    message: 'Scanning common local folders for Git repos.',
  });
  const repos = await discoverLocalRepos();
  upsertDiscoveredRepos(store.db, repos);

  updateOperation(store.db, operation.operation_id, {
    stage: 'scanning_usage',
    progressPercent: 70,
    message: 'Scanning local Claude, Codex, and OpenCode usage folders.',
  });
  const usageFiles = await discoverUsageFiles();
  return {
    repos: repos.length,
    usage_files: usageFiles.length,
  };
}

async function runPricingOperation(operation: LocalOperationRun): Promise<Record<string, unknown>> {
  updateOperation(store.db, operation.operation_id, {
    stage: 'syncing_pricing',
    progressPercent: 30,
    message: 'Fetching model pricing and rebuilding costs.',
  });
  const status = await syncPricingAndMaybeReprice({ repriceExisting: true });
  return {
    row_count: status.row_count,
    source: status.source,
    fetched_at: status.fetched_at,
    last_error: status.last_error,
  };
}

function readPublishHistory(): LocalPublishHistoryEntry[] {
  return readSyncState<LocalPublishHistoryEntry[]>(store.db, 'local_publish_history', []);
}

function writePublishHistory(entries: LocalPublishHistoryEntry[]): void {
  writeSyncState(store.db, 'local_publish_history', entries.slice(0, PUBLISH_HISTORY_LIMIT));
}

function upsertPublishHistory(entry: LocalPublishHistoryEntry): void {
  const existing = readPublishHistory().filter((item) => item.publish_run_id !== entry.publish_run_id);
  writePublishHistory([entry, ...existing].sort((left, right) => right.sent_at.localeCompare(left.sent_at)));
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function publishHistoryEntryFromResponse(
  response: PublishLocalResponse,
  hostedApiBase: string,
  sentAt: string,
): LocalPublishHistoryEntry {
  return {
    publish_run_id: response.data.publish_run_id,
    sent_at: sentAt,
    hosted_api_base: hostedApiBase,
    verification_status: response.data.verification_status,
    accepted_usage_days: response.data.accepted_usage_days,
    accepted_sessions: response.data.accepted_sessions,
    accepted_code_days: response.data.accepted_code_days,
    remote_github_shipped_loc_total: response.data.remote_github_shipped_loc_total,
    remote_github_commit_total: response.data.remote_github_commit_total,
    pricing_mismatch_count: response.data.pricing_mismatches.length,
    completed_at: null,
    rank_eligible: null,
    deboost_multiplier: null,
    error: null,
  };
}

function updatePublishHistoryFromHostedStatus(runId: string, hostedStatus: HostedPublishStatus): void {
  const current = readPublishHistory();
  const entry = current.find((item) => item.publish_run_id === runId);
  if (!entry) return;

  const run = hostedStatus.data?.publish_run;
  const trust = hostedStatus.data?.trust ?? null;
  const next: LocalPublishHistoryEntry = {
    ...entry,
    verification_status: stringField(run?.verification_status) ?? entry.verification_status,
    remote_github_shipped_loc_total: numberField(run?.remote_github_shipped_loc_total) || entry.remote_github_shipped_loc_total,
    remote_github_commit_total: numberField(run?.remote_github_commit_total) || entry.remote_github_commit_total,
    pricing_mismatch_count: Array.isArray(run?.pricing_mismatches)
      ? run.pricing_mismatches.length
      : entry.pricing_mismatch_count,
    completed_at: stringField(run?.verification_completed_at) ?? stringField(run?.completed_at) ?? entry.completed_at,
    rank_eligible: typeof trust?.rank_eligible === 'boolean' ? trust.rank_eligible : entry.rank_eligible,
    deboost_multiplier: typeof trust?.deboost_multiplier === 'number' || typeof trust?.deboost_multiplier === 'string'
      ? trust.deboost_multiplier
      : entry.deboost_multiplier,
    error: stringField(run?.error) ?? hostedStatus.error?.message ?? entry.error,
  };
  upsertPublishHistory(next);
}

function versionStatusIsStale(status: LocalVersionStatus): boolean {
  if (localUpdateCheckDisabled()) {
    return status.source !== 'cached' || Boolean(status.last_error);
  }
  if (!status.checked_at) return true;
  const checkedAt = Date.parse(status.checked_at);
  return !Number.isFinite(checkedAt) || Date.now() - checkedAt > 24 * 60 * 60 * 1000;
}

async function refreshVersionStatus(): Promise<LocalVersionStatus> {
  if (localUpdateCheckDisabled()) {
    const status = cachedLocalVersionStatus();
    writeSyncState(store.db, 'local_version_status', status);
    return status;
  }

  const status = await checkLocalVersionStatus({
    packageName: LOCAL_PACKAGE_NAME,
    currentVersion: LOCAL_VERSION,
    registryUrl: process.env.TOKENSRANK_NPM_REGISTRY_URL,
  });
  writeSyncState(store.db, 'local_version_status', status);
  return status;
}

function refreshVersionStatusIfStale(): void {
  if (!versionStatusIsStale(readVersionStatus())) return;
  void refreshVersionStatus().catch(() => {
    // The failed status is stored by refreshVersionStatus; startup must not block.
  });
}

function readScheduleStatus(): LocalScheduleStatus {
  return readSyncState<LocalScheduleStatus>(store.db, 'local_schedule_status', {
    config: readScheduleConfig(),
    running: scheduleRunning,
    next_run_at: null,
    last_run_at: null,
    last_finished_at: null,
    last_error: null,
    last_reason: null,
    last_result: null,
  });
}

function writeScheduleStatus(status: LocalScheduleStatus): LocalScheduleStatus {
  writeSyncState(store.db, 'local_schedule_status', status);
  return status;
}

function updateScheduleStatus(patch: Partial<LocalScheduleStatus>): LocalScheduleStatus {
  const current = readScheduleStatus();
  return writeScheduleStatus({
    ...current,
    ...patch,
    config: patch.config ?? readScheduleConfig(),
    running: patch.running ?? scheduleRunning,
  });
}

function nextRunAt(config: LocalScheduleConfig): string | null {
  if (!config.enabled) return null;
  return new Date(Date.now() + config.interval_minutes * 60 * 1000).toISOString();
}

async function sendHostedPublish(snapshot: LocalPublishPayload): Promise<PublishLocalResponse> {
  const hostedBase = connectedPublishBase(store.db);
  const publishToken = await readPublishToken();
  if (!publishToken) throw new Error('Connect publishing before sending data.');
  const payload = JSON.stringify(snapshot);
  if (Buffer.byteLength(payload) > LOCAL_PUBLISH_BODY_LIMIT_BYTES) {
    throw new Error('Your aggregate export exceeds the 32 MB publishing limit.');
  }
  const response = await publishFetch(`${hostedBase}/api/publish/local`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${publishToken}` },
    body: payload,
  });
  const body = await response.json() as PublishLocalResponse & { error?: { message?: string } };
  if (!response.ok) {
    if (response.status === 401) {
      savePublishConnection(store.db, { ...readPublishConnection(store.db)!, expires_at: new Date(0).toISOString() });
    }
    throw new Error(body?.error?.message ?? 'Could not publish local aggregates.');
  }
  const sentAt = new Date().toISOString();
  writeSyncState(store.db, 'last_publish_response', body);
  writeSyncState(store.db, 'last_publish_status', null);
  writeSyncState(store.db, 'last_publish_sent_at', sentAt);
  upsertPublishHistory(publishHistoryEntryFromResponse(body, hostedBase, sentAt));
  return body;
}

async function runScheduledUpdate(
  reason: LocalScheduleStatus['last_reason'],
  options: { hostedApiBase?: string; operationId?: string } = {},
): Promise<LocalScheduleStatus> {
  if (scheduleRunning || manualIngestRunning) {
    return readScheduleStatus();
  }

  scheduleRunning = true;
  const config = readScheduleConfig();
  const startedAt = new Date().toISOString();
  updateScheduleStatus({
    config,
    running: true,
    last_run_at: startedAt,
    last_error: null,
    last_reason: reason,
  });

  try {
    seedBundledPricing(store.db);
    if (options.operationId) updateOperation(store.db, options.operationId, {
      stage: 'discovering_files', progressPercent: 10, message: 'Finding local usage files.',
    });
    const files = await discoverUsageFiles();
    const ingestResult = await ingestUsageFiles(store.db, files, {
      runId: options.operationId,
      onProgress: options.operationId
        ? (progress) => {
          if (progress.stage === 'usage_ready') updateScheduleStatus({ usage_updated_at: new Date().toISOString() });
          if (progress.stage === 'reading_files') {
            updateOperation(store.db, options.operationId!, {
              stage: 'importing_usage',
              progressPercent: progressFromCounts(progress.files_scanned, progress.files_total, 15, 45),
              current: progress.files_scanned,
              total: progress.files_total,
              message: `${progress.files_scanned.toLocaleString()} / ${progress.files_total.toLocaleString()} files scanned`,
            });
          } else if (progress.stage === 'rebuilding_rollups') {
            updateOperation(store.db, options.operationId!, {
              stage: 'rebuilding_rollups',
              progressPercent: 12,
              message: 'Reading local usage totals.',
            });
          }
        }
        : undefined,
    });
    if (options.operationId) {
      updateOperation(store.db, options.operationId, {
        stage: 'syncing_pricing',
        progressPercent: 65,
        current: 0,
        total: 0,
        message: 'Usage is ready. Checking current model prices.',
      });
    }
    // Recoverable parser notes (e.g. a reset counter handled by a delta) are not failures.
    let enrichmentError: string | null = null;
    const pricing = await syncPricingAndMaybeReprice().catch((error) => ({ last_error: error instanceof Error ? error.message : String(error) }));
    if (pricing.last_error) enrichmentError = `Usage refreshed using saved prices. Price refresh unavailable: ${pricing.last_error}`;
    const githubConnected = Boolean(getGithubIdentity(store.db));
    const githubResult = githubConnected ? await syncGithubCodeTotals(store.db, {
      onProgress: options.operationId
        ? (progress) => {
          if (progress.stage === 'matching_repos' || progress.stage === 'listing_commits') {
            updateOperation(store.db, options.operationId!, {
              stage: 'syncing_github', progressPercent: 68,
              current: progress.repos_synced, total: progress.repos_total,
              message: progress.current_repo ? `Checking GitHub commits for ${progress.current_repo}.` : 'Checking selected GitHub repositories.',
            });
          } else if (progress.stage === 'fetching_commit_details') {
            updateOperation(store.db, options.operationId!, {
              stage: 'syncing_github',
              progressPercent: progress.commits_total > 0
                ? progressFromCounts(progress.commits_processed, progress.commits_total, 70, 22)
                : 72,
              current: progress.commits_processed,
              total: progress.commits_total,
              message: 'Fetching production commit details from GitHub.',
            });
          } else if (progress.stage === 'rebuilding_links') {
            updateOperation(store.db, options.operationId!, {
              stage: 'rebuilding_links',
              progressPercent: 94,
              message: 'Rebuilding shipped-code links.',
            });
          }
        }
        : undefined,
    }).catch((error) => {
      enrichmentError = `Usage refreshed. GitHub sync unavailable: ${error instanceof Error ? error.message : String(error)}`;
      return { verified_repo_count: 0, github_total_loc: 0 };
    }) : { verified_repo_count: 0, github_total_loc: 0 };
    const githubErrors = githubConnected ? readSyncState<string[]>(store.db, 'github_repo_sync_errors', []) : [];
    if (githubErrors.length) enrichmentError = `Usage refreshed. ${githubErrors[0]}`;
    // Refreshes never grant permission to share a new snapshot.
    const published = false;

    scheduleRunning = false;
    rescheduleLocalUpdates();
    return updateScheduleStatus({
      config: readScheduleConfig(),
      running: false,
      next_run_at: nextRunAt(readScheduleConfig()),
      last_finished_at: new Date().toISOString(),
      last_error: enrichmentError,
      last_result: {
        files_seen: ingestResult.files_seen,
        events_inserted: ingestResult.events_inserted,
        events_deduped: ingestResult.events_deduped,
        github_verified_repo_count: githubResult.verified_repo_count,
        github_total_loc: githubResult.github_total_loc,
        warnings: ingestResult.warnings,
        published,
      },
    });
  } catch (error) {
    scheduleRunning = false;
    rescheduleLocalUpdates();
    return updateScheduleStatus({
      config: readScheduleConfig(),
      running: false,
      next_run_at: nextRunAt(readScheduleConfig()),
      last_finished_at: new Date().toISOString(),
      last_error: error instanceof Error ? error.message : String(error),
    });
  }
}

function startScheduleOperation(
  reason: LocalScheduleStatus['last_reason'],
  options: { hostedApiBase?: string } = {},
): { operation: LocalOperationRun; alreadyRunning: boolean } {
  const active = latestRunningOperation(store.db, 'usage_ingest') ?? latestRunningOperation(store.db, 'schedule_run');
  if (active) return { operation: active, alreadyRunning: true };
  return startBackgroundOperation({
    type: 'schedule_run',
    label: reason === 'interval' ? 'Scheduled update' : reason === 'startup' ? 'Startup update' : 'Run update now',
    stage: 'queued',
    message: 'Queued local update.',
  }, async (operation) => {
    const status = await runScheduledUpdate(reason, {
      hostedApiBase: options.hostedApiBase,
      operationId: operation.operation_id,
    });
    if (status.last_error) {
      throw new Error(status.last_error);
    }
    return {
      files_seen: status.last_result?.files_seen ?? 0,
      events_inserted: status.last_result?.events_inserted ?? 0,
      events_deduped: status.last_result?.events_deduped ?? 0,
      github_verified_repo_count: status.last_result?.github_verified_repo_count ?? 0,
      github_total_loc: status.last_result?.github_total_loc ?? 0,
      published: status.last_result?.published ?? false,
    };
  });
}

function rescheduleLocalUpdates(): void {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }

  const config = readScheduleConfig();
  updateScheduleStatus({
    config,
    running: scheduleRunning,
    next_run_at: nextRunAt(config),
  });
  if (!config.enabled) return;

  scheduleTimer = setTimeout(() => {
    startScheduleOperation('interval');
    rescheduleLocalUpdates();
  }, config.interval_minutes * 60 * 1000);
}

function startupDiscoveryEnabled(): boolean {
  if (process.env.TOKENSRANK_LOCAL_STARTUP_REFRESH === 'true') return true;
  if (process.env.TOKENSRANK_LOCAL_STARTUP_REFRESH === 'false') return false;
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return false;
  return true;
}

async function refreshStartupDiscovery(fastify: FastifyInstance): Promise<void> {
  if (startupRefreshRunning) return;
  startupRefreshRunning = true;
  startScheduleOperation('startup');

  try {
    const [repos, usageFiles] = await Promise.all([
      discoverLocalRepos(),
      discoverUsageFiles(),
    ]);
    upsertDiscoveredRepos(store.db, repos);
    const pricing = await syncPricingAndMaybeReprice();
    fastify.log.info({
      event: 'local.startup_refresh.completed',
      repo_count: repos.length,
      usage_file_count: usageFiles.length,
      pricing_rows: pricing.row_count,
      pricing_source: pricing.source,
    }, 'TokensRank local startup discovery completed');
  } catch (error) {
    fastify.log.warn({
      err: error,
      event: 'local.startup_refresh.failed',
    }, 'TokensRank local startup discovery failed');
  } finally {
    startupRefreshRunning = false;
  }
}

export async function buildServer() {
  const logFile = process.env.TOKENSRANK_LOCAL_LOG_FILE || `${store.logsDir}/local-api.log`;
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      file: logFile,
    },
  });

  await fastify.register(cors, {
    origin: publicOrigins(),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });


  fastify.get('/health', async () => ({ ok: true, local: true }));
  fastify.get('/local/health', async () => ({ ok: true, local: true }));
  fastify.get('/api/local/status', async () => await getLocalSetupStatus(store));
  fastify.get('/local/setup/status', async () => await getLocalSetupStatus(store));
  async function completeOnboarding(request: FastifyRequest, reply: FastifyReply) {
    const parsed = LocalOnboardingCompleteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('schema_invalid', 'Invalid onboarding completion payload', parsed.error.flatten()));
    }
    return { data: completeLocalOnboarding(store, {
      completedVersion: parsed.data.completed_version,
      lastCompletedStep: parsed.data.last_completed_step,
    }) };
  }
  async function resetOnboarding() {
    const operation = startOperation(store.db, {
      type: 'onboarding_reset',
      label: 'Reset onboarding',
      stage: 'resetting_onboarding',
      progressPercent: 50,
      message: 'Resetting first-run wizard state.',
    });
    const onboarding = resetLocalOnboarding(store);
    const completed = completeOperation(store.db, operation.operation_id, {
      stage: 'completed',
      message: 'Onboarding wizard reset.',
      result: { completed_at: onboarding.completed_at },
    }) ?? operation;
    return { data: { onboarding, operation: completed } };
  }
  fastify.post('/api/local/onboarding/complete', completeOnboarding);
  fastify.post('/local/onboarding/complete', completeOnboarding);
  fastify.post('/api/local/onboarding/reset', resetOnboarding);
  fastify.post('/local/onboarding/reset', resetOnboarding);
  fastify.get('/api/local/operations', async () => ({ data: listOperationRuns(store.db) }));
  fastify.get('/local/operations', async () => ({ data: listOperationRuns(store.db) }));
  fastify.get('/api/local/schedule/status', async () => readScheduleStatus());
  fastify.get('/local/schedule/status', async () => readScheduleStatus());
  fastify.get('/api/local/version', async () => readVersionStatus());
  fastify.get('/local/version', async () => readVersionStatus());
  async function checkVersionRoute(_request: FastifyRequest, reply: FastifyReply) {
    const operation = startOperation(store.db, {
      type: 'version_check',
      label: 'Check updates',
      stage: 'checking_updates',
      progressPercent: 20,
      message: 'Checking package registry for newer local app versions.',
    });
    try {
      const status = await refreshVersionStatus();
      const completed = completeOperation(store.db, operation.operation_id, {
        stage: 'completed',
        message: status.update_available ? 'Update available.' : 'Local app is current.',
        result: {
          package_name: status.package_name,
          current_version: status.current_version,
          latest_version: status.latest_version,
          update_available: status.update_available,
        },
      }) ?? operation;
      return { data: { version: status, operation: completed } };
    } catch (error) {
      const failed = failOperation(store.db, operation.operation_id, error, {
        stage: 'failed',
        message: 'Could not check for updates.',
      }) ?? operation;
      return reply.code(400).send(errorEnvelope(
        'version_check_failed',
        error instanceof Error ? error.message : 'Could not check for updates.',
        { operation: failed },
      ));
    }
  }
  fastify.post('/api/local/version/check', checkVersionRoute);
  fastify.post('/local/version/check', checkVersionRoute);

  async function updateScheduleConfig(request: FastifyRequest, reply: FastifyReply) {
    const parsed = ScheduleConfigBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('schema_invalid', 'Invalid schedule config payload', parsed.error.flatten()));
    }

    const nextConfig: LocalScheduleConfig = {
      ...readScheduleConfig(),
      ...parsed.data,
      auto_publish: false,
    };
    updateLocalScheduleConfig(store.configPath, nextConfig);
    writeSyncState(store.db, 'local_schedule_config', nextConfig);
    rescheduleLocalUpdates();
    return readScheduleStatus();
  }

  fastify.patch('/api/local/schedule/config', updateScheduleConfig);
  fastify.patch('/local/schedule/config', updateScheduleConfig);

  async function runScheduleNow(request: FastifyRequest, reply: FastifyReply) {
    const parsed = ScheduleRunBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('schema_invalid', 'Invalid schedule run payload', parsed.error.flatten()));
    }
    const { operation, alreadyRunning } = startScheduleOperation('manual', { hostedApiBase: parsed.data.hosted_api_base });
    return reply.code(202).send(operationEnvelope(operation, alreadyRunning));
  }

  fastify.post('/api/local/schedule/run', runScheduleNow);
  fastify.post('/local/schedule/run', runScheduleNow);

  fastify.post('/local/auth/github/device/start', async (_request, reply) => {
    try {
      return await startGithubDeviceFlow(store.db);
    } catch (error) {
      return reply.code(400).send(errorEnvelope(
        'github_device_start_failed',
        error instanceof Error ? error.message : 'Could not start GitHub Device Flow',
      ));
    }
  });

  fastify.get('/local/auth/github/device/status', async (_request, reply) => {
    try {
      return await pollGithubDeviceFlow(store.db);
    } catch (error) {
      return reply.code(400).send(errorEnvelope(
        'github_device_status_failed',
        error instanceof Error ? error.message : 'Could not poll GitHub Device Flow',
      ));
    }
  });

  fastify.post('/api/local/github/token', async (request, reply) => {
    if (!localTokenAuthEnabled()) {
      return reply.code(404).send(errorEnvelope(
        'github_token_auth_disabled',
        'Local GitHub token auth is disabled. Use GitHub Device Flow.',
      ));
    }

    const parsed = TokenBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('schema_invalid', 'Invalid GitHub token payload', parsed.error.flatten()));
    }

    const token = parsed.data.token ?? process.env.GITHUB_DEV_TOKEN;
    if (!token) {
      return reply.code(400).send(errorEnvelope('github_token_missing', 'Provide a token or set GITHUB_DEV_TOKEN locally.'));
    }

    const identity = await connectGithubWithToken(store.db, token);
    return { data: identity };
  });

  async function discover() {
    const repos = await discoverLocalRepos();
    upsertDiscoveredRepos(store.db, repos);
    return {
      data: {
        usage_files: (await discoverUsageFiles()).length,
        repos: listStoredRepos(store.db),
      },
    };
  }

  fastify.post('/api/local/discover', discover);
  fastify.get('/local/discovery', discover);
  async function runDiscovery(_request: FastifyRequest, reply: FastifyReply) {
    const { operation, alreadyRunning } = startBackgroundOperation({
      type: 'discover',
      label: 'Discover folders',
      stage: 'queued',
      message: 'Queued local discovery.',
    }, runDiscoveryOperation);
    return reply.code(202).send(operationEnvelope(operation, alreadyRunning));
  }
  fastify.post('/api/local/discover/run', runDiscovery);
  fastify.post('/local/discovery/run', runDiscovery);

  async function updateRepoSelection(request: FastifyRequest, reply: FastifyReply) {
    const parsed = RepoSelectionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('schema_invalid', 'Invalid repo selection payload', parsed.error.flatten()));
    }

    const operation = startOperation(store.db, {
      type: 'repo_selection',
      label: 'Save repos',
      stage: 'saving_repos',
      progressPercent: 20,
      message: 'Saving selected repos and production branches.',
    });
    try {
      const stmt = store.db.prepare(`
        UPDATE local_repos
        SET selected = ?, prod_branch = COALESCE(?, prod_branch), updated_at = datetime('now')
        WHERE id = ?
      `);
      const write = store.db.transaction(() => {
        for (const repo of parsed.data.repos) {
          stmt.run(repo.selected ? 1 : 0, repo.prod_branch ?? null, repo.id);
        }
      });
      write();
      updateOperation(store.db, operation.operation_id, {
        stage: 'rebuilding_links',
        progressPercent: 70,
        message: 'Rebuilding local code links for selected repos.',
      });
      rebuildAiCommitLinks(store.db);
      rebuildLocalProfileSummary(store.db);
      const completed = completeOperation(store.db, operation.operation_id, {
        stage: 'completed',
        message: 'Repo selection saved.',
        result: { repos: parsed.data.repos.length },
      }) ?? operation;
      return { data: { repos: listStoredRepos(store.db), operation: completed } };
    } catch (error) {
      const failed = failOperation(store.db, operation.operation_id, error, {
        stage: 'failed',
        message: 'Could not save repo selection.',
      }) ?? operation;
      return reply.code(400).send(errorEnvelope(
        'repo_selection_failed',
        error instanceof Error ? error.message : 'Could not save repo selection.',
        { operation: failed },
      ));
    }
  }

  fastify.patch('/api/local/repos', updateRepoSelection);
  fastify.post('/local/repos/selection', updateRepoSelection);

  fastify.post('/api/local/pricing/sync', async (_request, reply) => {
    const { operation, alreadyRunning } = startBackgroundOperation({
      type: 'pricing_sync',
      label: 'Sync pricing',
      stage: 'queued',
      message: 'Queued pricing sync.',
    }, runPricingOperation);
    return reply.code(202).send(operationEnvelope(operation, alreadyRunning));
  });
  fastify.post('/local/reference/pricing/sync', async (_request, reply) => {
    const { operation, alreadyRunning } = startBackgroundOperation({
      type: 'pricing_sync',
      label: 'Sync pricing',
      stage: 'queued',
      message: 'Queued pricing sync.',
    }, runPricingOperation);
    return reply.code(202).send(operationEnvelope(operation, alreadyRunning));
  });
  fastify.get('/local/reference/pricing/status', async () => {
    const status = await getLocalSetupStatus(store);
    return { data: status.pricing };
  });

  async function runIngest(request: FastifyRequest, reply: FastifyReply) {
    const parsed = IngestBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('schema_invalid', 'Invalid ingest payload', parsed.error.flatten()));
    }

    if (manualIngestRunning || scheduleRunning) {
      const operation = latestRunningOperation(store.db, scheduleRunning ? 'schedule_run' : 'usage_ingest');
      return reply.code(202).send({
        data: {
          operation,
          operation_id: operation?.operation_id ?? null,
          status: operation?.status ?? 'running',
          already_running: true,
        },
      });
    }

    const { operation, alreadyRunning } = startBackgroundOperation({
      type: 'usage_ingest',
      label: 'Import usage',
      stage: 'queued',
      message: 'Queued usage import.',
    }, async (operationRun) => await runUsageIngestOperation(operationRun, parsed.data.file_paths));
    if (!alreadyRunning) {
      request.log.info({ event: 'local.ingest.started', operation_id: operation.operation_id }, 'TokensRank local ingestion started');
    }
    return reply.code(202).send(operationEnvelope(operation, alreadyRunning));
  }

  fastify.post('/api/local/ingest', runIngest);
  fastify.post('/local/ingest/run', runIngest);
  fastify.get('/local/ingest/runs', async () => {
    const rows = store.db.prepare(`
      SELECT run_id, status, started_at, finished_at, usage_day_count, session_count, code_day_count, error
      FROM ingestion_runs
      ORDER BY started_at DESC
      LIMIT 25
    `).all();
    return { data: rows };
  });

  async function syncGithub(_request: FastifyRequest, reply: FastifyReply) {
    const { operation, alreadyRunning } = startBackgroundOperation({
      type: 'github_sync',
      label: 'Sync shipped code',
      stage: 'queued',
      message: 'Queued shipped-code sync.',
    }, runGithubSyncOperation);
    return reply.code(202).send(operationEnvelope(operation, alreadyRunning));
  }

  fastify.post('/api/local/github/sync', syncGithub);
  fastify.post('/local/github/sync', syncGithub);

  fastify.get('/api/local/publish/payload', async (_request, reply) => {
    try {
      return { data: buildPublishPayload(store.db) };
    } catch (error) {
      return reply.code(400).send(errorEnvelope(
        'publish_payload_failed',
        error instanceof Error ? error.message : 'Could not build publish payload',
      ));
    }
  });
  fastify.get('/local/publish/preview', async (_request, reply) => {
    try {
      return { data: buildPublishPayload(store.db) };
    } catch (error) {
      return reply.code(400).send(errorEnvelope(
        'publish_preview_failed',
        error instanceof Error ? error.message : 'Could not build publish preview',
      ));
    }
  });

  fastify.get('/local/publish/status', async () => {
    const publishToken = await readPublishToken();
    let connection = readPublishConnection(store.db);
    let connectionStatus = !connection || connection.disconnected || !publishToken ? 'disconnected'
      : connection.expires_at && Date.parse(connection.expires_at) <= Date.now() ? 'expired' : 'connected';
    let connectionError: string | null = null;
    const lastResponse = readSyncState<PublishLocalResponse | null>(store.db, 'last_publish_response', null);
    const lastRunId = lastResponse?.data.publish_run_id;
    let hostedStatus = readSyncState<HostedPublishStatus | null>(store.db, 'last_publish_status', null);
    if (connectionStatus === 'connected' && connection) {
      try {
        const headers = { Accept: 'application/json', Authorization: `Bearer ${publishToken}` };
        const health = await publishFetch(`${connection.hosted_api_base}/api/publish/token/status`, { headers });
        const body = await health.json() as { data?: { expires_at: string; public_profile_url: string | null }; error?: { message?: string } };
        if (!health.ok || !body.data) {
          if (health.status === 401) {
            connectionStatus = 'expired';
            connection = { ...connection, expires_at: new Date(0).toISOString() };
            savePublishConnection(store.db, connection);
          }
          throw new Error(body.error?.message ?? 'Cannot check the publishing connection.');
        }
        connection = { ...connection, ...body.data };
        savePublishConnection(store.db, connection);
        if (lastRunId) {
          const response = await publishFetch(`${connection.hosted_api_base}/api/publish/local/runs/${lastRunId}`, { headers });
          const statusBody = await response.json() as HostedPublishStatus;
          if (!response.ok) throw new Error(statusBody.error?.message ?? 'Cannot check publication progress.');
          hostedStatus = statusBody;
          writeSyncState(store.db, 'last_publish_status', hostedStatus);
          updatePublishHistoryFromHostedStatus(lastRunId, hostedStatus);
        }
      } catch (error) {
        if (connectionStatus === 'connected') connectionStatus = 'unreachable';
        connectionError = error instanceof Error ? error.message : String(error);
      }
    }
    return { data: {
      token_connected: connectionStatus === 'connected', connection_status: connectionStatus,
      connection_error: connectionError, expires_at: connection?.expires_at ?? null,
      public_profile_url: connection?.public_profile_url ?? null,
      hosted_dashboard_url: new URL('/me', connection?.public_profile_url ?? process.env.TOKENSRANK_HOSTED_SITE_URL ?? 'https://tokensrank.ai').href,
      hosted_api_base: hostedApiBase(), last_response: lastResponse, hosted_status: hostedStatus,
      publish_history: readPublishHistory(),
    } };
  });

  fastify.post('/local/publish/disconnect', async () => {
    const connection = readPublishConnection(store.db);
    const token = await readPublishToken();
    let remoteRevoked = true;
    if (connection && !connection.disconnected && token) {
      try {
        const response = await publishFetch(`${connection.hosted_api_base}/api/publish/token/revoke`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok && response.status !== 401) throw new Error('The dashboard could not revoke this connection. Try again.');
      } catch { remoteRevoked = false; }
    }
    await clearSecret('publish');
    savePublishConnection(store.db, { hosted_api_base: hostedApiBase(), expires_at: null, public_profile_url: null, disconnected: true });
    writeSyncState(store.db, 'last_publish_response', null);
    writeSyncState(store.db, 'last_publish_status', null);
    return { data: { disconnected: true, remote_revoked: remoteRevoked } };
  });

  fastify.post('/local/publish/connect', async (request, reply) => {
    const parsed = PublishConnectBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('schema_invalid', 'Invalid publish connect payload', parsed.error.flatten()));
    }

    const hostedBase = hostedApiBase(parsed.data.hosted_api_base);
    const response = await publishFetch(`${hostedBase}/api/publish/link/exchange`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: parsed.data.code,
      }),
    });
    const body = await response.json() as { data?: { publish_token?: string; github_user_id?: number; expires_at?: string; public_profile_url?: string | null }; error?: { message?: string } };
    if (!response.ok || !body.data?.publish_token) {
      return reply.code(response.status || 400).send(errorEnvelope(
        'publish_connect_failed',
        body.error?.message ?? 'Could not exchange publish code.',
      ));
    }

    const tokenRef = await storeSecret('publish', body.data.publish_token);
    savePublishConnection(store.db, { hosted_api_base: hostedBase, expires_at: body.data.expires_at ?? null, public_profile_url: body.data.public_profile_url ?? null, github_user_id: body.data.github_user_id });
    writeSyncState(store.db, 'last_publish_response', null);
    writeSyncState(store.db, 'last_publish_status', null);
    return {
      data: {
        token_ref: tokenRef,
        expires_at: body.data.expires_at,
      },
    };
  });

  fastify.post('/local/publish/receipt', async (request, reply) => {
    const parsed = z.object({ include_code: z.boolean().default(false) }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorEnvelope('schema_invalid', 'Choose what to include in your receipt.'));
    try {
      const connection = readPublishConnection(store.db);
      const base = connectedPublishBase(store.db);
      const token = await readPublishToken();
      if (!token) throw new Error('Connect your account first.');
      const payload = buildPublishPayload(store.db, { includeCode: parsed.data.include_code, githubUserId: connection?.github_user_id });
      const fingerprint = createHash('sha256').update(base + token).digest('hex');
      return { data: { ...publishReceipts.create(payload, fingerprint), public_profile_url: connection?.public_profile_url, destination: base } };
    } catch (error) {
      return reply.code(400).send(errorEnvelope('receipt_failed', error instanceof Error ? error.message : String(error)));
    }
  });

  fastify.post('/local/publish/send', async (request, reply) => {
    const parsed = PublishSendBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('schema_invalid', 'Invalid publish send payload', parsed.error.flatten()));
    }

    try {
      const connection = connectedPublishBase(store.db);
      const token = await readPublishToken();
      if (!token) throw new Error('Connect your account first.');
      const fingerprint = createHash('sha256').update(connection + token).digest('hex');
      return await sendHostedPublish(publishReceipts.take(parsed.data.receipt_id, fingerprint));
    } catch (error) {
      return reply.code(400).send(errorEnvelope('publish_failed', error instanceof Error ? error.message : String(error)));
    }
  });

  fastify.get('/api/profile/:handle', async (request) => {
    return buildLocalProfile(store.db, { window: requestedProfileWindow(request) });
  });
  fastify.get('/local/profile', async (request) => {
    return buildLocalProfile(store.db, { window: requestedProfileWindow(request) });
  });

  fastify.get('/local/publish/presence', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { data: await readPublicPresence(readPublishConnection(store.db)) };
  });

  fastify.addHook('onClose', async () => {
    if (scheduleTimer) {
      clearTimeout(scheduleTimer);
      scheduleTimer = null;
    }
    store.close();
  });

  rescheduleLocalUpdates();
  refreshVersionStatusIfStale();
  if (startupDiscoveryEnabled()) {
    void refreshStartupDiscovery(fastify);
  }

  return fastify;
}

async function start() {
  const fastify = await buildServer();
  await fastify.listen({ host: HOST, port: PORT });
  fastify.log.info({ host: HOST, port: PORT }, 'TokensRank local API started');
}

if (process.env.START_FASTIFY === 'true' || (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true')) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
