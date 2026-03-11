import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesetStore } from '@/stores/changeset-store';
import { useChatStore } from '@/stores/chat-store';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { usePanelStore } from '@/stores/panel-store';
import { usePreviewStore } from '@/stores/preview-store';

const { regularChatHook, orchestratorHook } = vi.hoisted(() => ({
  regularChatHook: vi.fn(),
  orchestratorHook: vi.fn(),
}));

vi.mock('@/hooks/useChat', () => ({
  useChat: (...args: unknown[]) => regularChatHook(...args),
}));

vi.mock('@/hooks/useOrchestrator', () => ({
  useOrchestrator: (...args: unknown[]) => orchestratorHook(...args),
}));

vi.mock('@/components/chat/ChatArea', () => ({
  ChatArea: ({ activeProvider }: { activeProvider: string }) => (
    <div data-testid="chat-area">{activeProvider}</div>
  ),
}));

import { ChatPanel } from '@/components/chat/ChatPanel';

const regularChatState = {
  messages: [],
  input: '',
  setInput: vi.fn(),
  handleSend: vi.fn(),
  handleQuickSend: vi.fn(),
  queuedMessages: [],
  handleRemoveQueuedMessage: vi.fn(),
  handleSteerQueuedMessage: vi.fn(),
  handleStop: vi.fn(),
  handleRegenerate: vi.fn(),
  isStreaming: false,
  error: null,
  apiKeyModalOpen: false,
  setApiKeyModalOpen: vi.fn(),
  providerUnavailableOpen: false,
  setProviderUnavailableOpen: vi.fn(),
  activeProvider: 'openai',
  activeModel: 'gpt-5.2',
  toolActivityMap: {},
};

const orchestratorChatState = {
  messages: [],
  input: '',
  setInput: vi.fn(),
  handleSend: vi.fn(),
  handleQuickSend: vi.fn(),
  queuedMessages: [],
  handleRemoveQueuedMessage: vi.fn(),
  handleSteerQueuedMessage: vi.fn(),
  handleStop: vi.fn(),
  handleRegenerate: vi.fn(),
  isStreaming: false,
  error: null,
  apiKeyModalOpen: false,
  setApiKeyModalOpen: vi.fn(),
  providerUnavailableOpen: false,
  setProviderUnavailableOpen: vi.fn(),
  activeProvider: 'kimi-coding',
  activeModel: 'kimi-for-coding',
};

describe('ChatPanel provider switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();

    regularChatHook.mockReturnValue(regularChatState);
    orchestratorHook.mockReturnValue(orchestratorChatState);

    useChatStore.setState((state) => ({
      ...state,
      conversations: [],
    }));

    usePanelStore.setState((state) => ({
      ...state,
      panels: [{ id: 'default', conversationId: 'conv-1' }],
      focusedPanelId: 'default',
    }));

    useChangesetStore.setState({
      panelChangesets: {},
    });

    usePreviewStore.setState({
      panelPreviews: {},
    });

    useOrchestratorStore.setState((state) => ({
      ...state,
      enabled: false,
    }));
  });

  it('mounts only the active chat runtime when orchestrator mode toggles', () => {
    render(
      <ChatPanel
        panelId="default"
        conversationId="conv-1"
        isFocused
        onFocus={vi.fn()}
      />
    );

    expect(screen.getByTestId('chat-area')).toHaveTextContent('openai');
    expect(regularChatHook).toHaveBeenCalledTimes(1);
    expect(orchestratorHook).not.toHaveBeenCalled();

    act(() => {
      useOrchestratorStore.setState((state) => ({
        ...state,
        enabled: true,
      }));
    });

    expect(screen.getByTestId('chat-area')).toHaveTextContent('kimi-coding');
    expect(regularChatHook).toHaveBeenCalledTimes(1);
    expect(orchestratorHook).toHaveBeenCalledTimes(1);

    act(() => {
      useOrchestratorStore.setState((state) => ({
        ...state,
        enabled: false,
      }));
    });

    expect(screen.getByTestId('chat-area')).toHaveTextContent('openai');
    expect(regularChatHook).toHaveBeenCalledTimes(2);
    expect(orchestratorHook).toHaveBeenCalledTimes(1);
  });
});
