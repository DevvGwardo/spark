import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_CHAT_BACKGROUND_SETTINGS,
  isChatBackgroundImageFit,
  isChatBackgroundType,
  type ChatBackgroundImageFit,
  type ChatBackgroundType,
} from '@/lib/chat-backgrounds';
import { isColorThemeId } from '@/lib/themes';
import type { ApprovalPolicy } from '@/lib/approval-policy';

export type Provider =
  | 'openai' | 'anthropic' | 'google' | 'xai'
  | 'groq' | 'deepseek' | 'mistral' | 'together'
  | 'minimax' | 'minimax-payg' | 'kimi' | 'kimi-coding' | 'openclaw'
  | 'cerebras' | 'openrouter' | 'sambanova' | 'z-ai' | 'hermes';

export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ThemeMode = 'light' | 'dark' | 'system';
export type FontSize = 'small' | 'medium' | 'large';
export type FontFamily = 'inter' | 'mono' | 'serif';

export interface ProviderConfig {
  apiKey: string;
  autoDetected: boolean;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  reasoningEffort: ReasoningEffort;
}

type PersistedSettingsState = Partial<SettingsState> & {
  availableModels?: Partial<Record<Provider, string[]>>;
};

export type Language = 'en' | 'es' | 'fr' | 'de' | 'ja' | 'zh' | 'ko' | 'pt';

interface SettingsState {
  activeProvider: Provider;
  providers: Record<Provider, ProviderConfig>;
  availableModels: Partial<Record<Provider, string[]>>;
  theme: ThemeMode;
  colorTheme: string;
  accentColor: string;
  chatBackgroundType: ChatBackgroundType;
  chatBackgroundImageData: string | null;
  chatBackgroundImageFit: ChatBackgroundImageFit;
  chatBackgroundImageOpacity: number;
  fontSize: FontSize;
  fontFamily: FontFamily;
  defaultSystemPrompt: string;
  isSetupComplete: boolean;
  githubPAT: string;
  autoApproveRepoChanges: boolean;
  language: Language;
  autoSave: boolean;
  streamResponses: boolean;
  soundNotifications: boolean;
  analytics: boolean;
  approvalPolicies: ApprovalPolicy[];

  setActiveProvider: (p: Provider) => void;
  updateProviderConfig: (p: Provider, config: Partial<ProviderConfig>) => void;
  setAvailableModels: (p: Provider, models: string[]) => void;
  setTheme: (t: ThemeMode) => void;
  setColorTheme: (id: string) => void;
  setAccentColor: (hsl: string) => void;
  setChatBackgroundType: (type: ChatBackgroundType) => void;
  setChatBackgroundImageData: (imageData: string | null) => void;
  setChatBackgroundImageFit: (fit: ChatBackgroundImageFit) => void;
  setChatBackgroundImageOpacity: (opacity: number) => void;
  setFontSize: (f: FontSize) => void;
  setFontFamily: (f: FontFamily) => void;
  setDefaultSystemPrompt: (s: string) => void;
  completeSetup: () => void;
  setGithubPAT: (pat: string) => void;
  setAutoApproveRepoChanges: (enabled: boolean) => void;
  setLanguage: (l: Language) => void;
  setAutoSave: (enabled: boolean) => void;
  setStreamResponses: (enabled: boolean) => void;
  setSoundNotifications: (enabled: boolean) => void;
  setAnalytics: (enabled: boolean) => void;
  addApprovalPolicy: (policy: ApprovalPolicy) => void;
  removeApprovalPolicy: (key: string) => void;
}

const DEFAULT_PROVIDER_MAX_TOKENS = 32_768;
const DEFAULT_OPENAI_MODEL = 'gpt-5.4';

function makeDefault(model: string): ProviderConfig {
  return {
    apiKey: '',
    autoDetected: false,
    model,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: DEFAULT_PROVIDER_MAX_TOKENS,
    reasoningEffort: 'high',
  };
}

const HERMES_DEFAULT_MODEL = 'meta-llama/llama-4-maverick';
const LEGACY_HERMES_MODELS = new Set([
  'nousresearch/hermes-3-llama-3.1-405b',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'nousresearch/hermes-3-llama-3.1-70b',
  'nousresearch/hermes-3-llama-3.1-70b:free',
]);

