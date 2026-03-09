import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Provider =
  | 'lovable' | 'openai' | 'anthropic' | 'google' | 'xai'
  | 'groq' | 'deepseek' | 'mistral' | 'together'
  | 'minimax' | 'minimax-payg' | 'kimi'
  | 'cerebras' | 'openrouter' | 'sambanova';

export type ThemeMode = 'light' | 'dark' | 'system';
export type FontSize = 'small' | 'medium' | 'large';

export interface ProviderConfig {
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
}

interface SettingsState {
  activeProvider: Provider;
  providers: Record<Provider, ProviderConfig>;
  theme: ThemeMode;
  fontSize: FontSize;
  defaultSystemPrompt: string;
  isSetupComplete: boolean;
  githubPAT: string;

  setActiveProvider: (p: Provider) => void;
  updateProviderConfig: (p: Provider, config: Partial<ProviderConfig>) => void;
  setTheme: (t: ThemeMode) => void;
  setFontSize: (f: FontSize) => void;
  setDefaultSystemPrompt: (s: string) => void;
  completeSetup: () => void;
  setGithubPAT: (pat: string) => void;
}

function makeDefault(model: string): ProviderConfig {
  return { apiKey: '', model, temperature: 0.7, topP: 0.9, maxTokens: 4096 };
}

const defaultProviders: Record<Provider, ProviderConfig> = {
  lovable: makeDefault('google/gemini-3-flash-preview'),
  openai: makeDefault('gpt-4o'),
  anthropic: makeDefault('claude-sonnet-4-20250514'),
  google: makeDefault('gemini-2.5-flash-preview-05-20'),
  xai: makeDefault('grok-3-mini'),
  groq: makeDefault('llama-3.3-70b-versatile'),
  deepseek: makeDefault('deepseek-chat'),
  mistral: makeDefault('mistral-large-latest'),
  together: makeDefault('meta-llama/Llama-3.3-70B-Instruct-Turbo'),
  minimax: makeDefault('MiniMax-M2.5'),
  'minimax-payg': makeDefault('MiniMax-M2.5'),
  kimi: makeDefault('kimi-k2-0711-preview'),
  cerebras: makeDefault('llama-3.3-70b'),
  openrouter: makeDefault('openai/gpt-oss-120b:free'),
  sambanova: makeDefault('Meta-Llama-3.3-70B-Instruct'),
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      activeProvider: 'lovable',
      providers: defaultProviders,
      theme: 'system',
      fontSize: 'medium',
      defaultSystemPrompt: 'You are a helpful assistant.',
      isSetupComplete: false,
      githubPAT: '',

      setActiveProvider: (p) => set({ activeProvider: p }),
      updateProviderConfig: (p, config) =>
        set((state) => ({
          providers: {
            ...state.providers,
            [p]: { ...state.providers[p], ...config },
          },
        })),
      setTheme: (t) => set({ theme: t }),
      setFontSize: (f) => set({ fontSize: f }),
      setDefaultSystemPrompt: (s) => set({ defaultSystemPrompt: s }),
      completeSetup: () => set({ isSetupComplete: true }),
      setGithubPAT: (pat) => set({ githubPAT: pat }),
    }),
    {
      name: 'cloudchat-settings',
      version: 4,
      migrate: (persisted: any, version: number) => {
        const state = persisted as any;
        if (version < 3) {
          const existing = state?.providers || {};
          state.providers = { ...defaultProviders, ...existing };
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
        return state;
      },
    }
  )
);
