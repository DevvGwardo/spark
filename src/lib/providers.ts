import type { Provider } from '@/stores/settings-store';

export type ProviderCategory = 'featured' | 'open-source' | 'specialized';

export interface ProviderInfo {
  id: Provider;
  label: string;
  description: string;
  needsApiKey: boolean;
  baseURL: string;
  models: string[];
  defaultModel: string;
  category: ProviderCategory;
  badge?: string;
}

export const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  featured: 'Featured',
  'open-source': 'Open Source & Fast',
  specialized: 'Specialized',
};

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  lovable: {
    id: 'lovable',
    label: 'Lovable AI',
    description: 'Built-in — no API key needed',
    needsApiKey: false,
    baseURL: 'https://ai.gateway.lovable.dev/v1',
    category: 'featured',
    badge: 'Free',
    models: [
      'google/gemini-3-flash-preview',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro',
      'google/gemini-3.1-pro-preview',
      'openai/gpt-5',
      'openai/gpt-5-mini',
      'openai/gpt-5.2',
    ],
    defaultModel: 'google/gemini-3-flash-preview',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o, o1, o3 models',
    needsApiKey: true,
    baseURL: 'https://api.openai.com/v1',
    category: 'featured',
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'o1',
      'o1-mini',
      'o3-mini',
    ],
    defaultModel: 'gpt-4o',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude Sonnet, Opus & Haiku',
    needsApiKey: true,
    baseURL: 'https://api.anthropic.com/v1',
    category: 'featured',
    models: [
      'claude-sonnet-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
    ],
    defaultModel: 'claude-sonnet-4-20250514',
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    description: 'Gemini 2.5 Pro & Flash',
    needsApiKey: true,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    category: 'featured',
    models: [
      'gemini-2.5-pro-preview-06-05',
      'gemini-2.5-flash-preview-05-20',
      'gemini-2.0-flash',
      'gemini-1.5-pro',
    ],
    defaultModel: 'gemini-2.5-flash-preview-05-20',
  },
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    description: 'Grok-2 & Grok-3',
    needsApiKey: true,
    baseURL: 'https://api.x.ai/v1',
    category: 'featured',
    models: [
      'grok-3',
      'grok-3-mini',
      'grok-2',
    ],
    defaultModel: 'grok-3-mini',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    description: 'Ultra-fast Llama & Mixtral',
    needsApiKey: true,
    baseURL: 'https://api.groq.com/openai/v1',
    category: 'open-source',
    badge: 'Fast',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
    ],
    defaultModel: 'llama-3.3-70b-versatile',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'V3 & R1 reasoning',
    needsApiKey: true,
    baseURL: 'https://api.deepseek.com',
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
    baseURL: 'https://api.mistral.ai/v1',
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
    baseURL: 'https://api.together.xyz/v1',
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
    description: 'Coding Plan — Anthropic-compatible API',
    needsApiKey: true,
    baseURL: 'https://api.minimax.io/anthropic',
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
    description: 'Standard API — OpenAI-compatible',
    needsApiKey: true,
    baseURL: 'https://api.minimax.chat/v1',
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
    description: 'K2 long context MoE',
    needsApiKey: true,
    baseURL: 'https://api.moonshot.cn/v1',
    category: 'specialized',
    models: [
      'kimi-k2-0711-preview',
      'moonshot-v1-128k',
      'moonshot-v1-32k',
      'moonshot-v1-8k',
    ],
    defaultModel: 'kimi-k2-0711-preview',
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras',
    description: 'Ultra-fast free inference',
    needsApiKey: true,
    baseURL: 'https://api.cerebras.ai/v1',
    category: 'open-source',
    badge: 'Free',
    models: [
      'llama-3.3-70b',
      'llama-3.1-8b',
      'qwen-3-32b',
    ],
    defaultModel: 'llama-3.3-70b',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Free models from multiple providers',
    needsApiKey: true,
    baseURL: 'https://openrouter.ai/api/v1',
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
    baseURL: 'https://api.sambanova.ai/v1',
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
  'lovable', 'openai', 'anthropic', 'google', 'xai',
  'groq', 'cerebras', 'openrouter', 'sambanova',
  'deepseek', 'mistral', 'together', 'minimax', 'minimax-payg', 'kimi',
];

export function getProviderLabel(provider: Provider): string {
  return PROVIDERS[provider]?.label || provider;
}
