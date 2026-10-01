import React from 'react';
import { Bot, Check, ChevronDown, Layers } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useHermesStore } from '@/stores/hermes-store';
import { useUIStore } from '@/stores/ui-store';
import { useHermesProviders } from '@/hooks/useHermesProviders';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const MOA_PROVIDER_ID = 'moa';

/**
 * In-composer provider + model picker for the Hermes agent. Lists the providers
 * the hermes-agent already has credentialed (from `/v1/providers`) and their
 * models — including Mixture of Agents presets as a virtual provider.
 */
export const HermesModelPicker: React.FC = () => {
  const updateProviderConfig = useSettingsStore((s) => s.updateProviderConfig);
  const currentModel = useSettingsStore((s) => s.providers.hermes.model);
  const underlyingProvider = useHermesStore((s) => s.underlyingProvider);
  const setUnderlyingProvider = useHermesStore((s) => s.setUnderlyingProvider);
  const followAgentModel = useHermesStore((s) => s.followAgentModel);
  const setFollowAgentModel = useHermesStore((s) => s.setFollowAgentModel);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const { providers, loading, defaultModel } = useHermesProviders();

  const moaProvider = providers.find((p) => p.id === MOA_PROVIDER_ID);
  // Bridge already puts the active CLI custom endpoint first; keep custom:* rows
  // ahead of built-ins so the user's `hermes model` endpoint is easy to re-select.
  const connected = providers
    .filter((p) => p.id !== MOA_PROVIDER_ID && p.credentialed && p.models.length > 0)
    .slice()
    .sort((a, b) => {
      const aCustom = a.id === 'custom' || a.id.startsWith('custom:') ? 0 : 1;
      const bCustom = b.id === 'custom' || b.id.startsWith('custom:') ? 0 : 1;
      return aCustom - bCustom;
    });
  const disconnected = providers.filter(
    (p) => p.id !== MOA_PROVIDER_ID && !p.credentialed,
  );

  const isMoa = !followAgentModel && underlyingProvider === MOA_PROVIDER_ID;
  const activeProvider = providers.find((p) => p.id === underlyingProvider);
  const displayModel = (currentModel || '').split('/').pop() || currentModel || 'Auto';
  const triggerLabel = followAgentModel
    ? `Agent · ${displayModel}`
    : isMoa
      ? `MoA · ${displayModel}`
      : activeProvider
        ? `${activeProvider.name} · ${displayModel}`
        : displayModel;

  const choose = (providerId: string, model: string) => {
    setFollowAgentModel(false);
    setUnderlyingProvider(providerId);
    updateProviderConfig('hermes', { model });
  };

  const useAgentDefault = () => {
    setFollowAgentModel(true);
    setUnderlyingProvider('');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex min-w-0 items-center gap-1 px-2 py-1 rounded-[6px] text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100 max-w-[44vw] sm:max-w-[230px]"
          title="Choose provider & model"
        >
          {isMoa ? (
            <Layers className="h-3 w-3 shrink-0 text-primary/80" />
          ) : (
            <Bot className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-[min(16rem,calc(100vw-1.5rem))] overflow-y-auto">
        <DropdownMenuItem
          onClick={useAgentDefault}
          className={followAgentModel ? 'bg-accent' : ''}
        >
          <Bot className="mr-1.5 h-3 w-3 shrink-0 text-primary" />
          <span className="flex-1 truncate text-xs">
            Agent default
            {defaultModel && (
              <span className="text-muted-foreground"> · {defaultModel.split('/').pop()}</span>
            )}
          </span>
          {followAgentModel && <Check className="h-3 w-3 shrink-0" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => { setFollowAgentModel(false); setUnderlyingProvider(''); }}
          className={!followAgentModel && !underlyingProvider ? 'bg-accent' : ''}
        >
          <span className="text-xs flex-1">Auto (route by model)</span>
          {!followAgentModel && !underlyingProvider && <Check className="h-3 w-3" />}
        </DropdownMenuItem>

        {moaProvider && moaProvider.models.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Layers className="h-3 w-3 text-primary/80 shrink-0" />
              Mixture of Agents
            </DropdownMenuLabel>
            {moaProvider.models.map((m) => {
              const isActive = isMoa && currentModel === m;
              return (
                <DropdownMenuItem
                  key={`moa:${m}`}
                  onClick={() => choose(MOA_PROVIDER_ID, m)}
                  className={isActive ? 'bg-accent pl-4' : 'pl-4'}
                >
                  <span className="text-xs flex-1 truncate">MoA · {m}</span>
                  {isActive && <Check className="h-3 w-3 shrink-0" />}
                </DropdownMenuItem>
              );
            })}
          </>
        )}

        {connected.length > 0 && <DropdownMenuSeparator />}

        {connected.map((p) => (
          <React.Fragment key={p.id}>
            <DropdownMenuLabel className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
              {p.name}
            </DropdownMenuLabel>
            {p.models.map((m) => {
              const isActive = !followAgentModel && underlyingProvider === p.id && currentModel === m;
              return (
                <DropdownMenuItem
                  key={`${p.id}:${m}`}
                  onClick={() => choose(p.id, m)}
                  className={isActive ? 'bg-accent pl-4' : 'pl-4'}
                >
                  <span className="text-xs flex-1 truncate">{m.split('/').pop() || m}</span>
                  {isActive && <Check className="h-3 w-3 shrink-0" />}
                </DropdownMenuItem>
              );
            })}
          </React.Fragment>
        ))}

        {loading && connected.length === 0 && !moaProvider && (
          <div className="px-2 py-2 text-xs text-muted-foreground">Loading providers…</div>
        )}
        {!loading && connected.length === 0 && !moaProvider && (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            No connected providers found. Add keys in Settings.
          </div>
        )}

        {disconnected.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
              Not connected
            </DropdownMenuLabel>
            <div className="px-2 pb-1.5 text-[11px] leading-relaxed text-muted-foreground/60">
              {disconnected.map((p) => p.name).join(', ')}
            </div>
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => setSettingsOpen(true)}
          className="text-xs text-muted-foreground"
        >
          Manage providers &amp; MoA presets…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
