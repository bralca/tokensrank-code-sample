import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CacheService } from '../services/cache.service';
import { installerCompletionRoutes } from './installer-completion';

const apps: Array<ReturnType<typeof Fastify>> = [];

async function buildApp(auth: unknown = {
  profileId: 'profile-1',
  profile: { user_id: 'user-1' },
}) {
  const app = Fastify({ logger: false });
  const cache = new CacheService({ maxItems: 10 });
  const purgeKey = vi.spyOn(cache, 'purgeKey');

  app.decorate('cache', cache);
  app.decorate('requireAccessKey', async (request: unknown) => {
    (request as { auth: unknown }).auth = auth;
  });

  await app.register(installerCompletionRoutes);
  apps.push(app);

  return { app, purgeKey };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('installerCompletionRoutes', () => {
  it('acknowledges installer completion without creating a synthetic ingestion run', async () => {
    const { app, purgeKey } = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/installer/complete',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      message: 'Installation completion acknowledged',
    });
    expect(purgeKey).toHaveBeenCalledWith('onboarding:v1:user-1');
    expect(purgeKey).toHaveBeenCalledWith('me:v1:user-1');
  });

  it('does not fail when the access-key profile has no user id attached', async () => {
    const { app, purgeKey } = await buildApp({
      profileId: 'profile-1',
      profile: null,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/installer/complete',
    });

    expect(response.statusCode).toBe(200);
    expect(purgeKey).not.toHaveBeenCalled();
  });
});
