import { z } from 'zod';
import { ProfileEvidenceSchema, PublicPresenceSchema, type PublicPresence } from '@tokensrank/shared';
import { normalizePublishBase, type PublishConnection } from './publish-connection.js';

const PublicRecordSchema = z.object({
  identity: z.object({ handle: z.string() }),
  headline: z.object({ rank: z.number().int().positive().nullable(), total_ranked: z.number().int().nonnegative().nullable() }),
  at_glance: z.object({ tokens_total: z.number().nonnegative() }),
  evidence: z.object({
    published_at: z.string().datetime({ offset: true }).nullable(),
    standings: ProfileEvidenceSchema.shape.standings,
  }).optional(),
});

/** Read the already-public record. No local usage, cookies, or publishing credentials leave the device. */
export async function readPublicPresence(connection: PublishConnection | null, fetcher: typeof fetch = fetch): Promise<PublicPresence> {
  if (!connection || connection.disconnected || !connection.public_profile_url) return { status: 'disconnected' };
  try {
    const base = normalizePublishBase(connection.hosted_api_base);
    const profileUrl = normalizePublishBase(connection.public_profile_url);
    const handle = new URL(profileUrl).pathname.match(/^\/u\/([a-zA-Z0-9_-]+)$/)?.[1];
    if (!handle) return { status: 'unavailable' };
    const response = await fetcher(`${base}/api/profile/${encodeURIComponent(handle)}?window=all`, {
      method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit',
      redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return { status: 'unpublished', profile_url: profileUrl };
    if (!response.ok) return { status: 'unavailable' };
    const raw = await response.json();
    const record = PublicRecordSchema.parse(raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw);
    if (record.identity.handle.toLowerCase() !== handle.toLowerCase()) return { status: 'unavailable' };
    if (!record.at_glance.tokens_total && !record.evidence?.published_at) return { status: 'unpublished', profile_url: profileUrl };
    return PublicPresenceSchema.parse({
      status: 'available', profile_url: profileUrl, handle: record.identity.handle,
      tokens: record.at_glance.tokens_total, published_at: record.evidence?.published_at ?? null,
      rank: record.headline.rank, builders: record.headline.total_ranked,
      standings: record.evidence?.standings ?? [],
    });
  } catch {
    return { status: 'unavailable' };
  }
}
