import { describe, expect, it } from 'vitest';
import { LocalPublishPayloadSchema } from '@tokensrank/shared';
import { PublishReceipts } from './publish-receipt.js';
const payload = LocalPublishPayloadSchema.parse({ schema_version: 2, client_version: 'test', generated_at: '2026-09-14T00:00:00Z', github_user_id: 123, selected_repos: [], usage_daily: [], pricing_snapshot: [], summary: { total_tokens: 10, total_cost_usd: 1, sessions_count: 1, produced_loc_total: 0, github_shipped_loc_total: 0, ai_linked_shipped_loc_total: 0 }, privacy_report: { prompts_sent: 0, raw_commands_sent: 0, file_contents_sent: 0, absolute_paths_sent: 0, raw_transcripts_sent: 0 } });
describe('local sharing receipts', () => {
  it('freezes the reviewed snapshot and allows only one send', () => {
    const receipts = new PublishReceipts(); const source = structuredClone(payload);
    const receipt = receipts.create(source, 'account-a', 0);
    source.summary.total_tokens = 999; receipt.payload.summary.total_tokens = 888;
    expect(receipts.take(receipt.receipt_id, 'account-a', 1).summary.total_tokens).toBe(10);
    expect(() => receipts.take(receipt.receipt_id, 'account-a', 2)).toThrow('expired or the account changed');
  });
  it('rejects expired, replaced, forged and differently connected receipts', () => {
    const receipts = new PublishReceipts(); const old = receipts.create(payload, 'a', 0); const current = receipts.create(payload, 'a', 1);
    expect(() => receipts.take(old.receipt_id, 'a', 2)).toThrow();
    expect(() => receipts.take('invented', 'a', 2)).toThrow();
    expect(() => receipts.take(current.receipt_id, 'b', 2)).toThrow();
    expect(() => receipts.take(current.receipt_id, 'a', 16 * 60_000)).toThrow();
  });
  it('rejects a receipt with individual session records even when the caller claims it is aggregate data', () => {
    expect(() => new PublishReceipts().create({ ...payload, usage_session_rollups: [{ session_id: 'private' } as never] }, 'a')).toThrow();
  });
});
