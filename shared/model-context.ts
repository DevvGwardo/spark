// ─── Canonical per-model context-window table ────────────────────────────────
// ONE source of truth shared by the server (usage events) and the client
// (context-usage meter). Previously the server (`server/provider-config.ts`) and
// the client (`src/lib/tokens.ts`) each carried their own table with different
// values and different fallbacks, so the same model could report a different
// context window depending on which side asked.
//
// Conflict policy: where a model appeared in both the old server and client
// tables, the server value wins (the server table was the declared
// authoritative source and feeds the `usage` event). Keep this module free of
// server-only imports — it is bundled into the browser too.

/** Fallback context window when a model is not in the table. */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

export const MODEL_CONTEXT_WINDOW_SIZES: Record<string, number> = {
  // Anthropic
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-sonnet-4-5-20250929': 200_000,
  'claude-opus-4': 200_000,
  'claude-opus-4-7': 200_000,
  'claude-haiku-4': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,

  // OpenAI
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-5.4': 400_000,
  'gpt-5.2': 400_000,
  'gpt-5.2-codex': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-5-nano': 128_000,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o3-mini': 200_000,

  // Google Gemini
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-pro': 2_097_152,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-2.5-pro-preview-06-05': 1_000_000,
  'gemini-2.5-flash-preview-05-20': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-1.5-pro': 2_000_000,
  'gemini-3.1-flash-lite-preview': 1_048_576,
  'google/gemini-3-flash-preview': 1_000_000,
  'google/gemini-3.1-pro-preview': 1_000_000,

  // xAI
  'grok-4-fast-reasoning': 1_000_000,
  'grok-code-fast-1': 1_000_000,
  'grok-3': 131_072,
  'grok-3-mini': 131_072,
  'grok-2': 131_072,

  // Groq
  'llama-3.3-70b-versatile': 128_000,
  'llama-3.1-8b-instant': 131_072,
  'mixtral-8x7b-32768': 32_768,
  'gemma2-9b-it': 8_192,

  // DeepSeek (OpenRouter-proxied + direct)
  'deepseek/deepseek-v3.2': 128_000,
  'deepseek/deepseek-chat-v3.1': 128_000,
  'deepseek/deepseek-r1:free': 64_000,
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 64_000,
  'deepseek-ai/DeepSeek-V3': 64_000,

  // Meta Llama (OpenRouter / Together / SambaNova)
  'meta-llama/llama-4-maverick': 128_000,
  'meta-llama/llama-4-scout': 128_000,
  'meta-llama/llama-4-scout:free': 128_000,
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': 128_000,
  'Meta-Llama-3.3-70B-Instruct': 128_000,
  'llama-3.3-70b': 128_000,
  'llama-3.1-8b': 128_000,

  // Mistral
  'mistral-large-latest': 256_000,
  'mistral-small-latest': 256_000,
  'mistral-medium-latest': 32_000,
  'open-mistral-nemo': 128_000,
  'mistralai/Mixtral-8x22B-Instruct-v0.1': 65_536,

  // Qwen
  'Qwen/Qwen2.5-72B-Instruct-Turbo': 32_768,
  'Qwen2.5-72B-Instruct': 32_768,
  'qwen-3-32b': 32_768,
  'qwen/qwen3-32b:free': 32_768,

  // MiniMax
  'MiniMax-M2.7': 4_000_000,
  'MiniMax-M2.7-highspeed': 4_000_000,
  'MiniMax-M2.5': 1_000_000,
  'MiniMax-M2.5-highspeed': 1_000_000,
  'MiniMax-M2.1': 1_000_000,
  'MiniMax-M2.1-highspeed': 1_000_000,
  'MiniMax-M2': 200_000,

  // Kimi / Moonshot
  'kimi-k2.6': 128_000,
  'kimi-k2.5': 128_000,
  'kimi-k2-0711-preview': 131_072,
  'moonshot-v1-128k': 128_000,
  'moonshot-v1-32k': 32_000,
  'moonshot-v1-8k': 8_000,

  // z.ai / GLM
  'glm-5.1': 1_000_000,
  'glm-5': 1_000_000,

  // SambaNova
  'DeepSeek-R1': 64_000,

  // Gemma
  'google/gemma-3-27b-it:free': 8_192,

  // Xiaomi MiMo
  'xiaomi/mimo-v2.5-pro': 200_000,
  'mimo-v2.5-pro': 200_000,
  'mimo-v2.5': 200_000,
};

/**
 * Per-model context-window lookup by model *prefix*, ordered
 * longest-prefix-first. Exact-name entries above always win; this table is the
 * fallback for unknown or newly-rolled model ids (e.g. "gpt-5.3" → gpt-* →
 * 128k).
 */
