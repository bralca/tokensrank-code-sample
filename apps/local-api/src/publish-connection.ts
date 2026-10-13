import { readSyncState, writeSyncState, type LocalDatabase } from '@tokensrank/local-core';

export type PublishConnection = {
  hosted_api_base: string;
  expires_at: string | null;
  public_profile_url: string | null;
  disconnected?: boolean;
  github_user_id?: number;
};

export function normalizePublishBase(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('Use an HTTPS dashboard address, or HTTP on localhost for development.');
  }
  return url.href.replace(/\/+$/u, '');
}

export function readPublishConnection(db: LocalDatabase): PublishConnection | null {
  return readSyncState<PublishConnection | null>(db, 'publish_connection', null);
}

export function savePublishConnection(db: LocalDatabase, connection: PublishConnection): void {
  writeSyncState(db, 'publish_connection', connection);
}

/** A saved credential must never follow an edited destination or a redirect. */
export function connectedPublishBase(db: LocalDatabase, requested?: string): string {
  const connection = readPublishConnection(db);
  if (!connection || connection.disconnected) throw new Error('Connect publishing before sending data.');
  if (connection.expires_at && Date.parse(connection.expires_at) <= Date.now()) {
    throw new Error('Your publishing connection has expired. Connect again with a new code.');
  }
  if (requested && normalizePublishBase(requested) !== connection.hosted_api_base) {
    throw new Error('Disconnect and connect to the new dashboard before changing the publishing address.');
  }
  return connection.hosted_api_base;
}

export async function publishFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
}
