import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

type ReasoningEffort = 'low' | 'medium' | 'high';

export const OPENAI_COMPATIBLE: Record<string, string> = {
  lovable: 'https://ai.gateway.lovable.dev/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  xai: 'https://api.x.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  minimax: 'https://api.minimax.io/v1',
  'minimax-payg': 'https://api.minimax.chat/v1',
  kimi: 'https://api.moonshot.cn/v1',
  'kimi-coding': 'https://api.kimi.com/coding/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  sambanova: 'https://api.sambanova.ai/v1',
};

export const ANTHROPIC_COMPATIBLE: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
};

export const VALIDATION_MODELS: Record<string, string> = {
  openai: 'gpt-5.2',
  anthropic: 'claude-sonnet-4-5-20250929',
  google: 'gemini-2.5-flash',
  xai: 'grok-4-fast-reasoning',
  groq: 'llama-3.3-70b-versatile',
  deepseek: 'deepseek-chat',
  mistral: 'mistral-large-latest',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  minimax: 'MiniMax-M2.5',
  'minimax-payg': 'MiniMax-M2.5',
  kimi: 'moonshot-v1-32k',
  'kimi-coding': 'kimi-for-coding',
  cerebras: 'llama-3.3-70b',
  openrouter: 'openai/gpt-oss-120b:free',
  sambanova: 'Meta-Llama-3.3-70B-Instruct',
};

export function getProviderHeaders(provider: string, origin?: string): Record<string, string> {
  if (provider !== 'openrouter') return {};

  return {
    'HTTP-Referer': origin || 'https://lovable.app',
    'X-Title': 'CloudChat',
  };
}

export function createProviderModel(
  provider: string,
  model: string,
  apiKey: string,
  options?: { origin?: string }
) {
  if (ANTHROPIC_COMPATIBLE[provider]) {
    const anthropic = createAnthropic({
      baseURL: ANTHROPIC_COMPATIBLE[provider],
      apiKey,
    });
    return anthropic(model);
  }

  const baseURL = OPENAI_COMPATIBLE[provider];
  if (!baseURL) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const openai = createOpenAI({
    baseURL,
    apiKey,
    compatibility: 'compatible',
    headers: getProviderHeaders(provider, options?.origin),
  });

  return openai(model);
}

export function supportsReasoningEffort(provider: string, model?: string): boolean {
  if (provider !== 'openai' || !model) {
    return false;
  }

  const normalizedModel = model.toLowerCase();
  return normalizedModel.startsWith('gpt-5') || normalizedModel.startsWith('o');
}

export function getReasoningProviderOptions(
  provider: string,
  model: string,
  reasoningEffort?: string,
) {
  if (!supportsReasoningEffort(provider, model) || !reasoningEffort) {
    return undefined;
  }

  if (
    reasoningEffort !== 'low' &&
    reasoningEffort !== 'medium' &&
    reasoningEffort !== 'high'
  ) {
    return undefined;
  }

  return {
    openai: {
      reasoningEffort: reasoningEffort as ReasoningEffort,
    },
  };
}
