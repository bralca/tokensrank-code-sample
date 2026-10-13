import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.SUPABASE_URL ??= 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
});

import { isNonShippingPath, syncProfileContrib, calculateProfileContribDaily, commitNonDocAdditions, type ConnectedRepoRef } from './github-pull';

const REPO: ConnectedRepoRef = { repo_id: 1, full_name: 'acme/app', prod_branch: 'main' };

const COMMITS = [
  { sha: 'a1', author: { login: 'dev' }, commit: { author: { date: '2026-05-01T10:00:00Z' } } },
  { sha: 'a2', author: { login: 'dev' }, commit: { author: { date: '2026-05-01T12:00:00Z' } } },
  { sha: 'b1', author: { login: 'dev' }, commit: { author: { date: '2026-05-02T09:00:00Z' } } },
];

const DETAILS: Record<string, { files: Array<{ filename: string; additions: number }> }> = {
  a1: { files: [{ filename: 'src/a.ts', additions: 40 }, { filename: 'README.md', additions: 100 }] },
  a2: { files: [{ filename: 'src/b.ts', additions: 10 }, { filename: 'pnpm-lock.yaml', additions: 500 }] },
  b1: { files: [{ filename: 'lib/c.ts', additions: 25 }, { filename: 'docs/guide.md', additions: 80 }] },
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

function createFetch() {
  let detailFetches = 0;
  const impl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/commits/')) {
      detailFetches += 1;
      const sha = u.split('/commits/')[1]!;
      return jsonResponse(DETAILS[sha] ?? { files: [] });
    }
    if (u.includes('/commits?')) {
      const page = Number(new URL(u).searchParams.get('page'));
      return jsonResponse(page === 1 ? COMMITS : []);
    }
    return jsonResponse([]);
  }) as unknown as typeof fetch;

  return { impl, detailFetches: () => detailFetches };
}

function createSupabase(cached: Array<{ sha: string; nondoc_additions: number }> = []) {
  const commitCacheUpserts: any[] = [];
  const contribUpserts: any[][] = [];

  function builder(table: string) {
    let op: 'select' | 'upsert' | null = null;
    let payload: any = null;
    const b: any = {
      select() { op = 'select'; return b; },
      eq() { return b; },
      in() { return b; },
      order() { return b; },
      limit() { return b; },
      upsert(rows: any) { op = 'upsert'; payload = rows; return b; },
      then(resolve: (value: unknown) => void) {
        if (table === 'commit_cache' && op === 'select') {
          resolve({ data: cached, error: null });
        } else if (table === 'commit_cache' && op === 'upsert') {
          commitCacheUpserts.push(payload);
          resolve({ error: null });
        } else if (table === 'contrib_daily' && op === 'upsert') {
          contribUpserts.push(payload);
          resolve({ error: null });
        } else {
          resolve({ data: [], error: null });
        }
      },
    };
    return b;
  }

  return { client: { from: (t: string) => builder(t) } as never, commitCacheUpserts, contribUpserts };
}

describe('isNonShippingPath', () => {
  it('excludes docs, lockfiles, generated, vendored, and data files', () => {
    for (const path of ['README.md', 'docs/guide.mdx', 'pnpm-lock.yaml', 'package-lock.json', 'dist/app.js', 'vendor/x.go', 'a.min.js', 'data.csv', 'icon.svg']) {
      expect(isNonShippingPath(path)).toBe(true);
    }
  });

  it('counts real source files', () => {
    for (const path of ['src/index.ts', 'lib/server.py', 'app/page.tsx', 'main.go']) {
      expect(isNonShippingPath(path)).toBe(false);
    }
  });
});

