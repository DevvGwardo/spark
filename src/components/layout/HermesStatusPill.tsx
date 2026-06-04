import React, { useEffect, useRef, useState } from 'react';
import { detectHermesBridge } from '@/lib/detect-hermes';
import { cn } from '@/lib/utils';

type HermesPillState = 'checking' | 'online' | 'offline';

interface HermesStatusPillProps {
  /** Wired by the parent to open the bridge setup / settings flow. */
  onClick?: () => void;
  className?: string;
}

const STATE_META: Record<HermesPillState, { dot: string; label: string }> = {
  checking: { dot: 'bg-amber-400', label: 'Connecting…' },
  online: { dot: 'bg-emerald-500', label: 'Hermes' },
  offline: { dot: 'bg-red-500', label: 'Hermes offline' },
};

/**
 * Compact header pill surfacing Hermes bridge reachability. Polls
 * detectHermesBridge() on mount + every 15s; clicking when offline lets the
 * parent open the bridge setup flow.
 */
export const HermesStatusPill: React.FC<HermesStatusPillProps> = ({ onClick, className }) => {
  const [state, setState] = useState<HermesPillState>('checking');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const check = () => {
      detectHermesBridge()
        .then((status) => {
          if (!mountedRef.current) return;
          setState(status?.isReachable ? 'online' : 'offline');
        })
        .catch(() => {
          if (mountedRef.current) setState('offline');
        });
    };

    check();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') check();
    }, 15000);

    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
    };
  }, []);

  const { dot, label } = STATE_META[state];
  const isOffline = state === 'offline';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!isOffline}
      title={isOffline ? 'Hermes bridge offline — click to set up' : 'Hermes bridge status'}
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
