import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  discover: vi.fn(),
  github: vi.fn(),
  pricing: vi.fn(),
  identity: vi.fn(),
}));
vi.mock("@tokensrank/local-core", async (actual) => ({
  ...(await actual<typeof import("@tokensrank/local-core")>()),
  discoverLocalRepos: async () => [],
  discoverUsageFiles: mocks.discover,
  ingestUsageFiles: mocks.ingest,
  syncGithubCodeTotals: mocks.github,
  syncModelPricingLocalSafe: mocks.pricing,
  getGithubIdentity: mocks.identity,
}));
let app:
  | Awaited<ReturnType<(typeof import("./server.js"))["buildServer"]>>
  | undefined;
let dataDir: string;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});
async function setup(startup = false) {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.identity.mockReturnValue(null);
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tokensrank-schedule-"));
  vi.stubEnv("TOKENSRANK_DATA_DIR", dataDir);
  vi.stubEnv("TOKENSRANK_LOCAL_STARTUP_REFRESH", String(startup));
  vi.stubEnv("TOKENSRANK_LOCAL_UPDATE_CHECK", "false");
  mocks.discover.mockResolvedValue(["/local/example.jsonl"]);
  mocks.ingest.mockResolvedValue({
    files_seen: 1,
    events_inserted: 2,
    events_deduped: 3,
    warnings: [],
  });
  mocks.github.mockResolvedValue({
    verified_repo_count: 0,
    github_total_loc: 0,
  });
  mocks.pricing.mockResolvedValue({ row_count: 0, source: "cached" });
  app = await (await import("./server.js")).buildServer();
  await app.ready();
  return app;
}
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("local refresh lifecycle", () => {
  it('skips optional GitHub sync until an account is connected', async () => {
    await setup();
    await app!.inject({ method: 'POST', url: '/local/schedule/run', payload: {} });
    await settle();
    expect(mocks.github).not.toHaveBeenCalled();
    expect((await app!.inject('/local/schedule/status')).json().last_error).toBeNull();
  });
  it('refreshes GitHub code when a local account is connected', async () => {
    await setup();
    mocks.identity.mockReturnValue({ github_user_id: 1, login: 'connected', avatar_url: null, verified_emails: [], connected_at: '2026-09-14T00:00:00Z' });
    await app!.inject({ method: 'POST', url: '/local/schedule/run', payload: {} });
    await settle();
    expect(mocks.github).toHaveBeenCalledTimes(1);
  });
  it('refuses automatic publishing even if an old client enables it', async () => {
    await setup();
    const response = await app!.inject({ method: 'PATCH', url: '/local/schedule/config', payload: { auto_publish: true } });
    expect(response.statusCode).toBe(200);
    await app!.inject({ method: 'POST', url: '/local/schedule/run', payload: {} });
    await settle();
    const status = (await app!.inject('/local/schedule/status')).json();
    expect(status.config.auto_publish).toBe(false);
    expect(status.last_result.published).toBe(false);
  });
  it("imports on startup, rather than only discovering files", async () => {
    await setup(true);
    await settle();
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(
      (await app!.inject("/local/schedule/status")).json().last_reason,
    ).toBe("startup");
  });
  it("runs periodically, prevents overlap with manual import, and can be paused", async () => {
    await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await app!.inject({
      method: "PATCH",
      url: "/local/schedule/config",
      payload: { enabled: true, interval_minutes: 15 },
    });
    let resolveImport!: (value: unknown) => void;
    mocks.ingest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    );
    const manual = (
      await app!.inject({
        method: "POST",
        url: "/local/ingest/run",
        payload: {},
      })
    ).json();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    const schedule = (
      await app!.inject({
        method: "POST",
        url: "/local/schedule/run",
        payload: {},
      })
    ).json();
    expect(schedule.data.already_running).toBe(true);
    expect(schedule.data.operation_id).toBe(manual.data.operation_id);
    resolveImport({
      files_seen: 1,
      events_inserted: 2,
      events_deduped: 0,
      warnings: [],
    });
    await settle();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
    const status = (await app!.inject("/local/schedule/status")).json();
    expect(status).toMatchObject({
      last_reason: "interval",
      running: false,
      last_error: null,
    });
    expect(Date.parse(status.next_run_at)).toBe(Date.now() + 15 * 60_000);
    await app!.inject({
      method: "PATCH",
      url: "/local/schedule/config",
      payload: { enabled: false },
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
  });
  it('records recovered parser notes without falsely failing the update', async () => {
    await setup();
    mocks.ingest.mockResolvedValue({ files_seen: 1, events_inserted: 2, events_deduped: 0, warnings: ['Codex cumulative token counter reset; used last_token_usage for that line.'] });
    await app!.inject({ method: 'POST', url: '/local/schedule/run', payload: {} }); await settle();
    const status = (await app!.inject('/local/schedule/status')).json();
    expect(status.last_error).toBeNull();
    expect(status.last_result.warnings).toHaveLength(1);
    const operations = (await app!.inject('/local/operations')).json().data;
    expect(operations[0].status).toBe('completed');
  });
  it("refreshes local totals before network services, and retains an honest partial result", async () => {
    await setup();
    mocks.pricing.mockRejectedValue(new Error("offline"));
    mocks.github.mockRejectedValue(new Error("offline"));
    await app!.inject({
      method: "POST",
      url: "/local/schedule/run",
      payload: {},
    });
    await settle();
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pricing.mock.invocationCallOrder[0]!,
    );
    const status = (await app!.inject("/local/schedule/status")).json();
    expect(status.last_result.events_inserted).toBe(2);
    expect(status.last_error).toContain("Usage refreshed");
  });
});
