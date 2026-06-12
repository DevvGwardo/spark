import { useEffect, useRef } from 'react';
import { getApiBaseUrl } from '@/lib/api';
import { useActivityStore } from '@/stores/activity-store';
import { useChatStore } from '@/stores/chat-store';

/** Dispatched on window when a server-side background hermes run finishes,
 * with `detail: { conversationId }`. Open panels listen and re-hydrate. */
export const BACKGROUND_RUN_FINISHED_EVENT = 'hermes-background-run-finished';

const POLL_INTERVAL_MS = 4000;

/**
 * Polls the server for hermes runs that are still active server-side —
 * including runs whose originating panel/window has closed. Keeps the
 * sidebar status indicator alive and, when a run completes, refreshes the
 * conversation list and notifies open panels so the persisted assistant
 * message appears without a manual reload.
 */
export function useBackgroundRuns() {
  const knownRunsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/hermes/chat/active`);
        if (!response.ok || cancelled) return;
        const payload = await response.json() as {
          runs?: Array<{ conversationId: string; startedAt: number }>;
        };
        if (cancelled) return;
        const runs = payload.runs ?? [];
        const current = new Set(runs.map((run) => run.conversationId));

        useActivityStore.getState().setBackgroundRuns(runs);

        // Runs that were active last poll but are gone now have finished —
        // their final assistant message was persisted server-side.
        const finished = [...knownRunsRef.current].filter((id) => !current.has(id));
        knownRunsRef.current = current;
        if (finished.length > 0) {
          void useChatStore.getState().loadConversations();
          for (const conversationId of finished) {
            window.dispatchEvent(
              new CustomEvent(BACKGROUND_RUN_FINISHED_EVENT, { detail: { conversationId } }),
            );
          }
        }
      } catch {
        // Server unreachable — keep the last known state and retry next tick.
      }
    };

    void poll();
    const timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
}
