import React, { useState, useMemo } from 'react';
import { X, Eye, EyeOff, Search, Check, Zap, ChevronDown, ExternalLink, Github, Code2, Network, Info } from 'lucide-react';
import { useSettingsStore, type Provider } from '@/stores/settings-store';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { useUIStore } from '@/stores/ui-store';
import { PROVIDERS, PROVIDER_ORDER, CATEGORY_LABELS, type ProviderCategory } from '@/lib/providers';
import { KnowledgePanel } from './KnowledgePanel';
import { PROVIDER_KEY_URLS } from '@/components/chat/ApiKeyModal';
import { cn } from '@/lib/utils';

const ProviderIcon: React.FC<{ provider: Provider; className?: string }> = ({ provider, className }) => {
  if (PROVIDERS[provider]?.badge === 'Fast') return <Zap className={className} />;
  return (
    <span className={cn('flex items-center justify-center rounded-md bg-muted text-[10px] font-bold uppercase leading-none', className)}>
      {PROVIDERS[provider].label.slice(0, 2)}
    </span>
  );
};



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

  const handlePlanProviderChange = (p: Provider) => {
    setPlanningProvider(p);
    setPlanningModel(PROVIDERS[p].defaultModel);
  };

  const handleCodeProviderChange = (p: Provider) => {
    setCodingProvider(p);
    setCodingModel(PROVIDERS[p].defaultModel);
  };

  const selectClasses =
    'w-full appearance-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary/50 transition-colors cursor-pointer';

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-secondary flex items-center justify-center">
          <Network className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold">Coding Agent</h3>
          <p className="text-xs text-muted-foreground">
            Plan model breaks down the task, code model implements each step
          </p>
        </div>
        <button
          onClick={() => setEnabled(!enabled)}
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
            enabled ? 'bg-primary' : 'bg-border'
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-200',
              enabled ? 'translate-x-6' : 'translate-x-1'
            )}
          />
        </button>
      </div>

      {!enabled && (
        <div className="rounded-lg bg-accent border border-border px-4 py-3">
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
          <div className="rounded-xl border border-border bg-background overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
              <div className="h-8 w-8 rounded-lg bg-background/80 flex items-center justify-center">
                <Network className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-semibold">Plan Model</h4>
                <p className="text-[11px] text-muted-foreground">Breaks down requests and synthesizes results</p>
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div className="relative">
                <select
                  value={planningProvider}
                  onChange={(e) => handlePlanProviderChange(e.target.value as Provider)}
                  className={selectClasses}
                >
                  {PROVIDER_ORDER.map((p) => (
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
          <div className="rounded-xl border border-border bg-background overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
              <div className="h-8 w-8 rounded-lg bg-background/80 flex items-center justify-center">
                <Code2 className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-semibold">Code Model</h4>
                <p className="text-[11px] text-muted-foreground">Executes each sub-task in parallel</p>
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div className="relative">
                <select
                  value={codingProvider}
                  onChange={(e) => handleCodeProviderChange(e.target.value as Provider)}
                  className={selectClasses}
                >
                  {PROVIDER_ORDER.map((p) => (
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
          <div className="rounded-xl border border-border bg-background overflow-hidden">
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
    theme,
    fontSize,
    fontFamily,
    defaultSystemPrompt,
    githubPAT,
    autoApproveRepoChanges,
    setActiveProvider,
    updateProviderConfig,
    setTheme,
    setFontSize,
    setFontFamily,
    setDefaultSystemPrompt,
    setGithubPAT,
    setAutoApproveRepoChanges,
  } = useSettingsStore();

  const [showKey, setShowKey] = useState(false);
  const [showGithubKey, setShowGithubKey] = useState(false);
  const [tab, setTab] = useState<'providers' | 'roles' | 'github' | 'knowledge' | 'general'>('providers');
  const [search, setSearch] = useState('');

  const config = providers[activeProvider];
  const providerInfo = PROVIDERS[activeProvider];
  const needsApiKey = providerInfo?.needsApiKey ?? true;

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-foreground/10 backdrop-blur-[2px]" onClick={() => setSettingsOpen(false)} />
      <div className="relative bg-background border border-border rounded-xl w-full max-w-3xl mx-4 max-h-[85vh] overflow-hidden flex flex-col shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-1">
            {(['providers', 'roles', 'github', 'knowledge', 'general'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-100 capitalize',
                  tab === t ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t === 'github' ? 'GitHub' : t}
              </button>
            ))}
          </div>
          <button onClick={() => setSettingsOpen(false)} className="p-1.5 rounded-lg hover:bg-secondary transition-colors duration-100 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        {tab === 'providers' && (
          <div className="flex flex-1 overflow-hidden min-h-0">
            {/* Left: Provider list */}
            <div className="w-[220px] border-r border-border flex flex-col overflow-hidden shrink-0">
              <div className="p-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search..."
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-secondary border-0 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
                {(['featured', 'open-source', 'specialized'] as ProviderCategory[]).map(cat => {
                  const items = grouped[cat];
                  if (!items?.length) return null;
                  return (
                    <div key={cat}>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest px-2 mb-1">
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
                              'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all duration-100 group',
                              isActive
                                ? 'bg-secondary text-foreground'
                                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                            )}
                          >
                            <ProviderIcon provider={p} className="h-4 w-4 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm font-medium truncate">{info.label}</span>
                                {info.badge && (
                                  <span className={cn(
                                    'text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-full leading-none',
                                    info.badge === 'Free'
                                      ? 'bg-accent text-accent-foreground'
                                      : 'bg-muted text-muted-foreground'
                                  )}>
                                    {info.badge}
                                  </span>
                                )}
                              </div>
                            </div>
                            {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: Config */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* Provider header */}
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-secondary flex items-center justify-center">
                  <ProviderIcon provider={activeProvider} className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">{providerInfo.label}</h3>
                  <p className="text-xs text-muted-foreground">{providerInfo.description}</p>
                </div>
              </div>

              {/* API Key */}
              {needsApiKey && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">API Key</label>
                    {PROVIDER_KEY_URLS[activeProvider] && (
                      <a
                        href={PROVIDER_KEY_URLS[activeProvider]}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                      >
                        Get key
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={config.apiKey}
                      onChange={(e) => updateProviderConfig(activeProvider, { apiKey: e.target.value })}
                      placeholder={`Enter your ${providerInfo.label} key...`}
                      className="w-full px-3 py-2 pr-10 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring font-mono"
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
                <div className="rounded-lg bg-accent border border-border px-3.5 py-2.5">
                  <p className="text-xs text-accent-foreground font-medium">No API key required — built-in AI provider.</p>
                </div>
              )}

              {/* Model */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Model</label>
                <div className="relative">
                  <select
                    value={config.model}
                    onChange={(e) => updateProviderConfig(activeProvider, { model: e.target.value })}
                    className="w-full appearance-none px-3 py-2 pr-8 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring font-mono cursor-pointer"
                  >
                    {providerInfo.models.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                </div>
              </div>

              {/* Temperature & Max Tokens */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Temperature</label>
                    <span className="text-xs font-mono text-muted-foreground tabular-nums">{config.temperature}</span>
                  </div>
                  <input
                    type="range" min="0" max="1" step="0.1"
                    value={config.temperature}
                    onChange={(e) => updateProviderConfig(activeProvider, { temperature: parseFloat(e.target.value) })}
                    className="w-full accent-foreground h-1.5"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Max Tokens</label>
                    <span className="text-xs font-mono text-muted-foreground tabular-nums">{config.maxTokens}</span>
                  </div>
                  <input
                    type="range" min="256" max="16384" step="256"
                    value={config.maxTokens}
                    onChange={(e) => updateProviderConfig(activeProvider, { maxTokens: parseInt(e.target.value) })}
                    className="w-full accent-foreground h-1.5"
                  />
                </div>
              </div>

              {/* System Prompt */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">System Prompt</label>
                <textarea
                  value={defaultSystemPrompt}
                  onChange={(e) => setDefaultSystemPrompt(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
          </div>
        )}

        {tab === 'roles' && <RolesTab />}

        {tab === 'github' && (
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* GitHub header */}
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-secondary flex items-center justify-center">
                <Github className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">GitHub Integration</h3>
                <p className="text-xs text-muted-foreground">Connect to read repos and create PRs</p>
              </div>
            </div>

            {/* PAT Input */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Personal Access Token</label>
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo&description=CloudChat%20Integration"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
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
                  className="w-full px-3 py-2 pr-10 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                />
                <button
                  onClick={() => setShowGithubKey(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors duration-100"
                >
                  {showGithubKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Required scopes: <code className="px-1 py-0.5 rounded bg-secondary">repo</code> for full repository access
              </p>
            </div>

            {/* Status indicator */}
            {githubPAT && (
              <div className="rounded-lg bg-accent border border-border px-3.5 py-2.5">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                  <p className="text-xs text-accent-foreground font-medium">GitHub connected</p>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  You can now browse repositories and create pull requests from chat.
                </p>
              </div>
            )}

            {/* Instructions */}
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">How it works</h4>
              <ol className="space-y-1.5 text-xs text-muted-foreground">
                <li className="flex gap-2">
                  <span className="shrink-0 h-4 w-4 rounded-full bg-secondary flex items-center justify-center text-[10px] font-medium">1</span>
                  <span>Generate a GitHub Personal Access Token with <code className="px-1 py-0.5 rounded bg-secondary">repo</code> scope</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 h-4 w-4 rounded-full bg-secondary flex items-center justify-center text-[10px] font-medium">2</span>
                  <span>Paste the token above — it's stored locally in your browser</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 h-4 w-4 rounded-full bg-secondary flex items-center justify-center text-[10px] font-medium">3</span>
                  <span>Ask the AI to analyze or modify your repositories</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 h-4 w-4 rounded-full bg-secondary flex items-center justify-center text-[10px] font-medium">4</span>
                  <span>Review and create PRs with AI-generated changes</span>
                </li>
              </ol>
            </div>
          </div>
        )}

        {tab === 'knowledge' && (
          <div className="flex-1 overflow-y-auto p-5">
            <KnowledgePanel />
          </div>
        )}

        {tab === 'general' && (
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Theme</label>
              <div className="flex gap-1.5">
                {(['light', 'dark', 'system'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={cn(
                      'flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-100 capitalize',
                      theme === t
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Font Size</label>
              <div className="flex gap-1.5">
                {(['small', 'medium', 'large'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFontSize(f)}
                    className={cn(
                      'flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-100 capitalize',
                      fontSize === f
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                    )}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Font</label>
              <div className="flex gap-1.5">
                {([
                  { key: 'inter', label: 'Sans', preview: 'Inter' },
                  { key: 'mono', label: 'Mono', preview: 'JetBrains' },
                  { key: 'serif', label: 'Serif', preview: 'Source Serif' },
                ] as const).map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFontFamily(f.key)}
                    className={cn(
                      'flex-1 flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg transition-colors duration-100',
                      fontFamily === f.key
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                    )}
                  >
                    <span className={cn(
                      'text-base font-medium',
                      f.key === 'mono' && "font-['JetBrains_Mono',monospace]",
                      f.key === 'serif' && "font-['Source_Serif_4',serif]",
                      f.key === 'inter' && "font-['Inter',sans-serif]",
                    )}>
                      Aa
                    </span>
                    <span className="text-[10px]">{f.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold">Auto-approve repo changes</h4>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Automatically accept future file change proposals after the AI shows its plan. Disable this to require manual confirmation again.
                  </p>
                </div>
                <button
                  onClick={() => setAutoApproveRepoChanges(!autoApproveRepoChanges)}
                  className={cn(
                    'relative mt-0.5 inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                    autoApproveRepoChanges ? 'bg-primary' : 'bg-border'
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-200',
                      autoApproveRepoChanges ? 'translate-x-6' : 'translate-x-1'
                    )}
                  />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
