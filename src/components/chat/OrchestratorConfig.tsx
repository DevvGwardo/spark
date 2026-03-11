import React from 'react';
import { Network, ChevronDown } from 'lucide-react';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { useSettingsStore, type Provider } from '@/stores/settings-store';
import { PROVIDERS, PROVIDER_ORDER } from '@/lib/providers';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// OrchestratorConfig — toggle + dual-provider pickers (plan model + coding model)
// ---------------------------------------------------------------------------

export const OrchestratorConfig: React.FC = () => {
  const {
    enabled,
    setEnabled,
    planningProvider,
    planningModel,
    codingProvider,
    codingModel,
    maxSubAgents,
    setPlanningProvider,
    setPlanningModel,
    setCodingProvider,
    setCodingModel,
    setMaxSubAgents,
  } = useOrchestratorStore();

  const { providers: providerConfigs } = useSettingsStore();

  const availableProviders = PROVIDER_ORDER.filter((p) => {
    if (PROVIDERS[p].supportsOrchestrator === false) {
      return false;
    }
    const config = providerConfigs[p];
    return !!config?.apiKey;
  });

  const handlePlanningProviderChange = (newProvider: Provider) => {
    const info = PROVIDERS[newProvider];
    setPlanningProvider(newProvider);
    setPlanningModel(info.defaultModel);
  };

  const handleCodingProviderChange = (newProvider: Provider) => {
    const info = PROVIDERS[newProvider];
    setCodingProvider(newProvider);
    setCodingModel(info.defaultModel);
  };

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
            {/* Planning model */}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Plan Model
              </label>
              <div className="space-y-1.5">
                <div className="relative">
                  <select
                    value={planningProvider}
                    onChange={(e) => handlePlanningProviderChange(e.target.value as Provider)}
                    className={selectClasses}
                  >
                    {availableProviders.map((p) => (
                      <option key={p} value={p}>
                        {PROVIDERS[p].label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                </div>
                <div className="relative">
                  <select
                    value={planningModel}
                    onChange={(e) => setPlanningModel(e.target.value)}
                    className={selectClasses}
                  >
                    {PROVIDERS[planningProvider]?.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
            </div>

            {/* Coding model */}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Code Model
              </label>
              <div className="space-y-1.5">
                <div className="relative">
                  <select
                    value={codingProvider}
                    onChange={(e) => handleCodingProviderChange(e.target.value as Provider)}
                    className={selectClasses}
                  >
                    {availableProviders.map((p) => (
                      <option key={p} value={p}>
                        {PROVIDERS[p].label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                </div>
                <div className="relative">
                  <select
                    value={codingModel}
                    onChange={(e) => setCodingModel(e.target.value)}
                    className={selectClasses}
                  >
                    {PROVIDERS[codingProvider]?.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
            </div>

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
          </div>
        </div>
      )}
    </div>
  );
};
