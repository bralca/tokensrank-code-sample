import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTH_COOKIE_DOMAIN,
  clearCookies,
  getCookieOptions,
  setCookies,
} from '../../src/plugins/cookies';

const originalNodeEnv = process.env.NODE_ENV;

function cookieHeaders(response: Awaited<ReturnType<ReturnType<typeof Fastify>['inject']>>): string[] {
  const setCookie = response.headers['set-cookie'];

  if (!setCookie) {
    return [];
  }

  return Array.isArray(setCookie) ? setCookie : [String(setCookie)];
}

async function injectCookieRoute(mode: 'clear' | 'set') {
  const app = Fastify({ logger: false });

  app.post('/cookies', async (_request, reply) => {
    if (mode === 'clear') {
      clearCookies(reply);
    } else {
      setCookies(reply, {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
    }

    return reply.code(204).send();
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cookies',
    });

    return cookieHeaders(response);
  } finally {
    await app.close();
  }
}

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('authentication cookie domain behavior', () => {
  it('getCookieOptions adds .tokensrank.ai only for production', () => {
    expect(getCookieOptions('access', 'production')).toMatchObject({
      domain: AUTH_COOKIE_DOMAIN,
      path: '/',
    });
    expect(getCookieOptions('refresh', 'production')).toMatchObject({
      domain: AUTH_COOKIE_DOMAIN,
      path: '/api/auth/refresh',
    });
    expect(getCookieOptions('access', 'development')).not.toHaveProperty('domain');
    expect(getCookieOptions('refresh', 'test')).not.toHaveProperty('domain');
  });

  it('setCookies omits Domain outside production', async () => {
    process.env.NODE_ENV = 'development';

    const cookies = await injectCookieRoute('set');
    const joinedCookies = cookies.join('\n');

    expect(cookies).toHaveLength(2);
    expect(joinedCookies).not.toContain('Domain=');
    expect(joinedCookies).toContain('SameSite=Lax');
    expect(joinedCookies).not.toContain('SameSite=None');
  });

  it('setCookies and clearCookies include Domain=.tokensrank.ai in production', async () => {
    process.env.NODE_ENV = 'production';

    const setHeaders = await injectCookieRoute('set');
    const clearHeaders = await injectCookieRoute('clear');

    for (const header of [...setHeaders, ...clearHeaders]) {
      expect(header).toContain(`Domain=${AUTH_COOKIE_DOMAIN}`);
      expect(header).toContain('SameSite=Lax');
      expect(header).not.toContain('SameSite=None');
    }
  });
});

