import crypto from 'node:crypto';

const HIBP_TIMEOUT_MS = 2000;
const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range';

function hashPasswordForHibp(password: string): { prefix: string; suffix: string } {
  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();

  return {
    prefix: sha1.slice(0, 5),
    suffix: sha1.slice(5),
  };
}

export async function isPasswordBreached(password: string): Promise<boolean> {
  const { prefix, suffix } = hashPasswordForHibp(password);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, HIBP_TIMEOUT_MS);

  try {
    const response = await fetch(`${HIBP_RANGE_URL}/${prefix}`, {
      headers: {
        'Add-Padding': 'true',
        'User-Agent': 'tokensrank-api',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HIBP responded with ${response.status}`);
    }

    const body = await response.text();

    return body
      .split('\n')
      .some((line) => line.trim().split(':')[0]?.toUpperCase() === suffix);
  } finally {
    clearTimeout(timeout);
  }
}
