// A real local API backed by synthetic usage in disposable SQLite storage.
// It never runs discovery/import jobs or connects to a hosted publisher.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalStore } from '../../../packages/local-core/src/db.js';
import { writeCcusageRollups, type CcusageSessionRollup } from '../../../packages/local-core/src/ccusage.js';
import { rebuildLocalProfileSummary } from '../../../packages/local-core/src/scoring.js';
import { completeLocalOnboarding } from '../../../packages/local-core/src/status.js';
import { updateLocalScheduleConfig } from '../../../packages/local-core/src/config.js';

const dataDir = await mkdtemp(join(tmpdir(), 'tokensrank-browser-'));
process.env.TOKENSRANK_DATA_DIR = dataDir;
process.env.TOKENSRANK_LOCAL_STARTUP_REFRESH = 'false';
process.env.TOKENSRANK_LOCAL_UPDATE_CHECK = 'false';
process.env.NODE_ENV = 'test';
process.env.START_FASTIFY = 'false';
process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:31770';

const store = openLocalStore({ dataDir });
const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const session: CcusageSessionRollup = {
  source: 'codex', provider: 'openai', session_id: 'browser-fixture', model: 'gpt-5.5',
  first_event_at: `${today}T10:00:00.000Z`, last_event_at: `${today}T10:10:00.000Z`,
  input_tokens: 8000, output_tokens: 4000, cache_read_tokens: 0, cache_create_tokens: 0,
  cached_tokens: 0, reasoning_tokens: 0, total_tokens: 12000,
  turns: 4, cost_usd_total: 0.06, ccusage_version: 'synthetic-browser-fixture',
};
writeCcusageRollups(store.db, {
  version: 'synthetic-browser-fixture', sessions: [session], modelSessions: [session], warnings: [],
  eventDateSources: ['claude', 'codex', 'opencode'], daily: [{ ...session, date: today }],
});
rebuildLocalProfileSummary(store.db);
completeLocalOnboarding(store);
updateLocalScheduleConfig(store.configPath, { enabled: false, interval_minutes: 15, auto_publish: false });
store.close();

const { buildServer } = await import('../src/server.js');
const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 31771 });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
