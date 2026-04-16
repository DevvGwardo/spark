/**
 * Simple token estimator (~4 chars per token for English text).
 * Not exact, but good enough for context window progress bars.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Rough heuristic: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: { role: string; content: string }[]): number {
  return messages.reduce((sum, m) => {
    // Each message has ~4 tokens overhead (role, formatting)
    return sum + 4 + estimateTokens(m.content);
  }, 3); // 3 tokens for chat format priming
}

export function getContextUsage(
  messages: { role: string; content: string }[],
  model: string,
  realUsage?: { promptTokens: number; completionTokens: number; totalTokens: number },
) {
  const total = getModelContextWindow(model);
  const used = realUsage
    ? realUsage.totalTokens
    : messages.length > 0
      ? estimateMessagesTokens(messages)
      : 0;
  const percentage = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  return { used, total, percentage };
}

/**
 * Context window sizes (in tokens) per model.
 * Falls back to provider-level defaults when model isn't listed.
 */
const MODEL_CONTEXT: Record<string, number> = {
  // Lovable AI
  'google/gemini-3-flash-preview': 1_000_000,
  'google/gemini-2.5-flash': 1_000_000,
  'google/gemini-2.5-pro': 1_000_000,
  'google/gemini-3.1-pro-preview': 1_000_000,
  'openai/gpt-5': 128_000,
  'openai/gpt-5.4': 128_000,
  'openai/gpt-5-mini': 128_000,
  'openai/gpt-5.2': 128_000,

  // OpenAI
  'gpt-5.4': 128_000,
  'gpt-5.2': 128_000,
  'gpt-5.2-codex': 128_000,
  'gpt-5-mini': 128_000,
  'gpt-5-nano': 128_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o3-mini': 200_000,

  // Anthropic
  'claude-sonnet-4-20250514': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,

  // Google Gemini
  'gemini-2.5-pro-preview-06-05': 1_000_000,
  'gemini-2.5-flash-preview-05-20': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-1.5-pro': 2_000_000,

  // xAI
  'grok-3': 131_072,
  'grok-3-mini': 131_072,
  'grok-2': 131_072,

  // Groq
  'llama-3.3-70b-versatile': 128_000,
  'llama-3.1-8b-instant': 131_072,
  'mixtral-8x7b-32768': 32_768,
  'gemma2-9b-it': 8_192,

  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,

  // Mistral
  'mistral-large-latest': 128_000,
  'mistral-medium-latest': 32_000,
  'mistral-small-latest': 32_000,
  'open-mistral-nemo': 128_000,

  // Together
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': 128_000,
  'Qwen/Qwen2.5-72B-Instruct-Turbo': 32_768,
  'mistralai/Mixtral-8x22B-Instruct-v0.1': 65_536,
  'deepseek-ai/DeepSeek-V3': 64_000,

  // MiniMax
  'MiniMax-M2.5': 1_000_000,
  'MiniMax-M2.5-highspeed': 1_000_000,
  'MiniMax-M2.1': 1_000_000,
  'MiniMax-M2.1-highspeed': 1_000_000,
  'MiniMax-M2': 200_000,

  // Kimi
  'kimi-k2-0711-preview': 131_072,
  'moonshot-v1-128k': 128_000,
  'moonshot-v1-32k': 32_000,
  'moonshot-v1-8k': 8_000,

  // Cerebras
  'llama-3.3-70b': 128_000,
  'llama-3.1-8b': 128_000,
  'qwen-3-32b': 32_768,

  // OpenRouter
  'deepseek/deepseek-r1:free': 64_000,
  'qwen/qwen3-32b:free': 32_768,
  'meta-llama/llama-4-scout:free': 128_000,
  'google/gemma-3-27b-it:free': 8_192,

  // SambaNova
  'Meta-Llama-3.3-70B-Instruct': 128_000,
  'Qwen2.5-72B-Instruct': 32_768,
  'DeepSeek-R1': 64_000,
};

const DEFAULT_CONTEXT = 128_000;

export function getModelContextWindow(model: string): number {
  return MODEL_CONTEXT[model] ?? DEFAULT_CONTEXT;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}
