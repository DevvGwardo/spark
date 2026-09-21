import { describe, expect, it } from 'vitest';
import {
  formatTokens,
  getModelContextWindow,
  getModelContextWindowByPrefix,
} from '@/lib/tokens';

describe('formatTokens', () => {
  it('formats thousands with one decimal and lowercase k', () => {
    expect(formatTokens(31_400)).toBe('31.4k');
    expect(formatTokens(51_200)).toBe('51.2k');
  });

  it('trims a trailing .0', () => {
    expect(formatTokens(128_000)).toBe('128k');
    expect(formatTokens(1_000)).toBe('1k');
  });

  it('formats millions with M', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });

  it('leaves sub-thousand counts as integers', () => {
    expect(formatTokens(512)).toBe('512');
    expect(formatTokens(0)).toBe('0');
  });

  it('handles non-finite / negative input defensively', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(-5)).toBe('0');
  });
});

describe('context window lookup (prefix table)', () => {
  it('resolves providers/models from providers.ts', () => {
    // OpenAI / GPT-5 family
    expect(getModelContextWindowByPrefix('gpt-5.4')).toBe(128_000);
    expect(getModelContextWindowByPrefix('gpt-5.2-codex')).toBe(128_000);
    expect(getModelContextWindowByPrefix('openai/gpt-5-mini')).toBe(128_000);
    expect(getModelContextWindowByPrefix('openai/gpt-oss-120b')).toBe(128_000);
    expect(getModelContextWindowByPrefix('openai/gpt-oss-120b:free')).toBe(128_000);
    // Anthropic
    expect(getModelContextWindowByPrefix('claude-opus-4-7')).toBe(200_000);
    expect(getModelContextWindowByPrefix('claude-sonnet-4-5-20250929')).toBe(200_000);
    expect(getModelContextWindowByPrefix('anthropic/claude-sonnet-4')).toBe(200_000);
    // Google Gemini
    expect(getModelContextWindowByPrefix('gemini-2.5-flash')).toBe(1_000_000);
    expect(getModelContextWindowByPrefix('gemini-2.5-flash-lite')).toBe(1_000_000);
    expect(getModelContextWindowByPrefix('gemini-2.0-flash-001')).toBe(1_000_000);
    expect(getModelContextWindowByPrefix('google/gemini-3.1-flash-lite-preview')).toBe(1_000_000);
    // xAI
    expect(getModelContextWindowByPrefix('grok-4-fast-reasoning')).toBe(131_072);
    expect(getModelContextWindowByPrefix('grok-code-fast-1')).toBe(131_072);
    // DeepSeek (longest prefix wins)
    expect(getModelContextWindowByPrefix('deepseek/deepseek-chat-v3.1')).toBe(128_000);
    expect(getModelContextWindowByPrefix('deepseek/deepseek-chat')).toBe(64_000);
    expect(getModelContextWindowByPrefix('deepseek-chat')).toBe(64_000);
    // Mistral / Llama / Qwen
    expect(getModelContextWindowByPrefix('mistral-large-latest')).toBe(128_000);
    expect(getModelContextWindowByPrefix('mistral-small-latest')).toBe(32_000);
    expect(getModelContextWindowByPrefix('meta-llama/llama-3.3-70b-instruct:free')).toBe(128_000);
    expect(getModelContextWindowByPrefix('meta-llama/llama-4-scout')).toBe(1_000_000);
    expect(getModelContextWindowByPrefix('Qwen/Qwen2.5-72B-Instruct-Turbo')).toBe(32_768);
    expect(getModelContextWindowByPrefix('qwen/qwen3-coder:free')).toBe(128_000);
    // MiniMax / Kimi / GLM
    expect(getModelContextWindowByPrefix('MiniMax-M2.5-highspeed')).toBe(1_000_000);
    expect(getModelContextWindowByPrefix('MiniMax-M2')).toBe(200_000);
    expect(getModelContextWindowByPrefix('kimi-k2-0711-preview')).toBe(131_072);
    expect(getModelContextWindowByPrefix('moonshot-v1-32k')).toBe(32_000);
    expect(getModelContextWindowByPrefix('glm-5-plus')).toBe(128_000);
  });

  it('falls back to the 128k default for unknown models', () => {
    expect(getModelContextWindowByPrefix('totally-unknown-model')).toBe(128_000);
    expect(getModelContextWindowByPrefix('')).toBe(128_000);
  });

  it('keeps exact-name entries from the legacy table winning', () => {
    // 'mixtral-8x7b-32768' is in the exact table (32k) but has no prefix row.
    expect(getModelContextWindow('mixtral-8x7b-32768')).toBe(32_768);
  });

  it('getModelContextWindow falls back to prefix resolution', () => {
    expect(getModelContextWindow('gpt-5.9-future')).toBe(128_000);
    expect(getModelContextWindow('gemini-2.5-pro')).toBe(2_097_152);
  });
});
