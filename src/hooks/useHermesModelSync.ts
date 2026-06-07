import { useEffect } from 'react';
import { useHermesProviders } from '@/hooks/useHermesProviders';
import { useHermesStore } from '@/stores/hermes-store';
import { useSettingsStore } from '@/stores/settings-store';

/**
 * Keeps Spark's hermes model in sync with the agent's CLI-configured default
 * (config.yaml `model.default`, surfaced by the bridge as `/v1/providers`
 * default_model). While `followAgentModel` is true the app mirrors the CLI
 * model and re-syncs when it changes in the terminal; an explicit in-app pick
 * turns it off. Mount once near the app root.
 */
export function useHermesModelSync(): void {
  const activeProvider = useSettingsStore((s) => s.activeProvider);
  const hermesModel = useSettingsStore((s) => s.providers.hermes.model);
  const updateProviderConfig = useSettingsStore((s) => s.updateProviderConfig);
  const followAgentModel = useHermesStore((s) => s.followAgentModel);
  const { defaultModel, reload } = useHermesProviders(activeProvider === 'hermes');

  // Adopt the agent's CLI model while following it.
  useEffect(() => {
    if (!followAgentModel || !defaultModel || hermesModel === defaultModel) return;
    updateProviderConfig('hermes', { model: defaultModel });
  }, [followAgentModel, defaultModel, hermesModel, updateProviderConfig]);

  // Re-check the agent's model when the window regains focus, so a model change
  // made in the terminal shows up without restarting Spark.
  useEffect(() => {
    if (activeProvider !== 'hermes') return;
    const onFocus = () => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [activeProvider, reload]);
}
