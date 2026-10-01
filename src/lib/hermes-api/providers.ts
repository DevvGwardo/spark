import { hermesFetch } from './core';

// ─── Providers ────────────────────────────────────────────────────────────

export interface HermesProviderInfo {
  id: string;
  name: string;
  base_url: string;
  is_aggregator: boolean;
  credentialed: boolean;
  models: string[];
  /** Present on the synthetic CLI custom base_url row from /v1/providers. */
  default_model?: string;
}

export interface HermesProvidersResponse {
  providers: HermesProviderInfo[];
  defaultProvider: string;
  /** The agent's CLI-configured default model (config.yaml `model.default`). */
  defaultModel: string;
}

/**
 * Fetch the catalog of underlying providers (and their models) the Hermes
 * agent can route to. Used to populate the provider/model picker.
 */
export async function fetchHermesProviders(): Promise<HermesProvidersResponse> {
  const data = await hermesFetch<{
    data?: HermesProviderInfo[];
    default_provider?: string;
    default_model?: string;
  }>('/providers');
  return {
    providers: Array.isArray(data.data) ? data.data : [],
    defaultProvider: data.default_provider || 'openrouter',
    defaultModel: data.default_model || '',
  };
}

// ─── Mixture of Agents ────────────────────────────────────────────────────

export interface MoaModelRef {
  provider: string;
  model: string;
}

export interface MoaPreset {
  name: string;
  enabled: boolean;
  reference_models: MoaModelRef[];
  aggregator: MoaModelRef;
  reference_temperature?: number | null;
  aggregator_temperature?: number | null;
  max_tokens?: number | null;
  reference_max_tokens?: number | null;
  fanout?: 'per_iteration' | 'user_turn';
}

export interface MoaConfig {
  default_preset: string;
  presets: Record<string, MoaPreset>;
  preset_names: string[];
}

export async function fetchMoaConfig(): Promise<MoaConfig> {
  const data = await hermesFetch<{
    default_preset?: string;
    presets?: Record<string, MoaPreset>;
    preset_names?: string[];
  }>('/moa');
  return {
    default_preset: data.default_preset || 'default',
    presets: data.presets && typeof data.presets === 'object' ? data.presets : {},
    preset_names: Array.isArray(data.preset_names) ? data.preset_names : [],
  };
}

export async function updateMoaConfig(body: {
  default_preset?: string;
  presets?: Record<string, MoaPreset | Record<string, unknown>>;
  preset?: MoaPreset & { delete?: boolean };
}): Promise<MoaConfig> {
  const data = await hermesFetch<{
    default_preset?: string;
    presets?: Record<string, MoaPreset>;
    preset_names?: string[];
  }>('/moa', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return {
    default_preset: data.default_preset || 'default',
    presets: data.presets && typeof data.presets === 'object' ? data.presets : {},
    preset_names: Array.isArray(data.preset_names) ? data.preset_names : [],
  };
}

// ─── Ops: fallback, checkpoints, memory, curator, goals, insights ─────────

export interface FallbackProvider {
  provider: string;
  model: string;
  base_url?: string;
}

export async function fetchFallbackProviders(): Promise<FallbackProvider[]> {
  const data = await hermesFetch<{ providers?: FallbackProvider[] }>('/fallback');
  return Array.isArray(data.providers) ? data.providers : [];
}

export async function updateFallbackProviders(providers: FallbackProvider[]): Promise<FallbackProvider[]> {
  const data = await hermesFetch<{ providers?: FallbackProvider[] }>('/fallback', {
    method: 'PUT',
    body: JSON.stringify({ providers }),
  });
  return Array.isArray(data.providers) ? data.providers : [];
}

// ─── Saved providers (hermes-agent auth store) ──────────────────────────────

export interface HermesSavedProvider {
  id: string;
  name: string;
  label: string;
  auth_type: string;
  base_url: string;
  status: 'active' | 'configured' | 'error';
  detail: string;
  active: boolean;
  request_count: number;
}

/** Providers the user has saved/authenticated in their hermes-agent
 *  (~/.hermes/auth.json), with derived status. Read-only. */
export async function fetchHermesSavedProviders(): Promise<HermesSavedProvider[]> {
  const data = await hermesFetch<{ providers: HermesSavedProvider[] }>('/workspace/auth-providers');
  return data.providers ?? [];
}

// ─── Auth credential pool (hermes auth) ───────────────────────────────────

export interface AuthPoolCredential {
  index: number;
  id: string | null;
  label: string;
  auth_type: string;
  source: string;
  masked_key: string;
  exhausted: boolean;
  active: boolean;
  priority: number;
  request_count: number;
  last_status: string | null;
  last_error_code: number | null;
  last_error_message: string | null;
  status_hint?: string | null;
}

export interface AuthPoolProvider {
  provider: string;
  credential_count: number;
  active_provider: boolean;
  logged_in: boolean | null;
  status_error: string | null;
  credentials: AuthPoolCredential[];
}

export interface AuthPoolStatus {
  ok: boolean;
  cli_ok: boolean;
  active_provider: string | null;
  providers: AuthPoolProvider[];
  error?: string | null;
}

export async function fetchAuthPool(): Promise<AuthPoolStatus> {
  return hermesFetch<AuthPoolStatus>('/auth/pool');
}

export async function resetAuthPoolProvider(provider: string): Promise<{ ok: boolean; output: string }> {
  return hermesFetch('/auth/pool/reset', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
}

export async function removeAuthPoolCredential(
  provider: string,
  target: string | number,
): Promise<{ ok: boolean; output: string }> {
  return hermesFetch('/auth/pool/remove', {
    method: 'POST',
    body: JSON.stringify({ provider, target: String(target) }),
  });
}

export async function addAuthPoolApiKey(
  provider: string,
  apiKey: string,
  label?: string,
): Promise<{ ok: boolean; output: string }> {
  return hermesFetch('/auth/pool/add', {
    method: 'POST',
    body: JSON.stringify({ provider, api_key: apiKey, ...(label ? { label } : {}) }),
  });
}
