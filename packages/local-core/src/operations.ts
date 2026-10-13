import { randomUUID } from 'node:crypto';

import type { LocalOperationRun, LocalOperationStatus, LocalOperationType } from '@tokensrank/shared';

import type { LocalDatabase } from './db.js';
import { nowIso, readJson } from './db.js';

type OperationRow = Omit<LocalOperationRun, 'result'> & {
  result_json: string | null;
};

export type StartOperationInput = {
  operationId?: string;
  type: LocalOperationType;
  label: string;
  stage?: string;
  progressPercent?: number | null;
  current?: number | null;
  total?: number | null;
  message?: string | null;
};

export type UpdateOperationInput = {
  status?: LocalOperationStatus;
  stage?: string;
  progressPercent?: number | null;
  current?: number | null;
  total?: number | null;
  message?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  finishedAt?: string | null;
};

function clampProgress(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function toOperationRun(row: OperationRow): LocalOperationRun {
  return {
    operation_id: row.operation_id,
    type: row.type,
    label: row.label,
    status: row.status,
    stage: row.stage,
    progress_percent: row.progress_percent,
    current: row.current,
    total: row.total,
    message: row.message,
    result: readJson<Record<string, unknown> | null>(row.result_json, null),
    error: row.error,
    started_at: row.started_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
}

export function startOperation(db: LocalDatabase, input: StartOperationInput): LocalOperationRun {
  const now = nowIso();
  const operationId = input.operationId ?? randomUUID();
  db.prepare(`
    INSERT INTO operation_runs (
      operation_id, type, label, status, stage, progress_percent, current, total,
      message, result_json, error, started_at, updated_at, finished_at
    )
    VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, '{}', NULL, ?, ?, NULL)
  `).run(
    operationId,
    input.type,
    input.label,
    input.stage ?? 'starting',
    clampProgress(input.progressPercent ?? 0),
    input.current ?? null,
    input.total ?? null,
    input.message ?? null,
    now,
    now,
  );
  return getOperationRun(db, operationId)!;
}

export function updateOperation(db: LocalDatabase, operationId: string, input: UpdateOperationInput): LocalOperationRun | null {
  const current = getOperationRun(db, operationId);
  if (!current) return null;
  const nextStatus = input.status ?? current.status;
  const nextFinishedAt = input.finishedAt !== undefined
    ? input.finishedAt
    : ['completed', 'failed', 'interrupted'].includes(nextStatus)
      ? (current.finished_at ?? nowIso())
      : current.finished_at;

  db.prepare(`
    UPDATE operation_runs
    SET status = ?,
      stage = ?,
      progress_percent = ?,
      current = ?,
      total = ?,
      message = ?,
      result_json = ?,
      error = ?,
      updated_at = ?,
      finished_at = ?
    WHERE operation_id = ?
  `).run(
    nextStatus,
    input.stage ?? current.stage,
    clampProgress(input.progressPercent !== undefined ? input.progressPercent : current.progress_percent),
    input.current !== undefined ? input.current : current.current,
    input.total !== undefined ? input.total : current.total,
    input.message !== undefined ? input.message : current.message,
    JSON.stringify(input.result !== undefined ? input.result : current.result ?? {}),
    input.error !== undefined ? input.error : current.error,
    nowIso(),
    nextFinishedAt,
    operationId,
  );
  return getOperationRun(db, operationId);
}

export function completeOperation(
  db: LocalDatabase,
  operationId: string,
  input: Omit<UpdateOperationInput, 'status' | 'error' | 'finishedAt'> = {},
): LocalOperationRun | null {
  return updateOperation(db, operationId, {
    ...input,
    status: 'completed',
    progressPercent: input.progressPercent ?? 100,
    error: null,
    finishedAt: nowIso(),
  });
}

export function failOperation(
  db: LocalDatabase,
  operationId: string,
  error: unknown,
  input: Omit<UpdateOperationInput, 'status' | 'error' | 'finishedAt'> = {},
): LocalOperationRun | null {
  return updateOperation(db, operationId, {
    ...input,
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
    finishedAt: nowIso(),
  });
}

export function getOperationRun(db: LocalDatabase, operationId: string): LocalOperationRun | null {
  const row = db.prepare(`
    SELECT operation_id, type, label, status, stage, progress_percent,
      current, total, message, result_json, error, started_at, updated_at, finished_at
    FROM operation_runs
    WHERE operation_id = ?
  `).get(operationId) as OperationRow | undefined;
  return row ? toOperationRun(row) : null;
}

export function listOperationRuns(db: LocalDatabase, limit = 25): LocalOperationRun[] {
  const rows = db.prepare(`
    SELECT operation_id, type, label, status, stage, progress_percent,
      current, total, message, result_json, error, started_at, updated_at, finished_at
    FROM operation_runs
    ORDER BY
      CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
      updated_at DESC
    LIMIT ?
  `).all(limit) as OperationRow[];
  return rows.map(toOperationRun);
}

export function latestRunningOperation(db: LocalDatabase, type: LocalOperationType): LocalOperationRun | null {
  const row = db.prepare(`
    SELECT operation_id, type, label, status, stage, progress_percent,
      current, total, message, result_json, error, started_at, updated_at, finished_at
    FROM operation_runs
    WHERE type = ?
      AND status IN ('queued', 'running')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(type) as OperationRow | undefined;
  return row ? toOperationRun(row) : null;
}

export function markInterruptedOperationRuns(db: LocalDatabase): number {
  const now = nowIso();
  const result = db.prepare(`
    UPDATE operation_runs
    SET status = 'interrupted',
      stage = 'interrupted',
      message = COALESCE(message, 'Local API stopped before this operation finished.'),
      error = COALESCE(error, 'Local API stopped before this operation finished.'),
      updated_at = ?,
      finished_at = COALESCE(finished_at, ?)
    WHERE status IN ('queued', 'running')
  `).run(now, now);
  return result.changes;
}
