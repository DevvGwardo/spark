import { createAnthropic } from '@ai-sdk/anthropic';
import { createCerebras } from '@ai-sdk/cerebras';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel, ProviderMetadata } from 'ai';
import { Agent } from 'undici';
import { getHermesBridgeV1 } from './lib/hermes-bridge-url';

type ReasoningEffort = 'low' | 'medium' | 'high';

export const HERMES_TOOL_CAPABLE_MODELS = [
  // OpenRouter-proxied models
  'anthropic/claude-sonnet-4',
  'google/gemini-3.1-flash-lite-preview',
  'deepseek/deepseek-v3.2',
  'meta-llama/llama-4-maverick',
  'openai/gpt-4.1-mini',
  'google/gemini-2.5-flash',
  'deepseek/deepseek-chat-v3.1',
  'meta-llama/llama-4-scout',
  // MiniMax direct
  'MiniMax-M2.7',
  'MiniMax-M2.7-highspeed',
  // Nous direct
  'nousresearch/hermes-3-llama-3.3-70b',
  // DeepSeek direct
  'deepseek-chat',
  'deepseek-reasoner',
  // Anthropic direct
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-7',
  // Google direct
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  // OpenAI direct
  'gpt-5.4',
  'gpt-5-mini',
  // xAI direct
  'grok-4-fast-reasoning',
  'grok-code-fast-1',
  // Kimi direct
  'kimi-k2.6',
  'kimi-k2.5',
  // Z.AI direct
  'glm-5.1',
  'glm-5',
  // Mistral direct
  'mistral-large-latest',
  'mistral-small-latest',
  // Xiaomi MiMo direct (xiaomimimo.com)
  'xiaomi/mimo-v2.5-pro',
  'mimo-v2.5-pro',
  'mimo-v2.5',
] as const;

// Disable body timeout for streaming LLM responses — models can pause for
// extended periods during reasoning or tool execution, which triggers
// undici's default 300s body timeout (UND_ERR_BODY_TIMEOUT).
const streamingDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });
// Exported so provider paths that bypass createProviderFetch (e.g. the direct
// compatible-provider proxy) can share the same no-body-timeout dispatcher.
export const streamingFetch: typeof globalThis.fetch = (input, init) =>
  fetch(input, {
    ...init,
    dispatcher: streamingDispatcher,
  } as RequestInit & { dispatcher?: unknown });

function shouldSanitizeCompatibleStream(provider: string): boolean {
  return provider === 'minimax' || provider === 'minimax-payg';
}

export function sanitizeCompatibleSseLine(provider: string, line: string): string {
  if (!shouldSanitizeCompatibleStream(provider) || !line.startsWith('data: ')) {
    return line;
  }

  const payload = line.slice(6).trim();
  if (!payload || payload === '[DONE]') {
    return line;
  }

  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{ delta?: { role?: string } }>;
    };

    if (!Array.isArray(parsed.choices)) {
      return line;
    }

    let changed = false;
    const choices = parsed.choices.map((choice) => {
      if (!choice?.delta || choice.delta.role !== '') {
        return choice;
      }

      changed = true;
      return {
        ...choice,
        delta: {
          ...choice.delta,
          role: 'assistant',
        },
      };
    });

    if (!changed) {
      return line;
    }

    return `data: ${JSON.stringify({ ...parsed, choices })}`;
  } catch {
    return line;
  }
}

