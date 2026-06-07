/**
 * Hermes Bridge Local Detection
 *
 * Detects if the Hermes bridge is running locally and has valid API credentials
 * configured, allowing the frontend to skip manual API key entry.
 *
 * Detection goes through the same-origin API server (`/api/hermes/health`), which
 * proxies to the bridge on the server side. This must NOT fetch the bridge URL
 * directly: a phone loading the app over LAN/tunnel can't resolve the host's
 * localhost:3002, so a direct fetch always fails and Hermes would look offline.
 */

import { getApiBaseUrl } from './api';
import { getActiveProfile } from '@/stores/profiles-store';

export interface HermesBridgeCredentialSources {
  env: boolean;
  authJson: boolean;
  openclawGateway: boolean;
}

export interface HermesBridgeMiniMaxCredentialSources {
  env: boolean;
  openclawGateway: boolean;
}

export interface HermesBridgeStatus {
  isReachable: boolean;
  hasOpenRouterCreds: boolean;
  hasMiniMaxCreds: boolean;
  /** Full per-provider credential map from the bridge, e.g. { nous: true, openrouter: false }. */
  providerCredentials: Record<string, boolean>;
  /** True if the bridge has a usable credential for ANY provider (not just OpenRouter/MiniMax). */
  hasAnyCreds: boolean;
  /** True if the agent's configured default model is servable — covers config.yaml
   *  custom base_url providers (e.g. deepseek-v4-pro via opencode-go) absent from
   *  the provider_credentials map. */
  defaultModelCredentialed: boolean;
  credentialSources: HermesBridgeCredentialSources;
  credentialSourcesMinimax: HermesBridgeMiniMaxCredentialSources;
  launchTokenPresent: boolean;
  brainInitialized: boolean;
  activeRequests: number;
  hermesProvider?: string;
  hermesBaseUrl?: string;
  hermesDefaultModel?: string;
}

/**
 * Check if the Hermes bridge is running locally and get its credential status.
 * This is used to determine if the user needs to provide an API key manually
 * or if Hermes can use its local credentials fallback.
 */
export async function detectHermesBridge(): Promise<HermesBridgeStatus | null> {
  try {
    const healthUrl = `${getApiBaseUrl()}/api/hermes/health`;
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Profile': getActiveProfile(),
      },
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as {
      status?: string;
      has_openrouter_creds?: boolean;
      has_minimax_creds?: boolean;
      provider_credentials?: Record<string, boolean>;
      default_model_credentialed?: boolean;
      credential_sources?: {
        env?: boolean;
        auth_json?: boolean;
        openclaw_gateway?: boolean;
      };
      credential_sources_minimax?: {
        env?: boolean;
        openclaw_gateway?: boolean;
      };
      launch_token_present?: boolean;
      brain_initialized?: boolean;
      active_requests?: number;
      hermes_provider?: string;
      hermes_base_url?: string;
      hermes_default_model?: string;
    };

    if (data.status !== 'ok') {
      return null;
    }

    const providerCredentials = data.provider_credentials ?? {};
    const defaultModelCredentialed = data.default_model_credentialed ?? false;
    const hasAnyCreds =
      (data.has_openrouter_creds ?? false) ||
      (data.has_minimax_creds ?? false) ||
      defaultModelCredentialed ||
      Object.values(providerCredentials).some(Boolean);

    return {
      isReachable: true,
      hasOpenRouterCreds: data.has_openrouter_creds ?? false,
      hasMiniMaxCreds: data.has_minimax_creds ?? false,
      providerCredentials,
      hasAnyCreds,
      defaultModelCredentialed,
      credentialSources: {
        env: data.credential_sources?.env ?? false,
        authJson: data.credential_sources?.auth_json ?? false,
        openclawGateway: data.credential_sources?.openclaw_gateway ?? false,
      },
      credentialSourcesMinimax: {
        env: data.credential_sources_minimax?.env ?? false,
        openclawGateway: data.credential_sources_minimax?.openclaw_gateway ?? false,
      },
      launchTokenPresent: data.launch_token_present ?? false,
      brainInitialized: data.brain_initialized ?? false,
      activeRequests: data.active_requests ?? 0,
      hermesProvider: data.hermes_provider,
      hermesBaseUrl: data.hermes_base_url,
      hermesDefaultModel: data.hermes_default_model,
    };
  } catch {
    // Bridge is not reachable
    return null;
  }
}

/**
 * Returns true if Hermes can operate without a client-provided API key.
 * This is the case when the bridge is running locally and has credentials
 * configured via bridge env vars, ~/.hermes/auth.json, or ~/.openclaw/openclaw.json.
 */
export async function hermesHasLocalCredentials(): Promise<boolean> {
  const status = await detectHermesBridge();
  return status !== null && status.hasAnyCreds;
}
