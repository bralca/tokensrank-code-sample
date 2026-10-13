'use strict';

const releaseRoot = process.env.TOKENSRANK_RELEASE_ROOT || '/srv/tokensrank';
const logRoot = process.env.TOKENSRANK_LOG_ROOT || '/var/log/tokensrank';

module.exports = {
  apps: [
    {
      name: 'tokensrank-web',
      cwd: `${releaseRoot}/apps/web`,
      script: './node_modules/next/dist/bin/next',
      args: 'start',
      instances: 1,
      exec_mode: 'fork',
      env_file: '/etc/tokensrank/web.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '127.0.0.1',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      max_memory_restart: '400M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      kill_timeout: 10000,
      out_file: `${logRoot}/web.out.log`,
      error_file: `${logRoot}/web.err.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: false,
      time: true,
    },
    {
      name: 'tokensrank-api',
      cwd: `${releaseRoot}/apps/api`,
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env_file: '/etc/tokensrank/api.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
        HOST: '127.0.0.1',
      },
      max_memory_restart: '300M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      kill_timeout: 10000,
      out_file: `${logRoot}/api.out.log`,
      error_file: `${logRoot}/api.err.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: false,
      time: true,
    },
  ],
};
