import { useState, useEffect, useRef, useCallback } from "react";

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

export function useHermesStatus(): UseHermesStatusReturn {
  const [status, setStatus] = useState<HermesStatus>({
    online: false,
    lastSeen: null,
    host: null,
    profile: null,
  });
  const [loading, setLoading] = useState(true);

  const backoffRef = useRef(POLL_INTERVAL_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const scheduleNext = useCallback(
    (fn: () => void, delay: number) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (mountedRef.current) fn();
      }, delay);
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;

    const fetchStatus = async () => {
      try {
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

        if (mountedRef.current) {
          setStatus({
            online: data.online ?? false,
            lastSeen: data.lastSeen ?? null,
            host: data.host ?? null,
            profile: data.profile ?? null,
          });
          setLoading(false);
          backoffRef.current = POLL_INTERVAL_MS;
        }

        scheduleNext(fetchStatus, POLL_INTERVAL_MS);
      } catch {
        if (mountedRef.current) {
          setStatus((prev) => ({ ...prev, online: false }));
          setLoading(false);

          backoffRef.current = Math.min(
            backoffRef.current * 2,
            MAX_BACKOFF_MS,
          );
        }

        scheduleNext(fetchStatus, backoffRef.current);
      }
    };

    fetchStatus();

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scheduleNext]);

  return { ...status, loading };
}
