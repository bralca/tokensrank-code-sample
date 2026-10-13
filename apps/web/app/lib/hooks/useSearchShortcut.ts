'use client';

import { useEffect } from 'react';

export function isInputElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return true;
  }

  return target.isContentEditable || Boolean(target.closest('[contenteditable="true"]'));
}

export function useSearchShortcut() {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key !== '/'
        || event.shiftKey
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || isInputElement(event.target)
      ) {
        return;
      }

      const searchInput = document.getElementById('handle-search');

      if (!searchInput) {
        return;
      }

      event.preventDefault();
      searchInput.focus();
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
}
