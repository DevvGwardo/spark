import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";

const HERMES_STATUS_URL = "/api/remote/hermes-status";
const POLL_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 30_000;

export interface HermesStatus {
  online: boolean;
  lastSeen: string | null;
  host: string | null;
  profile: string | null;
}

interface UseHermesStatusReturn extends HermesStatus {
  loading: boolean;
}

export const hermesRemoteStatusKey = ["hermes-remote-status"] as const;

async function fetchHermesRemoteStatus(): Promise<HermesStatus> {
  const res = await fetch(HERMES_STATUS_URL, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    online?: boolean;
    lastSeen?: string | null;
    host?: string | null;
    profile?: string | null;
  };
  return {
    online: data.online ?? false,
    lastSeen: data.lastSeen ?? null,
    host: data.host ?? null,
    profile: data.profile ?? null,
  };
}

/**
 * Remote Hermes status for the mobile shell.
 *
 * Polls every 5s, doubling up to 30s across consecutive failures. React Query
 * supplies what the hand-rolled version did by hand: polling stops while the
 * tab is hidden (mobile browsers throttle background timers and drop the
 * network when the phone locks) and refetches immediately on wake
 * (visibility/focus) and on reconnect.
 */
export function useHermesStatus(): UseHermesStatusReturn {
  const consecutiveFailures = useRef(0);

  const query = useQuery({
    queryKey: hermesRemoteStatusKey,
    queryFn: async () => {
      try {
        const status = await fetchHermesRemoteStatus();
        consecutiveFailures.current = 0;
        return status;
      } catch (err) {
        consecutiveFailures.current += 1;
        throw err;
      }
    },
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchIntervalInBackground: false,
    refetchInterval: () =>
      consecutiveFailures.current === 0
        ? POLL_INTERVAL_MS
        : Math.min(POLL_INTERVAL_MS * 2 ** consecutiveFailures.current, MAX_BACKOFF_MS),
  });

  // On failure keep the last known host/profile/lastSeen, but report offline.
  const last = query.data;
  return {
    online: query.isError ? false : (last?.online ?? false),
    lastSeen: last?.lastSeen ?? null,
    host: last?.host ?? null,
    profile: last?.profile ?? null,
    loading: query.isPending,
  };
}
