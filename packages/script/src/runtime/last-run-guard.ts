import { LAST_RUN_MIN_INTERVAL_MS, type State } from './state.js';

type Logger = Pick<Console, 'info'>;

export interface LastRunGuardOptions {
  nowMs?: number;
  logger?: Logger;
  exit?: (code: number) => never;
}

export function checkLastRunGuard(
  state: State,
  force: boolean,
  firstRun: boolean,
  options: LastRunGuardOptions = {},
): void {
  if (force || firstRun || state.last_run_at === null) {
    return;
  }

  const lastRunMs = Date.parse(state.last_run_at);
  if (!Number.isFinite(lastRunMs)) {
    return;
  }

  const nowMs = options.nowMs ?? Date.now();
  const elapsedMs = nowMs - lastRunMs;

  if (elapsedMs >= LAST_RUN_MIN_INTERVAL_MS) {
    return;
  }

  const remainingSeconds = Math.ceil((LAST_RUN_MIN_INTERVAL_MS - elapsedMs) / 1_000);
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const logger = options.logger ?? console;
  logger.info(
    `[tokensrank-script] Skipping run (last_run_at within 30 minutes); elapsed=${elapsedSeconds}s remaining=${remainingSeconds}s`,
  );

  const exit = options.exit ?? ((code: number): never => process.exit(code));
  exit(0);
}
