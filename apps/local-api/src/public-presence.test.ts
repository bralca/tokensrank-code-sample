import { describe, expect, it, vi } from 'vitest';
import { readPublicPresence } from './public-presence.js';

const connection = { hosted_api_base: 'http://localhost:3201', public_profile_url: 'http://localhost:3200/u/example', expires_at: null };
const record = { identity: { handle: 'example' }, headline: { rank: 1, total_ranked: 1 }, at_glance: { tokens_total: 100 }, evidence: { published_at: '2026-09-14T10:00:00Z', standings: [{ kind: 'model', key: 'gpt-5', slug: 'gpt-5', rank: 1, builders: 1 }] } };

describe('read-only public presence', () => {
  it('reads only the saved public profile and sends no credentials or local payload', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(record));
    expect(await readPublicPresence(connection, fetcher)).toMatchObject({ status: 'available', rank: 1, builders: 1, tokens: 100 });
    expect(fetcher).toHaveBeenCalledWith('http://localhost:3201/api/profile/example?window=all', expect.objectContaining({ method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error' }));
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty('body');
    expect(Object.keys(fetcher.mock.calls[0]![1]!.headers!)).toEqual(['Accept']);
  });
  it('does not contact the public service when disconnected', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await readPublicPresence(null, fetcher)).toEqual({ status: 'disconnected' });
    expect(await readPublicPresence({ ...connection, disconnected: true }, fetcher)).toEqual({ status: 'disconnected' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('separates no publication from an unavailable service', async () => {
    expect((await readPublicPresence(connection, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })))).status).toBe('unpublished');
    expect((await readPublicPresence(connection, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })))).status).toBe('unavailable');
    expect((await readPublicPresence(connection, vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout')))).status).toBe('unavailable');
  });
  it('preserves an unranked profile without fabricating a population', async () => {
    const result = await readPublicPresence(connection, vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { ...record, headline: { rank: null, total_ranked: null } } })));
    expect(result).toMatchObject({ status: 'available', rank: null, builders: null });
  });
  it('rejects mismatched identities and unsafe saved destinations', async () => {
    expect((await readPublicPresence(connection, vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...record, identity: { handle: 'someone-else' } })))).status).toBe('unavailable');
    const fetcher = vi.fn<typeof fetch>();
    for (const public_profile_url of ['javascript:alert(1)', 'https://secret@example.com/u/example', 'https://example.com/u/example?token=x']) {
      expect((await readPublicPresence({ ...connection, public_profile_url }, fetcher)).status).toBe('unavailable');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
