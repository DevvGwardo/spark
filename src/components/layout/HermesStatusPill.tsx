import React from 'react';
import { useBridgeReadiness } from '@/lib/hermes-queries';
import type { BridgeReadinessState } from '@/lib/bridge-readiness';
import { cn } from '@/lib/utils';

type HermesPillState = 'checking' | 'online' | 'degraded' | 'offline';

interface HermesStatusPillProps {
  /** Wired by the parent to open the bridge setup / settings flow. */
  onClick?: () => void;
  className?: string;
}

const STATE_META: Record<HermesPillState, { dot: string; label: string }> = {
  checking: { dot: 'bg-amber-400', label: 'Connecting…' },
  online: { dot: 'bg-emerald-500', label: 'Hermes' },
  degraded: { dot: 'bg-amber-400', label: 'Hermes degraded' },
  offline: { dot: 'bg-red-500', label: 'Hermes offline' },
};

function pillState(state: BridgeReadinessState | undefined): HermesPillState {
  switch (state) {
    case 'ready':
      return 'online';
    case 'degraded':
      return 'degraded';
    case 'crashed':
    case 'stopped':
      return 'offline';
    default:
      // undefined (first check), starting, restarting
      return 'checking';
  }
}

/**
 * Compact header pill surfacing Hermes bridge reachability. Reads the shared
 * bridge-readiness query (the same one `BridgeGate` uses), which polls ~2s
 * while the bridge is coming up and every 15s once ready, and pauses while the
 * window is hidden. Clicking when offline lets the parent open bridge setup.
 */
export const HermesStatusPill: React.FC<HermesStatusPillProps> = ({ onClick, className }) => {
  const readiness = useBridgeReadiness();
  const state = pillState(readiness.data?.state);

  const { dot, label } = STATE_META[state];
  const isOffline = state === 'offline';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!isOffline}
      title={
        isOffline
          ? 'Hermes bridge offline — click to set up'
          : state === 'degraded' && readiness.data?.lastError
            ? `Hermes degraded — ${readiness.data.lastError}`
            : 'Hermes bridge status'
      }
      aria-label={`Hermes bridge ${label}`}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-2.5 text-[11px] font-medium text-muted-foreground transition-colors duration-100',
        isOffline ? 'hover:bg-background/85 hover:text-foreground cursor-pointer' : 'cursor-default',
        className,
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          dot,
          state === 'checking' && 'motion-safe:animate-pulse',
        )}
      />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
};
