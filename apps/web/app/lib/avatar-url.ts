export function avatarProxyUrl(avatarUrl?: string | null): string | null {
  if (!avatarUrl) {
    return null;
  }

  try {
    const url = new URL(avatarUrl);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    return `/avatar-proxy?url=${encodeURIComponent(url.toString())}`;
  } catch {
    return null;
  }
}
