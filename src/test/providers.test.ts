import { describe, expect, it } from 'vitest';
import { HERMES_RECOMMENDED_MODELS, PROVIDERS, getVisibleModelOptions } from '@/lib/providers';

describe('provider model options', () => {
  it('limits Hermes selections to the recommended tool-capable models', () => {
    expect(PROVIDERS.hermes.models).toEqual([...HERMES_RECOMMENDED_MODELS]);
  });

  it('does not prepend a saved non-curated model to Hermes selections', () => {
    expect(getVisibleModelOptions('hermes', [...HERMES_RECOMMENDED_MODELS], 'custom/hermes-model'))
      .toEqual([...HERMES_RECOMMENDED_MODELS]);
  });

  it('still prepends saved non-default models for non-Hermes providers', () => {
    expect(getVisibleModelOptions('openai', ['gpt-5.4'], 'custom/openai-model'))
      .toEqual(['custom/openai-model', 'gpt-5.4']);
  });
});
