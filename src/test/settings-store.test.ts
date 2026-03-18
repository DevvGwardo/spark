import { describe, expect, it } from 'vitest';
import { normalizePersistedSettingsState, useSettingsStore } from '@/stores/settings-store';

describe('normalizePersistedSettingsState', () => {
  it('deep-merges persisted provider config with defaults', () => {
    const normalized = normalizePersistedSettingsState({
      activeProvider: 'hermes',
      providers: {
        hermes: {
          model: 'custom/hermes-model',
        },
        openai: {
          apiKey: 'sk-test',
        },
      },
      availableModels: {
        hermes: ['custom/hermes-model', 'custom/hermes-model', ''],
      },
    } as never);

    expect(normalized.activeProvider).toBe('hermes');
    expect(normalized.providers.hermes).toMatchObject({
      apiKey: '',
      model: 'custom/hermes-model',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 32768,
      reasoningEffort: 'high',
    });
    expect(normalized.providers.openai.apiKey).toBe('sk-test');
    expect(normalized.providers.openclaw.model).toBe('default');
    expect(normalized.availableModels.hermes).toBeUndefined();
  });

  it('falls back to defaults for invalid persisted values', () => {
    const normalized = normalizePersistedSettingsState({
      activeProvider: 'lovable',
      defaultSystemPrompt: 12,
      githubPAT: null,
      theme: 'neon',
      fontSize: 'huge',
      fontFamily: 'comic-sans',
      autoApproveRepoChanges: 'yes',
    } as never);

    expect(normalized.activeProvider).toBe('openai');
    expect(normalized.defaultSystemPrompt).toBe('You are a helpful assistant.');
    expect(normalized.githubPAT).toBe('');
    expect(normalized.theme).toBe('system');
    expect(normalized.fontSize).toBe('medium');
    expect(normalized.fontFamily).toBe('inter');
    expect(normalized.autoApproveRepoChanges).toBe(false);
  });

  it('uses the tool-capable Hermes default model', () => {
    const normalized = normalizePersistedSettingsState(undefined);

    expect(normalized.providers.hermes.model).toBe('meta-llama/llama-4-maverick');
    expect(normalized.providers.openai.model).toBe('gpt-5.4');
    expect(normalized.providers.openai.maxTokens).toBe(32768);
  });

  it('migrates the legacy Hermes default model forward', async () => {
    const migrate = useSettingsStore.persist.getOptions().migrate;
    const migrated = await migrate?.({
      providers: {
        hermes: {
          model: 'nousresearch/hermes-3-llama-3.1-405b:free',
        },
      },
      availableModels: {
        hermes: ['custom/hermes-model'],
      },
    } as never, 13);

    expect((migrated as ReturnType<typeof normalizePersistedSettingsState>).providers.hermes.model)
      .toBe('meta-llama/llama-4-maverick');
    expect((migrated as ReturnType<typeof normalizePersistedSettingsState>).availableModels.hermes)
      .toBeUndefined();
  });

  it('upgrades legacy default OpenAI presets to gpt-5.4 with a larger token budget', async () => {
    const migrate = useSettingsStore.persist.getOptions().migrate;
    const migrated = await migrate?.({
      providers: {
        openai: {
          model: 'gpt-5.2',
          maxTokens: 16384,
        },
      },
    } as never, 15);

    expect((migrated as ReturnType<typeof normalizePersistedSettingsState>).providers.openai.model)
      .toBe('gpt-5.4');
    expect((migrated as ReturnType<typeof normalizePersistedSettingsState>).providers.openai.maxTokens)
      .toBe(32768);
  });
});
