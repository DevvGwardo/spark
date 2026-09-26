// Guards against registry drift: a provider added to one map but forgotten in
// another silently breaks /functions/v1/validate-key ("Unknown provider") and
// model discovery. Keep the allowlist in sync deliberately.
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_COMPATIBLE,
  MODEL_DISCOVERY_URLS,
  OPENAI_COMPATIBLE,
  VALIDATION_MODELS,
} from '../provider-config';

// Providers in OPENAI_COMPATIBLE that are internal-only: used by server features
// (e.g. the Lovable gateway in routes/github.ts) but never selectable by the
// user, so they intentionally have no validate-key / discovery entry.
const INTERNAL_ONLY_PROVIDERS = new Set(['lovable']);

describe('provider registry consistency', () => {
  it('every selectable OpenAI-compatible provider has discovery + validation entries', () => {
    for (const provider of Object.keys(OPENAI_COMPATIBLE)) {
      if (INTERNAL_ONLY_PROVIDERS.has(provider)) continue;
      expect(
        MODEL_DISCOVERY_URLS[provider],
        `MODEL_DISCOVERY_URLS is missing "${provider}"`,
      ).toBeDefined();
      expect(
        VALIDATION_MODELS[provider],
        `VALIDATION_MODELS is missing "${provider}" (validate-key would reject it)`,
      ).toBeDefined();
    }
  });

  it('discovery URLs stay in sync with the canonical base URL', () => {
    for (const [provider, url] of Object.entries(MODEL_DISCOVERY_URLS)) {
      expect(url, `MODEL_DISCOVERY_URLS.${provider} drifted from OPENAI_COMPATIBLE`).toBe(
        OPENAI_COMPATIBLE[provider],
      );
    }
  });

  it('every discovery provider has a validation model for the fallback ping', () => {
    for (const provider of Object.keys(MODEL_DISCOVERY_URLS)) {
      expect(
        VALIDATION_MODELS[provider],
        `MODEL_DISCOVERY_URLS.${provider} has no VALIDATION_MODELS entry`,
      ).toBeDefined();
    }
  });

  it('anthropic is registered as a first-class validation provider', () => {
    expect(ANTHROPIC_COMPATIBLE.anthropic).toBeDefined();
    expect(VALIDATION_MODELS.anthropic).toBeDefined();
  });
});
