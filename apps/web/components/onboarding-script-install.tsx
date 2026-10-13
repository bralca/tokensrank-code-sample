'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SSEListener } from '../app/onboarding/SSEListener';
import { AccessKeyModal } from '../app/onboarding/AccessKeyModal';
import { getApiBaseUrl } from '../lib/api';
import type { GeneratedOnboardingAccessKey } from '../lib/types/onboarding';
import { OnboardingRetry, type OnboardingRetryError } from './onboarding-retry';

const TROUBLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_LINES = 6;
const ACCESS_KEY_PLACEHOLDER = '<paste tr_script key>';

type OnboardingScriptInstallProps = {
  handle: string;
  generatedAccessKey?: GeneratedOnboardingAccessKey | null;
  shouldGenerateAccessKey?: boolean;
};

function appendLog(lines: string[], nextLine: string) {
  return [...lines, nextLine].slice(-MAX_LOG_LINES);
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/$/u, '');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

export function buildPosixInstallCommand(apiBaseUrl: string, handle: string, accessKey?: string | null): string {
  const baseUrl = withoutTrailingSlash(apiBaseUrl);
  const installUrl = `${baseUrl}/install.sh`;

  return [
    `curl -fsSL ${shellQuote(installUrl)} | \\`,
    `  TOKENSRANK_API_BASE=${shellQuote(baseUrl)} \\`,
    `  TOKENSRANK_ACCESS_KEY=${shellQuote(accessKey || ACCESS_KEY_PLACEHOLDER)} \\`,
    `  TOKENSRANK_PROFILE_HANDLE=${shellQuote(handle)} \\`,
    '  bash',
  ].join('\n');
}

export function buildWindowsInstallCommand(apiBaseUrl: string, handle: string, accessKey?: string | null): string {
  const baseUrl = withoutTrailingSlash(apiBaseUrl);
  const installUrl = `${baseUrl}/install.ps1`;

  return [
    `$env:TOKENSRANK_API_BASE = ${powerShellQuote(baseUrl)}`,
    `$env:TOKENSRANK_ACCESS_KEY = ${powerShellQuote(accessKey || ACCESS_KEY_PLACEHOLDER)}`,
    `$env:TOKENSRANK_PROFILE_HANDLE = ${powerShellQuote(handle)}`,
    `irm ${powerShellQuote(installUrl)} | iex`,
  ].join('; ');
}

async function copyText(value: string, label: string, onCopied: (label: string) => void) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (error) {
    console.warn('[web] Clipboard write failed, marking command as copied for manual selection', error);
  }

  onCopied(label);
  window.setTimeout(() => onCopied(''), 2000);
}

