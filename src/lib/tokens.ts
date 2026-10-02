import { resolveModelContextWindow } from '../../shared/model-context';

// Canonical per-model context windows now live in `shared/model-context.ts` so
// the client meter and the server `usage` event resolve the SAME window for a
// model. These re-exports preserve the previous public surface of this module.
export {
  getModelContextWindowByPrefix,
  MODEL_CONTEXT_PREFIXES,
} from '../../shared/model-context';

/**
 * Simple token estimator (~4 chars per token for English text).
 * Not exact, but good enough for context window progress bars.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Rough heuristic: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: Array<{ role: string; content?: string; parts?: any[] }>): number {
  return messages.reduce((sum, m) => {
    // Each message has ~4 tokens overhead (role, formatting)
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.parts)
        ? m.parts.filter((p: any) => p && p.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('\n\n')
        : '';
    return sum + 4 + estimateTokens(text);
  }, 3); // 3 tokens for chat format priming
}

export function getContextUsage(
  messages: Array<{ role: string; content?: string; parts?: any[] }>,
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

export function getModelContextWindow(model: string): number {
  return resolveModelContextWindow(model);
}

/**
 * Compact token count for meters, e.g. `formatTokens(31400)` → "31.4k",
 * `formatTokens(1_500_000)` → "1.5M". Trailing ".0" is trimmed ("128k").
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) {
    const value = (tokens / 1_000_000).toFixed(1);
    return `${value.replace(/\.0$/, '')}M`;
  }
  if (tokens >= 1_000) {
    const value = (tokens / 1_000).toFixed(1);
    return `${value.replace(/\.0$/, '')}k`;
  }
  return String(Math.round(tokens));
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/** Per-turn cost: `$0.0123` (four decimals under a dollar so cents stay visible), `$1.23` above. */
export function formatTurnCost(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}
