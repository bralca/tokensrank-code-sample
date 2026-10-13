# TokensRank Deployment Runbook

This runbook deploys TokensRank to one DigitalOcean Basic droplet in Frankfurt (`fra1`) with Caddy, PM2, and immutable release directories.

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Droplet Provisioning](#droplet-provisioning)
3. [DNS Setup](#dns-setup)
4. [Runtime Installation](#runtime-installation)
5. [Environment Files](#environment-files)
6. [Caddy Setup](#caddy-setup)
7. [PM2 Setup](#pm2-setup)
8. [GitHub Actions Secrets](#github-actions-secrets)
9. [Deployment Process](#deployment-process)
10. [Emergency Rollback](#emergency-rollback)
11. [Monitoring Commands](#monitoring-commands)
12. [Troubleshooting](#troubleshooting)

## Pre-Deployment Checklist

- [ ] DigitalOcean droplet is Basic, 1 vCPU, 1 GB RAM, 25 GB SSD.
- [ ] Droplet region is Frankfurt (`fra1`).
- [ ] Droplet OS is Ubuntu 22.04 LTS.
- [ ] DNS `A` record for `tokensrank.ai` points to the droplet public IP.
- [ ] DNS `A` record for `api.tokensrank.ai` points to the droplet public IP.
- [ ] DNS `CNAME` record for `www.tokensrank.ai` points to `tokensrank.ai`.
- [ ] Ports `80` and `443` are open in the DigitalOcean firewall.
- [ ] SSH access works for the deploy user using an Ed25519 key.
- [ ] Node.js 20 LTS is installed on the droplet.
- [ ] pnpm 10 is installed through Corepack.
- [ ] PM2 is installed globally.
- [ ] Caddy 2.x is installed and `caddy validate --config /etc/caddy/Caddyfile` passes.
- [ ] `/etc/tokensrank/api.env` exists with mode `0640`.
- [ ] `/etc/tokensrank/web.env` exists with mode `0640`.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` exists only in `/etc/tokensrank/api.env`.
- [ ] `ADMIN_PURGE_TOKEN` exists only in `/etc/tokensrank/api.env`.
- [ ] Supabase Prod URL and keys are copied from the Tokens Rank Prod project.
- [ ] GitHub Actions secrets are configured.
- [ ] `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, and app builds pass in CI.
- [ ] `Caddyfile`, `ecosystem.config.cjs`, `.env.production.example`, and `scripts/rollback.sh` have passed local validation.

## Droplet Provisioning

Create the droplet in the DigitalOcean UI:

```bash
# Values to use in the DigitalOcean Create Droplet screen:
# Image: Ubuntu 22.04 LTS x64
# Plan: Basic
# CPU option: Regular, 1 vCPU / 1 GB RAM / 25 GB SSD
# Region: Frankfurt, fra1
# Authentication: SSH key
# Hostname: tokensrank-prod-01
```

Connect as root for first-time setup:

```bash
ssh root@DROPLET_PUBLIC_IP
```

Create the unprivileged deploy user and directories:

```bash
adduser --disabled-password --gecos "" tokensrank
usermod -aG sudo tokensrank

install -d -o tokensrank -g tokensrank -m 0755 /srv/tokensrank-releases
install -d -o tokensrank -g tokensrank -m 0755 /var/log/tokensrank
install -d -o tokensrank -g tokensrank -m 0750 /etc/tokensrank

rsync --archive --chown=tokensrank:tokensrank ~/.ssh /home/tokensrank/
chmod 700 /home/tokensrank/.ssh
chmod 600 /home/tokensrank/.ssh/authorized_keys
```

Enable the firewall:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose
```

## DNS Setup

Configure these records at the domain registrar:

```text
tokensrank.ai      A      DROPLET_PUBLIC_IP      TTL 3600
api.tokensrank.ai  A      DROPLET_PUBLIC_IP      TTL 3600
www.tokensrank.ai  CNAME  tokensrank.ai          TTL 3600
```

Verify DNS before starting Caddy:

```bash
dig +short tokensrank.ai
dig +short api.tokensrank.ai
dig +short www.tokensrank.ai
```

Each command must resolve to the droplet IP, except `www.tokensrank.ai`, which may return the canonical name before resolving.

## Runtime Installation

Install Node.js 20, pnpm 10, PM2, and Caddy:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get update
apt-get install -y nodejs debian-keyring debian-archive-keyring apt-transport-https curl gnupg

corepack enable
corepack prepare pnpm@10 --activate
npm install -g pm2

curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

node --version
pnpm --version
pm2 --version
caddy version
```

## Environment Files

Create API and web environment files from `.env.production.example`. Use real Tokens Rank Prod values.

```bash
sudo install -o tokensrank -g tokensrank -m 0640 /dev/null /etc/tokensrank/api.env
sudo install -o tokensrank -g tokensrank -m 0640 /dev/null /etc/tokensrank/web.env
sudo nano /etc/tokensrank/api.env
sudo nano /etc/tokensrank/web.env
sudo chmod 0640 /etc/tokensrank/api.env /etc/tokensrank/web.env
sudo chown tokensrank:tokensrank /etc/tokensrank/api.env /etc/tokensrank/web.env
```

Audit permissions and service-role separation:

```bash
stat -c "%a %U:%G %n" /etc/tokensrank/api.env /etc/tokensrank/web.env
grep -n "SUPABASE_SERVICE_ROLE_KEY\|ADMIN_PURGE_TOKEN" /etc/tokensrank/api.env
! grep -n "SUPABASE_SERVICE_ROLE_KEY\|ADMIN_PURGE_TOKEN" /etc/tokensrank/web.env
```

Expected permissions output:

```text
640 tokensrank:tokensrank /etc/tokensrank/api.env
640 tokensrank:tokensrank /etc/tokensrank/web.env
```

## Caddy Setup

Copy the repo `Caddyfile` into place:

```bash
sudo cp /srv/tokensrank/Caddyfile /etc/caddy/Caddyfile
sudo chown root:root /etc/caddy/Caddyfile
sudo chmod 0644 /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Verify HTTPS and redirects after DNS propagates:

```bash
curl -I http://tokensrank.ai
curl -I https://tokensrank.ai
curl -I https://api.tokensrank.ai/healthz
curl -I https://www.tokensrank.ai
```

Expected:

- `http://tokensrank.ai` redirects to HTTPS.
- `https://www.tokensrank.ai` redirects to `https://tokensrank.ai`.
- HTTPS responses include `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, and `X-Frame-Options`.

## PM2 Setup

Start PM2 as the `tokensrank` user after the first release is deployed:

```bash
sudo -iu tokensrank
cd /srv/tokensrank
pm2 start ecosystem.config.cjs
pm2 save
exit
```

Register PM2 with systemd:

```bash
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u tokensrank --hp /home/tokensrank
sudo systemctl enable pm2-tokensrank
sudo systemctl status pm2-tokensrank --no-pager
```

Install and configure PM2 log rotation:

```bash
sudo -iu tokensrank
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
pm2 save
exit
```

Verify process settings:

```bash
sudo -iu tokensrank pm2 list
sudo -iu tokensrank pm2 show tokensrank-web
sudo -iu tokensrank pm2 show tokensrank-api
```

Expected:

- `tokensrank-web` listens on `127.0.0.1:3000`.
- `tokensrank-api` listens on `127.0.0.1:3001`.
- Memory restart limits are `400M` for web and `300M` for API.
- Logs write under `/var/log/tokensrank/`.

## GitHub Actions Secrets

Set these repository secrets in GitHub Actions:

```text
DEPLOY_HOST=DROPLET_PUBLIC_IP
DEPLOY_USER=tokensrank
DEPLOY_SSH_KEY=contents-of-ed25519-private-key
SUPABASE_URL=https://example-prod-project.supabase.co
SUPABASE_ANON_KEY=prod-anon-key
SUPABASE_SERVICE_ROLE_KEY=prod-service-role-key
```

Generate a deploy key on a trusted workstation:

```bash
ssh-keygen -t ed25519 -C "tokensrank-deploy" -f ./tokensrank-deploy
cat ./tokensrank-deploy.pub
```

Append the public key to the droplet:

```bash
ssh root@DROPLET_PUBLIC_IP 'install -d -o tokensrank -g tokensrank -m 0700 /home/tokensrank/.ssh'
cat ./tokensrank-deploy.pub | ssh root@DROPLET_PUBLIC_IP 'cat >> /home/tokensrank/.ssh/authorized_keys && chown tokensrank:tokensrank /home/tokensrank/.ssh/authorized_keys && chmod 0600 /home/tokensrank/.ssh/authorized_keys'
```

## Deployment Process

Build and audit locally or in CI:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm --filter @tokensrank/web build
pnpm --filter @tokensrank/api build

! grep -R "SUPABASE_SERVICE_ROLE_KEY" apps/web/.next
node -c ecosystem.config.cjs
caddy validate --config Caddyfile
bash -n scripts/rollback.sh
```

Create a release archive:

```bash
RELEASE_TS="$(date -u +%Y%m%d-%H%M%S)"
RELEASE_NAME="release-${RELEASE_TS}"
tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='apps/web/.next/cache' \
  -czf "${RELEASE_NAME}.tar.gz" .
```

Upload and extract the release:

```bash
scp "${RELEASE_NAME}.tar.gz" tokensrank@DROPLET_PUBLIC_IP:/tmp/

ssh tokensrank@DROPLET_PUBLIC_IP <<'EOF'
set -e
set -u

RELEASE_TAR="$(ls -1t /tmp/release-*.tar.gz | head -n 1)"
RELEASE_NAME="$(basename "$RELEASE_TAR" .tar.gz)"
RELEASE_DIR="/srv/tokensrank-releases/${RELEASE_NAME}"

mkdir -p "$RELEASE_DIR"
tar -xzf "$RELEASE_TAR" -C "$RELEASE_DIR"
cd "$RELEASE_DIR"
corepack enable
pnpm install --frozen-lockfile --prod

CURRENT_TARGET=""
if [ -L /srv/tokensrank ]; then
  CURRENT_TARGET="$(readlink -f /srv/tokensrank)"
fi

ln -sfn "$RELEASE_DIR" /srv/tokensrank.next
mv -Tf /srv/tokensrank.next /srv/tokensrank

if [ -n "$CURRENT_TARGET" ]; then
  ln -sfn "$CURRENT_TARGET" /srv/tokensrank-prev
fi

pm2 startOrReload /srv/tokensrank/ecosystem.config.cjs --update-env
pm2 save
EOF
```

Reload Caddy if the `Caddyfile` changed:

```bash
ssh tokensrank@DROPLET_PUBLIC_IP 'sudo cp /srv/tokensrank/Caddyfile /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy'
```

Run post-deploy health checks:

```bash
ssh tokensrank@DROPLET_PUBLIC_IP <<'EOF'
set -e
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null && curl -fsS http://127.0.0.1:3001/healthz >/dev/null; then
    echo "Deployment health check passed"
    exit 0
  fi
  sleep 1
done
echo "Deployment health check failed" >&2
exit 1
EOF
```

Prune old releases and keep the last three:

```bash
ssh tokensrank@DROPLET_PUBLIC_IP "find /srv/tokensrank-releases -maxdepth 1 -type d -name 'release-*' | sort | head -n -3 | xargs -r rm -rf"
```

## Emergency Rollback

Rollback is a code-only symlink swap and PM2 restart. It does not reverse database migrations.

Run the automated script:

```bash
ssh tokensrank@DROPLET_PUBLIC_IP
cd /srv/tokensrank
./scripts/rollback.sh
```

Expected duration is under 5 minutes. The script:

1. Shows current and previous releases.
2. Prompts for confirmation.
3. Atomically repoints `/srv/tokensrank` to `/srv/tokensrank-prev`.
4. Preserves the rolled-back release as the new `/srv/tokensrank-prev`.
5. Restarts PM2.
6. Checks `http://127.0.0.1:3000/healthz` and `http://127.0.0.1:3001/healthz`.

Manual fallback:

```bash
PREV_RELEASE="$(readlink -f /srv/tokensrank-prev)"
CURRENT_RELEASE="$(readlink -f /srv/tokensrank)"
ln -sfn "$PREV_RELEASE" /srv/tokensrank.next
mv -Tf /srv/tokensrank.next /srv/tokensrank
ln -sfn "$CURRENT_RELEASE" /srv/tokensrank-prev
pm2 restart all --update-env
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3001/healthz
```

## Monitoring Commands

Process health:

```bash
sudo -iu tokensrank pm2 list
sudo -iu tokensrank pm2 monit
sudo -iu tokensrank pm2 logs --lines 100
```

Caddy:

```bash
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy -n 100 --no-pager
sudo caddy validate --config /etc/caddy/Caddyfile
```

Logs:

```bash
tail -n 200 /var/log/tokensrank/web.out.log
tail -n 200 /var/log/tokensrank/web.err.log
tail -n 200 /var/log/tokensrank/api.out.log
tail -n 200 /var/log/tokensrank/api.err.log
```

Ports and health:

```bash
ss -ltnp | grep -E ':80|:443|:3000|:3001'
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3001/healthz
curl -I https://tokensrank.ai
curl -I https://api.tokensrank.ai/healthz
```

Disk and memory:

```bash
df -h
free -m
du -sh /srv/tokensrank-releases/*
sudo -iu tokensrank pm2 jlist
```

## Troubleshooting

### Caddy cannot obtain certificates

Check DNS and firewall first:

```bash
dig +short tokensrank.ai
dig +short api.tokensrank.ai
sudo ufw status verbose
sudo journalctl -u caddy -n 200 --no-pager
```

Fix DNS or firewall, then reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### API health check returns 503

Check API logs and Supabase env values:

```bash
sudo -iu tokensrank pm2 logs tokensrank-api --lines 200
sudo -iu tokensrank pm2 env tokensrank-api | grep -E 'SUPABASE_URL|NODE_ENV|PORT|HOST'
curl -fsS http://127.0.0.1:3001/healthz
```

Verify `/etc/tokensrank/api.env` contains real Tokens Rank Prod values and restart:

```bash
sudo chmod 0640 /etc/tokensrank/api.env
sudo chown tokensrank:tokensrank /etc/tokensrank/api.env
sudo -iu tokensrank pm2 restart tokensrank-api --update-env
```

### Web health check cannot reach API

Verify API is listening and `NEXT_PUBLIC_API_BASE` points to `https://api.tokensrank.ai` in web env:

```bash
ss -ltnp | grep ':3001'
grep '^NEXT_PUBLIC_API_BASE=' /etc/tokensrank/web.env
sudo -iu tokensrank pm2 restart tokensrank-web --update-env
```

### PM2 process restarts repeatedly

Inspect restart count and errors:

```bash
sudo -iu tokensrank pm2 list
sudo -iu tokensrank pm2 describe tokensrank-web
sudo -iu tokensrank pm2 describe tokensrank-api
sudo -iu tokensrank pm2 logs --lines 300
```

If a deploy introduced the crash, run rollback:

```bash
cd /srv/tokensrank
./scripts/rollback.sh
```

### Release symlink points to the wrong directory

Inspect symlinks:

```bash
readlink -f /srv/tokensrank
readlink -f /srv/tokensrank-prev
find /srv/tokensrank-releases -maxdepth 1 -type d -name 'release-*' | sort
```

Repoint to a known-good release:

```bash
KNOWN_GOOD="/srv/tokensrank-releases/release-YYYYMMDD-HHMMSS"
CURRENT="$(readlink -f /srv/tokensrank)"
ln -sfn "$KNOWN_GOOD" /srv/tokensrank.next
mv -Tf /srv/tokensrank.next /srv/tokensrank
ln -sfn "$CURRENT" /srv/tokensrank-prev
sudo -iu tokensrank pm2 restart all --update-env
```
