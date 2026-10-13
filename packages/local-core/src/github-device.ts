import type {
  LocalGithubDeviceStartResponse,
  LocalGithubDeviceStatusResponse,
} from '@tokensrank/shared';

import type { LocalDatabase } from './db.js';
import { deleteSyncState, nowIso, readSyncState, writeSyncState } from './db.js';
import { connectGithubWithToken } from './github.js';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

type DeviceState = {
  client_id: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_at: string;
  interval: number;
  next_poll_at?: string;
};

type DeviceCodeResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
};

type AccessTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

function clientIdFromEnv(clientId?: string): string {
  const value = clientId
    ?? process.env.GITHUB_DEVICE_CLIENT_ID
    ?? process.env.GITHUB_OAUTH_CLIENT_ID
    ?? process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID;

  if (!value) {
    throw new Error('[github-device] Missing GITHUB_DEVICE_CLIENT_ID for local GitHub Device Flow.');
  }

  return value;
}

function formBody(values: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    body.set(key, value);
  }
  return body;
}

export async function startGithubDeviceFlow(
  db: LocalDatabase,
  options: { clientId?: string; fetchImpl?: typeof fetch } = {},
): Promise<LocalGithubDeviceStartResponse> {
  const clientId = clientIdFromEnv(options.clientId);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'tokensrank-local',
    },
    body: formBody({
      client_id: clientId,
      scope: 'repo user:email',
    }),
  });
  const body = await response.json() as DeviceCodeResponse;

  if (!response.ok || body.error || !body.device_code || !body.user_code || !body.verification_uri || !body.expires_in) {
    throw new Error(body.error_description ?? body.error ?? '[github-device] Could not start GitHub Device Flow.');
  }

  const interval = body.interval ?? 5;
  const state: DeviceState = {
    client_id: clientId,
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
    interval,
  };
  writeSyncState(db, 'github_device_flow', state);

  return {
    device_code: state.device_code,
    user_code: state.user_code,
    verification_uri: state.verification_uri,
    expires_in: body.expires_in,
    interval,
  };
}

function pendingResponse(
  state: DeviceState,
  message: string | null,
): LocalGithubDeviceStatusResponse {
  return {
    status: 'pending',
    message,
    identity: null,
    poll_interval_seconds: state.interval,
    next_poll_at: state.next_poll_at ?? null,
  };
}

function updateDeviceState(db: LocalDatabase, state: DeviceState): DeviceState {
  writeSyncState(db, 'github_device_flow', state);
  return state;
}

export async function pollGithubDeviceFlow(
  db: LocalDatabase,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<LocalGithubDeviceStatusResponse> {
  const state = readSyncState<DeviceState | null>(db, 'github_device_flow', null);
  if (!state) {
    return {
      status: 'error',
      message: 'No GitHub device flow is active.',
      identity: null,
    };
  }

  if (Date.parse(state.expires_at) <= Date.now()) {
    deleteSyncState(db, 'github_device_flow');
    return {
      status: 'expired',
      message: 'GitHub device code expired.',
      identity: null,
    };
  }

  const nextPollAt = state.next_poll_at ? Date.parse(state.next_poll_at) : 0;
  if (Number.isFinite(nextPollAt) && nextPollAt > Date.now()) {
    const seconds = Math.max(1, Math.ceil((nextPollAt - Date.now()) / 1000));
    return pendingResponse(state, `Waiting before the next GitHub status check (${seconds}s).`);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'tokensrank-local',
    },
    body: formBody({
      client_id: state.client_id,
      device_code: state.device_code,
      grant_type: DEVICE_GRANT_TYPE,
    }),
  });
  const body = await response.json() as AccessTokenResponse;

  if (body.error === 'authorization_pending') {
    return pendingResponse(updateDeviceState(db, {
      ...state,
      next_poll_at: new Date(Date.now() + state.interval * 1000).toISOString(),
    }), body.error_description ?? 'Waiting for GitHub authorization.');
  }

  if (body.error === 'slow_down') {
    const interval = Math.min(state.interval + 5, 60);
    return pendingResponse(updateDeviceState(db, {
      ...state,
      interval,
      next_poll_at: new Date(Date.now() + interval * 1000).toISOString(),
    }), body.error_description ?? `GitHub asked us to slow down; checking again in ${interval}s.`);
  }

  if (body.error === 'expired_token') {
    deleteSyncState(db, 'github_device_flow');
    return {
      status: 'expired',
      message: body.error_description ?? 'GitHub device code expired.',
      identity: null,
    };
  }

  if (!response.ok || body.error || !body.access_token) {
    return {
      status: 'error',
      message: body.error_description ?? body.error ?? 'GitHub device authorization failed.',
      identity: null,
    };
  }

  const identity = await connectGithubWithToken(db, body.access_token, fetchImpl);
  deleteSyncState(db, 'github_device_flow');
  writeSyncState(db, 'github_device_flow_authorized_at', { authorized_at: nowIso() });

  return {
    status: 'authorized',
    message: null,
    identity,
  };
}
