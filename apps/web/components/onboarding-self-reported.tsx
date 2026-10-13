'use client';

import { useMemo, useState } from 'react';

import { getApiBaseUrl } from '../lib/api';
import { OnboardingRetry, type OnboardingRetryError } from './onboarding-retry';

type OnboardingSelfReportedProps = {
  accessKey: string;
  handle: string;
};

type CopyBlockProps = {
  title: string;
  value: string;
  copyKey: string;
  copied: string;
  onCopy: (value: string, copyKey: string) => void;
  multiline?: boolean;
  secret?: boolean;
};

type ErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
  };
};

function CopyBlock({
  title,
  value,
  copyKey,
  copied,
  onCopy,
  multiline = false,
  secret = false,
}: CopyBlockProps) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-[var(--line)] bg-[#ffffff] p-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-sans text-sm font-medium text-[var(--accent-ink)]">
          {title}
        </h3>
        <button
          type="button"
          onClick={() => onCopy(value, copyKey)}
          className="h-10 shrink-0 rounded-md border border-[var(--line)] px-3 font-sans text-sm font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          data-testid={`copy-${copyKey}`}
        >
          {copied === copyKey ? 'Copied' : 'Copy'}
        </button>
      </div>

      {multiline ? (
        <pre
          aria-label={`${title} code block`}
          tabIndex={0}
          className="max-h-[360px] overflow-auto whitespace-pre rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4 font-sans text-xs leading-5 text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          data-testid={`self-reported-${copyKey}`}
        >
          {value}
        </pre>
      ) : (
        <code
          className="break-all rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4 font-sans text-sm leading-6 text-[var(--ink)]"
          data-testid={`self-reported-${copyKey}`}
        >
          {secret ? value : value}
        </code>
      )}
    </section>
  );
}

