import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Eye, EyeOff, Search, Check, Zap, ChevronDown, ChevronRight, ArrowLeft, ExternalLink, Github, Code2, Network, TerminalSquare, RefreshCw, LayoutGrid, BookOpen, Settings, Plus, Trash2, MessageSquare, ImagePlus, ShieldCheck } from 'lucide-react';
import { useSettingsStore, type Provider, type Language } from '@/stores/settings-store';
import { COLOR_THEMES, ACCENT_COLORS } from '@/lib/themes';
import { ChatSurfaceBackground } from '@/components/chat/ChatSurfaceBackground';
import { useHermesStore } from '@/stores/hermes-store';
import { discoverMCPTools } from '@/lib/mcp-connect';
import { fetchHermesProviders, type HermesProviderInfo } from '@/lib/hermes-api';
import { useUIStore } from '@/stores/ui-store';
import { PROVIDERS, PROVIDER_ORDER, CATEGORY_LABELS, getVisibleModelOptions } from '@/lib/providers';
import { validateApiKey, listGitHubRepos, type GitHubRepoSummary } from '@/lib/api';
import { PROVIDER_KEY_URLS } from '@/components/chat/ApiKeyModal';
import { cn } from '@/lib/utils';
import {
  optimizeChatBackgroundImage,
  type ChatBackgroundImageFit,
  type ChatBackgroundType,
} from '@/lib/chat-backgrounds';
import { getLocalProviderRuntimeDetails, parseLocalProviderRuntimeError } from '@/lib/local-provider-runtime';
import MessagingTab from './MessagingTab';
import packageJson from '../../../package.json';

const PROVIDER_COLORS: Partial<Record<Provider, string>> = {
  openai: '#10A37F',
  anthropic: '#D4A274',
  google: '#4285F4',
  xai: '#cccccc',
  groq: '#F55200',
  cerebras: '#8B5CF6',
  openrouter: '#6366F1',
  sambanova: '#22D3EE',
  deepseek: '#4F8FEA',
  mistral: '#FF7000',
  together: '#00B4D8',
  minimax: '#FF6B6B',
  'minimax-payg': '#FF6B6B',
  kimi: '#7C3AED',
  'kimi-coding': '#7C3AED',
  'z-ai': '#3B82F6',
  openclaw: '#F59E0B',
  hermes: '#EC4899',
};

const navSections = [
  { label: 'PROVIDERS', items: [{ id: 'providers' as const, label: 'Providers', icon: LayoutGrid }] },
  { label: 'INTEGRATIONS', items: [
    { id: 'messaging' as const, label: 'Messaging', icon: MessageSquare },
    { id: 'github' as const, label: 'GitHub', icon: Github },
  ]},
  { label: 'MANAGEMENT', items: [
    { id: 'knowledge' as const, label: 'Knowledge', icon: BookOpen },
    { id: 'general' as const, label: 'General', icon: Settings },
  ]},
];

const ProviderIcon: React.FC<{ provider: Provider; size?: 'sm' | 'card' }> = ({ provider, size = 'sm' }) => {
  const color = PROVIDER_COLORS[provider] || '#888888';
  if (size === 'card') {
    return (
      <div
        className="h-[38px] w-[38px] rounded-[10px] flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18` }}
      >
        <span style={{ color }} className="text-base font-bold">
          {PROVIDERS[provider].label[0]}
        </span>
      </div>
    );
  }
  if (PROVIDERS[provider]?.badge === 'Fast') return <Zap className="h-4 w-4" />;
  return (
    <span className="flex items-center justify-center rounded-lg bg-muted/70 text-[10px] font-bold uppercase leading-none h-8 w-8">
      {PROVIDERS[provider].label.slice(0, 2)}
    </span>
  );
};

const settingsCardClass = 'rounded-[10px] border border-[#2a2a2a] bg-white/[0.02]';
const fieldLabelClass = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80';
const textInputClass = 'w-full rounded-[10px] border border-[#2a2a2a] bg-[#141414] px-3 py-2 text-sm text-foreground outline-none transition-colors duration-100 placeholder:text-muted-foreground focus:border-[#FF8400]/40 focus:ring-1 focus:ring-[#FF8400]/20';
const selectInputClass = `${textInputClass} appearance-none pr-9 cursor-pointer font-mono`;
const toggleTrackClass = 'relative inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2';
const toggleThumbClass = 'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-md ring-0 transition-transform duration-200';
const sectionLabelClass = 'text-[10px] font-semibold uppercase tracking-[1px] text-[#555555]';
const settingsDividerClass = 'h-px bg-[#2a2a2a] w-full';
const settingsSearchClass = 'w-full rounded-[10px] border border-[#2a2a2a] bg-[#141414] h-[38px] px-[14px] pl-9 text-sm text-foreground outline-none transition-colors duration-100 placeholder:text-muted-foreground focus:border-[#FF8400]/40 focus:ring-1 focus:ring-[#FF8400]/20';
const listCardClass = 'rounded-[10px] bg-white/[0.016] border border-[#2a2a2a] px-4 py-[14px] flex items-center gap-[14px] w-full text-left transition-colors duration-100 hover:bg-white/[0.04]';
const bottomActionClass = 'rounded-[10px] border border-[#2a2a2a] border-dashed h-[42px] w-full flex items-center justify-center gap-2 text-[13px] text-[#555555] hover:text-[#888888] hover:border-[#444444] transition-colors duration-100';
const dropdownClass = 'rounded-[8px] bg-[#141414] border border-[#2a2a2a] px-3 py-2 text-sm text-foreground outline-none appearance-none cursor-pointer pr-9';



// ---------------------------------------------------------------------------
// KnowledgeTab — Knowledge base cards
// ---------------------------------------------------------------------------

const KNOWLEDGE_BASES = [
  { id: 'kb-project-docs', name: 'Project Documentation', description: 'Architecture docs, READMEs, and onboarding guides', iconColor: '#4F8FEA', fileCount: 12, size: '2.4 MB' },
  { id: 'kb-code-snippets', name: 'Code Snippets', description: 'Reusable code patterns and utility functions', iconColor: '#10A37F', fileCount: 34, size: '890 KB' },
  { id: 'kb-style-guide', name: 'Style Guide', description: 'Design tokens, component specs, and brand guidelines', iconColor: '#FF8400', fileCount: 8, size: '1.1 MB' },
  { id: 'kb-meeting-notes', name: 'Meeting Notes', description: 'Sprint retrospectives and planning session notes', iconColor: '#8B5CF6', fileCount: 22, size: '560 KB' },
];

