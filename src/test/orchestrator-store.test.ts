import { describe, expect, it } from 'vitest';
import { useOrchestratorStore } from '@/stores/orchestrator-store';

describe('orchestrator store defaults', () => {
  it('has sensible defaults with no dual-provider config', () => {
    const state = useOrchestratorStore.getState();

    expect(state.enabled).toBe(true);
    expect(state.maxSubAgents).toBe(6);
    // No planning/coding provider fields — uses active chat provider
    expect(state).not.toHaveProperty('planningProvider');
    expect(state).not.toHaveProperty('codingProvider');
  });

  it('migrates legacy dual-provider state to simplified store', async () => {
    const migrate = useOrchestratorStore.persist.getOptions().migrate;
    const migrated = await migrate?.({
      enabled: true,
      planningFollowsActiveProvider: true,
      planningProvider: 'openai',
      planningModel: 'gpt-5.4',
      codingProvider: 'anthropic',
      codingModel: 'claude-sonnet-4-5-20250929',
      maxSubAgents: 4,
    }, 6);

    expect(migrated).toMatchObject({
      enabled: true,
      maxSubAgents: 4,
    });
    // Dual-provider fields should be dropped
    expect(migrated).not.toHaveProperty('planningProvider');
    expect(migrated).not.toHaveProperty('codingProvider');
  });
});