const defaultProviders: Record<Provider, ProviderConfig> = {
  openai: makeDefault(DEFAULT_OPENAI_MODEL),
  anthropic: makeDefault('claude-opus-4-7'),
  google: makeDefault('gemini-2.5-flash'),
  xai: makeDefault('grok-4-fast-reasoning'),
  groq: makeDefault('llama-3.3-70b-versatile'),
  deepseek: makeDefault('deepseek-chat'),
  mistral: makeDefault('mistral-large-latest'),
  together: makeDefault('meta-llama/Llama-3.3-70B-Instruct-Turbo'),
  minimax: makeDefault('MiniMax-M2.5'),
  'minimax-payg': makeDefault('MiniMax-M2.5'),
  kimi: makeDefault('moonshot-v1-32k'),
  'kimi-coding': makeDefault('kimi-for-coding'),
  openclaw: makeDefault('default'),
  cerebras: makeDefault('llama-3.3-70b'),
  openrouter: makeDefault('nvidia/llama-3.1-nemotron-70b-instruct:free'),
  sambanova: makeDefault('Meta-Llama-3.3-70B-Instruct'),
  'z-ai': makeDefault('glm-5-plus'),
  hermes: makeDefault(HERMES_DEFAULT_MODEL),
};

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

function cloneDefaultProviders(): Record<Provider, ProviderConfig> {
  return Object.fromEntries(
    (Object.entries(defaultProviders) as Array<[Provider, ProviderConfig]>).map(([provider, config]) => [
      provider,
      { ...config },
    ]),
  ) as Record<Provider, ProviderConfig>;
}

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && value in defaultProviders;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isFontSize(value: unknown): value is FontSize {
  return value === 'small' || value === 'medium' || value === 'large';
}

function isFontFamily(value: unknown): value is FontFamily {
  return value === 'inter' || value === 'mono' || value === 'serif';
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high';
}

function normalizeProviderConfig(
  provider: Provider,
  config: Partial<ProviderConfig> | undefined,
): ProviderConfig {
  const defaults = defaultProviders[provider];

  return {
    apiKey: typeof config?.apiKey === 'string' ? config.apiKey : defaults.apiKey,
    autoDetected: typeof config?.autoDetected === 'boolean' ? config.autoDetected : defaults.autoDetected,
    model: typeof config?.model === 'string' && config.model.trim().length > 0 ? config.model : defaults.model,
    temperature: typeof config?.temperature === 'number' && Number.isFinite(config.temperature)
      ? config.temperature
      : defaults.temperature,
    topP: typeof config?.topP === 'number' && Number.isFinite(config.topP)
      ? config.topP
      : defaults.topP,
    maxTokens: typeof config?.maxTokens === 'number' && Number.isFinite(config.maxTokens)
      ? config.maxTokens
      : defaults.maxTokens,
    reasoningEffort: isReasoningEffort(config?.reasoningEffort)
      ? config.reasoningEffort
      : defaults.reasoningEffort,
  };
}

function normalizeAvailableModels(
  availableModels: PersistedSettingsState['availableModels'],
): Partial<Record<Provider, string[]>> {
  const normalized: Partial<Record<Provider, string[]>> = {};

  for (const provider of Object.keys(defaultProviders) as Provider[]) {
    if (provider === 'hermes') {
      continue;
    }

    const models = availableModels?.[provider];
    if (!Array.isArray(models)) {
      continue;
    }

    const nextModels = [...new Set(models.filter((model): model is string => typeof model === 'string' && model.length > 0))];
    if (nextModels.length > 0) {
      normalized[provider] = nextModels;
    }
  }

  return normalized;
}

export function normalizePersistedSettingsState(
  persisted: PersistedSettingsState | undefined,
): Omit<
  SettingsState,
  'setActiveProvider' |
  'updateProviderConfig' |
  'setAvailableModels' |
  'setTheme' |
  'setColorTheme' |
  'setAccentColor' |
  'setChatBackgroundType' |
  'setChatBackgroundImageData' |
  'setChatBackgroundImageFit' |
  'setChatBackgroundImageOpacity' |
  'setFontSize' |
  'setFontFamily' |
  'setDefaultSystemPrompt' |
  'completeSetup' |
  'setGithubPAT' |
  'setAutoApproveRepoChanges' |
  'setLanguage' |
  'setAutoSave' |
  'setStreamResponses' |
  'setSoundNotifications' |
  'setAnalytics' |
  'addApprovalPolicy' |
  'removeApprovalPolicy'
