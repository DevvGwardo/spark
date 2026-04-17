/**
 * Hermes Bridge Local Detection
 *
 * Detects if the Hermes bridge is running locally and has valid API credentials
 * configured, allowing the frontend to skip manual API key entry.
 */

const HERMES_BRIDGE_URL = import.meta.env.VITE_HERMES_BRIDGE_URL || 'http://localhost:3002/v1';

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
    const healthUrl = `${HERMES_BRIDGE_URL.replace('/v1', '')}/health`;
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as {
      status?: string;
      has_openrouter_creds?: boolean;
      has_minimax_creds?: boolean;
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

    return {
      isReachable: true,
      hasOpenRouterCreds: data.has_openrouter_creds ?? false,
      hasMiniMaxCreds: data.has_minimax_creds ?? false,
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
  return status !== null && (status.hasOpenRouterCreds || status.hasMiniMaxCreds);
}
