import type { Express } from 'express';
import {
  ANTHROPIC_COMPATIBLE,
  getProviderHeaders,
  OPENAI_COMPATIBLE,
} from '../provider-config';
import { getProfileFromRequest } from '../lib/hermes-profiles';
import { sendJson } from '../lib/helpers';
import { getUnknownErrorMessage } from '../lib/github-utils';
import {
  buildCompactionMessages,
  estimateTokens,
  normalizeCompactionThreshold,
  COMPACTION_SYSTEM_PROMPT,
  type CompactionMessage,
} from '../lib/compaction';

// Summarizing a long conversation is a big single generation; give it more room
// than an ordinary provider call, but still bound it so a hung upstream cannot
// hold the request open forever.
const COMPACTION_TIMEOUT_MS = 120_000;
const COMPACTION_MAX_TOKENS = 4096;

/** Authorization scheme prefix, kept out of the template literal. */
const AUTH_SCHEME = 'Bearer';

function extractAnthropicText(data: unknown): string {
  const content = (data as { content?: Array<{ type?: string; text?: string }> })?.content;
  return content?.find((part) => part.type === 'text')?.text || '';
}

function extractOpenAiText(data: unknown): string {
  const choice = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0];
  const content = choice?.message?.content;
  return typeof content === 'string' ? content : '';
}

/** Coerce the client's message array into the summarizer's input shape. */
function toCompactionMessages(raw: unknown): CompactionMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((message): message is Record<string, unknown> => !!message && typeof message === 'object')
    .map((message) => {
      const role = typeof message.role === 'string' ? message.role : 'user';
      const content =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.parts)
            ? (message.parts as Array<{ type?: string; text?: string }>)
                .filter((part) => part?.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('\n')
            : '';
      return { role, content };
    })
    .filter((message) => message.content.trim().length > 0);
}

// ─── /functions/v1/compact ────────────────────────────────────────────────────
// Summarizes a conversation into a dense handoff so the client can replace an
// over-full history with a single message and keep going. Mirrors the
// auto-compaction [CC] performs when the context window fills up.

export function registerCompactRoute(app: Express): void {
  app.post('/functions/v1/compact', async (req, res) => {
    try {
      const {
        messages: rawMessages,
        provider,
        model,
        api_key,
        threshold,
      } = (req.body ?? {}) as {
        messages?: unknown;
        provider?: string;
        model?: string;
        api_key?: string;
        threshold?: unknown;
      };

      const messages = toCompactionMessages(rawMessages);
      if (messages.length === 0) {
        return sendJson(res, 400, { error: 'messages is required' });
      }
      if (!provider) {
        return sendJson(res, 400, { error: 'provider is required' });
      }
      if (!model) {
        return sendJson(res, 400, { error: 'model is required' });
      }

      const resolvedThreshold = normalizeCompactionThreshold(threshold);
      const tokensBefore = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
      const summarizerMessages = buildCompactionMessages(messages);

      let summary = '';

      if (provider === 'anthropic') {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        };
        if (api_key) headers['x-api-key'] = api_key;

        const response = await fetch(`${ANTHROPIC_COMPATIBLE.anthropic}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            max_tokens: COMPACTION_MAX_TOKENS,
            temperature: 0.2,
            system: COMPACTION_SYSTEM_PROMPT,
            messages: summarizerMessages.map((message) => ({
              role: message.role === 'assistant' ? 'assistant' : 'user',
              content: message.content,
            })),
          }),
          signal: AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          return sendJson(res, response.status, { error: `Anthropic API error: ${errorBody}` });
        }
        summary = extractAnthropicText(await response.json());
      } else {
        const baseUrl = OPENAI_COMPATIBLE[provider];
        if (!baseUrl) {
          return sendJson(res, 400, { error: `Unsupported provider: ${provider}` });
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(api_key ? { Authorization: `${AUTH_SCHEME} ${api_key}` } : {}),
          ...getProviderHeaders(provider),
          ...(provider === 'hermes' ? { 'X-Hermes-Execution-Mode': 'agent-loop' } : {}),
          ...(provider === 'hermes' ? { 'X-Hermes-Profile': getProfileFromRequest(req) } : {}),
        };

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            stream: false,
            temperature: 0.2,
            max_tokens: COMPACTION_MAX_TOKENS,
            messages: [
              { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
              ...summarizerMessages,
            ],
          }),
          signal: AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          return sendJson(res, response.status, { error: `Provider API error: ${errorBody}` });
        }
        summary = extractOpenAiText(await response.json());
      }

      const trimmed = summary.trim();
      if (!trimmed) {
        return sendJson(res, 502, { error: 'Provider returned an empty summary' });
      }

      return sendJson(res, 200, {
        summary: trimmed,
        tokensBefore,
        tokensAfter: estimateTokens(trimmed),
        threshold: resolvedThreshold,
      });
    } catch (err: unknown) {
      const message = getUnknownErrorMessage(err) || 'Compaction failed';
      return sendJson(res, 500, { error: message });
    }
  });
}