> {
  const providers = cloneDefaultProviders();

  for (const provider of Object.keys(defaultProviders) as Provider[]) {
    providers[provider] = normalizeProviderConfig(provider, persisted?.providers?.[provider]);
  }

  return {
    activeProvider: isProvider(persisted?.activeProvider) ? persisted.activeProvider : 'openai',
    providers,
    availableModels: normalizeAvailableModels(persisted?.availableModels),
    theme: isThemeMode(persisted?.theme) ? persisted.theme : 'system',
    colorTheme: isColorThemeId(persisted?.colorTheme) ? persisted.colorTheme : 'default',
    accentColor: typeof persisted?.accentColor === 'string' && persisted.accentColor.trim().length > 0 ? persisted.accentColor : '31 100% 50%',
    chatBackgroundType: isChatBackgroundType(persisted?.chatBackgroundType)
      ? persisted.chatBackgroundType
      : DEFAULT_CHAT_BACKGROUND_SETTINGS.type,
    chatBackgroundImageData:
      typeof persisted?.chatBackgroundImageData === 'string' && persisted.chatBackgroundImageData.trim().length > 0
        ? persisted.chatBackgroundImageData
        : DEFAULT_CHAT_BACKGROUND_SETTINGS.imageData,
    chatBackgroundImageFit: isChatBackgroundImageFit(persisted?.chatBackgroundImageFit)
      ? persisted.chatBackgroundImageFit
      : DEFAULT_CHAT_BACKGROUND_SETTINGS.imageFit,
    chatBackgroundImageOpacity:
      typeof persisted?.chatBackgroundImageOpacity === 'number'
        && Number.isFinite(persisted.chatBackgroundImageOpacity)
      ? Math.min(1, Math.max(0.05, persisted.chatBackgroundImageOpacity))
      : DEFAULT_CHAT_BACKGROUND_SETTINGS.imageOpacity,
    fontSize: isFontSize(persisted?.fontSize) ? persisted.fontSize : 'medium',
    fontFamily: isFontFamily(persisted?.fontFamily) ? persisted.fontFamily : 'inter',
    defaultSystemPrompt:
      typeof persisted?.defaultSystemPrompt === 'string'
        ? persisted.defaultSystemPrompt
        : DEFAULT_SYSTEM_PROMPT,
    isSetupComplete: typeof persisted?.isSetupComplete === 'boolean' ? persisted.isSetupComplete : false,
    githubPAT: typeof persisted?.githubPAT === 'string' ? persisted.githubPAT : '',
    autoApproveRepoChanges:
      typeof persisted?.autoApproveRepoChanges === 'boolean' ? persisted.autoApproveRepoChanges : false,
    language: (persisted?.language === 'en' || persisted?.language === 'es' || persisted?.language === 'fr' || persisted?.language === 'de' || persisted?.language === 'ja' || persisted?.language === 'zh' || persisted?.language === 'ko' || persisted?.language === 'pt') ? persisted.language : 'en',
    autoSave: typeof persisted?.autoSave === 'boolean' ? persisted.autoSave : true,
    streamResponses: typeof persisted?.streamResponses === 'boolean' ? persisted.streamResponses : true,
    soundNotifications: typeof persisted?.soundNotifications === 'boolean' ? persisted.soundNotifications : false,
    analytics: typeof persisted?.analytics === 'boolean' ? persisted.analytics : false,
    approvalPolicies: Array.isArray(persisted?.approvalPolicies)
      ? persisted.approvalPolicies.filter((p): p is ApprovalPolicy =>
          !!p
            && typeof (p as ApprovalPolicy).key === 'string'
            && (p as ApprovalPolicy).scope === 'always'
            && typeof (p as ApprovalPolicy).createdAt === 'number',
        )
      : [],
  };
}

