// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_CONTEXT_WINDOW, getModelContextWindow } from '../model-context';
import { buildUsageEvent } from '../lib/usage-events';

describe('getModelContextWindow', () => {
  it('resolves known models from provider-config', () => {
    expect(getModelContextWindow('claude-sonnet-4')).toBe(200_000);
    expect(getModelContextWindow('gpt-5.4')).toBe(400_000);
    expect(getModelContextWindow('gemini-2.5-pro')).toBe(2_097_152);
    expect(getModelContextWindow('deepseek-chat')).toBe(128_000);
  });

  it('strips provider prefixes (openrouter-style names)', () => {
    expect(getModelContextWindow('deepseek/deepseek-v3.2')).toBe(128_000);
    expect(getModelContextWindow('anthropic/claude-sonnet-4')).toBe(200_000);
  });

  it('falls back to the contract default for unknown models', () => {
    expect(getModelContextWindow('totally-unknown-model-9000')).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(DEFAULT_MODEL_CONTEXT_WINDOW).toBe(128_000);
  });

  it('falls back for empty/garbage input', () => {
    expect(getModelContextWindow('')).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(getModelContextWindow('  ')).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
  });
});

describe('buildUsageEvent', () => {
  it('emits the contract usage shape with context window + model', () => {
    const event = buildUsageEvent(
      { inputTokens: 120, outputTokens: 30, cachedInputTokens: 40 },
      'gpt-5.4',
    );
    expect(event).toEqual({
      type: 'usage',
      input_tokens: 120,
      output_tokens: 30,
      cached_input_tokens: 40,
      context_window: 400_000,
      model: 'gpt-5.4',
    });
  });

  it('carries the turn cost when the backend priced it (Hermes bridge, spec 4.5)', () => {
    const event = buildUsageEvent(
      { inputTokens: 2000, outputTokens: 350, cachedInputTokens: 800, costUsd: 0.00909 },
      'claude-sonnet-4',
    );
    expect(event.cost_usd).toBe(0.00909);
    // Unpriced or nonsensical costs are left out rather than shown as $0.
    expect(buildUsageEvent({ inputTokens: 1, outputTokens: 1, costUsd: -1 }, 'x')).not.toHaveProperty('cost_usd');
    expect(buildUsageEvent({ inputTokens: 1, outputTokens: 1 }, 'x')).not.toHaveProperty('cost_usd');
  });

  it('defaults missing values to zero and unknown windows to the fallback', () => {
    const event = buildUsageEvent({ inputTokens: 5, outputTokens: 2 }, 'mystery-model');
    expect(event).toEqual({
      type: 'usage',
      input_tokens: 5,
      output_tokens: 2,
      cached_input_tokens: 0,
      context_window: DEFAULT_MODEL_CONTEXT_WINDOW,
      model: 'mystery-model',
    });
  });

  it('never emits negative token counts', () => {
    const event = buildUsageEvent({ inputTokens: -1, outputTokens: NaN }, 'x');
    expect(event.input_tokens).toBe(0);
    expect(event.output_tokens).toBe(0);
  });
});
