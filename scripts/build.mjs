import { spawnSync } from 'node:child_process';
import './load-env.mjs';

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    // A local .env may select development; Next production builds must not inherit it.
    env: { ...process.env, NODE_ENV: 'production' },
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const target = process.argv.slice(2).find((arg) => arg === 'apps/web' || arg === '@tokensrank/web');

if (target) {
  run('pnpm', ['--filter', '@tokensrank/web', 'build']);
} else {
  run('pnpm', ['-r', 'build']);
}
