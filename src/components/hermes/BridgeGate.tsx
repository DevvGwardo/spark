import { useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, PlugZap, RefreshCw } from 'lucide-react';
import { BridgeReadyContext, useBridgeReadiness } from '@/lib/hermes-queries';
import { isBridgeUsable, type BridgeReadinessResult } from '@/lib/bridge-readiness';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';

interface BridgeGateProps {
  children: ReactNode;
  /** Overrides the default "Set up" action (open the bridge setup modal). */
  onSetup?: () => void;
}

type Phase = 'checking' | 'starting' | 'reconnecting' | 'offline' | 'crashed';

function phaseOf(data: BridgeReadinessResult | undefined): Phase | 'ready' | 'degraded' {
  if (!data) return 'checking';
  switch (data.state) {
    case 'ready':
      return 'ready';
    case 'degraded':
      return 'degraded';
    case 'starting':
      return 'starting';
    case 'restarting':
      return 'reconnecting';
    case 'crashed':
      return 'crashed';
    case 'stopped':
    default:
      return 'offline';
  }
}

const PHASE_COPY: Record<Phase, { title: string; detail: string }> = {
  checking: { title: 'Checking Hermes bridge…', detail: '' },
  starting: { title: 'Hermes is starting…', detail: 'Panels load as soon as the bridge is ready.' },
  reconnecting: { title: 'Reconnecting to Hermes…', detail: 'The bridge restarted; data will refresh when it is back.' },
  offline: { title: 'Hermes bridge offline', detail: 'Start the bridge to load this panel.' },
  crashed: { title: 'Hermes bridge crashed', detail: '' },
};

/**
 * Single offline story for the Hermes sidebar panels (hardening spec 6.3).
 *
 * Driven by `useBridgeReadiness` (`/api/bridge/readiness`, falling back to the
 * `/api/hermes/health` probe on servers without that route):
 *
 * - **ready** — children render; their queries run.
 * - **degraded** — children render with a one-line warning above them.
 * - **starting / reconnecting / offline / crashed** — before the panel has ever
 *   rendered, the gate shows that state instead of the panel. After it has
 *   rendered, the panel stays mounted (so drafts and scroll survive a bridge
 *   restart) under a compact status strip, and its queries are paused through
 *   `BridgeReadyContext` so nothing fails on its own.
 *
 * When the bridge comes back, every Hermes query is invalidated so errors from
 * the outage don't linger.
 */
export function BridgeGate({ children, onSetup }: BridgeGateProps) {
  const readiness = useBridgeReadiness();
  const data = readiness.data;
  const phase = phaseOf(data);
  const usable = isBridgeUsable(data?.state);
  const requestBridgeSetup = useUIStore((s) => s.requestBridgeSetup);
  const qc = useQueryClient();

  const hasRenderedChildren = useRef(usable);
  if (usable) hasRenderedChildren.current = true;

  const wasUsable = useRef(usable);
  useEffect(() => {
    if (usable && !wasUsable.current) {
      void qc.invalidateQueries({ queryKey: ['hermes'] });
    }
    wasUsable.current = usable;
  }, [qc, usable]);

  const handleSetup = onSetup ?? requestBridgeSetup;
  const handleRetry = () => {
    void readiness.refetch();
  };

  if (usable || hasRenderedChildren.current) {
    // One tree shape for both branches — strip slot, then children — so a
    // bridge restart swaps the strip without remounting the panel.
    let strip: ReactNode = null;
    if (phase === 'degraded') {
      strip = <DegradedStrip lastError={data?.lastError ?? null} />;
    } else if (!usable) {
      strip = <StatusStrip phase={phase as Phase} data={data} onRetry={handleRetry} onSetup={handleSetup} />;
    }
    return (
      <BridgeReadyContext.Provider value={usable}>
        {strip}
        {children}
      </BridgeReadyContext.Provider>
    );
  }

  return (
    <BridgeReadyContext.Provider value={false}>
      <GateState
        phase={phase as Phase}
        data={data}
        onRetry={handleRetry}
        onSetup={handleSetup}
        retrying={readiness.isFetching}
      />
    </BridgeReadyContext.Provider>
  );
}