export function OnboardingScriptInstall({
  handle,
  generatedAccessKey,
  shouldGenerateAccessKey = false,
}: OnboardingScriptInstallProps) {
  const [activeGeneratedAccessKey, setActiveGeneratedAccessKey] = useState<GeneratedOnboardingAccessKey | null>(
    generatedAccessKey ?? null,
  );
  const [logs, setLogs] = useState<string[]>(['Connecting to server...']);
  const [isConnected, setIsConnected] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [showTrouble, setShowTrouble] = useState(false);
  const [retryError, setRetryError] = useState<OnboardingRetryError | null>(null);
  const [retrySignal, setRetrySignal] = useState(0);
  const [copied, setCopied] = useState('');
  const [isAccessKeyGateOpen, setIsAccessKeyGateOpen] = useState(Boolean(generatedAccessKey));
  const [pendingRedirectHandle, setPendingRedirectHandle] = useState<string | null>(null);
  const accessKeyGateOpenRef = useRef(Boolean(generatedAccessKey));
  const accessKeyRequestStartedRef = useRef(false);

  const setAccessKeyGateOpen = useCallback((isOpen: boolean) => {
    accessKeyGateOpenRef.current = isOpen;
    setIsAccessKeyGateOpen(isOpen);
  }, []);

  const installCommand = useMemo(() => {
    return buildPosixInstallCommand(getApiBaseUrl(), handle, activeGeneratedAccessKey?.plaintext);
  }, [activeGeneratedAccessKey?.plaintext, handle]);

  const windowsInstallCommand = useMemo(() => {
    return buildWindowsInstallCommand(getApiBaseUrl(), handle, activeGeneratedAccessKey?.plaintext);
  }, [activeGeneratedAccessKey?.plaintext, handle]);

  const redirectToProfile = useCallback((nextHandle: string) => {
    if (accessKeyGateOpenRef.current) {
      setPendingRedirectHandle(nextHandle);
      return;
    }

    window.location.assign(`/u/${nextHandle}`);
  }, []);

  const handleLog = useCallback((line: string) => {
    setLogs((current) => appendLog(current, line));
  }, []);

  const handleModeChange = useCallback((mode: 'sse' | 'polling') => {
    setIsConnected(mode === 'sse');
    setIsPolling(mode === 'polling');
  }, []);

  const handleRetry = useCallback(() => {
    setRetryError(null);
    setLogs((current) => appendLog(current, 'Retrying onboarding connection...'));
    setRetrySignal((current) => current + 1);
  }, []);

  useEffect(() => {
    if (isAccessKeyGateOpen || !pendingRedirectHandle) {
      return;
    }

    window.location.assign(`/u/${pendingRedirectHandle}`);
  }, [isAccessKeyGateOpen, pendingRedirectHandle]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setShowTrouble(true);
    }, TROUBLE_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!shouldGenerateAccessKey || activeGeneratedAccessKey || accessKeyRequestStartedRef.current) {
      return;
    }

    accessKeyRequestStartedRef.current = true;

    async function createAccessKey(): Promise<void> {
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/access-keys/generate`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scope: 'script' }),
        });

        if (!response.ok) {
          setLogs((current) => appendLog(current, `Access key generation returned ${response.status}.`));
          return;
        }

        const body = await response.json() as { data: GeneratedOnboardingAccessKey };
        setActiveGeneratedAccessKey(body.data);
      } catch (error) {
        console.warn('[web] Script access key generation failed', error);
        setLogs((current) => appendLog(current, 'Access key generation failed. Refresh and try again.'));
      }
    }

    void createAccessKey();
  }, [activeGeneratedAccessKey, shouldGenerateAccessKey]);

  return (
    <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="onboarding-script-install">
      <SSEListener
        fallbackHandle={handle}
        onDetected={redirectToProfile}
        onLog={handleLog}
        onModeChange={handleModeChange}
        onPollingError={setRetryError}
        retrySignal={retrySignal}
      />

      {activeGeneratedAccessKey ? (
        <AccessKeyModal
          plaintextKey={activeGeneratedAccessKey.plaintext}
          keyPrefix={activeGeneratedAccessKey.prefix}
          scope="script"
          onVisibilityChange={setAccessKeyGateOpen}
        />
      ) : null}

      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <p className="font-sans text-sm font-medium text-[var(--accent-ink)]">
            Step 02 / Verified
          </p>
          <h2 className="text-2xl font-semibold text-[var(--ink)]">Install the sync agent</h2>
          <p className="max-w-2xl text-sm leading-6 text-[var(--muted)]">
            Paste the command in your terminal, then keep this page open while the first session is detected.
          </p>
        </div>

        <div className="rounded-md border border-[var(--accent)] bg-[var(--surface-muted)] p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <code className="select-all break-all font-sans text-sm leading-6 text-[var(--ink)]">
              {installCommand}
            </code>
            <button
              type="button"
              onClick={() => {
                void copyText(installCommand, 'mac', setCopied);
              }}
              className="h-10 shrink-0 rounded-md border border-[var(--line)] px-3 font-sans text-sm font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              data-testid="copy-install-command"
            >
              {copied === 'mac' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="rounded-md border border-[var(--line)] bg-[#ffffff] p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <code className="select-all break-all font-sans text-sm leading-6 text-[var(--muted)]">
              {windowsInstallCommand}
            </code>
            <button
              type="button"
              onClick={() => {
                void copyText(windowsInstallCommand, 'windows', setCopied);
              }}
              className="h-10 shrink-0 rounded-md border border-[var(--line)] px-3 font-sans text-sm font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              data-testid="copy-windows-install-command"
            >
              {copied === 'windows' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </section>

      <section aria-label="Connection status" className="flex min-h-[360px] flex-col gap-4 rounded-md border border-[var(--line)] bg-[#ffffff] p-5">
        <div className="flex items-center gap-3" role="status" aria-live="polite" aria-atomic="true">
          <span className="relative flex h-4 w-4" aria-hidden="true">
            <span className="dash-button primary w-full " />
            <span className="dash-button primary " />
          </span>
          <div className="flex flex-col">
            <span className="font-sans text-sm font-medium text-[var(--ink)]">
              {isPolling ? 'Polling for connection...' : 'Listening for connection...'}
            </span>
            <span className="text-xs text-[var(--muted)]">
              {isConnected ? 'SSE connected' : 'Waiting for live events'}
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col justify-end overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4 font-sans text-xs leading-5 text-[var(--muted)]">
          <div className="flex flex-col gap-2" data-testid="onboarding-live-log" aria-live="polite">
            {logs.map((line, index) => (
              <div key={`${line}-${index}`}>{line}</div>
            ))}
          </div>
        </div>

        {showTrouble ? (
          <a
            href="/onboarding"
            className="text-sm text-[var(--accent-ink)] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            data-testid="onboarding-trouble-link"
          >
            Having trouble? Switch mode or try again.
          </a>
        ) : null}

        {retryError ? (
          <OnboardingRetry error={retryError} onRetry={handleRetry} />
        ) : null}
      </section>
    </div>
  );
}