function KnowledgeTab() {
  const [search, setSearch] = useState('');

  const filteredBases = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return KNOWLEDGE_BASES;
    return KNOWLEDGE_BASES.filter(kb =>
      kb.name.toLowerCase().includes(q) || kb.description.toLowerCase().includes(q)
    );
  }, [search]);

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-[#e0e0e0]">Knowledge</h3>
        <p className="text-[13px] text-[#666666]">Custom knowledge bases, documents, and context sources.</p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#555555]" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search knowledge bases..."
          className={settingsSearchClass}
        />
      </div>

      {/* Knowledge base cards */}
      <div className="space-y-2">
        {filteredBases.map(kb => (
          <button key={kb.id} className={listCardClass}>
            <div
              className="h-[38px] w-[38px] rounded-[10px] flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${kb.iconColor}18` }}
            >
              <BookOpen className="h-4 w-4" style={{ color: kb.iconColor }} />
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-foreground">{kb.name}</span>
              <p className="text-xs text-[#666666] truncate">{kb.description}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs text-[#888888] font-mono">{kb.fileCount} files</p>
              <p className="text-[10px] text-[#555555] font-mono">{kb.size}</p>
            </div>
            <ChevronRight className="h-4 w-4 text-[#444444] shrink-0" />
          </button>
        ))}
      </div>

      {/* Add knowledge base button */}
      <button className={bottomActionClass}>
        <Plus className="h-4 w-4" />
        Add knowledge base
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GeneralTab — App preferences with sectioned layout
// ---------------------------------------------------------------------------

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  pt: 'Portuguese',
};

function GeneralTab() {
  const {
    theme,
    colorTheme,
    accentColor,
    chatBackgroundType,
    chatBackgroundImageData,
    chatBackgroundImageFit,
    chatBackgroundImageOpacity,
    language,
    autoSave,
    streamResponses,
    soundNotifications,
    analytics,
    approvalPolicies,
    setTheme,
    setColorTheme,
    setAccentColor,
    setChatBackgroundType,
    setChatBackgroundImageData,
    setChatBackgroundImageFit,
    setChatBackgroundImageOpacity,
    setLanguage,
    setAutoSave,
    setStreamResponses,
    setSoundNotifications,
    setAnalytics,
    removeApprovalPolicy,
  } = useSettingsStore();
  const sessionApprovalPolicies = useHermesStore((state) => state.sessionApprovalPolicies);
  const clearSessionApprovalPolicies = useHermesStore((state) => state.clearSessionApprovalPolicies);

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [backgroundUploadError, setBackgroundUploadError] = useState<string | null>(null);
  const backgroundFileInputRef = useRef<HTMLInputElement>(null);

  const backgroundModes: Array<{ value: ChatBackgroundType; label: string }> = [
    { value: 'solid', label: 'Solid' },
    { value: 'gradient', label: 'Gradient' },
    { value: 'image', label: 'Image' },
  ];

  const imageFitOptions: Array<{ value: ChatBackgroundImageFit; label: string }> = [
    { value: 'cover', label: 'Fill' },
    { value: 'contain', label: 'Fit' },
    { value: 'stretch', label: 'Stretch' },
    { value: 'tile', label: 'Tile' },
  ];

  const handleClearData = () => {
    // Clear conversation history from IndexedDB
    try {
      const req = indexedDB.deleteDatabase('cloudchat-db');
      req.onsuccess = () => setShowClearConfirm(false);
      req.onerror = () => setShowClearConfirm(false);
    } catch {
      setShowClearConfirm(false);
    }
  };

  const handleBackgroundFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';

    if (!file) {
      return;
    }

    setBackgroundUploadError(null);

    try {
      const optimized = await optimizeChatBackgroundImage(file);
      setChatBackgroundImageData(optimized);
      setChatBackgroundType('image');
    } catch (error) {
      console.error('Failed to process chat background image', error);
      setBackgroundUploadError('Unable to process that image. Try a smaller JPG or PNG.');
    }
  }, [setChatBackgroundImageData, setChatBackgroundType]);

  const ToggleRow: React.FC<{ label: string; description: string; enabled: boolean; onChange: (v: boolean) => void }> = ({ label, description, enabled, onChange }) => (
    <div className="flex items-center justify-between py-1">
      <div className="min-w-0 flex-1 pr-4">
        <p className="text-sm text-foreground">{label}</p>
        <p className="text-xs text-[#666666]">{description}</p>
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className={cn(toggleTrackClass, enabled ? 'bg-[#FF8400]' : 'bg-[#333333]')}
      >
        <span className={cn(toggleThumbClass, enabled ? 'translate-x-[20px]' : 'translate-x-[3px]')} />
      </button>
    </div>
  );

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-[#e0e0e0]">General</h3>
        <p className="text-[13px] text-[#666666]">App preferences, theme, language, and notification settings.</p>
      </div>

      {/* APPEARANCE */}
      <div className="space-y-4">
        <p className={sectionLabelClass}>Appearance</p>

        {/* Mode row */}
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1 pr-4">
            <p className="text-sm text-foreground">Mode</p>
            <p className="text-xs text-[#666666]">Choose your preferred color scheme</p>
          </div>
          <div className="relative">
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}
              className={dropdownClass}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>

        {/* Color Theme grid */}
        <div className="space-y-2">
          <p className="text-sm text-foreground">Theme</p>
          {(theme === 'light' || (theme === 'system' && typeof window !== 'undefined' && !window.matchMedia('(prefers-color-scheme: dark)').matches)) ? (
            <p className="text-xs text-[#666666]">Color themes available in dark mode</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {COLOR_THEMES.map((t) => {
                const isSelected = colorTheme === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setColorTheme(t.id)}
                    className={cn(
                      'rounded-xl overflow-hidden text-left transition-all duration-100',
                      isSelected
                        ? 'border-2 border-primary ring-2 ring-primary/20'
                        : 'border border-[#2F2F2F] hover:border-[#444]'
                    )}
                  >
                    {/* Mini window preview */}
                    <div
                      className="h-[68px] p-2 flex gap-1.5"
                      style={{ backgroundColor: t.preview.bg }}
                    >
                      {/* Sidebar */}
                      <div
                        className="w-[28%] rounded-md flex flex-col gap-1 p-1.5"
                        style={{ backgroundColor: t.preview.sidebar }}
                      >
                        <div className="h-1 w-3/4 rounded-full" style={{ backgroundColor: t.preview.text, opacity: 0.15 }} />
                        <div className="h-1 w-1/2 rounded-full" style={{ backgroundColor: t.preview.text, opacity: 0.1 }} />
                        <div className="h-1 w-2/3 rounded-full" style={{ backgroundColor: t.preview.text, opacity: 0.1 }} />
                      </div>
                      {/* Main area */}
                      <div className="flex-1 rounded-md p-1.5 flex flex-col justify-between" style={{ backgroundColor: t.preview.sidebar, opacity: 0.6 }}>
                        <div className="flex flex-col gap-1">
                          <div className="h-1 w-3/4 rounded-full" style={{ backgroundColor: t.preview.text, opacity: 0.12 }} />
                          <div className="h-1 w-1/2 rounded-full" style={{ backgroundColor: t.preview.text, opacity: 0.08 }} />
                        </div>
                        {/* Accent dot */}
                        <div className="flex justify-end">
                          <div className="h-2 w-2 rounded-full" style={{ backgroundColor: t.preview.accent }} />
                        </div>
                      </div>
                    </div>
                    {/* Theme name */}
                    <div className="px-2.5 py-2 bg-[#111]">
                      <p className={cn(
                        'text-xs font-medium',
                        isSelected ? 'text-primary' : 'text-[#999]'
                      )}>{t.name}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Accent Color row */}
        <div className="space-y-2">
          <p className="text-sm text-foreground">Accent Color</p>
          <div className="flex items-center gap-2">
            {ACCENT_COLORS.map((c) => {
              const isSelected = accentColor === c.value;
              return (
                <button
                  key={c.name}
                  title={c.name}
                  onClick={() => setAccentColor(c.value)}
                  className={cn(
                    'h-6 w-6 rounded-full transition-all duration-100 flex items-center justify-center shrink-0',
                    isSelected && 'ring-2 ring-offset-2 ring-offset-[#141414]'
                  )}
                  style={{
                    backgroundColor: `hsl(${c.value})`,
                    ...(isSelected ? { boxShadow: `0 0 0 2px hsl(${c.value} / 0.4)` } : {}),
                  }}
                >
                  {isSelected && <Check className="h-3 w-3 text-white drop-shadow-sm" />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-sm text-foreground">Chat background</p>
            <p className="text-xs text-[#666666]">Apply a subtle background to the conversation canvas while keeping the current palette.</p>
          </div>

          <div className="relative overflow-hidden rounded-[14px] border border-[#2a2a2a] bg-[#0f0f10]">
            <ChatSurfaceBackground />
            <div className="relative z-10 flex h-[108px] items-end gap-3 p-3">
              <div className="w-[124px] rounded-[14px] border border-white/10 bg-background/72 px-3 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-xl">
                <div className="h-2.5 w-16 rounded-full bg-foreground/12" />
                <div className="mt-2 h-2 w-20 rounded-full bg-foreground/8" />
              </div>
              <div className="mb-3 flex-1 rounded-[16px] border border-white/10 bg-background/45 px-3 py-2 backdrop-blur-xl">
                <div className="h-2.5 w-24 rounded-full bg-foreground/10" />
                <div className="mt-2 h-2 w-32 rounded-full bg-foreground/8" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {backgroundModes.map((option) => {
              const isSelected = chatBackgroundType === option.value;

              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setChatBackgroundType(option.value)}
                  className={cn(
                    'rounded-[10px] border px-3 py-2 text-[12px] font-medium transition-colors duration-100',
                    isSelected
                      ? 'border-primary/50 bg-primary/12 text-foreground'
                      : 'border-[#2a2a2a] bg-[#141414] text-muted-foreground hover:border-[#444444] hover:text-foreground'
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {chatBackgroundType === 'image' && (
            <div className="space-y-3 rounded-[10px] border border-[#2a2a2a] bg-[#111111] p-3">
              <input
                ref={backgroundFileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={handleBackgroundFileChange}
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => backgroundFileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-[10px] border border-[#2a2a2a] bg-[#141414] px-3 py-2 text-[12px] font-medium text-foreground transition-colors duration-100 hover:border-[#444444]"
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                  {chatBackgroundImageData ? 'Replace image' : 'Upload image'}
                </button>
                {chatBackgroundImageData && (
                  <button
                    type="button"
                    onClick={() => setChatBackgroundImageData(null)}
                    className="rounded-[10px] border border-[#2a2a2a] px-3 py-2 text-[12px] font-medium text-muted-foreground transition-colors duration-100 hover:border-[#444444] hover:text-foreground"
                  >
                    Remove image
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                {imageFitOptions.map((option) => {
                  const isSelected = chatBackgroundImageFit === option.value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setChatBackgroundImageFit(option.value)}
                      className={cn(
                        'rounded-[10px] border px-3 py-2 text-[12px] font-medium transition-colors duration-100',
                        isSelected
                          ? 'border-primary/50 bg-primary/12 text-foreground'
                          : 'border-[#2a2a2a] bg-[#141414] text-muted-foreground hover:border-[#444444] hover:text-foreground'
                      )}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] text-foreground">Image opacity</p>
                  <span className="text-[11px] font-mono text-[#777777]">{Math.round(chatBackgroundImageOpacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={chatBackgroundImageOpacity}
                  onChange={(event) => setChatBackgroundImageOpacity(Number(event.target.value))}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[#222222] accent-[hsl(var(--primary))]"
                />
              </div>

              {backgroundUploadError && (
                <p className="text-[11px] text-[#ff9b9b]">{backgroundUploadError}</p>
              )}
            </div>
          )}
        </div>

        {/* Language */}
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1 pr-4">
            <p className="text-sm text-foreground">Language</p>
            <p className="text-xs text-[#666666]">Set your preferred display language</p>
          </div>
          <div className="relative">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              className={dropdownClass}
            >
              {Object.entries(LANGUAGE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
      </div>

      <div className={settingsDividerClass} />

      {/* BEHAVIOR */}
      <div className="space-y-3">
        <p className={sectionLabelClass}>Behavior</p>
        <ToggleRow label="Auto-save" description="Automatically save conversations as you type" enabled={autoSave} onChange={setAutoSave} />
        <ToggleRow label="Stream responses" description="Show responses as they're generated" enabled={streamResponses} onChange={setStreamResponses} />
        <ToggleRow label="Sound notifications" description="Play sound when a response is ready" enabled={soundNotifications} onChange={setSoundNotifications} />
      </div>

      <div className={settingsDividerClass} />

      {/* APPROVAL POLICIES */}
      <div className="space-y-3">
        <p className={sectionLabelClass}>Approval policies</p>
        <p className="text-xs text-[#666666]">
          Saved approvals auto-accept repo changes that match. Session approvals clear when the chat panel closes.
        </p>

        {approvalPolicies.length === 0 ? (
          <p className="text-xs text-[#555555]">No saved always-approvals.</p>
        ) : (
          <ul className="space-y-1.5">
            {approvalPolicies.map((policy) => (
              <li
                key={policy.key}
                className="flex items-center justify-between rounded-[8px] border border-[#2a2a2a] bg-[#141414] px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <code className="truncate font-mono text-[11px] text-foreground">{policy.key}</code>
                </div>
                <button
                  onClick={() => removeApprovalPolicy(policy.key)}
                  aria-label={`Revoke approval ${policy.key}`}
                  className="ml-3 rounded-[6px] p-1 text-muted-foreground transition-colors duration-100 hover:bg-[#1f1f1f] hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between py-1">
          <div className="min-w-0 flex-1 pr-4">
            <p className="text-sm text-foreground">Session approvals</p>
            <p className="text-xs text-[#666666]">
              {sessionApprovalPolicies.length === 0
                ? 'No active session approvals.'
                : `${sessionApprovalPolicies.length} active session approval${sessionApprovalPolicies.length === 1 ? '' : 's'}.`}
            </p>
          </div>
          <button
            onClick={clearSessionApprovalPolicies}
            disabled={sessionApprovalPolicies.length === 0}
            className={cn(
              'rounded-[8px] border px-3 py-1.5 text-xs font-medium transition-colors duration-100',
              sessionApprovalPolicies.length === 0
                ? 'cursor-not-allowed border-[#2a2a2a] bg-[#141414] text-muted-foreground/50'
                : 'border-[#2a2a2a] bg-[#141414] text-muted-foreground hover:border-[#444444] hover:text-foreground',
            )}
          >
            Clear all
          </button>
        </div>
      </div>

      <div className={settingsDividerClass} />

      {/* DATA & PRIVACY */}
      <div className="space-y-3">
        <p className={sectionLabelClass}>Data & Privacy</p>
        <ToggleRow label="Analytics" description="Help improve Spark by sharing anonymous usage data" enabled={analytics} onChange={setAnalytics} />
        <div className="flex items-center justify-between py-1">
          <div className="min-w-0 flex-1 pr-4">
            <p className="text-sm text-foreground">Clear history</p>
            <p className="text-xs text-[#666666]">Delete all conversation history and cached data</p>
          </div>
          {showClearConfirm ? (
            <div className="flex items-center gap-2">
              <button
                onClick={handleClearData}
                className="rounded-[8px] bg-[#FF4444] px-3 py-1.5 text-xs font-medium text-white"
              >
                Confirm
              </button>
              <button
                onClick={() => setShowClearConfirm(false)}
                className="rounded-[8px] border border-[#2a2a2a] px-3 py-1.5 text-xs font-medium text-muted-foreground"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowClearConfirm(true)}
              className="rounded-[8px] bg-[#FF444418] border border-[#FF444430] px-3 py-1.5 text-xs font-medium text-[#FF4444]"
            >
              Clear data
            </button>
          )}
        </div>
      </div>

    </div>
  );
}

export const SettingsModal: React.FC = () => {
  const { settingsOpen, setSettingsOpen } = useUIStore();
  const {
    activeProvider,
    providers,
    availableModels,
    defaultSystemPrompt,
    githubPAT,
    setActiveProvider,
    updateProviderConfig,
    setAvailableModels,
    setDefaultSystemPrompt,
    setGithubPAT,
  } = useSettingsStore();

  const {
    toolsets: hermesToolsets,
    setToolset: setHermesToolset,
    swarm: hermesSwarm,
    setSwarmEnabled: setHermesSwarmEnabled,
    underlyingProvider: hermesUnderlyingProvider,
    setUnderlyingProvider: setHermesUnderlyingProvider,
    mcpServers,
    addMCPServer,
    removeMCPServer,
    toggleMCPServer,
  } = useHermesStore();

  const [showKey, setShowKey] = useState(false);
  const [showGithubKey, setShowGithubKey] = useState(false);
  const [githubUsername, setGithubUsername] = useState<string | null>(null);
  const [githubRepos, setGithubRepos] = useState<GitHubRepoSummary[]>([]);
  const [syncingRepos, setSyncingRepos] = useState(false);

  const handleSyncRepos = useCallback(async () => {
    if (!githubPAT) return;
    setSyncingRepos(true);
    try {
      const repos = await listGitHubRepos(githubPAT);
      setGithubRepos(repos);
    } catch (e) {
      console.error('Failed to sync repos:', e);
    } finally {
      setSyncingRepos(false);
    }
  }, [githubPAT]);
  const [tab, setTab] = useState<'providers' | 'messaging' | 'github' | 'knowledge' | 'general'>('providers');
  const [search, setSearch] = useState('');
  const [providerView, setProviderView] = useState<'list' | 'detail'>('list');
  const [showMoreProviders, setShowMoreProviders] = useState(false);
  const [localRuntimeStatus, setLocalRuntimeStatus] = useState<string | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  // Hermes underlying-provider catalog (providers + models the agent can route to)
  const [hermesProviders, setHermesProviders] = useState<HermesProviderInfo[]>([]);

  // MCP server management state
  const [mcpAddOpen, setMcpAddOpen] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpApiKey, setMcpApiKey] = useState('');
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const handleConnectMCP = useCallback(async (serverId: string, url: string, apiKey?: string) => {
    setMcpConnecting(serverId);
    setMcpError(null);
    const tools = await discoverMCPTools({ serverId, url, apiKey });
    if (tools === null) {
      const server = useHermesStore.getState().mcpServers.find((s) => s.id === serverId);
      setMcpError(server?.lastError ?? 'Connection failed');
    }
    setMcpConnecting(null);
  }, []);

  const handleAddMCPServer = useCallback(() => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    const id = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const url = mcpUrl.trim();
    const apiKey = mcpApiKey.trim() || undefined;
    addMCPServer({
      id,
      name: mcpName.trim(),
      url,
      apiKey,
      enabled: true,
      tools: [],
      transportType: 'http',
      connectionStatus: 'disconnected',
      errorCount: 0,
    });
    setMcpName('');
    setMcpUrl('');
    setMcpApiKey('');
    setMcpAddOpen(false);
    // Auto-connect to discover tools
    handleConnectMCP(id, url, apiKey);
  }, [mcpName, mcpUrl, mcpApiKey, addMCPServer, handleConnectMCP]);

  // Animation state: tracks whether the modal is mounted and whether it's visually open
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const closingRef = useRef(false);

  useEffect(() => {
    if (settingsOpen) {
      setMounted(true);
      closingRef.current = false;
      // Trigger enter animation on next frame
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    } else if (mounted) {
      // Trigger exit animation, then unmount
      closingRef.current = true;
      setVisible(false);
    }
  }, [mounted, settingsOpen]);

  const handleTransitionEnd = useCallback(() => {
    if (closingRef.current) {
      setMounted(false);
      closingRef.current = false;
    }
  }, []);

  // Fetch the GitHub username whenever the PAT changes (debounced, validated)
  useEffect(() => {
    const pat = githubPAT.trim();
    if (!pat || !/^(ghp_|github_pat_|gho_|ghs_|ghr_)[a-zA-Z0-9._-]+$/.test(pat)) {
      setGithubUsername(null);
      return;
    }

    let cancelled = false;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${pat}` },
          });
          if (cancelled) return;
          if (res.ok) {
            const data = await res.json() as { login?: string };
            if (!cancelled && data.login) {
              setGithubUsername(data.login);
            }
          } else {
            setGithubUsername(null);
          }
        } catch {
          if (!cancelled) setGithubUsername(null);
        }
      })();
    }, 500);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [githubPAT]);

  // Auto-fetch repos when GitHub tab is shown and PAT is valid
  useEffect(() => {
    if (tab === 'github' && githubUsername && githubPAT && githubRepos.length === 0) {
      handleSyncRepos();
    }
  }, [tab, githubUsername, githubPAT, githubRepos.length, handleSyncRepos]);

  const config = providers[activeProvider];
  const providerInfo = PROVIDERS[activeProvider];
  const needsApiKey = providerInfo?.needsApiKey ?? true;
  const modelOptions = useMemo(() => {
    // For Hermes with an explicit underlying provider, show that provider's
    // catalog models so the model list matches the chosen provider.
    if (activeProvider === 'hermes' && hermesUnderlyingProvider) {
      const selected = hermesProviders.find((p) => p.id === hermesUnderlyingProvider);
      if (selected?.models?.length) {
        return getVisibleModelOptions('hermes', selected.models, config.model);
      }
    }
    const baseModels = availableModels[activeProvider]?.length
      ? availableModels[activeProvider]!
      : providerInfo.models;
    return getVisibleModelOptions(activeProvider, baseModels, config.model);
  }, [activeProvider, availableModels, config.model, providerInfo.models, hermesUnderlyingProvider, hermesProviders]);

  // Refresh models for any provider with an API key when settings opens
  useEffect(() => {
    if (!settingsOpen || activeProvider === 'openclaw' || activeProvider === 'hermes') {
      // openclaw/hermes handled below
      return;
    }

    const apiKey = config.apiKey;
    if (!apiKey?.trim()) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const result = await validateApiKey(activeProvider, apiKey);
        if (cancelled || !result.valid) {
          return;
        }

        const nextModels = (result.models ?? []).filter(Boolean);
        if (nextModels.length > 0) {
          setAvailableModels(activeProvider, nextModels);
        }
      } catch {
        // Silently fail — the user can still use cached models
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProvider, config.apiKey, setAvailableModels, settingsOpen]);

  // Refresh models for openclaw/hermes (runtime validation)
  useEffect(() => {
    if (!settingsOpen || (activeProvider !== 'openclaw' && activeProvider !== 'hermes')) {
      setLocalRuntimeStatus(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const apiKey = activeProvider === 'hermes' ? providers.hermes.apiKey : '';
        if (activeProvider === 'hermes' && !apiKey.trim()) {
          if (!cancelled) {
            setLocalRuntimeStatus(null);
          }
          return;
        }

        const result = await validateApiKey(activeProvider, apiKey);
        if (cancelled) {
          return;
        }

        const runtimeError = result.error ? parseLocalProviderRuntimeError(activeProvider, result.error) : null;
        setLocalRuntimeStatus(runtimeError ? result.error || runtimeError.summary : null);

        if (!result.valid) {
          return;
        }

        if (activeProvider === 'openclaw') {
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
        }

        if (activeProvider === 'hermes') {
          const nextModels = (result.models ?? []).filter(Boolean);
          if (nextModels.length > 0) {
            setAvailableModels('hermes', nextModels);
          }

          const nextDefaultModel = result.defaultModel || nextModels[0];
          const currentModel = providers.hermes.model;
          if (
            nextDefaultModel &&
            (!currentModel || (nextModels.length > 0 && !nextModels.includes(currentModel)))
          ) {
            updateProviderConfig('hermes', { model: nextDefaultModel });
          }
        }
      } catch (error) {
        console.error(`Failed to validate ${activeProvider} runtime`, error);
        if (!cancelled) {
          setLocalRuntimeStatus(error instanceof Error ? error.message : `Failed to validate ${activeProvider} runtime`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeProvider,
    providers.hermes.apiKey,
    providers.hermes.model,
    providers.openclaw.model,
    setAvailableModels,
    settingsOpen,
    updateProviderConfig,
  ]);

  // Load the Hermes underlying-provider catalog (providers + their models) so
  // the user can switch which provider/model the agent routes to.
  useEffect(() => {
    if (!settingsOpen || activeProvider !== 'hermes') return;

    let cancelled = false;
    void (async () => {
      try {
        const { providers: catalog } = await fetchHermesProviders();
        if (!cancelled && catalog.length > 0) {
          setHermesProviders(catalog);
        }
      } catch {
        // Bridge unreachable — leave the picker on its default (auto) state
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [settingsOpen, activeProvider]);

  const handleRefreshModels = useCallback(async () => {
    const apiKey = config.apiKey;
    if (activeProvider === 'hermes') {
      // Hermes doesn't need an API key — validate against the bridge directly
      setRefreshingModels(true);
      try {
        const result = await validateApiKey('hermes', '');
        if (result.valid) {
          const nextModels = (result.models ?? []).filter(Boolean);
          if (nextModels.length > 0) {
            setAvailableModels('hermes', nextModels);
          }
          if (result.defaultModel) {
            updateProviderConfig('hermes', { model: result.defaultModel });
          }
        }
      } catch {
        // Silently fail
      } finally {
        setRefreshingModels(false);
      }
      return;
    }

    if (!apiKey?.trim()) {
      return;
    }

    setRefreshingModels(true);
    try {
      const result = await validateApiKey(activeProvider, apiKey);
      if (result.valid) {
        const nextModels = (result.models ?? []).filter(Boolean);
        if (nextModels.length > 0) {
          setAvailableModels(activeProvider, nextModels);
        }
      }
    } catch {
      // Silently fail
    } finally {
      setRefreshingModels(false);
    }
  }, [activeProvider, config.apiKey, setAvailableModels, updateProviderConfig]);

  const filteredProviders = useMemo(() => {
    const q = search.toLowerCase();
    return PROVIDER_ORDER.filter(p => {
      const info = PROVIDERS[p];
      return info.label.toLowerCase().includes(q) || info.description.toLowerCase().includes(q);
    });
  }, [search]);

  // Hermes-first grouping: 'featured' shows expanded; the remaining categories
  // collapse behind a single disclosure unless the user is actively searching.
  const featuredProviders = useMemo(
    () => filteredProviders.filter((p) => PROVIDERS[p].category === 'featured'),
    [filteredProviders],
  );
  const moreProviderGroups = useMemo(
    () =>
      (['open-source', 'specialized'] as const)
        .map((category) => ({
          category,
          providers: filteredProviders.filter((p) => PROVIDERS[p].category === category),
        }))
        .filter((group) => group.providers.length > 0),
    [filteredProviders],
  );
  const moreProvidersExpanded = showMoreProviders || search.trim().length > 0;

  if (!mounted) return null;

  const localRuntimeDetails = getLocalProviderRuntimeDetails(activeProvider);

  const handleSelectProvider = (p: Provider) => {
    setActiveProvider(p);
    if (!providers[p]?.model) {
      updateProviderConfig(p, { model: PROVIDERS[p].defaultModel });
    }
  };

  const handleTabChange = (nextTab: typeof tab) => {
    setTab(nextTab);
    setProviderView('list');
  };

  const getProviderStatus = (p: Provider): { label: string; color: string; bg: string } | null => {
    const info = PROVIDERS[p];
    if (!info.needsApiKey) return null;
    const config = providers[p];
    if (p === 'hermes' && config?.autoDetected) {
      return { label: 'Signed in via Hermes', color: '#00FF88', bg: '#00FF8812' };
    }
    const key = config?.apiKey;
    if (key?.trim()) return { label: 'Connected', color: '#00FF88', bg: '#00FF8812' };
    return { label: 'No key', color: '#FF6666', bg: '#FF444412' };
  };

  const renderProviderCard = (p: Provider) => {
    const info = PROVIDERS[p];
    const isActive = activeProvider === p;
    const status = getProviderStatus(p);
    return (
      <button
        key={p}
        onClick={() => {
          handleSelectProvider(p);
          setProviderView('detail');
        }}
        className={cn(
          'rounded-[10px] border px-4 py-3.5 flex items-center gap-3.5 w-full text-left transition-all duration-100',
          isActive
            ? 'bg-[#FF840010] border-[#FF840040]'
            : 'bg-white/[0.02] border-[#2a2a2a] hover:bg-white/[0.04]'
        )}
      >
        <ProviderIcon provider={p} size="card" />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium text-foreground">{info.label}</span>
          <p className="text-xs text-[#666666] truncate">{info.description}</p>
        </div>
        {status && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-semibold shrink-0"
            style={{ color: status.color, backgroundColor: status.bg }}
          >
            {status.label}
          </span>
        )}
        <ChevronRight className="h-4 w-4 text-[#555555] shrink-0" />
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className={cn(
          'absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-250 ease-out',
          visible ? 'opacity-100' : 'opacity-0',
        )}
        onClick={() => setSettingsOpen(false)}
      />
      <div
        onTransitionEnd={handleTransitionEnd}
        className={cn(
          'relative flex w-[880px] h-[600px] flex-col overflow-hidden rounded-2xl border border-[#2a2a2a] bg-card transition-[transform,opacity] duration-250 ease-out',
          visible ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
        )}
      >
        {/* Header */}
        <div className="border-b border-[#2a2a2a] px-5 py-3.5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground">Settings</h2>
            <button
              onClick={() => setSettingsOpen(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.03] text-muted-foreground transition-colors duration-100 hover:bg-white/[0.06] hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Vertical nav sidebar */}
          <nav className="w-[200px] shrink-0 border-r border-[#2a2a2a] flex flex-col py-4 px-3">
            {navSections.map((section, sIdx) => (
              <React.Fragment key={section.label}>
                {sIdx > 0 && <div className="h-px bg-[#2a2a2a] my-3" />}
                <p className="text-[10px] font-semibold uppercase tracking-[1px] text-[#555555] px-2.5 mb-1.5">
                  {section.label}
                </p>
                {section.items.map((item) => {
                  const isActive = tab === item.id;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      onClick={() => handleTabChange(item.id)}
                      className={cn(
                        'h-9 rounded-lg flex items-center gap-2.5 px-2.5 text-[13px] w-full transition-colors duration-100',
                        isActive
                          ? 'bg-[#FF840010] text-[#e0e0e0]'
                          : 'text-[#888888] hover:text-[#bbbbbb] hover:bg-white/[0.03]'
                      )}
                    >
                      <Icon className={cn('h-4 w-4', isActive ? 'text-[#FF8400]' : 'text-[#666666]')} />
                      {item.label}
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
            <div className="mt-auto px-2.5">
              <span className="font-mono text-[11px] text-[#444444]">v{packageJson.version}</span>
            </div>
          </nav>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto">
            {tab === 'providers' && providerView === 'list' && (
              <div className="p-6 space-y-4">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Providers</h3>
                  <p className="text-[13px] text-[#666666]">Manage AI providers, API keys, and active models.</p>
                </div>

                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search providers..."
                    className={cn(textInputClass, 'pl-9 h-[38px]')}
                  />
                </div>

                {/* Provider cards — Hermes-first: Featured expanded, rest behind a disclosure */}
                <div className="space-y-2">
                  {featuredProviders.map(renderProviderCard)}
                </div>

                {moreProviderGroups.length > 0 && (
                  <div className="space-y-2">
                    {!moreProvidersExpanded ? (
                      <button
                        onClick={() => setShowMoreProviders(true)}
                        className={cn(bottomActionClass, 'gap-1.5')}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                        Show more providers
                      </button>
                    ) : (
                      moreProviderGroups.map((group) => (
                        <div key={group.category} className="space-y-2">
                          <p className={cn(sectionLabelClass, 'px-1 pt-1')}>{CATEGORY_LABELS[group.category]}</p>
                          {group.providers.map(renderProviderCard)}
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Add provider placeholder */}
                <button className="rounded-[10px] h-[42px] border border-[#2a2a2a] border-dashed w-full text-[13px] text-[#555555] hover:text-[#888888] hover:border-[#444444] transition-colors duration-100">
                  + Add provider
                </button>
              </div>
            )}

            {tab === 'providers' && providerView === 'detail' && (
              <div className="p-6">
                <button
                  onClick={() => setProviderView('list')}
                  className="flex items-center gap-1.5 text-[13px] text-[#888888] hover:text-foreground transition-colors duration-100 mb-4"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to providers
                </button>

                <div className="space-y-5">
                  <div className={cn(settingsCardClass, 'flex items-start gap-4 px-5 py-5')}>
                    <ProviderIcon provider={activeProvider} size="card" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold tracking-[-0.015em] text-foreground">{providerInfo.label}</h3>
                        {providerInfo.badge && (
                          <span className="rounded-full border border-[#2a2a2a] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
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

                  {localRuntimeDetails && (
                    <div className={cn(settingsCardClass, 'px-5 py-5')}>
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-200">
                          <TerminalSquare className="h-4.5 w-4.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-[#2a2a2a] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                              {localRuntimeDetails.badge}
                            </span>
                            <span className="rounded-full border border-[#2a2a2a] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                              {localRuntimeDetails.title}
                            </span>
                          </div>
                          <p className="mt-2 text-sm font-medium text-foreground">{localRuntimeDetails.summary}</p>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{localRuntimeDetails.detail}</p>
                          <div className="mt-3 grid gap-3 grid-cols-2">
                            <div>
                              <p className={fieldLabelClass}>Start Command</p>
                              <div className="mt-1 rounded-[10px] border border-[#2a2a2a] bg-[#141414] px-3 py-2 text-xs font-mono text-foreground">
                                {localRuntimeDetails.command}
                              </div>
                            </div>
                            <div>
                              <p className={fieldLabelClass}>{localRuntimeDetails.locationLabel}</p>
                              <div className="mt-1 rounded-[10px] border border-[#2a2a2a] bg-[#141414] px-3 py-2 text-xs font-mono text-foreground">
                                {localRuntimeDetails.locationValue}
                              </div>
                            </div>
                          </div>
                          {localRuntimeStatus && (
                            <div className="mt-3 rounded-[10px] border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
                              {localRuntimeStatus}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

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
                              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-muted/50 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-all duration-150 hover:bg-muted hover:text-foreground"
                            >
                              Get API key
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

                    {activeProvider === 'hermes' && (
                      <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                        <div>
                          <p className={fieldLabelClass}>Agent Provider</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Choose which AI provider the Hermes agent routes to. "Auto" lets the agent
                            pick based on the model name. A dot indicates whether a credential is configured.
                          </p>
                        </div>
                        <div className="relative">
                          <select
                            value={hermesUnderlyingProvider}
                            onChange={(e) => {
                              const next = e.target.value;
                              setHermesUnderlyingProvider(next);
                              const selected = hermesProviders.find((p) => p.id === next);
                              const firstModel = selected?.models?.[0];
                              if (firstModel && !selected?.models?.includes(providers.hermes.model)) {
                                updateProviderConfig('hermes', { model: firstModel });
                              }
                            }}
                            className={selectInputClass}
                          >
                            <option value="">Auto (route by model)</option>
                            {hermesProviders.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.credentialed ? '● ' : '○ '}{p.name}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        </div>
                        {(() => {
                          const selected = hermesProviders.find((p) => p.id === hermesUnderlyingProvider);
                          if (hermesUnderlyingProvider && selected && !selected.credentialed) {
                            return (
                              <p className="text-xs text-amber-500">
                                No credential detected for {selected.name}. Configure its API key in your
                                Hermes profile (or the matching provider above) before using it.
                              </p>
                            );
                          }
                          return null;
                        })()}
                      </div>
                    )}

                    <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                      <div>
                        <p className={fieldLabelClass}>Model</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Choose the default model used when this provider is active.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
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
                        {needsApiKey && activeProvider !== 'hermes' && config.apiKey?.trim() && (
                          <button
                            onClick={handleRefreshModels}
                            disabled={refreshingModels}
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#141414] text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-colors duration-100 disabled:opacity-50"
                            title="Refresh available models"
                          >
                            <RefreshCw className={cn('h-3.5 w-3.5', refreshingModels && 'animate-spin')} />
                          </button>
                        )}
                      </div>
                      {activeProvider === 'hermes' && (
                        <p className="text-xs text-muted-foreground">
                          {hermesUnderlyingProvider
                            ? 'Models shown are those offered by the selected agent provider.'
                            : 'In Auto mode the agent routes by model name (OpenRouter handles anything unrecognized). Pick a provider above to scope the list.'}
                        </p>
                      )}
                    </div>

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
                        rows={4}
                        className={cn(textInputClass, 'resize-none')}
                      />
                    </div>

                    {activeProvider === 'hermes' && (
                      <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                        <div>
                          <p className={fieldLabelClass}>Hermes Agent Tools</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Choose which tools the Hermes agent can use during conversations.
                          </p>
                        </div>
                        <div className="space-y-3">
                          {([
                            { key: 'web' as const, label: 'Web Search', desc: 'Search the web for information' },
                            { key: 'browser' as const, label: 'Browser Automation', desc: 'Browse and interact with web pages' },
                            { key: 'vision' as const, label: 'Vision Analysis', desc: 'Analyze images and screenshots' },
                            { key: 'computer' as const, label: 'Computer Use', desc: 'Let the agent control the screen, mouse, and keyboard', warn: true },
                            { key: 'terminal' as const, label: 'Terminal Access', desc: 'Allows shell command execution on your machine', warn: true },
                            { key: 'files' as const, label: 'File Operations', desc: 'Allows reading and writing files on your machine', warn: true },
                            { key: 'code_execution' as const, label: 'Code Execution', desc: 'Allows running arbitrary code on your machine', warn: true },
                          ]).map(({ key, label, desc, warn }) => (
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
                                    hermesToolsets[key] ? 'translate-x-[20px]' : 'translate-x-[3px]'
                                  )}
                                />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {activeProvider === 'hermes' && (
                      <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                        <div>
                          <p className={fieldLabelClass}>Swarm Pipeline</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Run an Architect → Implementor → Reviewer pipeline for multi-step tasks.
                            Each phase is a separate agent that plans, implements, then reviews changes.
                          </p>
                        </div>
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm text-foreground">Enable Swarm Mode</div>
                            <div className="text-xs text-muted-foreground">
                              {hermesSwarm.enabled
                                ? 'Messages will run through the 3-phase pipeline'
                                : 'Messages use the standard single-agent loop'}
                            </div>
                          </div>
                          <button
                            onClick={() => setHermesSwarmEnabled(!hermesSwarm.enabled)}
                            className={cn(
                              toggleTrackClass,
                              hermesSwarm.enabled ? 'bg-primary' : 'bg-border'
                            )}
                          >
                            <span
                              className={cn(
                                toggleThumbClass,
                                hermesSwarm.enabled ? 'translate-x-[20px]' : 'translate-x-[3px]'
                              )}
                            />
                          </button>
                        </div>
                      </div>
                    )}

                    {activeProvider === 'hermes' && (
                      <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                        <div className="flex items-center justify-between">
                          <div>
                            <p className={fieldLabelClass}>MCP Servers</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Connect external tool servers to extend agent capabilities.
                            </p>
                          </div>
                          <button
                            onClick={() => setMcpAddOpen(!mcpAddOpen)}
                            className="flex items-center gap-1.5 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-[#3a3a3a] transition-colors"
                          >
                            <Plus size={12} />
                            Add
                          </button>
                        </div>

                        {mcpAddOpen && (
                          <div className="space-y-2 rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-3">
                            <input
                              value={mcpName}
                              onChange={(e) => setMcpName(e.target.value)}
                              placeholder="Server name"
                              className={cn(textInputClass, 'text-xs')}
                            />
                            <input
                              value={mcpUrl}
                              onChange={(e) => setMcpUrl(e.target.value)}
                              placeholder="Server URL (e.g. http://localhost:8080/mcp)"
                              className={cn(textInputClass, 'text-xs font-mono')}
                            />
                            <input
                              value={mcpApiKey}
                              onChange={(e) => setMcpApiKey(e.target.value)}
                              placeholder="API key (optional)"
                              type="password"
                              className={cn(textInputClass, 'text-xs')}
                            />
                            <div className="flex gap-2 pt-1">
                              <button
                                onClick={handleAddMCPServer}
                                disabled={!mcpName.trim() || !mcpUrl.trim()}
                                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                              >
                                Add & Connect
                              </button>
                              <button
                                onClick={() => { setMcpAddOpen(false); setMcpName(''); setMcpUrl(''); setMcpApiKey(''); }}
                                className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {mcpError && (
                          <p className="text-xs text-red-400">{mcpError}</p>
                        )}

                        {mcpServers.length === 0 && !mcpAddOpen && (
                          <p className="text-xs text-muted-foreground/60 py-2">
                            No MCP servers configured. Add one to give the agent extra tools.
                          </p>
                        )}

                        <div className="space-y-2">
                          {mcpServers.map((server) => (
                            <div key={server.id} className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2.5">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span
                                    className={cn(
                                      'inline-block h-2 w-2 shrink-0 rounded-full',
                                      server.connectionStatus === 'connected' && 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.45)]',
                                      server.connectionStatus === 'connecting' && 'bg-amber-500 animate-pulse',
                                      server.connectionStatus === 'disconnected' && 'bg-muted-foreground/40',
                                      server.connectionStatus === 'error' && 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.45)]',
                                    )}
                                  />
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm text-foreground truncate">{server.name}</span>
                                      <span className="text-[9px] uppercase tracking-wider text-muted-foreground/40">
                                        {server.transportType === 'http' ? 'HTTP' : 'STDIO'}
                                      </span>
                                    </div>
                                    <div className="text-[10px] font-mono text-muted-foreground/60 truncate">{server.url}</div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className={cn(
                                    'text-[10px] font-medium',
                                    server.connectionStatus === 'connected' ? 'text-emerald-400/70' :
                                    server.connectionStatus === 'error' ? 'text-red-400/70' :
                                    'text-muted-foreground'
                                  )}>
                                    {server.tools.length} tool{server.tools.length !== 1 ? 's' : ''}
                                  </span>
                                  <button
                                    onClick={() => handleConnectMCP(server.id, server.url, server.apiKey)}
                                    disabled={mcpConnecting === server.id}
                                    className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                                    title="Refresh tools"
                                  >
                                    <RefreshCw size={12} className={mcpConnecting === server.id ? 'animate-spin' : ''} />
                                  </button>
                                  <button
                                    onClick={() => toggleMCPServer(server.id)}
                                    className={cn(
                                      toggleTrackClass,
                                      server.enabled ? 'bg-primary' : 'bg-border'
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        toggleThumbClass,
                                        server.enabled ? 'translate-x-[20px]' : 'translate-x-[3px]'
                                      )}
                                    />
                                  </button>
                                  <button
                                    onClick={() => removeMCPServer(server.id)}
                                    className="text-muted-foreground hover:text-red-400 transition-colors"
                                    title="Remove server"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              </div>
                              {server.lastError && (
                                <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/8 px-2 py-1.5 text-[10px] text-red-300/80">
                                  {server.lastError}
                                </div>
                              )}
                              {server.tools.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {server.tools.map((tool) => (
                                    <span
                                      key={tool.name}
                                      className="inline-block rounded-md bg-[#1a1a1a] border border-[#2a2a2a] px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
                                      title={tool.description}
                                    >
                                      {tool.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {activeProvider !== 'hermes' && activeProvider !== 'openclaw' && (
                      <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                        <div>
                          <p className={fieldLabelClass}>Agent Tools</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Enable local execution tools. Requires a model that supports tool calling.
                          </p>
                        </div>
                        <div className="space-y-3">
                          {([
                            { key: 'terminal' as const, label: 'Terminal Access', desc: 'Execute shell commands on your machine', warn: true },
                            { key: 'files' as const, label: 'File Operations', desc: 'Read and write files on your machine', warn: true },
                            { key: 'code_execution' as const, label: 'Code Execution', desc: 'Run Python code on your machine', warn: true },
                            { key: 'computer' as const, label: 'Computer Use', desc: 'Let the agent control the screen, mouse, and keyboard', warn: true },
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
                                    hermesToolsets[key] ? 'translate-x-[20px]' : 'translate-x-[3px]'
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
                          <span className="rounded-full border border-[#2a2a2a] px-2 py-0.5 text-xs font-mono tabular-nums text-muted-foreground">
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
                          <span className="rounded-full border border-[#2a2a2a] px-2 py-0.5 text-xs font-mono tabular-nums text-muted-foreground">
                            {config.maxTokens}
                          </span>
                        </div>
                        <input
                          type="range" min="256" max="65536" step="256"
                          value={config.maxTokens}
                          onChange={(e) => updateProviderConfig(activeProvider, { maxTokens: parseInt(e.target.value) })}
                          className="h-1.5 w-full accent-foreground"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}


            {tab === 'github' && (
              <div className="p-6 space-y-4">
                {/* Header */}
                <div>
                  <h3 className="text-lg font-semibold text-[#e0e0e0]">GitHub</h3>
                  <p className="text-[13px] text-[#666666]">Connected repositories, access tokens, and config settings.</p>
                </div>

                {/* Connection status card */}
                <div className={cn(settingsCardClass, 'px-4 py-[14px] flex items-center gap-[14px]')}>
                  <div className="h-[38px] w-[38px] rounded-[10px] flex items-center justify-center shrink-0 bg-white/[0.05]">
                    <Github className="h-5 w-5 text-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-foreground">
                      {githubPAT ? (githubUsername ? `@${githubUsername}` : 'Verifying...') : 'Not connected'}
                    </span>
                    <p className="text-xs text-[#666666]">
                      {githubPAT ? 'Personal Access Token configured' : 'Add a token to connect'}
                    </p>
                  </div>
                  {githubPAT ? (
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-[#00FF88] bg-[#00FF8812] shrink-0">
                      Connected
                    </span>
                  ) : (
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-[#FF6666] bg-[#FF444412] shrink-0">
                      Disconnected
                    </span>
                  )}
                </div>

                {/* PAT input */}
                <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className={fieldLabelClass}>Personal Access Token</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Stored locally. Required scopes: <code className="rounded bg-secondary px-1 py-0.5">repo</code>
                      </p>
                    </div>
                    <a
                      href="https://github.com/settings/tokens/new?scopes=repo&description=Spark%20Integration"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-full border border-[#2a2a2a] px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors duration-100 hover:bg-white/[0.04] hover:text-foreground"
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
                </div>

                {/* Repositories section */}
                {githubPAT && (
                  <>
                    <div className="flex items-center gap-3">
                      <span className={sectionLabelClass}>Repositories</span>
                      <div className={cn(settingsDividerClass, 'flex-1')} />
                    </div>

                    <div className="space-y-2">
                      {syncingRepos && githubRepos.length === 0 && (
                        <p className="text-xs text-muted-foreground py-3 text-center">Loading repositories...</p>
                      )}
                      {!syncingRepos && githubRepos.length === 0 && (
                        <p className="text-xs text-muted-foreground/60 py-3 text-center">No repositories loaded. Click sync to fetch.</p>
                      )}
                      {githubRepos.map((repo) => (
                        <div key={repo.id} className={cn(listCardClass, 'cursor-default')}>
                          <div className="h-[38px] w-[38px] rounded-[10px] flex items-center justify-center shrink-0 bg-[#4F8FEA18]">
                            <Code2 className="h-4 w-4 text-[#4F8FEA]" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <span className="text-sm font-medium text-foreground">{repo.full_name}</span>
                            <p className="text-xs text-[#666666] truncate">{repo.description || (repo.private ? 'Private repository' : 'No description')}</p>
                          </div>
                          {repo.language && (
                            <span className="text-[10px] text-muted-foreground/60 shrink-0">{repo.language}</span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Sync button */}
                    <button
                      onClick={handleSyncRepos}
                      disabled={syncingRepos}
                      className={bottomActionClass}
                    >
                      <RefreshCw className={`h-4 w-4 ${syncingRepos ? 'animate-spin' : ''}`} />
                      {syncingRepos ? 'Syncing...' : 'Sync repositories'}
                    </button>
                  </>
                )}
              </div>
            )}

            {tab === 'messaging' && <MessagingTab />}

            {tab === 'knowledge' && <KnowledgeTab />}

            {tab === 'general' && <GeneralTab />}
          </div>
        </div>
      </div>
    </div>
  );
};
