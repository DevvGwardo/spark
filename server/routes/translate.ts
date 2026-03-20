import type { Express } from 'express';
import {
  ANTHROPIC_COMPATIBLE,
  getProviderHeaders,
  OPENAI_COMPATIBLE,
} from '../provider-config';
import { normalizeChatMessages } from '../message-normalization';
import { sendJson } from '../lib/helpers';
import { getUnknownErrorMessage } from '../lib/github-utils';

// ─── /functions/v1/translate ───────────────────────────────────────────────────

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

    const systemMessage = `Translate the following text to ${targetLanguage}. Output ONLY the direct translation. Do not explain, narrate, or add commentary. Do not include phrases like "Here is the translation" or "This translates to". Just output the translated text exactly as it would read in ${targetLanguage}.`;
    const translatedMessages = normalizeChatMessages(
      [{ role: 'user', content: text }],
      systemMessage,
    ).messages;

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
      let translated = '';
      for (const line of responseText.split('\n')) {
        if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(line.slice(6)) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = chunk.choices?.[0]?.delta?.content;
          if (token) translated += token;
        } catch {
          // skip unparseable lines
        }
      }
      return sendJson(res, 200, { translated: translated.trim() });
    }

    // Standard JSON response
    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      data = JSON.parse(responseText);
    } catch {
      return sendJson(res, 502, {
        error: 'Provider returned unparseable response',
      });
    }
    const translated = data.choices?.[0]?.message?.content?.trim() || '';
    return sendJson(res, 200, { translated });
  } catch (err: unknown) {
    const message = getUnknownErrorMessage(err) || 'Translation failed';
    return sendJson(res, 500, { error: message });
  }
});

}
