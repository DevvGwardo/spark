import type { Express } from 'express';
import { generateText } from 'ai';
import {
  createProviderModel,
  getModelDiscoveryHeaders,
  HERMES_TOOL_CAPABLE_MODELS,
  MODEL_DISCOVERY_URLS,
  OPENAI_COMPATIBLE,
  VALIDATION_MODELS,
} from '../provider-config';
import { getOpenClawModels } from '../openclaw';
import { sendJson, validateKeyRateLimiter, getClientIp } from '../lib/helpers';
import { getUnknownErrorMessage, normalizeLocalProviderError } from '../lib/github-utils';

// ─── /functions/v1/validate-key ──────────────────────────────────────────────

export function registerValidateRoute(app: Express) {

app.post('/functions/v1/validate-key', async (req, res) => {
  if (!validateKeyRateLimiter.isAllowed(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Too many requests. Please try again later.' });
  }

  try {
    const { provider, api_key } = req.body;

    if (provider === 'openclaw') {
      const { defaultModel, models } = await getOpenClawModels();
      return sendJson(res, 200, { valid: true, defaultModel, models });
    }

    if (!api_key || !provider) {
      return sendJson(res, 400, { valid: false, error: 'Missing provider or api_key' });
    }

    const validationModel = VALIDATION_MODELS[provider];
    if (!validationModel) {
      return sendJson(res, 400, { valid: false, error: `Unknown provider: ${provider}` });
    }

    const origin = req.headers.origin as string | undefined;
    const discoveryBaseUrl = MODEL_DISCOVERY_URLS[provider];
    const listModelsUrl = discoveryBaseUrl ? `${discoveryBaseUrl}/models` : null;

    if (listModelsUrl) {
      let modelListResponse: Response;
      try {
        modelListResponse = await fetch(listModelsUrl, {
          headers: getModelDiscoveryHeaders(provider, api_key, origin),
        });
      } catch (error) {
        if (provider === 'hermes') {
          return sendJson(res, 503, {
            valid: false,
            error:
              `Hermes bridge is not reachable at ${OPENAI_COMPATIBLE.hermes}. ` +
              'Start hermes-bridge/main.py and try again.',
          });
        }
        throw error;
      }

      if (modelListResponse.ok) {
        if (provider === 'hermes') {
          return sendJson(res, 200, {
            valid: true,
            defaultModel: HERMES_TOOL_CAPABLE_MODELS[0],
            models: [...HERMES_TOOL_CAPABLE_MODELS],
          });
        }

        const data = await modelListResponse.json();
        const models = Array.isArray(data?.data)
          ? (data.data as Array<{ id?: string }>)
              .map((model) => model?.id)
              .filter((modelId: string | undefined): modelId is string => !!modelId)
          : undefined;

        const defaultModel = validationModel;
        return sendJson(res, 200, { valid: true, defaultModel, models });
      }
    }

    const model = createProviderModel(provider, validationModel, api_key, {
      origin,
    });

    await generateText({
      model,
      prompt: 'ping',
      maxTokens: 1,
      temperature: 0,
    });

    return sendJson(res, 200, { valid: true, defaultModel: validationModel, models: undefined });
  } catch (err: unknown) {
    const message = getUnknownErrorMessage(err) || 'Provider validation failed';
    const normalizedProviderError = normalizeLocalProviderError(req.body?.provider, message);
    const status = normalizedProviderError
      ? normalizedProviderError.status
      : /401|403|authentication|unauthorized|invalid api key/i.test(message) ? 401 : 500;
    sendJson(res, status, { valid: false, error: normalizedProviderError?.error || message });
  }
});

}