describe('syncProfileContrib', () => {
  it('sums non-doc additions per day and writes contrib_daily', async () => {
    const fetchMock = createFetch();
    const supabase = createSupabase();

    const result = await syncProfileContrib({
      profileId: 'p1',
      login: 'dev',
      repos: [REPO],
      token: 'gho_test',
      sinceIso: '2026-01-01T00:00:00Z',
      supabaseClient: supabase.client,
      fetchImpl: fetchMock.impl,
    });

    expect(result.commitsSeen).toBe(3);
    expect(result.commitsFetched).toBe(3);
    expect(result.shippedLocTotal).toBe(75); // 40 + 10 + 25 (docs/lockfiles excluded)

    const rows = supabase.contribUpserts.flat();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile_id: 'p1', day: '2026-05-01', shipped_loc: 50, commit_count: 2, weighted_shipped: 50 }),
      expect.objectContaining({ profile_id: 'p1', day: '2026-05-02', shipped_loc: 25, commit_count: 1 }),
    ]));
    expect(supabase.commitCacheUpserts).toHaveLength(1);
    expect(supabase.commitCacheUpserts.flat()).toHaveLength(3);
  });

  it('reuses cached commits and does not re-fetch commit detail', async () => {
    const fetchMock = createFetch();
    const supabase = createSupabase([
      { sha: 'a1', nondoc_additions: 40 },
      { sha: 'a2', nondoc_additions: 10 },
      { sha: 'b1', nondoc_additions: 25 },
    ]);

    const result = await syncProfileContrib({
      profileId: 'p1',
      login: 'dev',
      repos: [REPO],
      token: 'gho_test',
      sinceIso: '2026-01-01T00:00:00Z',
      supabaseClient: supabase.client,
      fetchImpl: fetchMock.impl,
    });

    expect(fetchMock.detailFetches()).toBe(0);
    expect(result.commitsFetched).toBe(0);
    expect(result.shippedLocTotal).toBe(75);
    expect(supabase.commitCacheUpserts).toHaveLength(0);
  });

  it('attributes by author login OR verified email, ignoring other contributors', async () => {
    // GitHub's author= filter is unreliable, so we page all branch commits and
    // attribute client-side. Mix: login match, email match, and a foreign author.
    const MIXED = [
      { sha: 'by-login', author: { login: 'dev' }, commit: { author: { date: '2026-05-03T10:00:00Z', email: 'dev@users.noreply.github.com' } } },
      { sha: 'by-email', author: { login: null }, commit: { author: { date: '2026-05-03T11:00:00Z', email: 'dev@personal.dev' } } },
      { sha: 'foreign', author: { login: 'someoneelse' }, commit: { author: { date: '2026-05-03T12:00:00Z', email: 'other@x.com' } } },
    ];
    const detail: Record<string, { files: Array<{ filename: string; additions: number }> }> = {
      'by-login': { files: [{ filename: 'src/a.ts', additions: 5 }] },
      'by-email': { files: [{ filename: 'src/b.ts', additions: 7 }] },
      foreign: { files: [{ filename: 'src/c.ts', additions: 999 }] },
    };
    const impl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/commits/')) {
        return jsonResponse(detail[u.split('/commits/')[1]!] ?? { files: [] });
      }
      if (u.includes('/commits?')) {
        return jsonResponse(Number(new URL(u).searchParams.get('page')) === 1 ? MIXED : []);
      }
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const supabase = createSupabase();

    const result = await syncProfileContrib({
      profileId: 'p1',
      login: 'dev',
      repos: [REPO],
      token: 'gho_test',
      sinceIso: '2026-01-01T00:00:00Z',
      verifiedEmails: ['dev@personal.dev'],
      supabaseClient: supabase.client,
      fetchImpl: impl,
    });

    expect(result.commitsSeen).toBe(2); // login + email matched; foreign excluded
    expect(result.shippedLocTotal).toBe(12); // 5 + 7, never the foreign 999
  });
});


describe('GitHub evidence versus ranking score', () => {
  it('returns uncapped evidence and capped ranking rows from the same commits', async () => {
    const supabase = createSupabase([{ sha: 'a1', nondoc_additions: 3400 }, { sha: 'a2', nondoc_additions: 10 }, { sha: 'b1', nondoc_additions: 25 }]);
    const result = await calculateProfileContribDaily({ profileId: 'p1', login: 'dev', repos: [REPO], token: 'test', sinceIso: '2026-01-01T00:00:00Z', supabaseClient: supabase.client, fetchImpl: createFetch().impl });
    expect(result.shippedLocTotal).toBe(2035);
    expect(result.rawShippedLocTotal).toBe(3435);
    expect(result.verificationRows.find((row) => row.day === '2026-05-01')?.shipped_loc).toBe(3410);
  });
  it('follows all file pages instead of accepting the first 300 files as complete', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => new Response(JSON.stringify({ files: [{ filename: String(url).includes('?page=2') ? 'src/b.ts' : 'src/a.ts', additions: 15 }] }), {
      headers: String(url).includes('?page=2') ? {} : { link: '<https://api.github.com/repos/acme/app/commits/a?page=2>; rel="next"' },
    }));
    expect(await commitNonDocAdditions({ fullName: 'acme/app', sha: 'a', token: 'test', fetchImpl: fetchImpl as typeof fetch })).toBe(30);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
