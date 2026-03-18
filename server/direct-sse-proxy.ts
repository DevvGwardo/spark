import express from 'express';
import { formatDataStreamPart } from 'ai';
import { bindClientDisconnect } from './http-disconnect';

export type ProxyFinishReason = 'stop' | 'length' | 'tool-calls' | 'unknown';

export interface ProxyUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface NormalizedProxyEvent {
  text?: string;
  data?: Record<string, unknown>[];
  finishReason?: ProxyFinishReason;
  usage?: ProxyUsage;
}

interface ProxySseToDataStreamInput {
  req: express.Request;
  res: express.Response;
  upstreamResponse: Response;
  corsHeaders: Record<string, string>;
  normalizePayload: (payload: string) => NormalizedProxyEvent | null;
  emptyTextFallback?: string;
  throwOnEmpty?: string;
  onFirstEvent?: (kind: 'text' | 'data') => void;
}

const EMPTY_USAGE: ProxyUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

async function writeDataStreamChunk(res: express.Response, chunk: string) {
  const ok = res.write(chunk);
  if (!ok) {
    await new Promise<void>((resolve) => res.once('drain', resolve));
  }
}

export function isAbortLikeError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  if (typeof error === 'object') {
    const candidate = error as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';

    if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED') {
      return true;
    }

    if (message === 'terminated' || message.includes('operation was aborted')) {
      return true;
    }

    if (candidate.cause) {
      return isAbortLikeError(candidate.cause);
    }
  }

  return false;
}

function extractSsePayload(eventBlock: string): string | null {
  const lines = eventBlock.split(/\r?\n/);
  const dataLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) {
      continue;
    }
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    dataLines.push(trimmed.slice(5).trimStart());
  }

  if (dataLines.length === 0) {
    return null;
  }

  return dataLines.join('\n');
}

export async function proxySseToDataStream(input: ProxySseToDataStreamInput) {
  if (!input.upstreamResponse.body) {
    throw new Error('Upstream provider returned no response body.');
  }

  input.res.writeHead(200, {
    ...input.corsHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'x-vercel-ai-data-stream': 'v1',
  });

  const decoder = new TextDecoder();
  const reader = input.upstreamResponse.body.getReader();
  let buffer = '';
  let sawVisibleOutput = false;
  let sawDataEvent = false;
  let finishReason: ProxyFinishReason = 'unknown';
  let usage: ProxyUsage = EMPTY_USAGE;
  const disconnect = bindClientDisconnect(input.req, input.res, () => {
    reader.cancel().catch(() => {});
  });

  const flushEventBlock = async (eventBlock: string) => {
    const payload = extractSsePayload(eventBlock);
    if (!payload || payload === '[DONE]') {
      return;
    }

    const normalized = input.normalizePayload(payload);
    if (!normalized) {
      return;
    }

    if (normalized.usage) {
      usage = normalized.usage;
    }

    if (normalized.finishReason) {
      finishReason = normalized.finishReason;
    }

    if (normalized.text) {
      if (!sawVisibleOutput) {
        input.onFirstEvent?.('text');
      }
      sawVisibleOutput = true;
      await writeDataStreamChunk(input.res, formatDataStreamPart('text', normalized.text));
    }

    if (normalized.data && normalized.data.length > 0) {
      if (!sawDataEvent) {
        input.onFirstEvent?.('data');
      }
      sawDataEvent = true;
      await writeDataStreamChunk(input.res, formatDataStreamPart('data', normalized.data));
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const eventBlocks = buffer.split(/\r?\n\r?\n/);
      buffer = eventBlocks.pop() ?? '';

      for (const eventBlock of eventBlocks) {
        await flushEventBlock(eventBlock);
      }
    }

    if (buffer.trim().length > 0) {
      await flushEventBlock(buffer);
    }
  } catch (error) {
    if (disconnect.isDisconnected() && isAbortLikeError(error)) {
      return;
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (!sawVisibleOutput && !sawDataEvent && input.emptyTextFallback) {
    sawVisibleOutput = true;
    await writeDataStreamChunk(input.res, formatDataStreamPart('text', input.emptyTextFallback));
  }

  if (!sawVisibleOutput && !sawDataEvent && input.throwOnEmpty) {
    throw new Error(input.throwOnEmpty);
  }

  await writeDataStreamChunk(
    input.res,
    formatDataStreamPart('finish_message', {
      finishReason: finishReason === 'unknown' && (sawVisibleOutput || sawDataEvent) ? 'stop' : finishReason,
      usage,
    }),
  );
  input.res.end();
}
