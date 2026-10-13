import { timingSafeEqual } from 'node:crypto';

function copyIntoPaddedBuffer(source: Buffer, comparisonLength: number): Buffer {
  const padded = Buffer.alloc(comparisonLength);
  source.copy(padded);
  return padded;
}

/**
 * Compares bearer-token strings without leaking the first mismatching byte.
 *
 * Node's timingSafeEqual requires equal-length buffers, so both token buffers
 * are copied into zero-filled buffers with the same comparison length. The
 * constant-time comparison always runs on those padded buffers, including when
 * the original inputs have unequal lengths. The original byte lengths are then
 * included in the final boolean result so padded prefixes cannot authenticate.
 */
export function safeCompareTokens(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const comparisonLength = Math.max(providedBuffer.length, expectedBuffer.length);

  const paddedProvided = copyIntoPaddedBuffer(providedBuffer, comparisonLength);
  const paddedExpected = copyIntoPaddedBuffer(expectedBuffer, comparisonLength);

  return (
    timingSafeEqual(paddedProvided, paddedExpected) &&
    providedBuffer.length === expectedBuffer.length
  );
}
