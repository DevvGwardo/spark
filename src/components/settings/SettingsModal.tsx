import React, { useEffect, useMemo, useState } from 'react';
import { X, Eye, EyeOff, Search, Check, Zap, ChevronDown, ExternalLink, Github, Code2, Network, Info } from 'lucide-react';
import { useSettingsStore, type Provider } from '@/stores/settings-store';
import { useHermesStore, type HermesToolsets } from '@/stores/hermes-store';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { useUIStore } from '@/stores/ui-store';
import { PROVIDERS, PROVIDER_ORDER, CATEGORY_LABELS, type ProviderCategory } from '@/lib/providers';
import { validateApiKey } from '@/lib/api';
import { KnowledgePanel } from './KnowledgePanel';
import { PROVIDER_KEY_URLS } from '@/components/chat/ApiKeyModal';
import { cn } from '@/lib/utils';

const ProviderIcon: React.FC<{ provider: Provider; className?: string }> = ({ provider, className }) => {
  if (PROVIDERS[provider]?.badge === 'Fast') return <Zap className={className} />;
  return (
    <span className={cn('flex items-center justify-center rounded-lg bg-muted/70 text-[10px] font-bold uppercase leading-none', className)}>
      {PROVIDERS[provider].label.slice(0, 2)}
    </span>
  );
};

const settingsCardClass = 'rounded-2xl border border-border/60 bg-background/55';
const fieldLabelClass = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80';
const textInputClass = 'w-full rounded-xl border border-border/60 bg-background/70 px-3 py-2.5 text-sm text-foreground outline-none transition-colors duration-100 placeholder:text-muted-foreground focus:border-primary/40 focus:ring-1 focus:ring-primary/30';
const selectInputClass = `${textInputClass} appearance-none pr-9 cursor-pointer font-mono`;
const toggleTrackClass = 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2';
const toggleThumbClass = 'inline-block h-4 w-4 rounded-full bg-background transition-transform duration-200';



// ---------------------------------------------------------------------------
// RolesTab — Coding Agent provider override configuration
// ---------------------------------------------------------------------------

