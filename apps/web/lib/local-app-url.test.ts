import {afterEach,expect,it,vi} from 'vitest';
import {getLocalAppUrl} from './local-app-url';
afterEach(()=>vi.unstubAllEnvs());
it('sends the public preview to the local app port',()=>{
  vi.stubEnv('NEXT_PUBLIC_SITE_URL','http://localhost:3200');
  vi.stubEnv('NEXT_PUBLIC_LOCAL_APP_URL','');
  expect(getLocalAppUrl()).toBe('http://localhost:3100/local');
  expect(getLocalAppUrl('/local/publish')).toBe('http://localhost:3100/local/publish');
});
it('honors an explicitly configured local app address',()=>{
  vi.stubEnv('NEXT_PUBLIC_LOCAL_APP_URL','http://127.0.0.1:4100');
  expect(getLocalAppUrl('/local/setup')).toBe('http://127.0.0.1:4100/local/setup');
});
it('uses the documented standalone local port for hosted deployments',()=>{
  vi.stubEnv('NEXT_PUBLIC_SITE_URL','https://tokensrank.ai');
  vi.stubEnv('NEXT_PUBLIC_LOCAL_APP_URL','');
  expect(getLocalAppUrl()).toBe('http://localhost:3000/local');
});
