import { hermesFetch } from './core';

// ─── Nous Portal (hermes portal) ────────────────────────────────────────────

export interface PortalToolGatewayRow {
  label: string;
  status_text: string;
  via_nous: boolean;
  active: boolean;
  configured: boolean;
  provider: string | null;
  partner?: string;
}

export interface PortalInfo {
  ok: boolean;
  cli_ok?: boolean;
  logged_in: boolean;
  logged_out: boolean;
  portal_url: string | null;
  inference_base_url: string | null;
  signup_url: string | null;
  model_hint: string | null;
  using_nous_provider: boolean;
  tool_gateway: PortalToolGatewayRow[];
  docs_url: string | null;
  error?: string | null;
}

export interface PortalToolsCatalog {
  ok: boolean;
  cli_ok?: boolean;
  tools: PortalToolGatewayRow[];
  nous_auth_present: boolean;
  subscription_url: string;
  docs_url: string;
  error?: string | null;
}

export interface PortalOpenUrls {
  ok: boolean;
  portal_url: string;
  subscription_url: string;
  login_url: string;
  docs_url: string;
  logged_in: boolean;
  login_hint: string;
}

export interface PortalOAuthStart {
  ok: boolean;
  session_id?: string;
  user_code?: string;
  verification_url?: string;
  expires_in?: number;
  poll_interval?: number;
  already_logged_in?: boolean;
  logged_in?: boolean;
  imported_shared_state?: boolean;
  error?: string;
}

export interface PortalOAuthPoll {
  ok: boolean;
  session_id: string;
  status: 'pending' | 'complete' | 'error' | 'expired' | 'not_found';
  poll_interval?: number;
  logged_in?: boolean;
  error?: string;
}

export async function fetchPortalInfo(): Promise<PortalInfo> {
  return hermesFetch<PortalInfo>('/portal/info');
}

export async function fetchPortalTools(): Promise<PortalToolsCatalog> {
  return hermesFetch<PortalToolsCatalog>('/portal/tools');
}

export async function fetchPortalOpenUrls(): Promise<PortalOpenUrls> {
  return hermesFetch<PortalOpenUrls>('/portal/open-url');
}

export async function startPortalOAuth(): Promise<PortalOAuthStart> {
  return hermesFetch<PortalOAuthStart>('/portal/oauth/start', { method: 'POST' });
}

export async function pollPortalOAuth(sessionId: string): Promise<PortalOAuthPoll> {
  return hermesFetch<PortalOAuthPoll>(
    `/portal/oauth/poll/${encodeURIComponent(sessionId)}`,
  );
}
