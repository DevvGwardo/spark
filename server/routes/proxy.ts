import type { Express } from 'express';
import { OPENAI_COMPATIBLE } from '../provider-config';
import { bindClientDisconnect } from '../http-disconnect';
import { normalizeChatMessages } from '../message-normalization';
import { getCorsOrigin, sendJson } from '../lib/helpers';
import { getUnknownErrorMessage } from '../lib/github-utils';

// ─── /functions/v1/chat-proxy ────────────────────────────────────────────────

interface ChatProxyRequest {
  provider: 'minimax' | 'minimax-payg' | 'kimi' | 'kimi-coding';
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  api_key: string;
  system_prompt?: string;
}

/** Timeout for the initial upstream fetch (60 s). */
const FETCH_TIMEOUT_MS = 60_000;

/** Maximum size for the raw response accumulator (1 MB). */
const MAX_RAW_ACCUMULATOR_SIZE = 1_048_576;

const PROVIDER_URLS: Record<string, string> = {
  kimi: 'https://api.moonshot.cn/v1/chat/completions',
  'kimi-coding': 'https://api.kimi.com/coding/v1/chat/completions',
};

const DEFAULT_MAX_TOKENS: Partial<Record<string, number>> = {
  'kimi-coding': 32768,
};

const PROVIDER_LABELS: Record<string, string> = {
  minimax: 'MiniMax',
  'minimax-payg': 'MiniMax',
  kimi: 'Kimi',
  'kimi-coding': 'Kimi Coding',
};

async function proxyProviderRequest(body: ChatProxyRequest): Promise<Response> {
  const messages = normalizeChatMessages(body.messages, body.system_prompt).messages;

  const url = PROVIDER_URLS[body.provider]
    ?? `${OPENAI_COMPATIBLE[body.provider]}/chat/completions`;

  const payload = {
    model: body.model,
    messages,
    temperature: body.temperature ?? 0.7,
    top_p: body.top_p ?? 0.9,
    max_tokens: body.max_tokens ?? (DEFAULT_MAX_TOKENS[body.provider] || 4096),
    stream: true,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${body.api_key}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const label = PROVIDER_LABELS[body.provider] || body.provider;
    throw new Error(`${label} API error (${response.status}): ${errorText}`);
  }

  return response;
}

export function registerProxyRoute(app: Express) {

app.post('/functions/v1/chat-proxy', async (req, res) => {
  try {
    const body: ChatProxyRequest = req.body;

    if (!body.api_key) {
      return sendJson(res, 400, { error: 'API key is required' });
    }

    if (!body.provider || !['minimax', 'minimax-payg', 'kimi', 'kimi-coding'].includes(body.provider)) {
      return sendJson(res, 400, {
        error: 'Invalid provider. Use "minimax", "minimax-payg", "kimi", or "kimi-coding".',
      });
    }

    const upstreamResponse = await proxyProviderRequest(body);

    if (!upstreamResponse.body) {
      const text = await upstreamResponse.text();
      console.warn('[chat-proxy] No response body from provider:', text);
      return sendJson(res, 502, {
        error: 'No response body from provider',
        details: text,
      });
    }

    // Set SSE headers (guard against double-send if an earlier path already responded)
    if (res.headersSent) {
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req.headers.origin));

    // Parse and re-emit SSE stream
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedAnyContent = false;
    let rawAccumulator = '';

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!receivedAnyContent && rawAccumulator.trim()) {
              console.warn('[chat-proxy] No SSE content received. Raw response:', rawAccumulator);
              try {
                const errorJson = JSON.parse(rawAccumulator);
                const errorMsg =
                  errorJson.base_resp?.status_msg ||
                  errorJson.error?.message ||
                  errorJson.message ||
                  'Unknown API error';
                res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
              } catch {
                res.write(
                  `data: ${JSON.stringify({ error: `API returned non-streaming response: ${rawAccumulator.slice(0, 200)}` })}\n\n`
                );
              }
            }
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          const chunk = decoder.decode(value, { stream: true });
          if (rawAccumulator.length < MAX_RAW_ACCUMULATOR_SIZE) {
            rawAccumulator += chunk;
            if (rawAccumulator.length > MAX_RAW_ACCUMULATOR_SIZE) {
              rawAccumulator = rawAccumulator.slice(0, MAX_RAW_ACCUMULATOR_SIZE);
            }
          }
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);

            if (data === '[DONE]') {
              res.write('data: [DONE]\n\n');
              continue;
            }

            try {
              const json = JSON.parse(data);

              if (json.base_resp?.status_code && json.base_resp.status_code !== 0) {
                const errorMsg = json.base_resp.status_msg || 'API error';
                console.warn('[chat-proxy] MiniMax inline error:', errorMsg);
                res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
                receivedAnyContent = true;
                continue;
              }

              const content = json.choices?.[0]?.delta?.content || '';

              if (content) {
                receivedAnyContent = true;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      } catch (err) {
        console.error('SSE stream error:', err);
        res.end();
      }
    };

    bindClientDisconnect(req, res, async () => {
      await reader.cancel().catch(() => {});
    });

    await pump();
  } catch (err: unknown) {
    // Detect fetch timeout (AbortSignal.timeout fires a TimeoutError / AbortError).
    if (
      err instanceof DOMException &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')
    ) {
      if (!res.headersSent) {
        return sendJson(res, 504, { error: 'Upstream provider did not respond in time' });
      }
      return;
    }

    const message = getUnknownErrorMessage(err) || 'Internal server error';
    const status = message.includes('401') ? 401 : message.includes('429') ? 429 : 500;

    if (!res.headersSent) {
      return sendJson(res, status, { error: message });
    }
  }
});

}
