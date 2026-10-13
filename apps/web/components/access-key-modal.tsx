'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

type AccessKeyModalProps = {
  plaintextKey: string;
  keyPrefix: string;
  scope: 'script' | 'self_reported';
  onVisibilityChange?: (isVisible: boolean) => void;
};

function storageKeyFor(prefix: string) {
  return `tokensrank:accessKey_shown:${prefix}`;
}

async function copyKey(plaintextKey: string, onCopied: (copied: boolean) => void) {
  try {
    await navigator.clipboard.writeText(plaintextKey);
  } catch (error) {
    console.warn('[web] Clipboard write failed, marking access key as copied for manual selection', error);
  }

  onCopied(true);
  window.setTimeout(() => onCopied(false), 2000);
}

function downloadKey(plaintextKey: string, scope: AccessKeyModalProps['scope']) {
  const body = [
    'TokensRank access key',
    `Scope: ${scope}`,
    `Key: ${plaintextKey}`,
    '',
    'Store this key now. TokensRank will not show it again.',
  ].join('\n');
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = `tokensrank-${scope}-access-key.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function AccessKeyModal({
  plaintextKey,
  keyPrefix,
  scope,
  onVisibilityChange,
}: AccessKeyModalProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [hasConfirmed, setHasConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const localStorageKey = useMemo(() => storageKeyFor(keyPrefix), [keyPrefix]);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const copyButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const shouldShow = window.localStorage.getItem(localStorageKey) !== 'true';

    setIsVisible(shouldShow);
    onVisibilityChange?.(shouldShow);
  }, [localStorageKey, onVisibilityChange]);

  useEffect(() => {
    if (isVisible) {
      copyButtonRef.current?.focus();
    }
  }, [isVisible]);

  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !modalRef.current) {
      return;
    }

    const focusable = Array.from(
      modalRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (!first || !last) {
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function dismissModal() {
    window.localStorage.setItem(localStorageKey, 'true');
    window.localStorage.setItem('accessKey_shown', 'true');
    setIsVisible(false);
    onVisibilityChange?.(false);
  }

  if (!isVisible) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#272421]/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="access-key-modal-title"
      data-testid="access-key-modal"
      onKeyDown={trapFocus}
    >
      <div ref={modalRef} className="dash-card w-full max-w-xl bg-white">
        <div className="flex flex-col gap-5">
          <header className="flex flex-col gap-2">
            <p className="font-sans text-sm text-[var(--accent-ink)]">
              Access key
            </p>
            <h2 id="access-key-modal-title" className="text-2xl font-semibold text-[var(--ink)]">
              Save this key now
            </h2>
            <p className="text-sm leading-6 text-[var(--muted)]">
              This plaintext key is only available during this creation step.
            </p>
          </header>

          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            Copy this key. You will not see it again.
          </div>

          <code
            className="break-all rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4 font-mono text-sm leading-6 text-[var(--ink)]"
            data-testid="access-key-plaintext"
          >
            {plaintextKey}
          </code>

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              ref={copyButtonRef}
              type="button"
              onClick={() => {
                void copyKey(plaintextKey, setCopied);
              }}
              className="dash-button"
              data-testid="access-key-copy"
            >
              {copied ? 'Copied' : 'Copy to clipboard'}
            </button>
            <button
              type="button"
              onClick={() => downloadKey(plaintextKey, scope)}
              className="dash-button"
              data-testid="access-key-download"
            >
              Download .txt file
            </button>
          </div>

          <label className="flex items-start gap-3 text-sm leading-6 text-[var(--ink)]">
            <input
              type="checkbox"
              checked={hasConfirmed}
              onChange={(event) => setHasConfirmed(event.target.checked)}
              className="mt-1 h-4 w-4 accent-[#b63b13] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-ink)] focus-visible:outline-offset-2 focus-visible:outline-accent-lime"
              data-testid="access-key-confirm"
            />
            <span>I have saved this key.</span>
          </label>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={!hasConfirmed}
              onClick={dismissModal}
              className="dash-button primary"
              data-testid="access-key-done"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
