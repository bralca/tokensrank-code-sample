const GEIST_FONT_STYLESHEET_URL = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;600;700&display=swap';
const FONT_URL_PATTERN = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/;

let geistFontPromise: Promise<ArrayBuffer | null> | null = null;
let geistFontData: ArrayBuffer | null = null;

function cloneArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

async function fetchGeistFont(signal: AbortSignal): Promise<ArrayBuffer> {
  const stylesheetResponse = await fetch(GEIST_FONT_STYLESHEET_URL, {
    headers: {
      Accept: 'text/css',
      'User-Agent': 'TokensRank OG Renderer',
    },
    signal,
  });

  if (!stylesheetResponse.ok) {
    throw new Error(`stylesheet returned ${stylesheetResponse.status}`);
  }

  const stylesheet = await stylesheetResponse.text();
  const fontUrl = stylesheet.match(FONT_URL_PATTERN)?.[1];

  if (!fontUrl) {
    throw new Error('stylesheet did not include a Geist font URL');
  }

  const fontResponse = await fetch(fontUrl, {
    headers: {
      Accept: 'font/woff2,*/*',
      'User-Agent': 'TokensRank OG Renderer',
    },
    signal,
  });

  if (!fontResponse.ok) {
    throw new Error(`font returned ${fontResponse.status}`);
  }

  return fontResponse.arrayBuffer();
}

export async function loadGeistFont(timeoutMs = 2000): Promise<ArrayBuffer | null> {
  if (geistFontData) {
    return cloneArrayBuffer(geistFontData);
  }

  if (geistFontPromise) {
    const fontData = await geistFontPromise;
    return fontData ? cloneArrayBuffer(fontData) : null;
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });

  try {
    geistFontPromise = Promise.race([
      fetchGeistFont(controller.signal),
      timeoutPromise,
    ]);
    const fontData = await geistFontPromise;

    if (fontData === null) {
      console.warn(`[og-fonts] WARN Geist font load timed out after ${timeoutMs}ms; using system fallback`);
      geistFontPromise = null;
      return null;
    }

    geistFontData = fontData;
    return cloneArrayBuffer(fontData);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[og-fonts] WARN Geist font load failed: ${message}; using system fallback`);
    geistFontPromise = null;
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    geistFontPromise = null;
  }
}
