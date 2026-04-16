import type { Express } from 'express';
import {
  ANTHROPIC_COMPATIBLE,
  getProviderHeaders,
  OPENAI_COMPATIBLE,
} from '../provider-config';
import { extractHermesChoiceText } from '../lib/hermes';
import { getHubSelectedProfileName } from '../lib/hermes-profiles';
import { normalizeChatMessages } from '../message-normalization';
import { sendJson } from '../lib/helpers';
import { getUnknownErrorMessage } from '../lib/github-utils';
import { runOpenClawTurn } from '../openclaw';

// ─── /functions/v1/translate ───────────────────────────────────────────────────

function buildTranslationSystemMessage(targetLanguage: string, text: string): string {
  const hasTitleLine = /^\s*Title:/im.test(text);

  return [
    `Translate the following text to ${targetLanguage}.`,
    'Return only the translated text.',
    'Do not explain, narrate, summarize, or add commentary.',
    'Do not add markdown fences, labels, or preambles.',
    hasTitleLine
      ? 'If the input begins with a "Title:" line, preserve that exact structure: output a first line that also begins with "Title:", then a blank line, then the translated body text if any body text exists.'
      : '',
  ].filter(Boolean).join(' ');
}

function stripThinkingTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .trim();
}

function extractTextFromChoice(choice: unknown): string {
  if (!choice || typeof choice !== 'object') {
    return '';
  }

  return extractHermesChoiceText(choice as {
    delta?: { content?: unknown };
    message?: { content?: unknown };
  });
}

function extractTranslationFromSse(responseText: string): string {
  let translated = '';

  for (const rawLine of responseText.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data: ') || line === 'data: [DONE]') {
      continue;
    }

    try {
      const chunk = JSON.parse(line.slice(6)) as {
        choices?: unknown[];
      };
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      const token = extractTextFromChoice(choice);
      if (token) {
        translated += token;
      }
    } catch {
      // Ignore malformed chunks and continue collecting the rest of the stream.
    }
  }

  return stripThinkingTags(translated);
}

function extractTranslationFromJson(responseText: string): string {
  const data = JSON.parse(responseText) as {
    choices?: unknown[];
  };

  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  return stripThinkingTags(extractTextFromChoice(choice));
}

export function registerTranslateRoute(app: Express) {

app.post('/functions/v1/translate', async (req, res) => {
  try {
    const {
      text,
      targetLanguage = 'English',
      provider,
      api_key,
      model,
    } = req.body as {
      text?: string;
      targetLanguage?: string;
      provider?: string;
      api_key?: string;
      model?: string;
    };

    if (!text) {
      return sendJson(res, 400, { error: 'text is required' });
    }
    if (!provider) {
      return sendJson(res, 400, { error: 'provider is required' });
    }
    if (!model) {
      return sendJson(res, 400, { error: 'model is required' });
    }

    const systemMessage = buildTranslationSystemMessage(targetLanguage, text);
    const translatedMessages = normalizeChatMessages(
      [{ role: 'user', content: text }],
      systemMessage,
    ).messages;

    if (provider === 'openclaw') {
      const result = await runOpenClawTurn({
        message: text,
        model,
        sessionId: `translate-${Date.now()}`,
        systemPrompt: systemMessage,
      });

      return sendJson(res, 200, { translated: stripThinkingTags(result.text) });
    }

    // ── Anthropic uses its own messages format ────────────────────────────
    if (provider === 'anthropic') {
      const baseUrl = ANTHROPIC_COMPATIBLE.anthropic;
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': api_key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: 0.3,
          messages: translatedMessages,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        return sendJson(res, response.status, {
          error: `Anthropic API error: ${errorBody}`,
        });
      }

      const data = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const translated =
        data.content?.find((c) => c.type === 'text')?.text || '';
      return sendJson(res, 200, { translated });
    }

    // ── All other providers: OpenAI-compatible format ─────────────────────
    const baseUrl = OPENAI_COMPATIBLE[provider];
    if (!baseUrl) {
      return sendJson(res, 400, {
        error: `Unsupported provider: ${provider}`,
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(api_key ? { Authorization: `Bearer ${api_key}` } : {}),
      ...getProviderHeaders(provider),
      ...(provider === 'hermes' ? { 'X-Hermes-Execution-Mode': 'agent-loop' } : {}),
      ...(provider === 'hermes' ? { 'X-Hermes-Profile': getHubSelectedProfileName() } : {}),
    };

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.3,
        max_tokens: 4096,
        messages: translatedMessages,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return sendJson(res, response.status, {
        error: `Provider API error: ${errorBody}`,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();

    // Some providers (e.g. Hermes bridge) ignore stream:false and return SSE
    const trimmedText = responseText.trimStart();
    if (contentType.includes('text/event-stream') || trimmedText.startsWith('data: ')) {
      return sendJson(res, 200, { translated: extractTranslationFromSse(responseText) });
    }

    // Standard JSON response
    try {
      return sendJson(res, 200, { translated: extractTranslationFromJson(responseText) });
    } catch {
      return sendJson(res, 502, {
        error: 'Provider returned unparseable response',
      });
    }
  } catch (err: unknown) {
    const message = getUnknownErrorMessage(err) || 'Translation failed';
    return sendJson(res, 500, { error: message });
  }
});

}
