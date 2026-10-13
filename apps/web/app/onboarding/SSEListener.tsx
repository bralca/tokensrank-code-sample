'use client';

import { useEffect } from 'react';

import { getApiBaseUrl } from '../../lib/api';

const READY_TIMEOUT_MS = 500;
const POLLING_INTERVAL_MS = 5000;
const MAX_POLLING_FAILURES = 5;

type OnboardingDetectedEvent = {
  type: 'detected';
  handle?: string | null;
  ingestion_run_id?: string;
};

type ProfilePollingResponse = {
  identity?: {
    handle?: string | null;
  };
  at_glance?: {
    sessions_count?: number;
  };
};

type MePollingResponse = {
  data?: {
    handle?: string | null;
    recentIngestionRuns?: Array<{
      status: 'processing' | 'completed' | 'partial' | 'failed';
      acceptedCount: number;
    }>;
  };
};

type SSEListenerProps = {
  fallbackHandle: string;
  onDetected: (handle: string) => void;
  onLog?: (line: string) => void;
  onModeChange?: (mode: 'sse' | 'polling') => void;
  onPollingError?: (error: { code: string; message: string; status?: number }) => void;
  retrySignal?: number;
};

function appendBase(path: string): string {
  return `${getApiBaseUrl().replace(/\/$/u, '')}${path}`;
}

export function SSEListener({
  fallbackHandle,
  onDetected,
  onLog,
  onModeChange,
  onPollingError,
  retrySignal = 0,
}: SSEListenerProps) {
  useEffect(() => {
    let isActive = true;
    let pollingInterval: number | null = null;
    let pollingFailures = 0;

    function stopPolling(): void {
      if (pollingInterval !== null) {
        window.clearInterval(pollingInterval);
        pollingInterval = null;
      }
    }

    function recordPollingFailure(message: string, status?: number): void {
      pollingFailures += 1;
      onLog?.(message);

      if (pollingFailures >= MAX_POLLING_FAILURES) {
        onPollingError?.({
          code: status === 401 ? 'unauthorized' : 'timeout',
          message: 'Could not confirm your first session after repeated polling attempts.',
          status,
        });
      }
    }

    async function pollMeFallback(): Promise<boolean> {
      try {
        const meResponse = await fetch(appendBase('/api/me'), {
          credentials: 'include',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!meResponse.ok) {
          return false;
        }

        const meBody = await meResponse.json() as MePollingResponse;
        const completedRun = meBody.data?.recentIngestionRuns?.find((run) => (
          (run.status === 'completed' || run.status === 'partial') && run.acceptedCount > 0
        ));

        if (!completedRun) {
          return false;
        }

        pollingFailures = 0;
        stopPolling();
        onLog?.('First session detected, redirecting...');
        onDetected(meBody.data?.handle || fallbackHandle);
        return true;
      } catch (fallbackError) {
        console.warn('[web] Onboarding /api/me polling fallback failed', fallbackError);
        return false;
      }
    }

    async function pollForDetected(): Promise<void> {
      try {
        const response = await fetch(appendBase(`/api/profile/${encodeURIComponent(fallbackHandle)}?window=all`), {
          credentials: 'include',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          if (await pollMeFallback()) {
            return;
          }

          recordPollingFailure(`Polling returned ${response.status}.`, response.status);
          return;
        }

        pollingFailures = 0;
        const body = await response.json() as ProfilePollingResponse;
        const hasSessions = (body.at_glance?.sessions_count ?? 0) > 0;

        if (hasSessions) {
          stopPolling();
          onLog?.('First session detected, redirecting...');
          onDetected(body.identity?.handle || fallbackHandle);
          return;
        }

        if (await pollMeFallback()) {
          return;
        }

        onLog?.('Still listening for first session...');
      } catch (error) {
        if (isActive) {
          console.warn('[web] Onboarding polling failed', error);
          if (await pollMeFallback()) {
            return;
          }

          recordPollingFailure('Polling failed. Retrying in 5 seconds.');
        }
      }
    }

    function startPolling(): void {
      if (pollingInterval !== null) {
        return;
      }

      onModeChange?.('polling');
      onLog?.('Polling every 5 seconds.');
      void pollForDetected();
      pollingInterval = window.setInterval(() => {
        void pollForDetected();
      }, POLLING_INTERVAL_MS);
    }

    if (typeof EventSource === 'undefined') {
      onLog?.('EventSource unavailable.');
      startPolling();
      return () => {
        isActive = false;
        stopPolling();
      };
    }

    let opened = false;
    const readyTimeout = window.setTimeout(() => {
      if (isActive && !opened) {
        onLog?.('SSE handshake timed out.');
        source.close();
        startPolling();
      }
    }, READY_TIMEOUT_MS);
    const source = new EventSource(appendBase('/api/onboarding/waiting'), {
      withCredentials: true,
    });

    source.onopen = () => {
      if (!isActive) {
        return;
      }

      opened = true;
      window.clearTimeout(readyTimeout);
      onModeChange?.('sse');
      onLog?.('Handshake complete.');
    };

    source.addEventListener('connected', (message) => {
      if (!isActive) {
        return;
      }

      try {
        const event = JSON.parse(message.data) as { message?: string };
        onLog?.(event.message || 'Handshake complete.');
      } catch {
        onLog?.('Handshake complete.');
      }
    });

    source.addEventListener('detected', (message) => {
      if (!isActive) {
        return;
      }

      try {
        const event = JSON.parse(message.data) as OnboardingDetectedEvent;
        source.close();
        onLog?.('First session detected, redirecting...');
        onDetected(event.handle || fallbackHandle);
      } catch (error) {
        console.warn('[web] Onboarding detected event parse failed', error);
        onLog?.('Received an unreadable server event.');
      }
    });

    source.addEventListener('timeout', () => {
      if (!isActive) {
        return;
      }

      source.close();
      onLog?.('SSE timed out. Polling every 5 seconds.');
      startPolling();
    });

    source.onerror = () => {
      if (!isActive) {
        return;
      }

      window.clearTimeout(readyTimeout);
      source.close();
      onLog?.('SSE disconnected.');
      startPolling();
    };

    return () => {
      isActive = false;
      window.clearTimeout(readyTimeout);
      source.close();
      stopPolling();
    };
  }, [fallbackHandle, onDetected, onLog, onModeChange, onPollingError, retrySignal]);

  return null;
}