function DegradedStrip({ lastError }: { lastError: string | null }) {
  return (
    <div
      role="status"
      className="mx-3 mt-2 flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300/90"
      title={lastError ?? undefined}
    >
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">Hermes degraded{lastError ? ` — ${lastError}` : ''}</span>
    </div>
  );
}

interface StateProps {
  phase: Phase;
  data: BridgeReadinessResult | undefined;
  onRetry: () => void;
  onSetup: () => void;
}

function isBusyPhase(phase: Phase) {
  return phase === 'checking' || phase === 'starting' || phase === 'reconnecting';
}

function attemptLabel(data: BridgeReadinessResult | undefined): string | null {
  return data && data.attempt > 0 ? `attempt ${data.attempt}` : null;
}

/** Compact one-line state shown above an already-rendered panel. */
function StatusStrip({ phase, data, onRetry, onSetup }: StateProps) {
  const busy = isBusyPhase(phase);
  const attempt = attemptLabel(data);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'mx-3 mt-2 flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px]',
        busy
          ? 'border-border/40 bg-background/40 text-muted-foreground'
          : 'border-destructive/25 bg-destructive/10 text-destructive',
      )}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 shrink-0 motion-safe:animate-spin" aria-hidden />
      ) : (
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">
        {PHASE_COPY[phase].title}
        {attempt ? ` · ${attempt}` : ''}
      </span>
      {!busy && (
        <>
          <StripButton onClick={onRetry}>Retry</StripButton>
          <StripButton onClick={onSetup}>Set up</StripButton>
        </>
      )}
    </div>
  );
}

function StripButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded px-1 py-0.5 font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
    >
      {children}
    </button>
  );
}

/** Full-panel state shown before the panel has had a usable bridge. */
function GateState({ phase, data, onRetry, onSetup, retrying }: StateProps & { retrying: boolean }) {
  const busy = isBusyPhase(phase);
  const copy = PHASE_COPY[phase];
  const attempt = attemptLabel(data);
  const lastError = data?.lastError ?? null;
  const stderrTail = data?.stderrTail ?? [];

  if (busy) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center text-[12px] text-muted-foreground/60"
      >
        <span className="inline-flex items-center">
          <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" aria-hidden />
          {copy.title}
        </span>
        {(copy.detail || attempt) && (
          <span className="text-[10px] text-muted-foreground/45">
            {[copy.detail, attempt].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col px-3 pt-3">
      <div role="alert" className="rounded-xl border border-border/40 bg-background/40 p-3">
        <div className="flex items-start gap-2">
          <div
            className={cn(
              'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg',
              phase === 'crashed' ? 'bg-destructive/10 text-destructive' : 'bg-background/70 text-muted-foreground',
            )}
          >
            {phase === 'crashed' ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : <PlugZap className="h-3.5 w-3.5" aria-hidden />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium text-foreground">
              {copy.title}
              {attempt && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/50">{attempt}</span>}
            </p>
            {phase === 'crashed' && lastError ? (
              <p className="mt-0.5 break-words font-mono text-[10px] leading-snug text-destructive/85">{lastError}</p>
            ) : (
              copy.detail && <p className="mt-0.5 text-[11px] text-muted-foreground/60">{copy.detail}</p>
            )}
          </div>
        </div>

        {phase === 'crashed' && stderrTail.length > 0 && (
          <details className="group mt-2 rounded-lg border border-border/30 bg-background/40">
            <summary className="cursor-pointer select-none px-2 py-1 text-[10px] text-muted-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))]">
              stderr · last {stderrTail.length} line{stderrTail.length === 1 ? '' : 's'}
            </summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-border/30 px-2 py-1.5 font-mono text-[10px] leading-4 text-muted-foreground/75">
              {stderrTail.join('\n')}
            </pre>
          </details>
        )}

        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={onSetup}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <PlugZap className="h-3 w-3" aria-hidden />
            Set up
          </button>
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))]"
          >
            <RefreshCw className={cn('h-3 w-3', retrying && 'motion-safe:animate-spin')} aria-hidden />
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
