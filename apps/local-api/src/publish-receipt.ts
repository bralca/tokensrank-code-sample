import { randomUUID } from 'node:crypto';
import { LocalPublishPayloadSchema, type LocalPublishPayload } from '@tokensrank/shared';

export class PublishReceipts {
  private current: { receipt_id: string; expires_at: string; payload: LocalPublishPayload; connection: string } | null = null;

  create(payload: LocalPublishPayload, connection: string, now = Date.now()) {
    const snapshot = LocalPublishPayloadSchema.parse(structuredClone(payload));
    if (snapshot.schema_version !== 2 || snapshot.usage_session_rollups.length) {
      throw new Error('A sharing receipt can contain aggregates only.');
    }
    this.current = { receipt_id: randomUUID(), expires_at: new Date(now + 15 * 60_000).toISOString(), payload: snapshot, connection };
    return { receipt_id: this.current.receipt_id, expires_at: this.current.expires_at,
      byte_size: Buffer.byteLength(JSON.stringify(snapshot)), payload: structuredClone(snapshot) };
  }

  take(id: string, connection: string, now = Date.now()): LocalPublishPayload {
    const receipt = this.current;
    if (!receipt || receipt.receipt_id !== id || Date.parse(receipt.expires_at) <= now || receipt.connection !== connection) {
      throw new Error('This receipt expired or the account changed. Review a new receipt before publishing.');
    }
    // One confirmation permits one attempt. Network failures require a fresh
    // review rather than silently sending a changed snapshot or replaying it.
    this.current = null;
    return receipt.payload;
  }
}
