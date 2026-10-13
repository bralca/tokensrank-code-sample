'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { ApiFetchError, apiFetch } from '../../../lib/api';

type GithubRepo = {
  repo_id: number;
  full_name: string;
  is_private: boolean;
  default_branch: string;
  stars: number;
  connected: boolean;
  prod_branch: string;
};

export default function ConnectReposPage() {
  const router = useRouter();
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [branches, setBranches] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');

  const normalizedQuery = query.trim().toLowerCase();
  const visibleRepos = (repos ?? []).filter((repo) => repo.full_name.toLowerCase().includes(normalizedQuery));

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const body = await apiFetch<{ data: GithubRepo[] }>('/api/github/repos', { credentials: 'include' });
        if (cancelled) {
          return;
        }
        const list = body.data ?? [];
        setRepos(list);
        setSelected(new Set(list.filter((repo) => repo.connected).map((repo) => repo.repo_id)));
        setBranches(Object.fromEntries(list.map((repo) => [repo.repo_id, repo.prod_branch])));
      } catch (err) {
        if (cancelled) {
          return;
        }
        if (err instanceof ApiFetchError && err.status === 401) { router.replace('/auth/sign-in'); return; }
        if (err instanceof ApiFetchError && err.code === 'github_not_connected') {
          setError('Connect your GitHub account first.');
        } else {
          setError('Could not load your repositories. Please try again.');
        }
        setRepos([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  function toggle(repoId: number): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }

  async function handleContinue(): Promise<void> {
    if (!repos) {
      return;
    }
    setSaving(true);
    setError(null);

    try {
      const payload = repos
        .filter((repo) => selected.has(repo.repo_id))
        .map((repo) => ({
          repo_id: repo.repo_id,
          full_name: repo.full_name,
          prod_branch: (branches[repo.repo_id] || repo.default_branch).trim(),
          is_private: repo.is_private,
          stars: repo.stars,
        }));

      await apiFetch('/api/github/repos', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: payload }),
      });

      router.push('/me');
    } catch {
      setError('Could not save your selection. Please try again.');
      setSaving(false);
    }
  }

  return (
    <section className="flex w-full flex-col gap-8" aria-labelledby="connect-repos-title">
      <header className="flex flex-col gap-2">
        <p className="font-sans text-sm font-medium text-[var(--muted)]">
          OPTIONAL · CODE CONTRIBUTIONS
        </p>
        <h1 id="connect-repos-title" className="text-2xl font-semibold text-[var(--ink)]">
          Your GitHub repositories
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-[var(--muted)]">
          Choose which repositories contribute verified code activity to your profile. Usage tracking works without this step.
        </p>
      </header>

      {error ? (
        <p className="rounded-md border border-[#fecdd3] bg-[#fff1f2] px-4 py-3 text-sm text-[#b91c1c]">{error}</p>
      ) : null}

      {repos === null ? (
        <p className="font-sans text-sm text-[var(--muted)]">Loading your repositories…</p>
      ) : repos.length === 0 && !error ? (
        <p className="font-sans text-sm text-[var(--muted)]">No repositories found on your GitHub account.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter repositories…"
              aria-label="Filter repositories"
              className="w-full max-w-sm rounded-md border border-[var(--line)] bg-[var(--surface-muted)] px-3 py-2 font-sans text-sm text-[var(--ink)] placeholder:text-[var(--muted)]"
            />
            <span className="shrink-0 font-sans text-[11px] text-[var(--muted)]">
              {selected.size} selected · showing {visibleRepos.length}/{repos.length}
            </span>
          </div>

          {visibleRepos.length === 0 ? (
            <p className="font-sans text-sm text-[var(--muted)]">No repositories match “{query}”.</p>
          ) : (
        <ul className="flex max-h-[480px] flex-col gap-2 overflow-y-auto pr-1">
          {visibleRepos.map((repo) => {
            const isSelected = selected.has(repo.repo_id);
            return (
              <li
                key={repo.repo_id}
                className={`flex flex-col gap-3 rounded-md border px-4 py-3 transition-colors sm:flex-row sm:items-center sm:justify-between ${
                  isSelected ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-[#ffffff]'
                }`}
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(repo.repo_id)}
                    className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 truncate font-sans text-sm text-[var(--ink)]">{repo.full_name}</span>
                  {repo.is_private ? (
                    <span className="shrink-0 rounded bg-[var(--line)] px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-[0.08em] text-[var(--muted)]">
                      private
                    </span>
                  ) : null}
                  {repo.stars > 0 ? (
                    <span className="shrink-0 font-sans text-[11px] text-[var(--muted)]">★ {repo.stars}</span>
                  ) : null}
                </label>

                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-sans text-[10px] uppercase tracking-[0.08em] text-[var(--muted)]">prod</span>
                  <input
                    type="text"
                    value={branches[repo.repo_id] ?? repo.default_branch}
                    onChange={(event) =>
                      setBranches((prev) => ({ ...prev, [repo.repo_id]: event.target.value }))
                    }
                    disabled={!isSelected}
                    aria-label={`Prod branch for ${repo.full_name}`}
                    className="w-32 rounded border border-[var(--line)] bg-[var(--surface-muted)] px-2 py-1 font-sans text-xs text-[var(--ink)] disabled:opacity-40"
                  />
                </div>
              </li>
            );
          })}
        </ul>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <Link
          href="/me"
          className="font-sans text-sm text-[var(--muted)] underline underline-offset-4 hover:text-[var(--ink)]"
        >
          Back to your account
        </Link>
        <button
          type="button"
          onClick={handleContinue}
          disabled={saving || repos === null}
          className="dash-button primary "
        >
          {saving
            ? 'Saving…'
            : selected.size > 0
              ? `Save ${selected.size} selected repo${selected.size === 1 ? '' : 's'}`
              : 'Continue'}
        </button>
      </div>
    </section>
  );
}
