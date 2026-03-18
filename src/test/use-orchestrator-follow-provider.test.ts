import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrchestrator } from '@/hooks/useOrchestrator';
import { useChatStore } from '@/stores/chat-store';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { useSettingsStore } from '@/stores/settings-store';

vi.mock('@/lib/db', () => ({
  db: {
    messages: {
      getByConversation: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('@/lib/api', () => ({
  getApiBaseUrl: () => 'http://localhost:3001',
}));

describe('useOrchestrator uses active chat provider', () => {
  beforeEach(() => {
    window.localStorage.clear();

    useKnowledgeStore.setState({ entries: [] });
    useChatStore.setState((state) => ({
      ...state,
      conversations: [],
      createConversation: vi.fn(),
      renameConversation: vi.fn(),
      loadConversations: vi.fn(),
    }));

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'anthropic',
      providers: {
        ...state.providers,
        anthropic: {
          ...state.providers.anthropic,
          apiKey: 'anthropic-key',
          model: 'claude-sonnet-4-5-20250929',
        },
        openai: {
          ...state.providers.openai,
          apiKey: 'openai-key',
          model: 'gpt-5.4',
        },
      },
    }));

    useOrchestratorStore.setState((state) => ({
      ...state,
      enabled: true,
      maxSubAgents: 6,
      activeOrchestration: { phase: 'idle', tasks: [] },
    }));
  });

  it('uses the active chat provider for orchestration', () => {
    const { result } = renderHook(() => useOrchestrator(null));

    expect(result.current.activeProvider).toBe('anthropic');
    expect(result.current.activeModel).toBe('claude-sonnet-4-5-20250929');
  });

  it('switches provider when activeProvider changes', () => {
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'openai',
    }));

    const { result } = renderHook(() => useOrchestrator(null));

    expect(result.current.activeProvider).toBe('openai');
    expect(result.current.activeModel).toBe('gpt-5.4');
  });
});
