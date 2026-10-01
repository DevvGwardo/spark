import { getApiBaseUrl } from '@/lib/api';

/** Client for the server's /api/nub routes (server/routes/nub.ts). */

export interface NubInstance {
  id: string;
  publicUrl: string;
  status: string;
}

export type NubStatus =
  | { linked: false; expired?: boolean }
  | {
      linked: true;
      reachable: boolean;
      origin: string;
      instance: NubInstance | null;
      keyPrefix: string | null;
      keyExpiresAt: number | null;
    };

export interface NubLinkStart {
  code: string;
  telegramUrl: string;
  pairingUrl: string | null;
  pollInterval: number;
}

export interface NubKey {
  apiKey: string;
  keyPrefix: string;
  keyExpiresAt: number;
  models: string[];
}

export type NubPoll =
  | { status: 'pending' }
  | { status: 'needs_subscription'; telegramUrl: string }
  | { status: 'provisioning'; instanceStatus?: string }
  | ({ status: 'ready'; instance: NubInstance; mcpRegistered: boolean } & NubKey)
  | { status: 'expired' | 'denied' | 'not_found' | 'provision_failed' }
  | { status: 'error'; error?: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  // Poll answers carry their outcome in `status`, even on 4xx.
  if (!response.ok && !(data && typeof data === 'object' && 'status' in data)) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }
  return data;
}

export const nubApi = {
  status: () => call<NubStatus>('GET', '/api/nub/status'),
  start: () => call<NubLinkStart>('POST', '/api/nub/auth/start'),
  poll: (code: string) => call<NubPoll>('GET', `/api/nub/auth/poll?code=${encodeURIComponent(code)}`),
  refreshKey: () => call<NubKey>('POST', '/api/nub/key'),
  logout: () => call<{ ok: boolean; revoked: boolean }>('POST', '/api/nub/logout'),
};
