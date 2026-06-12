import { useEffect, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toolbarPopoverAlignment } from '@/hooks/chat-utils';
import {
  HERMES_REASONING_EFFORTS,
  useHermesStore,
  type HermesReasoningEffort,
} from '@/stores/hermes-store';

export const HERMES_EFFORT_LABELS: Record<HermesReasoningEffort, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Ultra',
};

/**
 * Composer toolbar control for the Hermes agent's reasoning effort.
 * Opens a Faster ↔ Smarter slider popover; the chosen level is sent to the
 * bridge as `reasoning_effort` on every Hermes request.
 */
export function HermesEffortSlider() {
  const reasoningEffort = useHermesStore((s) => s.reasoningEffort);
  const setReasoningEffort = useHermesStore((s) => s.setReasoningEffort);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click (same pattern as the loop config popover).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const index = Math.max(0, HERMES_REASONING_EFFORTS.indexOf(reasoningEffort));
  const label = HERMES_EFFORT_LABELS[reasoningEffort];

  return (
    <div className="relative shrink-0" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Reasoning effort: ${label}`}
        aria-expanded={open}
        title="Adjust the Hermes agent's reasoning effort"
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
          open
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
        )}
      >
        <Gauge className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden sm:inline">Effort</span>
        {/* Fixed width so changing levels (Off ↔ Minimal ↔ Ultra) doesn't
            reflow the composer toolbar. Sized to the widest label. */}
        <span className="inline-block w-12 text-left text-primary">{label}</span>
      </button>

      {open && (
        <div
          className={cn(
            'absolute bottom-full mb-2 z-50 w-60 rounded-lg border border-border bg-popover p-3 shadow-lg',
            toolbarPopoverAlignment(containerRef.current),
          )}
        >
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs font-semibold text-foreground">Effort</span>
            <span className="text-xs font-semibold text-primary">{label}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Faster</span>
            <span>Smarter</span>
          </div>
          <input
            type="range"
            min={0}
            max={HERMES_REASONING_EFFORTS.length - 1}
            step={1}
            value={index}
            onChange={(e) => {
              const next = HERMES_REASONING_EFFORTS[Number(e.target.value)];
              if (next) setReasoningEffort(next);
            }}
            aria-label="Reasoning effort"
            aria-valuetext={label}
            className="mt-1.5 w-full cursor-pointer accent-primary"
          />
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            Higher effort lets the agent think longer before acting. Lower is faster and cheaper.
          </p>
        </div>
      )}
    </div>
  );
}
