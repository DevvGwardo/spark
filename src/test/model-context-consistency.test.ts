// The server usage event and the client context meter must report the same
// window for a model. They previously used separate tables with different
// values (gpt-5.4: 400k vs 128k, grok-4-fast-reasoning: 1M vs 131k, …). Both
// now delegate to shared/model-context.ts; this test fails if either side
// reintroduces a divergent lookup.
import { describe, expect, it } from 'vitest';
import { getModelContextWindow as clientContextWindow } from '@/lib/tokens';
import { getModelContextWindow as serverContextWindow } from '../../server/model-context';

const SAMPLE_MODELS = [
  // Models that previously disagreed between the two tables.
  'gpt-5.4',
  'gemini-2.5-pro',
  'deepseek-chat',
  'mistral-large-latest',
  'grok-4-fast-reasoning',
  // Representative known models.
  'claude-sonnet-4',
  'MiniMax-M2.5',
  'kimi-k2.6',
  'glm-5',
  // OpenRouter-style prefixed ids.
  'deepseek/deepseek-v3.2',
  'anthropic/claude-sonnet-4',
  // Unknown must agree on the fallback too.
  'totally-unknown-model-9000',
];

describe('server/client context-window agreement', () => {
  it('resolves the same window on both sides', () => {
    for (const model of SAMPLE_MODELS) {
      expect(
        serverContextWindow(model),
        `server/client disagree on context window for ${model}`,
      ).toBe(clientContextWindow(model));
    }
  });
});