export function sanitizeCompatibleStream(
  provider: string,
  original: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (!shouldSanitizeCompatibleStream(provider)) {
    return original;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = original.getReader();

      const flushLine = (line: string) => {
        controller.enqueue(encoder.encode(`${sanitizeCompatibleSseLine(provider, line)}\n`));
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.length > 0) {
              const remainingLines = buffer.split('\n');
              for (const line of remainingLines) {
                if (line.length === 0) continue;
                flushLine(line);
              }
            }
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            flushLine(line);
          }
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function createProviderFetch(provider: string): typeof globalThis.fetch {
  if (!shouldSanitizeCompatibleStream(provider)) {
    return streamingFetch;
  }

  return async (input, init) => {
    const response = await streamingFetch(input, init);
    if (!response.body) {
      return response;
    }

    return new Response(sanitizeCompatibleStream(provider, response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

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
  'z-ai': 'https://open.bigmodel.cn/api/paas/v4',
  hermes: getHermesBridgeV1(),
};

export const ANTHROPIC_COMPATIBLE: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
};

const FIRST_PARTY_PROVIDER_IDS = [
  'google',
  'xai',
  'groq',
  'deepseek',
  'mistral',
  'together',
  'cerebras',
] as const;

type FirstPartyProviderId = (typeof FIRST_PARTY_PROVIDER_IDS)[number];

const FIRST_PARTY_PROVIDER_SET = new Set<string>(FIRST_PARTY_PROVIDER_IDS);

type FirstPartyProviderFactory = (options: {
  apiKey: string;
  headers: Record<string, string>;
  fetch: typeof globalThis.fetch;
}) => (model: string) => unknown;

const FIRST_PARTY_PROVIDER_FACTORIES: Record<FirstPartyProviderId, FirstPartyProviderFactory> = {
  google: ({ apiKey, headers, fetch }) => createGoogleGenerativeAI({
    apiKey,
    headers,
    fetch,
  }),
  xai: ({ apiKey, headers, fetch }) => createXai({
    apiKey,
    headers,
    fetch,
  }),
  groq: ({ apiKey, headers, fetch }) => createGroq({
    apiKey,
    headers,
    fetch,
  }),
  deepseek: ({ apiKey, headers, fetch }) => createDeepSeek({
    apiKey,
    headers,
    fetch,
  }),
  mistral: ({ apiKey, headers, fetch }) => createMistral({
    apiKey,
    headers,
    fetch,
  }),
  together: ({ apiKey, headers, fetch }) => createTogetherAI({
    apiKey,
    headers,
    fetch,
  }),
  cerebras: ({ apiKey, headers, fetch }) => createCerebras({
    apiKey,
    headers,
    fetch,
  }),
};

export const MODEL_DISCOVERY_URLS: Partial<Record<string, string>> = {
  openai: OPENAI_COMPATIBLE.openai,
  google: OPENAI_COMPATIBLE.google,
  xai: OPENAI_COMPATIBLE.xai,
  groq: OPENAI_COMPATIBLE.groq,
  deepseek: OPENAI_COMPATIBLE.deepseek,
  mistral: OPENAI_COMPATIBLE.mistral,
  together: OPENAI_COMPATIBLE.together,
  minimax: OPENAI_COMPATIBLE.minimax,
  'minimax-payg': OPENAI_COMPATIBLE['minimax-payg'],
  kimi: OPENAI_COMPATIBLE.kimi,
  'kimi-coding': OPENAI_COMPATIBLE['kimi-coding'],
  cerebras: OPENAI_COMPATIBLE.cerebras,
  openrouter: OPENAI_COMPATIBLE.openrouter,
  sambanova: OPENAI_COMPATIBLE.sambanova,
  'z-ai': OPENAI_COMPATIBLE['z-ai'],
  hermes: OPENAI_COMPATIBLE.hermes,
};

export const VALIDATION_MODELS: Record<string, string> = {
  openai: 'gpt-5.4',
  anthropic: 'claude-opus-4-7',
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
  openrouter: 'meta-llama/llama-3.3-70b-instruct',
  sambanova: 'Meta-Llama-3.3-70B-Instruct',
  'z-ai': 'glm-5-plus',
  hermes: HERMES_TOOL_CAPABLE_MODELS[0],
};

export type HermesExecutionMode = 'passthrough' | 'agent-loop' | 'acp';

export function resolveHermesExecutionMode(_options?: {
  activeRepo?: unknown;
  githubPAT?: string;
}): HermesExecutionMode {
  // ACP transport: drive the REAL hermes-agent via Agent Client Protocol
  // instead of the reimplemented agent loop. The bridge spawns hermes-acp per
  // conversation and streams its tools/approvals through the existing SSE
  // pipeline. This is now the DEFAULT; set HERMES_EXECUTION_MODE=agent-loop
  // to fall back to the legacy in-process loop (or =passthrough for a plain
  // proxy with no tool loop).
  const mode = (process.env.HERMES_EXECUTION_MODE || '').trim().toLowerCase();
  if (mode === 'agent-loop' || mode === 'passthrough') {
    return mode;
  }
  return 'acp';
}

const HERMES_RUNS_TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function isHermesRunsTruthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    return HERMES_RUNS_TRUTHY.has(value.trim().toLowerCase());
  }
  return false;
}

/** Phase 7: opt-in gateway /v1/runs transport (default off). */
export function resolveHermesUseRuns(options?: {
  envEnabled?: boolean;
  headerValue?: string | string[] | undefined;
  bodyValue?: unknown;
}): boolean {
  if (options?.envEnabled) return true;
  const header = options?.headerValue;
  if (Array.isArray(header)) {
    if (header.some((v) => isHermesRunsTruthy(v))) return true;
  } else if (isHermesRunsTruthy(header)) {
    return true;
  }
  return isHermesRunsTruthy(options?.bodyValue);
}

export function resolveRuntimeProvider(
  provider: string,
  _options?: { activeRepo?: unknown }
): string {
  return provider;
}

export function usesFirstPartyProviderSdk(provider: string): boolean {
  return FIRST_PARTY_PROVIDER_SET.has(provider);
}

export function getProviderHeaders(provider: string, origin?: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};

  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = origin || 'https://lovable.app';
    headers['X-Title'] = 'CloudChat';
  }

  if (extra) {
    Object.assign(headers, extra);
  }

  return headers;
}

