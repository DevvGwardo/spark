import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Provider =
  | 'openai' | 'anthropic' | 'google' | 'xai'
  | 'groq' | 'deepseek' | 'mistral' | 'together'
  | 'minimax' | 'minimax-payg' | 'kimi' | 'kimi-coding' | 'openclaw'
  | 'cerebras' | 'openrouter' | 'sambanova' | 'hermes';

export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ThemeMode = 'light' | 'dark' | 'system';
export type FontSize = 'small' | 'medium' | 'large';
export type FontFamily = 'inter' | 'mono' | 'serif';

export interface ProviderConfig {
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  reasoningEffort: ReasoningEffort;
}

type PersistedSettingsState = Partial<SettingsState> & {
  activeProvider?: Provider | 'lovable';
  availableModels?: Partial<Record<Provider, string[]>>;
  providers?: Partial<Record<Provider, ProviderConfig>> & {
    lovable?: ProviderConfig;
  };
};

interface SettingsState {
  activeProvider: Provider;
  providers: Record<Provider, ProviderConfig>;
  availableModels: Partial<Record<Provider, string[]>>;
  theme: ThemeMode;
  fontSize: FontSize;
  fontFamily: FontFamily;
  defaultSystemPrompt: string;
  isSetupComplete: boolean;
  githubPAT: string;
  autoApproveRepoChanges: boolean;

  setActiveProvider: (p: Provider) => void;
  updateProviderConfig: (p: Provider, config: Partial<ProviderConfig>) => void;
  setAvailableModels: (p: Provider, models: string[]) => void;
  setTheme: (t: ThemeMode) => void;
  setFontSize: (f: FontSize) => void;
  setFontFamily: (f: FontFamily) => void;
  setDefaultSystemPrompt: (s: string) => void;
  completeSetup: () => void;
  setGithubPAT: (pat: string) => void;
  setAutoApproveRepoChanges: (enabled: boolean) => void;
}

function makeDefault(model: string): ProviderConfig {
  return {
    apiKey: '',
    model,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 16384,
    reasoningEffort: 'high',
  };
}

const defaultProviders: Record<Provider, ProviderConfig> = {
  openai: makeDefault('gpt-5.2'),
  anthropic: makeDefault('claude-sonnet-4-5-20250929'),
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
  openrouter: makeDefault('openai/gpt-oss-120b:free'),
  sambanova: makeDefault('Meta-Llama-3.3-70B-Instruct'),
  hermes: makeDefault('nousresearch/hermes-3-llama-3.1-70b'),
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      activeProvider: 'openai',
      providers: defaultProviders,
      availableModels: {},
      theme: 'system',
      fontSize: 'medium',
      fontFamily: 'inter',
      defaultSystemPrompt: 'You are a helpful assistant.',
      isSetupComplete: false,
      githubPAT: '',
      autoApproveRepoChanges: false,

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
      setFontSize: (f) => set({ fontSize: f }),
      setFontFamily: (f) => set({ fontFamily: f }),
      setDefaultSystemPrompt: (s) => set({ defaultSystemPrompt: s }),
      completeSetup: () => set({ isSetupComplete: true }),
      setGithubPAT: (pat) => set({ githubPAT: pat }),
      setAutoApproveRepoChanges: (enabled) => set({ autoApproveRepoChanges: enabled }),
    }),
    {
      name: 'cloudchat-settings',
      version: 12,
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as PersistedSettingsState;
        if (version < 3) {
          const existing = state?.providers || {};
          state.providers = { ...defaultProviders, ...existing } as Record<Provider, ProviderConfig>;
          for (const key of Object.keys(defaultProviders)) {
            if (!state.providers[key]) {
              state.providers[key] = defaultProviders[key as Provider];
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
            state.providers = { ...state.providers, 'kimi-coding': makeDefault('kimi-for-coding') };
          }
        }
        if (version < 7 && state?.providers) {
          const replaceIfLegacy = (provider: Provider, legacyModels: string[], nextModel: string) => {
            const currentModel = state.providers?.[provider]?.model;
            if (!currentModel || legacyModels.includes(currentModel)) {
              state.providers[provider] = {
                ...state.providers[provider],
                model: nextModel,
              };
            }
          };

          replaceIfLegacy('openai', ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini', 'o3-mini'], 'gpt-5.2');
          replaceIfLegacy('google', ['gemini-2.5-pro-preview-06-05', 'gemini-2.5-flash-preview-05-20', 'gemini-1.5-pro'], 'gemini-2.5-flash');
          replaceIfLegacy('xai', ['grok-3-mini', 'grok-2'], 'grok-4-fast-reasoning');
          replaceIfLegacy('groq', ['mixtral-8x7b-32768', 'gemma2-9b-it'], 'llama-3.3-70b-versatile');
          replaceIfLegacy('kimi', ['kimi-k2-0711-preview'], 'moonshot-v1-32k');
        }
        if (version < 8) {
          // Remove lovable provider; migrate users to openai
          if (state.activeProvider === 'lovable') {
            state.activeProvider = 'openai';
          }
          if (state.providers) {
            delete state.providers.lovable;
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
          if (!state?.providers?.hermes) {
            state.providers = { ...state.providers, hermes: makeDefault('nousresearch/hermes-3-llama-3.1-70b') };
          }
        }
        if (version < 12) {
          state.availableModels = state.availableModels || {};
        }
        return state;
      },
    }
  )
);
