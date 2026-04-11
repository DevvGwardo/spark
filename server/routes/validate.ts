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

    if (provider === 'hermes') {
      // Hermes bridge handles its own credential fallback
      // If no api_key provided, check if bridge is running with local credentials
      if (!api_key) {
        const bridgeUrl = OPENAI_COMPATIBLE.hermes;
        try {
          const healthUrl = `${bridgeUrl.replace('/v1', '')}/health`;
          const healthResponse = await fetch(healthUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
          });

          if (!healthResponse.ok) {
            return sendJson(res, 503, {
              valid: false,
              error: `Hermes bridge is not reachable at ${bridgeUrl}. Start hermes-bridge/main.py and try again.`,
            });
          }

          const healthData = await healthResponse.json() as {
            has_openrouter_creds?: boolean;
            has_minimax_creds?: boolean;
            hermes_default_model?: string;
            hermes_provider?: string;
          };

          // Use the bridge's configured model if available, fall back to hardcoded list
          const bridgeModel = healthData.hermes_default_model;
          const models = bridgeModel
            ? [bridgeModel, ...HERMES_TOOL_CAPABLE_MODELS.filter(m => m !== bridgeModel)]
            : [...HERMES_TOOL_CAPABLE_MODELS];

          if (!healthData.has_openrouter_creds && !healthData.has_minimax_creds) {
            return sendJson(res, 200, {
              valid: true,
              defaultModel: bridgeModel || models[0],
              models,
              warning: 'Hermes bridge has no API credentials configured. Set HERMES_OPENROUTER_KEY or HERMES_MINIMAX_KEY env var, or configure ~/.openclaw/openclaw.json.',
            });
          }

          return sendJson(res, 200, {
            valid: true,
            defaultModel: bridgeModel || models[0],
            models,
          });
        } catch {
          return sendJson(res, 503, {
            valid: false,
            error: `Hermes bridge is not reachable at ${bridgeUrl}. Start hermes-bridge/main.py and try again.`,
          });
        }
      }

      // If api_key IS provided, validate it via model discovery (original approach)
      const bridgeUrl = OPENAI_COMPATIBLE.hermes;
      const listModelsUrl = `${bridgeUrl}/models`;
      try {
        const modelListResponse = await fetch(listModelsUrl, {
          headers: getModelDiscoveryHeaders(provider, api_key, req.headers.origin),
        });

        if (modelListResponse.ok) {
          // Also fetch health to get the bridge's configured model
          let bridgeModel: string | undefined;
          try {
            const healthUrl2 = `${bridgeUrl.replace('/v1', '')}/health`;
            const hr = await fetch(healthUrl2, { signal: AbortSignal.timeout(3000) });
            if (hr.ok) {
              const hd = await hr.json() as { hermes_default_model?: string };
              bridgeModel = hd.hermes_default_model;
            }
          } catch { /* ignore health fetch failure */ }

          const models = bridgeModel
            ? [bridgeModel, ...HERMES_TOOL_CAPABLE_MODELS.filter(m => m !== bridgeModel)]
            : [...HERMES_TOOL_CAPABLE_MODELS];
          return sendJson(res, 200, {
            valid: true,
            defaultModel: bridgeModel || models[0],
            models,
          });
        }
      } catch {
        // Fall through to error
      }

      return sendJson(res, 503, {
        valid: false,
        error: `Hermes bridge validation failed at ${bridgeUrl}.`,
      });
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
      const modelListResponse = await fetch(listModelsUrl, {
        headers: getModelDiscoveryHeaders(provider, api_key, origin),
      });

      if (modelListResponse.ok) {
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
