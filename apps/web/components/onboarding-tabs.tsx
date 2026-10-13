'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { Check, Laptop, FolderUp, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { getApiBaseUrl } from '../lib/api';
import { getLocalAppUrl } from '../lib/local-app-url';
import type { OnboardingMode } from '../lib/types/onboarding';

const STORAGE_KEY = 'tokensrank:onboarding:selectedMode';

const OnboardingPathFormSchema = z.object({
  mode: z.enum(['local_first', 'self_reported', 'script_verified']),
}).strict();

type OnboardingPathForm = z.infer<typeof OnboardingPathFormSchema>;
type LegacyHostedMode = 'script_verified' | 'self_reported';

type OnboardingModeOption = {
  mode: OnboardingPathForm['mode'];
  queryMode?: OnboardingMode;
  testId: string;
  label: string;
  eyebrow: string;
  description: string;
  bullets: string[];
  destination: 'local' | 'import' | 'waiting';
  hostedMode?: LegacyHostedMode;
};

const MODE_OPTIONS: OnboardingModeOption[] = [
  {
    mode: 'local_first',
    testId: 'local',
    label: 'Local dashboard',
    eyebrow: 'Recommended',
    description: 'Automatically read usage on your computer. Review a summary before publishing.',
    bullets: [
      'Automatic discovery',
      'Raw data stays local',
      'Publish aggregates only',
    ],
    destination: 'local',
  },
  {
    mode: 'self_reported',
    queryMode: 'self_reported',
    testId: 'self_reported',
    label: 'Folder upload',
    eyebrow: 'Manual upload',
    description: 'Choose Claude or Codex folders in your browser and import their usage counters.',
    bullets: [
      'No install required',
      'Full-history resend safe',
      'Only counters are uploaded',
    ],
    destination: 'import',
    hostedMode: 'self_reported',
  },
  {
    mode: 'script_verified',
    queryMode: 'script',
    testId: 'script',
    label: 'Sync script',
    eyebrow: 'Script install',
    description: 'For existing sync-agent users. Connect the script you run from your terminal.',
    bullets: [
      'Automatic sync',
      'Terminal command setup',
      'Kept for compatibility',
    ],
    destination: 'waiting',
    hostedMode: 'script_verified',
  },
];

function isOnboardingPathChoice(value: string | null): value is OnboardingPathForm['mode'] {
  return value === 'local_first' || value === 'script_verified' || value === 'self_reported';
}

function getTileClassName(isSelected: boolean) {
  return `dash-mode-choice ${isSelected ? 'selected' : ''}`;
}

function tabId(mode: OnboardingPathForm['mode']): string {
  return `onboarding-tab-${mode}`;
}

function panelId(mode: OnboardingPathForm['mode']): string {
  return `onboarding-panel-${mode}`;
}

export function OnboardingModeSelect() {
  const router = useRouter();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [submitError, setSubmitError] = useState('');
  const {
    formState,
    handleSubmit,
    setValue,
    watch,
  } = useForm<OnboardingPathForm>({
    resolver: zodResolver(OnboardingPathFormSchema),
  });
  const selectedMode = watch('mode') ?? null;

  useEffect(() => {
    const storedMode = window.sessionStorage.getItem(STORAGE_KEY);

    if (isOnboardingPathChoice(storedMode)) {
      setValue('mode', storedMode, {
        shouldValidate: true,
      });
    }
  }, [setValue]);

  const selectedOption = useMemo(() => {
    return MODE_OPTIONS.find((option) => option.mode === selectedMode) ?? null;
  }, [selectedMode]);

  function selectMode(mode: OnboardingPathForm['mode']) {
    setSubmitError('');
    setValue('mode', mode, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
    window.sessionStorage.setItem(STORAGE_KEY, mode);
  }

  async function continueToStepTwo(values: OnboardingPathForm) {
    const option = MODE_OPTIONS.find((candidate) => candidate.mode === values.mode);

    if (!option) {
      return;
    }

    setSubmitError('');

    if (option.destination === 'local') {
      window.location.assign(getLocalAppUrl());
      return;
    }

    const hostedMode = option.hostedMode;

    if (!hostedMode) {
      setSubmitError('Could not resolve this onboarding path. Try again.');
      return;
    }

    const response = await fetch(`${getApiBaseUrl()}/api/me/onboarding`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: hostedMode }),
    });

    if (!response.ok) {
      setSubmitError('Could not save your onboarding path. Try again.');
      return;
    }

    if (option.destination === 'import') {
      router.push('/me/import');
      return;
    }

    router.push(`/onboarding/waiting?mode=${option.queryMode}`);
  }

  function focusTab(index: number): void {
    tabRefs.current[index]?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab((index + 1) % MODE_OPTIONS.length);
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab((index - 1 + MODE_OPTIONS.length) % MODE_OPTIONS.length);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      focusTab(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      focusTab(MODE_OPTIONS.length - 1);
    }
  }

  return (
    <form
      className="flex w-full flex-col gap-6"
      data-testid="onboarding-mode-select"
      onSubmit={(event) => {
        void handleSubmit(continueToStepTwo)(event);
      }}
    >
      <div className="dash-mode-options" role="tablist" aria-label="Choose TokensRank setup path">
        {MODE_OPTIONS.map((option, index) => {
          const isSelected = selectedMode === option.mode;

          return (
            <button
              key={option.mode}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              id={tabId(option.mode)}
              role="tab"
              className={getTileClassName(isSelected)}
              onClick={() => selectMode(option.mode)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              aria-selected={isSelected}
              aria-controls={panelId(option.mode)}
              data-testid={`onboarding-mode-${option.testId}`}
            >
              <span className="dash-mode-icon" aria-hidden="true">{index === 0 ? <Laptop size={24} /> : index === 1 ? <FolderUp size={24} /> : <TerminalSquare size={24} />}</span>
              <span className="dash-mode-copy">
                <small>{option.eyebrow}</small>
                <strong>{option.label}</strong>
                <span>{option.description}</span>
              </span>
              <span className="dash-mode-check" aria-hidden="true" data-testid={isSelected ? `onboarding-mode-${option.testId}-pip` : undefined}>{isSelected && <Check size={16} />}</span>
            </button>
          );
        })}
      </div>

      <div className="dash-mode-details">
        {selectedOption ? null : (
          <p className="max-w-3xl text-sm leading-6 text-[var(--muted)]" data-testid="onboarding-mode-empty">
            Select how you want to import usage.
          </p>
        )}

        {MODE_OPTIONS.map((option) => {
          const isSelected = selectedMode === option.mode;

          return (
            <div
              key={option.mode}
              id={panelId(option.mode)}
              role="tabpanel"
              aria-labelledby={tabId(option.mode)}
              hidden={!isSelected}
              className={isSelected ? 'flex flex-col gap-2' : 'hidden'}
              data-testid={isSelected ? 'onboarding-mode-details' : undefined}
            >
              <p className="font-sans text-sm font-medium text-[var(--accent-ink)]">
                Selected / {option.label}
              </p>
              <p className="max-w-3xl text-sm leading-6 text-[var(--muted)]">
                {option.bullets.join(" · ")}
              </p>
            </div>
          );
        })}
      </div>

      {submitError ? (
        <p className="text-sm text-[#b91c1c]" role="alert" data-testid="onboarding-submit-error">
          {submitError}
        </p>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!selectedMode || formState.isSubmitting}
          className="dash-button primary"
          data-testid="onboarding-next"
        >
          {formState.isSubmitting ? 'Saving' : 'Next →'}
        </button>
      </div>
    </form>
  );
}