export const MODEL_CONTEXT_PREFIXES: ReadonlyArray<readonly [prefix: string, window: number]> = [
  // Google Gemini (1M+ windows; gemini-3.x previews also 1M)
  ['google/gemini-', 1_000_000],
  ['gemini-3.1-pro', 1_000_000],
  ['gemini-3.1-flash', 1_000_000],
  ['gemini-2.5', 1_000_000],
  ['gemini-2.0', 1_000_000],
  ['gemini-1.5-pro', 2_000_000],
  ['gemini-1.5', 1_000_000],

  // OpenAI / GPT-5 family + o-series reasoning
  ['openai/gpt-', 128_000],
  ['gpt-', 128_000],
  ['o1-', 200_000],
  ['o1', 200_000],
  ['o3-', 200_000],
  ['o3', 200_000],
  ['o4-', 200_000],
  ['o4', 200_000],

  // Anthropic Claude (200k standard, 1M beta)
  ['anthropic/claude-', 200_000],
  ['claude-', 200_000],

  // xAI Grok
  ['grok-', 131_072],

  // DeepSeek (longest prefix first: v3.x is 128k, plain deepseek-chat is 64k)
  ['deepseek/deepseek-chat-v3', 128_000],
  ['deepseek/deepseek-r1', 64_000],
  ['deepseek/deepseek-v3', 128_000],
  ['deepseek/deepseek-chat', 64_000],
  ['deepseek-chat', 64_000],
  ['deepseek-reasoner', 64_000],
  ['DeepSeek-V3', 64_000],
  ['DeepSeek-R1', 64_000],
  ['deepseek-ai/', 64_000],

  // Mistral
  ['mistral-large', 128_000],
  ['mistral-medium', 32_000],
  ['mistral-small', 32_000],
  ['open-mistral-nemo', 128_000],
  ['mistralai/mixtral', 65_536],
  ['mistralai/mistral-small', 128_000],
  ['mistralai/', 128_000],

  // Meta Llama
  ['meta-llama/llama-4-maverick', 1_000_000],
  ['meta-llama/llama-4-scout', 1_000_000],
  ['meta-llama/llama-3.3', 128_000],
  ['meta-llama/llama-3.1', 131_072],
  ['Meta-Llama-3.3', 128_000],
  ['llama-3.3-70b-versatile', 128_000],
  ['llama-3.1-8b-instant', 131_072],
  ['llama-3.3-70b', 128_000],
  ['llama-3.1-8b', 128_000],
  ['llama-4-', 1_000_000],

  // Qwen
  ['Qwen/Qwen2.5-72B', 32_768],
  ['qwen/qwen3-coder', 128_000],
  ['qwen/qwen3-32b', 32_768],
  ['qwen-3-32b', 32_768],
  ['Qwen2.5-72B', 32_768],
  ['qwen3-next', 128_000],
  ['qwen/', 128_000],

  // OpenAI GPT-OSS (Groq/Cerebras/OpenRouter)
  ['openai/gpt-oss', 128_000],

  // MiniMax
  ['MiniMax-M2.7', 1_000_000],
  ['MiniMax-M2.5', 1_000_000],
  ['MiniMax-M2.1', 1_000_000],
  ['MiniMax-M2', 200_000],

  // Kimi / Moonshot
  ['kimi-k2', 131_072],
  ['kimi-thinking', 131_072],
  ['kimi-for-coding', 131_072],
  ['moonshot-v1-128k', 128_000],
  ['moonshot-v1-32k', 32_000],
  ['moonshot-v1-8k', 8_000],
  ['moonshot-v1', 32_000],

  // z.ai / GLM
  ['glm-5', 128_000],
  ['glm-4', 128_000],

  // Groq free / Cerebras
  ['llama-3.1-', 131_072],

  // Gemma
  ['google/gemma-', 8_192],

  // NVIDIA / others (OpenRouter free tier, default-ish 128k)
  ['nvidia/llama-3.1-nemotron', 131_072],
  ['nousresearch/hermes-3', 131_072],
  ['xiaomi/', 128_000],
  ['anthropic/', 200_000],
];

/**
 * Resolve a model's context window from the prefix table.
 * Longest matching prefix wins; falls back to DEFAULT_MODEL_CONTEXT_WINDOW.
 */
export function getModelContextWindowByPrefix(model: string): number {
  if (!model) return DEFAULT_MODEL_CONTEXT_WINDOW;
  const normalized = model.toLowerCase();
  for (const [prefix, window] of MODEL_CONTEXT_PREFIXES) {
    if (normalized.startsWith(prefix.toLowerCase())) {
      return window;
    }
  }
  return DEFAULT_MODEL_CONTEXT_WINDOW;
}

/**
 * Best-effort per-model context window (in tokens).
 *
 * Resolution order:
 *  1. exact model name
 *  2. short name (strip any `provider/` prefix, e.g. `deepseek/deepseek-v3.2`)
 *  3. model prefix table
 *  4. DEFAULT_MODEL_CONTEXT_WINDOW
 */
export function resolveModelContextWindow(model: string): number {
  if (typeof model !== 'string' || model.trim().length === 0) {
    return DEFAULT_MODEL_CONTEXT_WINDOW;
  }

  if (MODEL_CONTEXT_WINDOW_SIZES[model]) {
    return MODEL_CONTEXT_WINDOW_SIZES[model];
  }

  const shortName = model.includes('/') ? model.split('/').pop()! : model;
  if (MODEL_CONTEXT_WINDOW_SIZES[shortName]) {
    return MODEL_CONTEXT_WINDOW_SIZES[shortName];
  }

  return getModelContextWindowByPrefix(model);
}
