import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '@/hooks/useChat';
import { useOrchestrator } from '@/hooks/useOrchestrator';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore } from '@/stores/preview-store';
import { useOrchestratorStore } from '@/stores/orchestrator-store';

const { dbMock, aiChatState } = vi.hoisted(() => ({
  dbMock: {
    conversations: {
      update: vi.fn().mockResolvedValue(undefined),
    },
    messages: {
      add: vi.fn().mockResolvedValue(undefined),
      getByConversation: vi.fn().mockResolvedValue([]),
    },
    conversationFiles: {
      delete: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(undefined),
    },
  },
  aiChatState: {
    messages: [] as Array<{ id: string; role: string; content: string }>,
    append: vi.fn<(_: { role: string; content: string }) => Promise<void>>(),
    status: 'ready',
    stop: vi.fn(),
    reload: vi.fn(),
    setMessages: vi.fn(),
    error: null,
  },
}));

let latestUseChatOptions: Record<string, unknown> | null = null;

vi.mock('@/lib/db', () => ({
  db: dbMock,
}));

vi.mock('@/lib/api', () => ({
  getApiBaseUrl: () => 'http://localhost:3001',
}));

vi.mock('@ai-sdk/react', () => ({
  useChat: (options: Record<string, unknown>) => {
    latestUseChatOptions = options;
    return aiChatState;
  },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStreamResponse(events: Array<{ type: string; data: unknown }>) {
  const encoder = new TextEncoder();
  const payload = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
    .join('');

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    { status: 200 }
  );
}

describe('new thread handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();

    useKnowledgeStore.setState({ entries: [] });
    useChangesetStore.setState({ panelChangesets: {} });
    usePreviewStore.setState({ panelPreviews: {} });
    useOrchestratorStore.setState({
      enabled: false,
      planningProvider: 'kimi-coding',
      planningModel: 'kimi-for-coding',
      codingProvider: 'kimi-coding',
      codingModel: 'kimi-for-coding',
      maxSubAgents: 3,
      activeOrchestration: { phase: 'idle', tasks: [] },
    });
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'openai',
      defaultSystemPrompt: 'You are a helpful assistant.',
      githubPAT: '',
      autoApproveRepoChanges: false,
      providers: {
        ...state.providers,
        openai: { ...state.providers.openai, apiKey: 'test-key', model: 'gpt-5.2' },
        'kimi-coding': { ...state.providers['kimi-coding'], apiKey: 'test-key', model: 'kimi-for-coding' },
      },
    }));

    useChatStore.setState((state) => ({
      ...state,
      conversations: [],
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      renameConversation: vi.fn().mockResolvedValue(undefined),
      loadConversations: vi.fn().mockResolvedValue(undefined),
    }));

    aiChatState.messages = [];
    aiChatState.status = 'ready';
    latestUseChatOptions = null;
  });

  it('waits for the initial append to settle before selecting a brand-new chat conversation', async () => {
    const appendDeferred = deferred<void>();
    aiChatState.append.mockImplementation(() => appendDeferred.promise);

    const onConversationCreated = vi.fn();
    const { result } = renderHook(() => useChat(null, onConversationCreated));

    await act(async () => {
      result.current.handleQuickSend('Ship the first draft');
      await Promise.resolve();
    });

    await waitFor(() => expect(dbMock.messages.add).toHaveBeenCalledTimes(1));
    expect(onConversationCreated).not.toHaveBeenCalled();

    await act(async () => {
      appendDeferred.resolve();
      await appendDeferred.promise;
    });

    await waitFor(() => expect(onConversationCreated).toHaveBeenCalledWith('conv-1'));
  });

  it('only forwards reasoning effort for supported provider-model pairs', () => {
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'openai',
      providers: {
        ...state.providers,
        openai: {
          ...state.providers.openai,
          model: 'gpt-5.2',
          reasoningEffort: 'medium',
        },
      },
    }));

    const { unmount } = renderHook(() => useChat(null));
    expect((latestUseChatOptions?.body as Record<string, unknown>)?.reasoning_effort).toBe('medium');
    unmount();

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'minimax',
      providers: {
        ...state.providers,
        minimax: {
          ...state.providers.minimax,
          model: 'MiniMax-M2.5',
          reasoningEffort: 'high',
        },
      },
    }));

    renderHook(() => useChat(null));
    expect((latestUseChatOptions?.body as Record<string, unknown>)?.reasoning_effort).toBeUndefined();
  });

  it('waits for the first orchestration run to finish before selecting a brand-new conversation', async () => {
    const fetchDeferred = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => fetchDeferred.promise));

    const onConversationCreated = vi.fn();
    const { result } = renderHook(() => useOrchestrator(null, onConversationCreated));

    await act(async () => {
      result.current.handleQuickSend('Plan and implement the landing page');
      await Promise.resolve();
    });

    await waitFor(() => expect(dbMock.messages.add).toHaveBeenCalledTimes(1));
    expect(onConversationCreated).not.toHaveBeenCalled();

    await act(async () => {
      fetchDeferred.resolve(
        makeStreamResponse([
          { type: 'token', data: { content: 'done' } },
          { type: 'done', data: {} },
        ])
      );
      await fetchDeferred.promise;
    });

    await waitFor(() => expect(onConversationCreated).toHaveBeenCalledWith('conv-1'));
  });

  it('persists the paused proposal snapshot before handing off a new conversation', async () => {
    const appendDeferred = deferred<void>();
    aiChatState.append.mockImplementation(() => appendDeferred.promise);

    const onConversationCreated = vi.fn();
    const { result, rerender } = renderHook(() => useChat(null, onConversationCreated));

    await act(async () => {
      result.current.handleQuickSend('Review the repo and propose the changes first');
      await Promise.resolve();
    });

    const onToolCall = latestUseChatOptions?.onToolCall as ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>) | undefined;
    expect(onToolCall).toBeDefined();

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'propose_changes',
          args: {
            summary: 'Update the landing page shell',
            plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Refresh the layout' }],
          },
        },
      });
    });

    aiChatState.messages = [
      {
        id: 'assistant-proposal',
        role: 'assistant',
        content: '## Proposed Changes',
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              toolName: 'propose_changes',
              state: 'result',
              args: {
                summary: 'Update the landing page shell',
                plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Refresh the layout' }],
              },
            },
          },
        ],
      } as unknown as { id: string; role: string; content: string },
    ];
    aiChatState.status = 'streaming';

    rerender();

    await waitFor(() => expect(aiChatState.stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onConversationCreated).toHaveBeenCalledWith('conv-1'));
    await waitFor(() =>
      expect(dbMock.messages.add).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'assistant-proposal',
          role: 'assistant',
          conversationId: 'conv-1',
          parts: expect.any(Array),
        })
      )
    );
  });
});
