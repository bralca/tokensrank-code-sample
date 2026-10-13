import type { LocalPublishPayload } from '@tokensrank/shared';

export type HostedPricingSnapshotRow = {
  provider: string;
  model_id: string;
  content_hash: string | null;
};

export function comparePricingSnapshotToHostedRows(
  payload: LocalPublishPayload,
  hostedRows: HostedPricingSnapshotRow[],
  limit = 100,
): string[] {
  const snapshotByKey = new Map(payload.pricing_snapshot.map((row) => [
    `${row.provider}:${row.model_id}`,
    row.content_hash,
  ]));
  const modelRows = payload.model_daily.length > 0 ? payload.model_daily : payload.usage_daily;
  const usedKeys = new Set(modelRows.map((row) => `${row.provider}:${row.model}`));
  const hostedByKey = new Map(hostedRows.map((row) => [`${row.provider}:${row.model_id}`, row.content_hash]));
  const mismatches: string[] = [];

  for (const key of usedKeys) {
    if (!snapshotByKey.has(key)) {
      mismatches.push(`${key}: local pricing snapshot missing for used model`);
    }
  }

  for (const [key, localHash] of snapshotByKey) {
    const hostedHash = hostedByKey.get(key);
    if (!hostedHash) {
      if (usedKeys.has(key)) {
        mismatches.push(`${key}: hosted pricing row missing`);
      }
      continue;
    }
    if (hostedHash !== localHash) {
      mismatches.push(`${key}: pricing hash differs from hosted reference`);
    }
  }

  return mismatches.slice(0, limit);
}