function buildPayloadTemplate(handle: string) {
  return {
    client: {
      version: 'self-reported-1.0.0',
      install_id: '00000000-0000-4000-8000-000000000001',
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: `${handle || 'builder'}-manual-run-001`,
      started_at: '2026-04-28T10:00:00.000Z',
      finished_at: '2026-04-28T10:00:02.000Z',
    },
    sessions: [
      {
        session_id: `${handle || 'builder'}-manual-session-001`,
        model: 'claude-3-5-sonnet-20241022',
        source: 'claude',
        first_event_at: '2026-04-28T09:00:00.000Z',
        last_event_at: '2026-04-28T09:45:00.000Z',
        input_tokens: 5000,
        output_tokens: 2500,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
        turns: 18,
        file_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
  };
}

function mapSelfReportedError(error: OnboardingRetryError): OnboardingRetryError {
  const code = error.code?.toLowerCase();

  if (code === 'wrong_key_scope') {
    return {
      ...error,
      code: 'unauthorized',
      message: 'This bearer key cannot post to the self-reported endpoint.',
    };
  }

  if (code === 'batch_too_large') {
    return {
      ...error,
      message: 'The payload is too large. Send at most 100 sessions per request.',
    };
  }

  if (code === 'schema_invalid' || code === 'invalid_request') {
    return {
      ...error,
      message: 'The JSON payload does not match the required session schema.',
    };
  }

  return error;
}

export function OnboardingSelfReported({ accessKey, handle }: OnboardingSelfReportedProps) {
  const [copied, setCopied] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [testError, setTestError] = useState<OnboardingRetryError | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const endpointUrl = `${getApiBaseUrl()}/api/self-reported/sessions`;
  const payload = useMemo(() => buildPayloadTemplate(handle), [handle]);
  const payloadTemplate = useMemo(() => {
    return JSON.stringify(payload, null, 2);
  }, [payload]);
  const curlCommand = useMemo(() => {
    return [
      `curl -X POST ${endpointUrl}`,
      `  -H 'Authorization: Bearer ${accessKey}'`,
      "  -H 'Content-Type: application/json'",
      "  --data @tokensrank-payload.json",
    ].join(' \\\n');
  }, [accessKey, endpointUrl]);

  function copyValue(value: string, copyKey: string) {
    void navigator.clipboard.writeText(value).catch((error) => {
      console.warn('[web] Clipboard write failed, marking block as copied for manual selection', error);
    }).finally(() => {
      setCopied(copyKey);
      window.setTimeout(() => setCopied(''), 2000);
    });
  }

  async function testSelfReportedPost(): Promise<void> {
    setIsTesting(true);
    setTestError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(endpointUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let envelope: ErrorEnvelope = {};

        try {
          envelope = await response.json() as ErrorEnvelope;
        } catch {
          envelope = {};
        }

        setTestError(mapSelfReportedError({
          code: envelope.error?.code,
          message: envelope.error?.message ?? `Self-reported test returned ${response.status}.`,
          status: response.status,
        }));
        return;
      }

      setSuccessMessage('Self-reported test accepted. Your profile will update after the next cache refresh.');
    } catch (error) {
      console.warn('[web] Self-reported onboarding test failed', error);
      setTestError({
        code: 'timeout',
        message: 'Connection timed out while sending the self-reported test payload.',
      });
    } finally {
      setIsTesting(false);
    }
  }

  return (
    <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="onboarding-self-reported">
      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <p className="font-sans text-sm font-medium text-[var(--accent-ink)]">
            Step 02 / Self-reported
          </p>
          <h2 className="text-2xl font-semibold text-[var(--ink)]">Post sessions from your own tooling</h2>
          <p className="max-w-2xl text-sm leading-6 text-[var(--muted)]">
            Send strict JSON to the self-reported endpoint with your bearer key in the Authorization header.
          </p>
        </div>

        <CopyBlock
          title="Endpoint URL"
          value={endpointUrl}
          copyKey="endpoint"
          copied={copied}
          onCopy={copyValue}
        />

        <CopyBlock
          title="Bearer token"
          value={accessKey}
          copyKey="token"
          copied={copied}
          onCopy={copyValue}
          secret
        />

        <CopyBlock
          title="JSON payload template"
          value={payloadTemplate}
          copyKey="payload"
          copied={copied}
          onCopy={copyValue}
          multiline
        />
      </section>

      <section aria-label="Request preview" className="flex flex-col gap-4 rounded-md border border-[var(--line)] bg-[#ffffff] p-5">
        <div className="flex flex-col gap-2">
          <p className="font-sans text-sm font-medium text-[var(--accent-ink)]">
            Request preview
          </p>
          <p className="text-sm leading-6 text-[var(--muted)]">
            Store the JSON as <code className="font-sans text-[var(--ink)]">tokensrank-payload.json</code>, then run this command.
          </p>
        </div>

        <pre
          aria-label="Curl request code block"
          tabIndex={0}
          className="overflow-auto rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4 font-sans text-xs leading-5 text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          data-testid="self-reported-curl"
        >
          {curlCommand}
        </pre>

        <button
          type="button"
          onClick={() => copyValue(curlCommand, 'curl')}
          className="dash-button primary "
          data-testid="copy-curl"
        >
          {copied === 'curl' ? 'Copied' : 'Copy request'}
        </button>

        <button
          type="button"
          onClick={() => {
            void testSelfReportedPost();
          }}
          disabled={isTesting}
          className="h-10 rounded-md border border-[var(--accent)] px-4 font-sans text-xs font-semibold uppercase tracking-[0.12em] text-[var(--accent-ink)] transition-[border,color,opacity] hover:border-[var(--accent)] hover:text-[var(--accent-ink)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          data-testid="self-reported-test-now"
        >
          {isTesting ? 'Testing...' : 'Test now'}
        </button>

        {successMessage ? (
          <div
            role="status"
            className="rounded-md border border-tr-success/60 bg-tr-success/10 p-4 text-sm leading-6 text-[var(--ink)]"
            data-testid="self-reported-success"
          >
            {successMessage}
          </div>
        ) : null}

        {testError ? (
          <OnboardingRetry
            error={testError}
            onRetry={() => {
              void testSelfReportedPost();
            }}
            isRetrying={isTesting}
          />
        ) : null}
      </section>
    </div>
  );
}
