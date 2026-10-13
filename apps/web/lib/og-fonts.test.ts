import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('loadGeistFont', () => {
  const originalFetch = globalThis.fetch;
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    warnSpy.mockClear();
    vi.useRealTimers();
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('returns an ArrayBuffer when the CDN stylesheet and font load', async () => {
    const { loadGeistFont } = await import('./og-fonts');
    const fontBuffer = new Uint8Array([1, 2, 3]).buffer;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('fonts.googleapis.com')) {
        return new Response('@font-face{src:url(https://fonts.gstatic.com/s/geist/font.woff2)}');
      }

      return new Response(fontBuffer);
    });

    const result = await loadGeistFont(100);

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(result ?? new ArrayBuffer(0)))).toEqual([1, 2, 3]);
  });

  it('returns null when the timeout fires near the specified duration', async () => {
    const { loadGeistFont } = await import('./og-fonts');
    globalThis.fetch = vi.fn(async () => new Promise<Response>(() => undefined));
    const startedAt = performance.now();

    await expect(loadGeistFont(50)).resolves.toBeNull();

    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(150);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('resolves concurrent calls independently', async () => {
    const { loadGeistFont } = await import('./og-fonts');
    let callCount = 0;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      callCount += 1;
      const url = String(input);

      if (url.includes('fonts.googleapis.com')) {
        return new Response('@font-face{src:url(https://fonts.gstatic.com/s/geist/font.woff2)}');
      }

      const byte = callCount;
      return new Response(new Uint8Array([byte]).buffer);
    });

    const [first, second] = await Promise.all([
      loadGeistFont(100),
      loadGeistFont(100),
    ]);

    expect(first).toBeInstanceOf(ArrayBuffer);
    expect(second).toBeInstanceOf(ArrayBuffer);
    expect(first).not.toBe(second);
    expect(Array.from(new Uint8Array(first ?? new ArrayBuffer(0)))).toEqual([2]);
    expect(Array.from(new Uint8Array(second ?? new ArrayBuffer(0)))).toEqual([2]);
    expect(callCount).toBe(2);
  });
});
