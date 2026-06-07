import { useCallback, useEffect, useState } from 'react';
import { fetchHermesProviders, HermesApiError, type HermesProviderInfo } from '@/lib/hermes-api';

interface HermesProvidersState {
  providers: HermesProviderInfo[];
  defaultProvider: string;
  /** The agent's CLI-configured default model (config.yaml `model.default`). */
  defaultModel: string;
}

const EMPTY: HermesProvidersState = { providers: [], defaultProvider: 'openrouter', defaultModel: '' };

// Process-wide cache so every picker shares one fetch.
let cache: HermesProvidersState | null = null;
let inflight: Promise<HermesProvidersState> | null = null;

async function load(): Promise<HermesProvidersState> {
  // The bridge can come up a little after the server on a cold start — retry.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetchHermesProviders();
      if (res.providers.length) {
        return { providers: res.providers, defaultProvider: res.defaultProvider, defaultModel: res.defaultModel };
      }
    } catch (err) {
      // 4xx (e.g. 404) means this gateway doesn't expose the endpoint — don't
      // keep retrying a missing route; cache empty and move on.
      if (err instanceof HermesApiError && err.status >= 400 && err.status < 500) {
        return EMPTY;
      }
      /* transient (network / bridge still starting) — retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return EMPTY;
}

/**
 * The hermes-agent's configured providers (id, name, credentialed, models),
 * fetched from the bridge `/v1/providers` and cached for the whole session.
 * Pass `enabled=false` to skip fetching until the picker is relevant.
 */
export function useHermesProviders(enabled = true) {
  const [state, setState] = useState<HermesProvidersState>(() => cache ?? EMPTY);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    if (!enabled || cache) return;
    let cancelled = false;
    setLoading(true);
    (inflight ??= load()).then((res) => {
      cache = res;
      inflight = null;
      if (!cancelled) {
        setState(res);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const reload = useCallback(() => {
    cache = null;
    inflight = null;
    setLoading(true);
    load().then((res) => {
      cache = res;
      setState(res);
      setLoading(false);
    });
  }, []);

  return {
    providers: state.providers,
    defaultProvider: state.defaultProvider,
    defaultModel: state.defaultModel,
    loading,
    reload,
  };
}
