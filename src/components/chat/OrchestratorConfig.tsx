import React from 'react';
import { Network, ChevronDown } from 'lucide-react';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// OrchestratorConfig — toggle + max sub-agents (uses the active chat provider)
// ---------------------------------------------------------------------------

export const OrchestratorConfig: React.FC = () => {
  const {
    enabled,
    setEnabled,
    maxSubAgents,
    setMaxSubAgents,
    maxRetries,
    setMaxRetries,
    fallbackModel,
    setFallbackModel,
  } = useOrchestratorStore();

  const selectClasses =
    'w-full appearance-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/50 transition-colors cursor-pointer';

  return (
    <div className="w-full">
      {/* Toggle button */}
      <button
        onClick={() => setEnabled(!enabled)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all duration-200 border',
          enabled
            ? 'border-primary/40 bg-primary/10 text-primary shadow-sm shadow-primary/5'
            : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted/60',
        )}
      >
        <Network
          className={cn(
            'h-3.5 w-3.5 transition-colors duration-200',
            enabled ? 'text-primary' : 'text-muted-foreground',
          )}
        />
        Coding Agent
        {enabled && (
          <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
        )}
      </button>

      {/* Config panel */}
      {enabled && (
        <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3 transition-all duration-200 animate-in fade-in slide-in-from-top-1">
          <div className="space-y-3">
            <p className="text-[10px] text-muted-foreground">
              Uses your selected chat provider and model for all phases.
            </p>

            {/* Max sub-agents */}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Max Sub-agents
              </label>
              <div className="relative">
                <select
                  value={maxSubAgents}
                  onChange={(e) => setMaxSubAgents(Number(e.target.value))}
                  className={selectClasses}
                >
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>

            {/* Max retries */}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Max Retries
              </label>
              <div className="relative">
                <select
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(Number(e.target.value))}
                  className={selectClasses}
                >
                  {[0, 1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? 'No retries' : n}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>

            {/* Fallback model */}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Fallback Model <span className="font-normal normal-case tracking-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={fallbackModel}
                onChange={(e) => setFallbackModel(e.target.value)}
                placeholder="e.g. openai/gpt-4.1-mini"
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/50 transition-colors placeholder:text-muted-foreground/50"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