function RolesTab() {
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

  const orchestratorProviders = PROVIDER_ORDER.filter(
    (provider) => PROVIDERS[provider].supportsOrchestrator !== false,
  );

  const handlePlanProviderChange = (p: Provider) => {
    setPlanningProvider(p);
    setPlanningModel(PROVIDERS[p].defaultModel);
  };

  const handleCodeProviderChange = (p: Provider) => {
    setCodingProvider(p);
    setCodingModel(PROVIDERS[p].defaultModel);
  };

  const selectClasses = selectInputClass;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      {/* Header */}
      <div className={cn(settingsCardClass, 'flex items-center gap-4 px-5 py-4')}>
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/60 bg-background/70">
          <Network className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold tracking-[-0.01em]">Coding Agent</h3>
          <p className="text-xs text-muted-foreground">
            Route planning and execution through dedicated models when you want multi-step coding help.
          </p>
        </div>
        <button
          onClick={() => setEnabled(!enabled)}
          className={cn(
            toggleTrackClass,
            enabled ? 'bg-primary' : 'bg-border'
          )}
        >
          <span
            className={cn(
              toggleThumbClass,
              enabled ? 'translate-x-6' : 'translate-x-1'
            )}
          />
        </button>
      </div>

      {!enabled && (
        <div className={cn(settingsCardClass, 'px-4 py-3')}>
          <div className="flex items-start gap-2.5">
            <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-xs text-foreground font-medium">How it works</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                When enabled, the plan model analyzes your request and breaks it into sub-tasks.
                The code model then executes each sub-task in parallel. Finally, the plan model
                synthesizes the results into a single response.
              </p>
            </div>
          </div>
        </div>
      )}

      {enabled && (
        <div className="space-y-4">
          {/* Planning model */}
          <div className={cn(settingsCardClass, 'overflow-hidden')}>
            <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-background/80">
                <Network className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-semibold">Plan Model</h4>
                <p className="text-[11px] text-muted-foreground">Breaks down requests and synthesizes results</p>
              </div>
            </div>

            <div className="space-y-3 p-4">
              <div className="relative">
                <select
                  value={planningProvider}
                  onChange={(e) => handlePlanProviderChange(e.target.value as Provider)}
                  className={selectClasses}
                >
                  {orchestratorProviders.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDERS[p].label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
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
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Coding model */}
          <div className={cn(settingsCardClass, 'overflow-hidden')}>
            <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-background/80">
                <Code2 className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-semibold">Code Model</h4>
                <p className="text-[11px] text-muted-foreground">Executes each sub-task in parallel</p>
              </div>
            </div>

            <div className="space-y-3 p-4">
              <div className="relative">
                <select
                  value={codingProvider}
                  onChange={(e) => handleCodeProviderChange(e.target.value as Provider)}
                  className={selectClasses}
                >
                  {orchestratorProviders.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDERS[p].label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
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
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Max sub-agents */}
          <div className={cn(settingsCardClass, 'overflow-hidden')}>
            <div className="p-4">
              <label className="block text-sm font-semibold mb-1.5">Max Sub-agents</label>
              <p className="text-[11px] text-muted-foreground mb-3">
                How many parallel tasks the code model can run at once
              </p>
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
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const SettingsModal: React.FC = () => {
  const { settingsOpen, setSettingsOpen } = useUIStore();
  const {
    activeProvider,
    providers,
    availableModels,
    theme,
    fontSize,
    fontFamily,
    defaultSystemPrompt,
    githubPAT,
    autoApproveRepoChanges,
    setActiveProvider,
    updateProviderConfig,
    setAvailableModels,
    setTheme,
    setFontSize,
    setFontFamily,
    setDefaultSystemPrompt,
    setGithubPAT,
    setAutoApproveRepoChanges,
  } = useSettingsStore();

  const { toolsets: hermesToolsets, setToolset: setHermesToolset } = useHermesStore();

  const [showKey, setShowKey] = useState(false);
  const [showGithubKey, setShowGithubKey] = useState(false);
  const [tab, setTab] = useState<'providers' | 'roles' | 'github' | 'knowledge' | 'general'>('providers');
  const [search, setSearch] = useState('');

  const config = providers[activeProvider];
  const providerInfo = PROVIDERS[activeProvider];
  const needsApiKey = providerInfo?.needsApiKey ?? true;
  const modelOptions = useMemo(() => {
    const baseModels = availableModels[activeProvider]?.length
      ? availableModels[activeProvider]!
      : providerInfo.models;

    if (config.model && !baseModels.includes(config.model)) {
      return [config.model, ...baseModels];
    }

    return baseModels;
  }, [activeProvider, availableModels, config.model, providerInfo.models]);

  useEffect(() => {
    if (!settingsOpen || activeProvider !== 'openclaw') return;

    let cancelled = false;

    void (async () => {
      try {
        const result = await validateApiKey('openclaw', '');
        if (!result.valid || cancelled) {
          return;
        }

        const nextModels = (result.models ?? []).filter(Boolean);
        if (nextModels.length > 0) {
          setAvailableModels('openclaw', nextModels);
        }

        const nextDefaultModel = result.defaultModel || nextModels[0];
        const currentModel = providers.openclaw.model;
        if (
          nextDefaultModel &&
          (currentModel === 'default' || (nextModels.length > 0 && !nextModels.includes(currentModel)))
        ) {
          updateProviderConfig('openclaw', { model: nextDefaultModel });
        }
      } catch (error) {
        console.error('Failed to load OpenClaw models', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProvider, providers.openclaw.model, setAvailableModels, settingsOpen, updateProviderConfig]);

  const filteredProviders = useMemo(() => {
    const q = search.toLowerCase();
    return PROVIDER_ORDER.filter(p => {
      const info = PROVIDERS[p];
      return info.label.toLowerCase().includes(q) || info.description.toLowerCase().includes(q);
    });
  }, [search]);

  const grouped = useMemo(() => {
    const groups: Partial<Record<ProviderCategory, Provider[]>> = {};
    for (const p of filteredProviders) {
      const cat = PROVIDERS[p].category;
      if (!groups[cat]) groups[cat] = [];
      groups[cat]!.push(p);
    }
    return groups;
  }, [filteredProviders]);

  if (!settingsOpen) return null;

  const handleSelectProvider = (p: Provider) => {
    setActiveProvider(p);
    if (!providers[p]?.model) {
      updateProviderConfig(p, { model: PROVIDERS[p].defaultModel });
    }
  };

  const tabItems = [
    { id: 'providers', label: 'Providers' },
    { id: 'roles', label: 'Roles' },
    { id: 'github', label: 'GitHub' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'general', label: 'General' },
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={() => setSettingsOpen(false)} />
      <div className="relative flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-border/70 bg-background/96">
        {/* Header */}
        <div className="border-b border-border/60 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-foreground">Workspace Settings</h2>
              <p className="text-sm text-muted-foreground">
                Configure providers, model routing, GitHub access, and workspace defaults for this app.
              </p>
            </div>
            <button
              onClick={() => setSettingsOpen(false)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-background/60 text-muted-foreground transition-colors duration-100 hover:bg-background hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {tabItems.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'rounded-xl border px-3 py-2 text-sm font-medium transition-colors duration-100',
                  tab === t.id
                    ? 'border-border/70 bg-background/85 text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-background/55 hover:text-foreground'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        {tab === 'providers' && (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* Left: Provider list */}
            <div className="flex w-[280px] shrink-0 flex-col border-r border-border/60 bg-muted/10">
              <div className="border-b border-border/60 p-4">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search providers"
                    className={cn(textInputClass, 'pl-8')}
                  />
                </div>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
                {(['featured', 'open-source', 'specialized'] as ProviderCategory[]).map(cat => {
                  const items = grouped[cat];
                  if (!items?.length) return null;
                  return (
                    <div key={cat}>
                      <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/75">
                        {CATEGORY_LABELS[cat]}
                      </p>
                      {items.map(p => {
                        const info = PROVIDERS[p];
                        const isActive = activeProvider === p;
                        return (
                          <button
                            key={p}
                            onClick={() => handleSelectProvider(p)}
                            className={cn(
                              'mb-1.5 w-full rounded-2xl border px-3 py-3 text-left transition-all duration-100',
                              isActive
                                ? 'border-border/70 bg-background/80 text-foreground'
                                : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-background/55 hover:text-foreground'
                            )}
                          >
                            <div className="flex items-start gap-3">
                              <ProviderIcon provider={p} className="h-8 w-8 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate text-sm font-medium">{info.label}</span>
                                  {info.badge && (
                                    <span className={cn(
                                      'rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none',
                                      info.badge === 'Free'
                                        ? 'bg-accent text-accent-foreground'
                                        : 'bg-muted text-muted-foreground'
                                    )}>
                                      {info.badge}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                                  {info.description}
                                </p>
                              </div>
                              {isActive && <Check className="mt-1 h-4 w-4 shrink-0 text-foreground" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: Config */}
            <div className="flex-1 overflow-y-auto bg-background/40 p-6">
              <div className="space-y-5">
                <div className={cn(settingsCardClass, 'flex items-start gap-4 px-5 py-5')}>
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-background/80">
                    <ProviderIcon provider={activeProvider} className="h-6 w-6" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold tracking-[-0.015em] text-foreground">{providerInfo.label}</h3>
                      {providerInfo.badge && (
                        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          {providerInfo.badge}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{providerInfo.description}</p>
                    <p className="mt-3 text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
                      Default model
                    </p>
                    <p className="mt-1 font-mono text-sm text-foreground">
                      {activeProvider === 'openclaw' ? config.model : providerInfo.defaultModel}
                    </p>
                  </div>
                </div>

                <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
                  <div className="space-y-5">
                    {needsApiKey && (
                      <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className={fieldLabelClass}>API Key</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Stored locally on this device and sent only to the selected provider.
                            </p>
                          </div>
                          {PROVIDER_KEY_URLS[activeProvider] && (
                            <a
                              href={PROVIDER_KEY_URLS[activeProvider]}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors duration-100 hover:bg-background/80 hover:text-foreground"
                            >
                              Provider site
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        <div className="relative">
                          <input
                            type={showKey ? 'text' : 'password'}
                            value={config.apiKey}
                            onChange={(e) => updateProviderConfig(activeProvider, { apiKey: e.target.value })}
                            placeholder={`Enter your ${providerInfo.label} key`}
                            className={cn(textInputClass, 'pr-11 font-mono')}
                          />
                          <button
                            onClick={() => setShowKey(s => !s)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors duration-100"
                          >
                            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                    )}
                    {!needsApiKey && (
                      <div className={cn(settingsCardClass, 'px-5 py-4')}>
                        <p className="text-sm font-medium text-foreground">No API key required</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          This provider is available without adding a separate key in settings.
                        </p>
                      </div>
                    )}

                    <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                      <div>
                        <p className={fieldLabelClass}>System Prompt</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Sets the default behavior for new conversations across the app.
                        </p>
                      </div>
                      <textarea
                        value={defaultSystemPrompt}
                        onChange={(e) => setDefaultSystemPrompt(e.target.value)}
                        rows={5}
                        className={cn(textInputClass, 'resize-none')}
                      />
                    </div>
                  </div>

                  <div className="space-y-5">
                    <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                      <div>
                        <p className={fieldLabelClass}>Model</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Choose the default model used when this provider is active.
                        </p>
                      </div>
                      <div className="relative">
                        <select
                          value={config.model}
                          onChange={(e) => updateProviderConfig(activeProvider, { model: e.target.value })}
                          className={selectInputClass}
                        >
                          {modelOptions.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      </div>
                    </div>

                    {activeProvider === 'hermes' && (
                      <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                        <div>
                          <p className={fieldLabelClass}>Agent Tools</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Choose which tools the Hermes agent can use during conversations.
                          </p>
                        </div>
                        <div className="space-y-3">
                          {([
                            { key: 'web' as const, label: 'Web Search', desc: 'Search the web for information' },
                            { key: 'browser' as const, label: 'Browser Automation', desc: 'Browse and interact with web pages' },
                            { key: 'vision' as const, label: 'Vision Analysis', desc: 'Analyze images and screenshots' },
                            { key: 'terminal' as const, label: 'Terminal Access', desc: 'Allows shell command execution on your machine', warn: true },
                            { key: 'files' as const, label: 'File Operations', desc: 'Allows reading and writing files on your machine', warn: true },
                            { key: 'code_execution' as const, label: 'Code Execution', desc: 'Allows running arbitrary code on your machine', warn: true },
                          ] as const).map(({ key, label, desc, warn }) => (
                            <div key={key} className="flex items-center justify-between">
                              <div>
                                <div className="text-sm text-foreground">{label}</div>
                                <div className={`text-xs ${warn ? 'text-amber-500' : 'text-muted-foreground'}`}>
                                  {desc}
                                </div>
                              </div>
                              <button
                                onClick={() => setHermesToolset(key, !hermesToolsets[key])}
                                className={cn(
                                  toggleTrackClass,
                                  hermesToolsets[key] ? 'bg-primary' : 'bg-border'
                                )}
                              >
                                <span
                                  className={cn(
                                    toggleThumbClass,
                                    hermesToolsets[key] ? 'translate-x-6' : 'translate-x-1'
                                  )}
                                />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className={cn(settingsCardClass, 'space-y-4 px-5 py-5')}>
                      <div>
                        <p className={fieldLabelClass}>Response Behavior</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Tune creativity and output headroom for this provider.
                        </p>
                      </div>

                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between">
                          <label className="text-sm font-medium text-foreground">Temperature</label>
                          <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs font-mono tabular-nums text-muted-foreground">
                            {config.temperature}
                          </span>
                        </div>
                        <input
                          type="range" min="0" max="1" step="0.1"
                          value={config.temperature}
                          onChange={(e) => updateProviderConfig(activeProvider, { temperature: parseFloat(e.target.value) })}
                          className="h-1.5 w-full accent-foreground"
                        />
                      </div>

                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between">
                          <label className="text-sm font-medium text-foreground">Max Tokens</label>
                          <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs font-mono tabular-nums text-muted-foreground">
                            {config.maxTokens}
                          </span>
                        </div>
                        <input
                          type="range" min="256" max="16384" step="256"
                          value={config.maxTokens}
                          onChange={(e) => updateProviderConfig(activeProvider, { maxTokens: parseInt(e.target.value) })}
                          className="h-1.5 w-full accent-foreground"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'roles' && <RolesTab />}

        {tab === 'github' && (
          <div className="flex-1 overflow-y-auto bg-background/40 p-6">
            <div className="space-y-5">
              <div className={cn(settingsCardClass, 'flex items-start gap-4 px-5 py-5')}>
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-background/80">
                  <Github className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold tracking-[-0.015em]">GitHub Integration</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Connect a Personal Access Token to browse repositories, stage changes, and open pull requests from chat.
                  </p>
                </div>
              </div>

              <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
                <div className="space-y-5">
                  <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className={fieldLabelClass}>Personal Access Token</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Stored locally for GitHub file reads, branch work, and PR creation.
                        </p>
                      </div>
                      <a
                        href="https://github.com/settings/tokens/new?scopes=repo&description=CloudChat%20Integration"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors duration-100 hover:bg-background/80 hover:text-foreground"
                      >
                        Generate token
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <div className="relative">
                      <input
                        type={showGithubKey ? 'text' : 'password'}
                        value={githubPAT}
                        onChange={(e) => setGithubPAT(e.target.value)}
                        placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                        className={cn(textInputClass, 'pr-11 font-mono')}
                      />
                      <button
                        onClick={() => setShowGithubKey(s => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors duration-100"
                      >
                        {showGithubKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Required scopes: <code className="rounded bg-secondary px-1 py-0.5">repo</code>
                    </p>
                  </div>

                  {githubPAT && (
                    <div className={cn(settingsCardClass, 'px-5 py-4')}>
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-green-500" />
                        <p className="text-sm font-medium text-foreground">GitHub connected</p>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Repository browsing and pull-request workflows are ready to use.
                      </p>
                    </div>
                  )}
                </div>

                <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                  <p className={fieldLabelClass}>Workflow</p>
                  <ol className="space-y-3 text-sm text-muted-foreground">
                    {[
                      'Generate a GitHub Personal Access Token with repo scope.',
                      'Paste the token here so the app can authenticate your repo actions.',
                      'Ask the assistant to inspect, edit, or prepare repository changes.',
                      'Review staged changes and create a pull request when ready.',
                    ].map((step, index) => (
                      <li key={step} className="flex gap-3">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border/60 text-[10px] font-semibold text-foreground">
                          {index + 1}
                        </span>
                        <span className="leading-relaxed">{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'knowledge' && (
          <div className="flex-1 overflow-y-auto bg-background/40 p-6">
            <div className={cn(settingsCardClass, 'p-5')}>
              <KnowledgePanel />
            </div>
          </div>
        )}

        {tab === 'general' && (
          <div className="flex-1 overflow-y-auto bg-background/40 p-6">
            <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
              <div className="space-y-5">
                <div className={cn(settingsCardClass, 'px-5 py-5')}>
                  <p className={fieldLabelClass}>Theme</p>
                  <div className="mt-3 flex gap-2">
                    {(['light', 'dark', 'system'] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTheme(t)}
                        className={cn(
                          'flex-1 rounded-xl border px-3 py-2 text-sm font-medium capitalize transition-colors duration-100',
                          theme === t
                            ? 'border-border/70 bg-background/85 text-foreground'
                            : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-background/55 hover:text-foreground'
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={cn(settingsCardClass, 'px-5 py-5')}>
                  <p className={fieldLabelClass}>Font Size</p>
                  <div className="mt-3 flex gap-2">
                    {(['small', 'medium', 'large'] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setFontSize(f)}
                        className={cn(
                          'flex-1 rounded-xl border px-3 py-2 text-sm font-medium capitalize transition-colors duration-100',
                          fontSize === f
                            ? 'border-border/70 bg-background/85 text-foreground'
                            : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-background/55 hover:text-foreground'
                        )}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-5">
                <div className={cn(settingsCardClass, 'px-5 py-5')}>
                  <p className={fieldLabelClass}>Typography</p>
                  <div className="mt-3 flex gap-2">
                    {([
                      { key: 'inter', label: 'Sans', preview: 'Inter' },
                      { key: 'mono', label: 'Mono', preview: 'JetBrains' },
                      { key: 'serif', label: 'Serif', preview: 'Source Serif' },
                    ] as const).map((f) => (
                      <button
                        key={f.key}
                        onClick={() => setFontFamily(f.key)}
                        className={cn(
                          'flex-1 rounded-2xl border px-3 py-3 transition-colors duration-100',
                          fontFamily === f.key
                            ? 'border-border/70 bg-background/85 text-foreground'
                            : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-background/55 hover:text-foreground'
                        )}
                      >
                        <div className={cn(
                          'text-lg font-medium',
                          f.key === 'mono' && "font-['JetBrains_Mono',monospace]",
                          f.key === 'serif' && "font-['Source_Serif_4',serif]",
                          f.key === 'inter' && "font-['Inter',sans-serif]",
                        )}>
                          Aa
                        </div>
                        <div className="mt-1 text-[11px] font-medium">{f.label}</div>
                        <div className="text-[10px] text-muted-foreground">{f.preview}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className={cn(settingsCardClass, 'px-5 py-5')}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <p className={fieldLabelClass}>Repo Approval</p>
                      <h4 className="text-sm font-semibold text-foreground">Auto-approve repo changes</h4>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        Automatically accept future repo change proposals after the AI shows its plan.
                      </p>
                    </div>
                    <button
                      onClick={() => setAutoApproveRepoChanges(!autoApproveRepoChanges)}
                      className={cn(
                        toggleTrackClass,
                        autoApproveRepoChanges ? 'bg-primary' : 'bg-border'
                      )}
                    >
                      <span
                        className={cn(
                          toggleThumbClass,
                          autoApproveRepoChanges ? 'translate-x-6' : 'translate-x-1'
                        )}
                      />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
