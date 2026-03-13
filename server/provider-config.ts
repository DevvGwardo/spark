import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent } from 'undici';

type ReasoningEffort = 'low' | 'medium' | 'high';

export const HERMES_TOOL_CAPABLE_MODELS = [
  'meta-llama/llama-4-maverick',
  'openai/gpt-4.1-mini',
  'google/gemini-2.5-flash',
] as const;

// Disable body timeout for streaming LLM responses — models can pause for
// extended periods during reasoning or tool execution, which triggers
// undici's default 300s body timeout (UND_ERR_BODY_TIMEOUT).
const streamingDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });
const streamingFetch: typeof globalThis.fetch = (input, init) =>
  fetch(input, {
    ...init,
    dispatcher: streamingDispatcher,
  });

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
  hermes: process.env.HERMES_BRIDGE_URL || 'http://localhost:3002/v1',
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
  hermes: HERMES_TOOL_CAPABLE_MODELS[0],
};

export function resolveRuntimeProvider(
  provider: string,
  options?: { activeRepo?: unknown }
): string {
  return provider;
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

export function createProviderModel(
  provider: string,
  model: string,
  apiKey: string,
  options?: { origin?: string; extraHeaders?: Record<string, string> }
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
    headers: getProviderHeaders(provider, options?.origin, options?.extraHeaders),
    fetch: createProviderFetch(provider),
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
