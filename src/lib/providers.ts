import type { Provider, ReasoningEffort } from '@/stores/settings-store';

export type ProviderCategory = 'featured' | 'open-source' | 'specialized';

export interface ProviderInfo {
  id: Provider;
  label: string;
  description: string;
  needsApiKey: boolean;
  models: string[];
  defaultModel: string;
  category: ProviderCategory;
  badge?: string;
  supportsOrchestrator?: boolean;
}

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

export const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  featured: 'Featured',
  'open-source': 'Open Source & Fast',
  specialized: 'Specialized',
};

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-5, Codex, and smaller GPT-5 variants',
    needsApiKey: true,
    category: 'featured',
    models: [
      'gpt-5.4',
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5-mini',
      'gpt-5-nano',
    ],
    defaultModel: 'gpt-5.2',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude 4.6, 4.5, and 4-family models',
    needsApiKey: true,
    category: 'featured',
    models: [
      'claude-opus-4-6-20260210',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-20250514',
    ],
    defaultModel: 'claude-sonnet-4-5-20250929',
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    description: 'Gemini 2.5 Pro, Flash, and Flash-Lite',
    needsApiKey: true,
    category: 'featured',
    models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
    ],
    defaultModel: 'gemini-2.5-flash',
  },
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    description: 'Grok 4, fast reasoning, and coding models',
    needsApiKey: true,
    category: 'featured',
    models: [
      'grok-4',
      'grok-4-fast-reasoning',
      'grok-3',
      'grok-code-fast-1',
    ],
    defaultModel: 'grok-4-fast-reasoning',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    description: 'Ultra-fast open models and GPT-OSS',
    needsApiKey: true,
    category: 'open-source',
    badge: 'Fast',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ],
    defaultModel: 'llama-3.3-70b-versatile',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'V3 & R1 reasoning',
    needsApiKey: true,
    category: 'open-source',
    models: [
      'deepseek-chat',
      'deepseek-reasoner',
    ],
    defaultModel: 'deepseek-chat',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    description: 'Large, Medium & Small',
    needsApiKey: true,
    category: 'open-source',
    models: [
      'mistral-large-latest',
      'mistral-medium-latest',
      'mistral-small-latest',
      'open-mistral-nemo',
    ],
    defaultModel: 'mistral-large-latest',
  },
  together: {
    id: 'together',
    label: 'Together AI',
    description: 'Hosted open-source models',
    needsApiKey: true,
    category: 'open-source',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
      'mistralai/Mixtral-8x22B-Instruct-v0.1',
      'deepseek-ai/DeepSeek-V3',
    ],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax (Coding Plan)',
    description: 'Coding Plan — OpenAI-compatible API',
    needsApiKey: true,
    category: 'specialized',
    badge: 'Coding',
    models: [
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ],
    defaultModel: 'MiniMax-M2.5',
  },
  'minimax-payg': {
    id: 'minimax-payg',
    label: 'MiniMax (Pay-as-you-go)',
    description: 'Pay-as-you-go — OpenAI-compatible API',
    needsApiKey: true,
    category: 'specialized',
    models: [
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ],
    defaultModel: 'MiniMax-M2.5',
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    description: 'Moonshot long-context and reasoning models',
    needsApiKey: true,
    category: 'specialized',
    models: [
      'kimi-thinking-preview',
      'moonshot-v1-128k',
      'moonshot-v1-32k',
      'moonshot-v1-8k',
    ],
    defaultModel: 'moonshot-v1-32k',
  },
  'kimi-coding': {
    id: 'kimi-coding',
    label: 'Kimi (Coding Plan)',
    description: 'Coding Plan — OpenAI-compatible API',
    needsApiKey: true,
    category: 'specialized',
    badge: 'Coding',
    models: [
      'kimi-for-coding',
    ],
    defaultModel: 'kimi-for-coding',
  },
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    description: 'Local OpenClaw agent runtime using your configured default model',
    needsApiKey: false,
    category: 'specialized',
    models: [
      'default',
    ],
    defaultModel: 'default',
    supportsOrchestrator: false,
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras',
    description: 'Ultra-fast free inference',
    needsApiKey: true,
    category: 'open-source',
    badge: 'Free',
    models: [
      'llama-3.3-70b',
      'qwen-3-32b',
      'openai/gpt-oss-120b',
      'llama-3.1-8b',
    ],
    defaultModel: 'llama-3.3-70b',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Free models from multiple providers',
    needsApiKey: true,
    category: 'open-source',
    badge: 'Free',
    models: [
      'openai/gpt-oss-120b:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'qwen/qwen3-coder:free',
      'google/gemma-3-27b-it:free',
    ],
    defaultModel: 'openai/gpt-oss-120b:free',
  },
  sambanova: {
    id: 'sambanova',
    label: 'SambaNova',
    description: 'Fast open-source inference',
    needsApiKey: true,
    category: 'open-source',
    badge: 'Free',
    models: [
      'Meta-Llama-3.3-70B-Instruct',
      'Qwen2.5-72B-Instruct',
      'DeepSeek-R1',
    ],
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
  },
};

// Ordered list for UI display
export const PROVIDER_ORDER: Provider[] = [
  'openai', 'anthropic', 'google', 'xai',
  'groq', 'cerebras', 'openrouter', 'sambanova',
  'deepseek', 'mistral', 'together', 'minimax', 'minimax-payg', 'kimi', 'kimi-coding', 'openclaw',
];

export function getProviderLabel(provider: Provider): string {
  return PROVIDERS[provider]?.label || provider;
}

export function supportsReasoningEffort(provider: string, model?: string): boolean {
  if (provider !== 'openai' || !model) {
    return false;
  }

  const normalizedModel = model.toLowerCase();
  return normalizedModel.startsWith('gpt-5') || normalizedModel.startsWith('o');
}