const defaultState = normalizePersistedSettingsState(undefined);

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaultState,

      setActiveProvider: (p) => set({ activeProvider: p }),
      updateProviderConfig: (p, config) =>
        set((state) => ({
          providers: {
            ...state.providers,
            [p]: { ...state.providers[p], ...config },
          },
        })),
      setAvailableModels: (p, models) =>
        set((state) => ({
          availableModels: {
            ...state.availableModels,
            [p]: [...new Set(models.filter((model) => typeof model === 'string' && model.length > 0))],
          },
        })),
      setTheme: (t) => set({ theme: t }),
      setColorTheme: (id) => set({ colorTheme: id }),
      setAccentColor: (hsl) => set({ accentColor: hsl }),
      setChatBackgroundType: (type) => set({ chatBackgroundType: type }),
      setChatBackgroundImageData: (imageData) => set({ chatBackgroundImageData: imageData }),
      setChatBackgroundImageFit: (fit) => set({ chatBackgroundImageFit: fit }),
      setChatBackgroundImageOpacity: (opacity) =>
        set({ chatBackgroundImageOpacity: Math.min(1, Math.max(0.05, opacity)) }),
      setFontSize: (f) => set({ fontSize: f }),
      setFontFamily: (f) => set({ fontFamily: f }),
      setDefaultSystemPrompt: (s) => set({ defaultSystemPrompt: s }),
      completeSetup: () => set({ isSetupComplete: true }),
      setGithubPAT: (pat) => set({ githubPAT: pat }),
      setAutoApproveRepoChanges: (enabled) => set({ autoApproveRepoChanges: enabled }),
      setLanguage: (l) => set({ language: l }),
      setAutoSave: (enabled) => set({ autoSave: enabled }),
      setStreamResponses: (enabled) => set({ streamResponses: enabled }),
      setSoundNotifications: (enabled) => set({ soundNotifications: enabled }),
      setAnalytics: (enabled) => set({ analytics: enabled }),
      addApprovalPolicy: (policy) =>
        set((state) => ({
          approvalPolicies: [
            ...state.approvalPolicies.filter((p) => p.key !== policy.key),
            policy,
          ],
        })),
      removeApprovalPolicy: (key) =>
        set((state) => ({
          approvalPolicies: state.approvalPolicies.filter((p) => p.key !== key),
        })),
    }),
    {
      name: 'cloudchat-settings',
      version: 21,
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as PersistedSettingsState;
        if (version < 3) {
          const existing = state?.providers || {};
          state.providers = { ...defaultProviders, ...existing } as Record<Provider, ProviderConfig>;
          for (const key of Object.keys(defaultProviders)) {
            const p = state.providers as Record<string, ProviderConfig | undefined>;
            if (!p[key]) {
              p[key] = defaultProviders[key as Provider];
            }
          }
        }
        if (version < 4) {
          // Fix deprecated OpenRouter model
          if (state?.providers?.openrouter?.model === 'deepseek/deepseek-r1:free') {
            state.providers.openrouter.model = 'openai/gpt-oss-120b:free';
          }
        }
        if (version < 5) {
          state.fontFamily = 'inter';
        }
        if (version < 6) {
          // Add kimi-coding provider for existing users
          if (!state?.providers?.['kimi-coding']) {
            state.providers = { ...state.providers, 'kimi-coding': makeDefault('kimi-for-coding') } as Record<Provider, ProviderConfig>;
          }
        }
        if (version < 7 && state?.providers) {
          const replaceIfLegacy = (provider: Provider, legacyModels: string[], nextModel: string) => {
            const p = state.providers as Record<string, ProviderConfig | undefined>;
            const currentModel = p[provider]?.model;
            if (!currentModel || legacyModels.includes(currentModel)) {
              (state.providers as Record<string, ProviderConfig>)[provider] = {
                ...(state.providers as Record<string, ProviderConfig>)[provider],
                model: nextModel,
              };
            }
          };

          replaceIfLegacy('openai', ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini', 'o3-mini'], DEFAULT_OPENAI_MODEL);
          replaceIfLegacy('google', ['gemini-2.5-pro-preview-06-05', 'gemini-2.5-flash-preview-05-20', 'gemini-1.5-pro'], 'gemini-2.5-flash');
          replaceIfLegacy('xai', ['grok-3-mini', 'grok-2'], 'grok-4-fast-reasoning');
          replaceIfLegacy('groq', ['mixtral-8x7b-32768', 'gemma2-9b-it'], 'llama-3.3-70b-versatile');
          replaceIfLegacy('kimi', ['kimi-k2-0711-preview'], 'moonshot-v1-32k');
        }
        if (version < 8) {
          // Remove lovable provider; migrate users to openai.
          // Cast to string: persisted data may contain legacy provider values
          // that no longer exist in the Provider union.
          if ((state.activeProvider as string) === 'lovable') {
            state.activeProvider = 'openai';
          }
          if (state.providers) {
            delete (state.providers as Record<string, unknown>).lovable;
          }
        }
        if (version < 9) {
          state.autoApproveRepoChanges = false;
        }
        if (version < 10) {
          const existing = state?.providers || {};
          state.providers = { ...defaultProviders, ...existing } as Record<Provider, ProviderConfig>;
          for (const key of Object.keys(defaultProviders) as Provider[]) {
            const current = state.providers[key] || defaultProviders[key];
            state.providers[key] = {
              ...defaultProviders[key],
              ...current,
              reasoningEffort:
                current.reasoningEffort === 'low' ||
                current.reasoningEffort === 'medium' ||
                current.reasoningEffort === 'high'
                  ? current.reasoningEffort
                  : 'high',
            };
          }
        }
        if (version < 11) {
          if (!(state.providers as Record<string, ProviderConfig | undefined>)?.hermes) {
            state.providers = { ...state.providers, hermes: makeDefault(HERMES_DEFAULT_MODEL) } as Record<Provider, ProviderConfig>;
          }
        }
        if (version < 12) {
          state.availableModels = state.availableModels || {};
        }
        if (version < 14) {
          const currentHermesModel = (state.providers as Record<string, ProviderConfig | undefined>)?.hermes?.model;
          if (!currentHermesModel || LEGACY_HERMES_MODELS.has(currentHermesModel)) {
            state.providers = {
              ...state.providers,
              hermes: {
                ...((state.providers as Record<string, ProviderConfig | undefined>)?.hermes ?? makeDefault(HERMES_DEFAULT_MODEL)),
                model: HERMES_DEFAULT_MODEL,
              },
            } as Record<Provider, ProviderConfig>;
          }
        }
        if (version < 15 && state.availableModels) {
          delete state.availableModels.hermes;
        }
        if (version < 16 && state.providers) {
          for (const provider of Object.keys(defaultProviders) as Provider[]) {
            const current = state.providers[provider];
            if (!current) {
              continue;
            }

            if (!Number.isFinite(current.maxTokens) || current.maxTokens === 16384) {
              current.maxTokens = DEFAULT_PROVIDER_MAX_TOKENS;
            }
          }

          const currentOpenAiModel = state.providers.openai?.model;
          if (!currentOpenAiModel || currentOpenAiModel === 'gpt-5.2') {
            state.providers.openai = {
              ...(state.providers.openai ?? makeDefault(DEFAULT_OPENAI_MODEL)),
              model: DEFAULT_OPENAI_MODEL,
            };
          }
        }
        if (version < 17) {
          state.language = state.language || 'en';
          state.autoSave = state.autoSave ?? true;
          state.streamResponses = state.streamResponses ?? true;
          state.soundNotifications = state.soundNotifications ?? false;
          state.analytics = state.analytics ?? false;
        }
        if (version < 18) {
          state.colorTheme = state.colorTheme || 'default';
          state.accentColor = state.accentColor || '31 100% 50%';
        }
        if (version < 19 && state?.providers?.openrouter) {
          const cur = state.providers.openrouter.model;
          if (cur === 'openai/gpt-oss-120b:free' || cur === 'deepseek/deepseek-r1:free') {
            state.providers.openrouter.model = 'nvidia/llama-3.1-nemotron-70b-instruct:free';
          }
        }
        if (version < 20) {
          state.chatBackgroundType = isChatBackgroundType(state.chatBackgroundType)
            ? state.chatBackgroundType
            : DEFAULT_CHAT_BACKGROUND_SETTINGS.type;
          state.chatBackgroundImageData =
            typeof state.chatBackgroundImageData === 'string' && state.chatBackgroundImageData.trim().length > 0
              ? state.chatBackgroundImageData
              : DEFAULT_CHAT_BACKGROUND_SETTINGS.imageData;
          state.chatBackgroundImageFit = isChatBackgroundImageFit(state.chatBackgroundImageFit)
            ? state.chatBackgroundImageFit
            : DEFAULT_CHAT_BACKGROUND_SETTINGS.imageFit;
          state.chatBackgroundImageOpacity =
            typeof state.chatBackgroundImageOpacity === 'number'
              && Number.isFinite(state.chatBackgroundImageOpacity)
            ? Math.min(1, Math.max(0.05, state.chatBackgroundImageOpacity))
            : DEFAULT_CHAT_BACKGROUND_SETTINGS.imageOpacity;
        }
        return normalizePersistedSettingsState(state);
      },
      merge: (persisted, current) => ({
        ...current,
        ...normalizePersistedSettingsState((persisted ?? {}) as PersistedSettingsState),
      }),
    }
  )
);
