import './load-env.mjs';
import { checkPublishingSetup } from './check-publishing-setup.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// Both applications run on this computer. The public API uses the existing
// Supabase settings in .env.local; the local API uses its existing SQLite store.
const children = [];
for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!process.env[key]) throw new Error(`Configure ${key} in .env.local before starting both dashboards.`);
}
for (const port of [3100, 3101, 3200, 3201]) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', () => reject(new Error(`Port ${port} is already in use. Stop the existing dashboard preview first.`)));
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}
await checkPublishingSetup();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
function start(name, args, env) {
  const child = spawn('pnpm', args, { stdio: 'inherit', detached: process.platform !== 'win32', env: { ...process.env, NODE_ENV: 'development', ...env } });
  children.push(child);
  child.on('error', (error) => { console.error(`${name}: ${error.message}`); process.exitCode = 1; stop(); });
  child.on('exit', (code) => { if (!stopping) { process.exitCode = code || 1; stop(); } });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
start('Local API', ['--filter', '@tokensrank/local-api', 'exec', 'tsx', 'watch', 'src/server.ts'], {
  HOST: '127.0.0.1', LOCAL_API_PORT: '3101', NEXT_PUBLIC_SITE_URL: 'http://localhost:3100',
  TOKENSRANK_HOSTED_API_BASE: 'http://localhost:3201',
  TOKENSRANK_HOSTED_SITE_URL: 'http://localhost:3200',
});
start('Public API', ['--filter', '@tokensrank/api', 'exec', 'tsx', 'watch', 'src/server.ts'], {
  PORT: '3201', HOST: '127.0.0.1', NEXT_PUBLIC_SITE_URL: 'http://localhost:3200',
  ALLOWED_ORIGINS: 'http://localhost:3200,http://127.0.0.1:3200',
});
for (const [name, webPort, apiPort] of [['local', 3100, 3101], ['public', 3200, 3201]]) {
  start(`${name} web`, ['--filter', '@tokensrank/web', 'exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', String(webPort)], {
    NEXT_PUBLIC_API_BASE: `http://localhost:${apiPort}`, NEXT_PUBLIC_SITE_URL: `http://localhost:${webPort}`,
    NEXT_PUBLIC_LOCAL_APP_URL: 'http://localhost:3100', NEXT_PUBLIC_APP_MODE: name,
    TOKENSRANK_WEB_DIST_DIR: `.next-${name}`,
  });
}
console.log('Local dashboard: http://localhost:3100/local/profile');
console.log('Public dashboard: http://localhost:3200/me (uses your configured Supabase project)');
