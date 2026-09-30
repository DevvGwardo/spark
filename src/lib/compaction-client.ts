import { getApiBaseUrl } from './api';

/**
 * Client half of auto-compaction.
 *
 * When the context window fills up the client asks the server to summarize the
 * conversation (`POST /functions/v1/compact`) and then replaces its history with
 * the returned summary, so the next turn starts from a dense handoff instead of
 * an over-full transcript. The decision to compact is made by
 * `shared/compaction.ts` against the live `usage` event.
 */

/** Bound the request: summarizing is a big generation but must not hang forever. */
const COMPACTION_TIMEOUT_MS = 180_000;

/** Marker prefix so the replacement message is recognizable in the transcript. */
export const COMPACTION_SUMMARY_PREFIX = 'Conversation summary (auto-compacted)';

export interface CompactionRequestInput {
  provider: string;
  model: string;
  apiKey?: string;
  /** Conversation messages to summarize, oldest first. */
  messages: Array<{ role: string; content: string }>;
  /** Optional override of the compaction threshold recorded by the server. */
  threshold?: number;
  signal?: AbortSignal;
}

export interface CompactionResult {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  threshold: number;
}

function abortAfter(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Summarize a conversation. Throws with the server's message on failure so the
 * caller can surface it and leave the history untouched.
 */
export async function requestCompaction(input: CompactionRequestInput): Promise<CompactionResult> {
  const { provider, model, apiKey, messages, threshold, signal } = input;

  const response = await fetch(`${getApiBaseUrl()}/functions/v1/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      provider,
      model,
      ...(apiKey ? { api_key: apiKey } : {}),
      ...(typeof threshold === 'number' ? { threshold } : {}),
    }),
    signal: signal ?? abortAfter(COMPACTION_TIMEOUT_MS),
  });

  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body — fall through to the status-based error below.
  }

  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string' && data.error
        ? data.error
        : `Compaction failed (${response.status})`,
    );
  }

  const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
  if (!summary) {
    throw new Error('Compaction returned an empty summary');
  }

  return {
    summary,
    tokensBefore: typeof data.tokensBefore === 'number' ? data.tokensBefore : 0,
    tokensAfter: typeof data.tokensAfter === 'number' ? data.tokensAfter : 0,
    threshold: typeof data.threshold === 'number' ? data.threshold : 0,
  };
}

/**
 * Build the single replacement message that stands in for the compacted
 * history. The summary is embedded verbatim so nothing the model wrote is lost.
 */
export function buildCompactionSummaryMessage(summary: string): { role: 'user'; content: string } {
  return {
    role: 'user',
    content: `${COMPACTION_SUMMARY_PREFIX}:\n\n${summary.trim()}`,
  };
}
