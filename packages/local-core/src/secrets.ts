import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SERVICE_NAME = 'TokensRankLocal';
const GITHUB_ACCOUNT = 'github-token';
const PUBLISH_ACCOUNT = 'publish-token';

type SecretKind = 'github' | 'publish';

function accountFor(kind: SecretKind): string {
  return kind === 'github' ? GITHUB_ACCOUNT : PUBLISH_ACCOUNT;
}

export function secretRef(kind: SecretKind): string {
  const platform = os.platform();
  if (platform === 'win32') return `dpapi:${SERVICE_NAME}:${accountFor(kind)}`;
  if (platform === 'linux') return `secret-tool:${SERVICE_NAME}:${accountFor(kind)}`;
  return `keychain:${SERVICE_NAME}:${accountFor(kind)}`;
}

function windowsSecretPath(kind: SecretKind): string {
  return path.join(os.homedir(), '.tokensrank', 'secrets', `${kind}.dpapi`);
}

async function runWithInput(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
    child.stdin.end(input);
  });
}

async function storeMacSecret(kind: SecretKind, value: string): Promise<string> {
  await execFileAsync('security', [
    'add-generic-password',
    '-a',
    accountFor(kind),
    '-s',
    SERVICE_NAME,
    '-w',
    value,
    '-U',
  ]);

  return secretRef(kind);
}

async function readMacSecret(kind: SecretKind): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-a',
      accountFor(kind),
      '-s',
      SERVICE_NAME,
      '-w',
    ]);
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

function windowsDpapiScript(mode: 'protect' | 'unprotect', base64: string): string {
  const method = mode === 'protect' ? 'Protect' : 'Unprotect';
  return [
    `$bytes = [Convert]::FromBase64String('${base64}')`,
    `$result = [System.Security.Cryptography.ProtectedData]::${method}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Convert]::ToBase64String($result)',
  ].join('; ');
}

async function storeWindowsSecret(kind: SecretKind, value: string): Promise<string> {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    windowsDpapiScript('protect', encoded),
  ]);
  const secretPath = windowsSecretPath(kind);
  await mkdir(path.dirname(secretPath), { recursive: true });
  await writeFile(secretPath, stdout.trim(), { encoding: 'utf8', mode: 0o600 });
  return secretRef(kind);
}

async function readWindowsSecret(kind: SecretKind): Promise<string | null> {
  try {
    const protectedBase64 = (await readFile(windowsSecretPath(kind), 'utf8')).trim();
    if (!protectedBase64) return null;
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsDpapiScript('unprotect', protectedBase64),
    ]);
    const decoded = Buffer.from(stdout.trim(), 'base64').toString('utf8');
    return decoded || null;
  } catch {
    return null;
  }
}

async function storeLinuxSecret(kind: SecretKind, value: string): Promise<string> {
  await runWithInput('secret-tool', [
    'store',
    '--label',
    SERVICE_NAME,
    'service',
    SERVICE_NAME,
    'account',
    accountFor(kind),
  ], value);
  return secretRef(kind);
}

async function readLinuxSecret(kind: SecretKind): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('secret-tool', [
      'lookup',
      'service',
      SERVICE_NAME,
      'account',
      accountFor(kind),
    ]);
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

export async function storeSecret(kind: SecretKind, value: string): Promise<string> {
  const platform = os.platform();
  if (platform === 'darwin') {
    return await storeMacSecret(kind, value);
  }
  if (platform === 'win32') {
    return await storeWindowsSecret(kind, value);
  }
  if (platform === 'linux') {
    return await storeLinuxSecret(kind, value);
  }
  throw new Error(`[local-secrets] Unsupported platform for local secret storage: ${platform}`);
}

export async function readSecret(kind: SecretKind): Promise<string | null> {
  const platform = os.platform();
  if (platform === 'darwin') {
    return await readMacSecret(kind);
  }
  if (platform === 'win32') {
    return await readWindowsSecret(kind);
  }
  if (platform === 'linux') {
    return await readLinuxSecret(kind);
  }
  return null;
}

export async function clearSecret(kind: SecretKind): Promise<void> {
  if (!await readSecret(kind)) return;
  if (os.platform() === 'darwin') {
    await execFileAsync('security', ['delete-generic-password', '-a', accountFor(kind), '-s', SERVICE_NAME]);
  } else if (os.platform() === 'win32') {
    await rm(windowsSecretPath(kind), { force: true });
  } else if (os.platform() === 'linux') {
    await execFileAsync('secret-tool', ['clear', 'service', SERVICE_NAME, 'account', accountFor(kind)]);
  }
}

export async function readGithubToken(): Promise<string | null> {
  if (process.env.TOKENSRANK_LOCAL_ALLOW_TOKEN_AUTH === 'true') {
    return process.env.GITHUB_DEV_TOKEN
      ?? process.env.GITHUB_TOKEN
      ?? await readSecret('github');
  }
  return await readSecret('github');
}

export async function readPublishToken(): Promise<string | null> {
  return process.env.TOKENSRANK_PUBLISH_TOKEN
    ?? await readSecret('publish');
}
