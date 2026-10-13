'use client';

import { useRef, type KeyboardEvent } from 'react';

import type { ProfileWindow } from '../../../packages/shared/src';

type ProfileWindowTabsProps = {
  handle: string;
  window: ProfileWindow;
};

const windowOptions: Array<{ label: string; value: ProfileWindow }> = [
  { label: '7D', value: '7d' },
  { label: '30D', value: '30d' },
  { label: 'All', value: 'all' },
];

function profilePath(handle: string, window: ProfileWindow): string {
  return `/u/${encodeURIComponent(handle)}?window=${encodeURIComponent(window)}`;
}

function tabClassName(isActive: boolean): string {
  return [
    'inline-flex h-9 shrink-0 items-center rounded-full border px-4 text-sm font-medium',
    'hover:border-accent-lime hover:text-accent-lime focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-500 focus-visible:outline-offset-2 focus-visible:outline-accent-lime',
    isActive
      ? 'border-accent-lime bg-transparent text-accent-lime'
      : 'border-tr-dim bg-transparent text-tr-secondary',
  ].join(' ');
}

export function ProfileWindowTabs({ handle, window }: ProfileWindowTabsProps) {
  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  function focusTab(index: number): void {
    tabRefs.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLAnchorElement>, index: number): void {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab((index + 1) % windowOptions.length);
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab((index - 1 + windowOptions.length) % windowOptions.length);
    }

    if (event.key === 'Home') {
      event.preventDefault();
      focusTab(0);
    }

    if (event.key === 'End') {
      event.preventDefault();
      focusTab(windowOptions.length - 1);
    }
  }

  return (
    <nav
      role="tablist"
      aria-label="Profile stats window"
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
      data-testid="profile-window-tabs"
    >
      {windowOptions.map((option, index) => {
        const isActive = option.value === window;

        return (
          <a
            key={option.value}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            href={profilePath(handle, option.value)}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? 'page' : undefined}
            className={tabClassName(isActive)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </a>
        );
      })}
    </nav>
  );
}
