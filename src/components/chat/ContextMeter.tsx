import { useContextUsageStore } from '@/stores/context-usage-store';
import { formatTokens, formatTurnCost } from '@/lib/tokens';
import { contextMeterBarClass } from '@/lib/context-meter';

/**
 * Compact live context meter: `Context 62% (31.4k/51k tokens)` with a thin
 * progress bar. Reads the `usage` slice of the context-usage store and renders
 * nothing when no usage has been reported yet (zero layout shift).
 * Self-contained: no props, safe to drop anywhere (composer, status bar, …).
 */
export const ContextMeter: React.FC = () => {
  const usage = useContextUsageStore((state) => state.usage);

  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
    return null;
  }

  const used = Math.max(0, usage.inputTokens + usage.outputTokens);
  const percentage = Math.min(100, (used / usage.contextWindow) * 100);
  const barClass = contextMeterBarClass(percentage);
  const cached = usage.cachedInputTokens && usage.cachedInputTokens > 0 ? usage.cachedInputTokens : null;
  const cost = typeof usage.costUsd === 'number' && usage.costUsd > 0 ? formatTurnCost(usage.costUsd) : null;

  return (
    <div
      className="flex items-center gap-2"
      title={`${used.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens on ${usage.model}${cached ? ` · ${cached.toLocaleString()} cached input tokens` : ''}${cost ? ` · last turn ${cost}` : ''}`}
      aria-label={`Context ${Math.round(percentage)}% (${formatTokens(used)} of ${formatTokens(usage.contextWindow)} tokens)`}
    >
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        Context {Math.round(percentage)}%
      </span>
      <div
        className="h-[3px] w-14 shrink-0 overflow-hidden rounded-full bg-[hsl(var(--muted))]"
        role="progressbar"
        aria-valuenow={Math.round(percentage)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-200 ease-out ${barClass}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
        ({formatTokens(used)}/{formatTokens(usage.contextWindow)} tokens)
      </span>
      {cost && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70" aria-label={`Last turn cost ${cost}`}>
          {cost}
        </span>
      )}
    </div>
  );
};