export function getModelDiscoveryHeaders(
  provider: string,
  apiKey: string,
  origin?: string,
): Record<string, string> {
  const headers = getProviderHeaders(provider, origin);

  if (provider === 'google') {
    return {
      ...headers,
      'x-goog-api-key': apiKey,
    };
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    ...headers,
  };
}

export function createProviderModel(
  provider: string,
  model: string,
  apiKey: string,
  options?: { origin?: string; extraHeaders?: Record<string, string> }
): LanguageModel {
  if (ANTHROPIC_COMPATIBLE[provider]) {
    const anthropic = createAnthropic({
      baseURL: ANTHROPIC_COMPATIBLE[provider],
      apiKey,
      headers: getProviderHeaders(provider, options?.origin, options?.extraHeaders),
      // Same no-body-timeout dispatcher as every other provider path — Anthropic
      // generations can run well past undici's 300s default body timeout.
      fetch: createProviderFetch(provider),
    });
    return anthropic(model) as unknown as LanguageModel;
  }

  if (usesFirstPartyProviderSdk(provider)) {
    const factory = FIRST_PARTY_PROVIDER_FACTORIES[provider as FirstPartyProviderId];
    return factory({
      apiKey,
      headers: getProviderHeaders(provider, options?.origin, options?.extraHeaders),
      fetch: createProviderFetch(provider),
    })(model) as LanguageModel;
  }

  const baseURL = OPENAI_COMPATIBLE[provider];
  if (!baseURL) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const openai = createOpenAI({
    baseURL,
    apiKey,
    headers: getProviderHeaders(provider, options?.origin, options?.extraHeaders),
    fetch: createProviderFetch(provider),
  });

  return openai(model) as unknown as LanguageModel;
}

export interface ReviewProviderResolution {
  provider: string;
  model: string;
  apiKey: string;
}

export function resolveReviewCapableProvider(
  activeProvider: string,
  activeModel: string,
  activeApiKey: string,
  _allProviders?: Record<string, { apiKey: string; model: string }>,
): ReviewProviderResolution | null {
  if (!activeProvider || !activeApiKey) {
    return null;
  }

  return { provider: activeProvider, model: activeModel, apiKey: activeApiKey };
}

/** Providers whose AI SDK adapter accepts a reasoning/thinking option via
 * `providerOptions` (see getReasoningProviderOptions). */
const REASONING_EFFORT_PROVIDERS = new Set(['openai', 'groq', 'xai', 'google']);

export function supportsReasoningEffort(provider: string, model?: string): boolean {
  if (provider === 'openai') {
    if (!model) return false;
    const normalizedModel = model.toLowerCase();
    return normalizedModel.startsWith('gpt-5') || normalizedModel.startsWith('o');
  }

  return REASONING_EFFORT_PROVIDERS.has(provider);
}

// Canonical per-model context-window table now lives in a shared module so the
// server (usage events) and the client (context meter) cannot disagree. The
// previous server-only `getContextWindow` helper (with a conflicting 200_000
// fallback and no callers) was removed; use `getModelContextWindow` from
// ./model-context instead.
export { MODEL_CONTEXT_WINDOW_SIZES as CONTEXT_WINDOW_SIZES } from '../shared/model-context';

/**
 * Maps a requested reasoning effort onto each provider's AI SDK providerOptions
 * shape. Providers that have no effort control (deepseek, anthropic thinking
 * budgets, …) return undefined so the caller can surface that the setting was
 * ignored rather than dropping it silently.
 */
export function getReasoningProviderOptions(
  provider: string,
  model: string,
  reasoningEffort?: string,
): ProviderMetadata | undefined {
  if (!reasoningEffort) {
    return undefined;
  }

  if (
    reasoningEffort !== 'low' &&
    reasoningEffort !== 'medium' &&
    reasoningEffort !== 'high'
  ) {
    return undefined;
  }

  switch (provider) {
    case 'openai':
      return supportsReasoningEffort(provider, model)
        ? { openai: { reasoningEffort: reasoningEffort as ReasoningEffort } }
        : undefined;
    case 'groq':
      return { groq: { reasoningEffort } };
    case 'xai':
      // xAI accepts only 'low' | 'high'.
      return { xai: { reasoningEffort: reasoningEffort === 'low' ? 'low' : 'high' } };
    case 'google':
      return { google: { thinkingConfig: { thinkingLevel: reasoningEffort } } };
    default:
      return undefined;
  }
}
