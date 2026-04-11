import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDataStreamPart } from 'ai';
import { useChat } from '@/hooks/useChat';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore } from '@/stores/preview-store';
import { useHermesStore } from '@/stores/hermes-store';
import { usePanelStore } from '@/stores/panel-store';
import { useUIStore } from '@/stores/ui-store';

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
    append: vi.fn<(_: { role: string; content: string }, _opts?: Record<string, unknown>) => Promise<void>>(),
    status: 'ready',
    stop: vi.fn(),
    reload: vi.fn(),
    setMessages: vi.fn(),
    error: null,
  },
}));

const apiMocks = vi.hoisted(() => ({
  fetchRepoFileTreeResult: vi.fn(),
}));

let latestUseChatOptions: Record<string, unknown> | null = null;

vi.mock('@/lib/db', () => ({
  db: dbMock,
}));

vi.mock('@/lib/api', () => ({
  getApiBaseUrl: () => 'http://localhost:3001',
  fetchRepoFileTreeResult: apiMocks.fetchRepoFileTreeResult,
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
    vi.useRealTimers();
    vi.clearAllMocks();
    window.localStorage.clear();

    useKnowledgeStore.setState({ entries: [] });
    useChangesetStore.setState({ panelChangesets: {} });
    usePreviewStore.setState({ panelPreviews: {} });
    usePanelStore.setState({
      panels: [{ id: 'default', conversationId: null }],
      focusedPanelId: 'default',
    });
    useHermesStore.setState({
      toolsets: {
        web: true,
        browser: true,
        vision: true,
        terminal: false,
        files: false,
        code_execution: false,
      },
    });
    useUIStore.setState({
      sidebarOpen: false,
      sidebarWidth: 320,
      settingsOpen: false,
      setupWizardOpen: false,
      repoBrowserOpen: false,
      activeTab: 'chat',
      pendingPanelPrompts: {},
      preservePanelRepoHandoffs: {},
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
    apiMocks.fetchRepoFileTreeResult.mockReset();
    apiMocks.fetchRepoFileTreeResult.mockResolvedValue({ paths: [], error: null });
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

  it('never bakes continuation approval into the default hook request body', () => {
    renderHook(() => useChat(null));

    expect((latestUseChatOptions?.body as Record<string, unknown>)?.continuing_approved_proposal).toBeUndefined();
  });

  it('prepares repo request bodies from the latest store state at send time', () => {
    renderHook(() => useChat(null));

    act(() => {
      useSettingsStore.setState((state) => ({
        ...state,
        githubPAT: 'ghp-test',
      }));
      useChangesetStore.getState().setActiveRepo('default', {
        owner: 'octo',
        name: 'cloudchat',
        defaultBranch: 'main',
        fullName: 'octo/cloudchat',
      });
      useChangesetStore.getState().setRepoFileTree('default', ['README.md']);
    });

    const prepareRequestBody = latestUseChatOptions?.experimental_prepareRequestBody as ((options: {
      id: string;
      messages: Array<{ role: string; content: string }>;
      requestData?: unknown;
      requestBody?: Record<string, unknown>;
    }) => Record<string, unknown>) | undefined;

    const prepared = prepareRequestBody?.({
      id: 'draft-req',
      messages: [{ role: 'user', content: 'Explain issue #42' }],
      requestBody: { conversation_id: 'conv-1' },
    });

    expect(prepared).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.2',
      github_pat: 'ghp-test',
      activeRepo: {
        owner: 'octo',
        name: 'cloudchat',
        defaultBranch: 'main',
        default_branch: 'main',
      },
      repo_file_tree: ['README.md'],
      conversation_id: 'conv-1',
    });
  });

  it('hydrates the selected repo tree before sending the first repo-mode turn', async () => {
    apiMocks.fetchRepoFileTreeResult.mockResolvedValue({
      paths: ['src/App.tsx', 'src/components/chat/ChatArea.tsx'],
      error: null,
    });

    const { result, rerender } = renderHook(() => useChat(null));

    act(() => {
      useSettingsStore.setState((state) => ({
        ...state,
        githubPAT: 'ghp-test',
      }));
      useChangesetStore.getState().setActiveRepo('default', {
        owner: 'octo',
        name: 'cloudchat',
        defaultBranch: 'main',
        fullName: 'octo/cloudchat',
      });
    });
    rerender();

    await act(async () => {
      result.current.handleQuickSend('Update the UI to feel more modern.');
    });

    await waitFor(() => expect(apiMocks.fetchRepoFileTreeResult).toHaveBeenCalledWith('ghp-test', 'octo', 'cloudchat', 'main'));
    await waitFor(() => expect(aiChatState.append).toHaveBeenCalledTimes(1));

    expect(useChangesetStore.getState().getChangeset('default').repoFileTree).toEqual([
      'src/App.tsx',
      'src/components/chat/ChatArea.tsx',
    ]);
    expect(useChangesetStore.getState().getChangeset('default').repoFileTreeStatus).toBe('ready');
    expect(aiChatState.append.mock.calls[0]?.[1]).toMatchObject({
      body: {
        conversation_id: 'conv-1',
        repo_edit_intent: true,
        repo_file_tree: ['src/App.tsx', 'src/components/chat/ChatArea.tsx'],
      },
    });
  });

  it('marks descriptive repo questions as read-only when sending a repo-attached turn', async () => {
    apiMocks.fetchRepoFileTreeResult.mockResolvedValue({
      paths: ['README.md', 'src/App.tsx'],
      error: null,
    });

    const { result, rerender } = renderHook(() => useChat(null));

    act(() => {
      useSettingsStore.setState((state) => ({
        ...state,
        githubPAT: 'ghp-test',
      }));
      useChangesetStore.getState().setActiveRepo('default', {
        owner: 'octo',
        name: 'cloudchat',
        defaultBranch: 'main',
        fullName: 'octo/cloudchat',
      });
    });
    rerender();

    await act(async () => {
      result.current.handleQuickSend('What is this repo?');
    });

    await waitFor(() => expect(aiChatState.append).toHaveBeenCalledTimes(1));
    expect(aiChatState.append.mock.calls[0]?.[1]).toMatchObject({
      body: {
        conversation_id: 'conv-1',
        repo_edit_intent: false,
      },
    });
  });

  it('keeps the selected explain repo attached across an existing-conversation reset', async () => {
    usePanelStore.getState().setConversationForPanel('default', 'conv-old');
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'upstream',
      name: 'remote-chat',
      defaultBranch: 'main',
      fullName: 'upstream/remote-chat',
    });
    useChangesetStore.getState().setRepoFileTree('default', ['README.md', 'src/index.ts']);
    useUIStore.getState().markPanelRepoHandoff('default');

    const { rerender } = renderHook(
      ({ convId }) => useChat(convId),
      { initialProps: { convId: 'conv-old' as string | null } },
    );

    rerender({ convId: null });

    await waitFor(() => {
      expect(useChangesetStore.getState().getChangeset('default').activeRepo).toMatchObject({
        owner: 'upstream',
        name: 'remote-chat',
        fullName: 'upstream/remote-chat',
      });
    });
    expect(useUIStore.getState().preservePanelRepoHandoffs.default).toBeUndefined();
  });

  it('keeps explain-issue handoff prompts read-only even when the issue text says fix', async () => {
    apiMocks.fetchRepoFileTreeResult.mockResolvedValue({
      paths: ['README.md', 'src/App.tsx'],
      error: null,
    });

    useSettingsStore.setState((state) => ({
      ...state,
      githubPAT: 'ghp-test',
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });
    useUIStore.getState().queuePanelPrompt('default', {
      content: [
        'Explain GitHub issue #42 in octo/cloudchat.',
        'Issue title: Fix auth profile order reversion',
        '',
        'The user wants an explanation only, not a fix or implementation plan.',
      ].join('\n'),
      autoSend: true,
      repoEditIntentOverride: false,
    });

    renderHook(() => useChat(null));

    await waitFor(() => expect(aiChatState.append).toHaveBeenCalledTimes(1));
    expect(aiChatState.append.mock.calls[0]?.[1]).toMatchObject({
      body: {
        conversation_id: 'conv-1',
        repo_edit_intent: false,
      },
    });
  });

  it('keeps the active request body stable while streaming repo reads populate the cache', async () => {
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });
    useChangesetStore.getState().setRepoFileTree('default', ['src/App.tsx']);

    const { result, rerender } = renderHook(() => useChat('conv-1'));

    await act(async () => {
      await result.current.handleQuickSend('Inspect src/App.tsx before editing it.');
    });

    expect((latestUseChatOptions?.body as Record<string, unknown>)?.repo_file_cache).toBeUndefined();

    await act(async () => {
      aiChatState.status = 'streaming';
      rerender();
    });

    await act(async () => {
      useChangesetStore.getState().cacheRepoFile('default', 'src/App.tsx', 'export default function App() {}');
    });

    expect((latestUseChatOptions?.body as Record<string, unknown>)?.repo_file_cache).toBeUndefined();
  });

  it('deduplicates identical Hermes server-side repo edit events within one stream', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          apiKey: 'test-key',
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));

    renderHook(() => useChat('conv-1'));

    const fetchInterceptor = latestUseChatOptions?.fetch as ((url: string, init?: RequestInit) => Promise<Response>) | undefined;

    expect(fetchInterceptor).toBeDefined();

    const payload = [
      formatDataStreamPart('data', [{
        type: 'repo_file_edit',
        path: 'src/App.tsx',
        content: 'export default function App() { return <main>Updated</main>; }',
        originalContent: 'export default function App() { return <main>Original</main>; }',
        description: 'Refresh the app shell',
      }]),
      formatDataStreamPart('data', [{
        type: 'repo_file_edit',
        path: 'src/App.tsx',
        content: 'export default function App() { return <main>Updated</main>; }',
        originalContent: 'export default function App() { return <main>Original</main>; }',
        description: 'Refresh the app shell',
      }]),
      formatDataStreamPart('finish_message', {
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    ].join('');

    const originalFetch = global.fetch;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    ));

    try {
      await act(async () => {
        const intercepted = await fetchInterceptor?.('http://localhost:3001/functions/v1/chat');
        expect(intercepted).toBeDefined();
        await intercepted?.text();
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(useChangesetStore.getState().getChangeset('default').changes['src/App.tsx']).toMatchObject({
      path: 'src/App.tsx',
      action: 'edit',
      content: 'export default function App() { return <main>Updated</main>; }',
      staged: true,
    });
  });

  it('filters local Hermes mutation toolsets when a repo is attached', () => {
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      githubPAT: 'ghp-test',
      providers: {
        ...state.providers,
        hermes: { ...state.providers.hermes, apiKey: 'test-key', model: 'meta-llama/llama-4-maverick' },
      },
    }));
    useHermesStore.setState({
      toolsets: {
        web: true,
        browser: true,
        vision: true,
        terminal: true,
        files: true,
        code_execution: true,
      },
    });

    renderHook(() => useChat('conv-1'));

    act(() => {
      useChangesetStore.getState().setActiveRepo('default', {
        owner: 'octo',
        name: 'cloudchat',
        defaultBranch: 'main',
        fullName: 'octo/cloudchat',
      });
      useChangesetStore.getState().setRepoFileTree('default', ['src/App.tsx']);
    });

    renderHook(() => useChat('conv-1'));

    expect((latestUseChatOptions?.body as Record<string, unknown>)?.hermes_toolsets).toBe('web,browser,vision');
  });

  it('returns repo-tree guidance when the model guesses a missing repo file path', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const { result } = renderHook(() => useChat(null));

    act(() => {
      useSettingsStore.setState((state) => ({
        ...state,
        githubPAT: 'ghp-test',
      }));
      useChangesetStore.getState().setActiveRepo('default', {
        owner: 'octo',
        name: 'cloudchat',
        defaultBranch: 'main',
        fullName: 'octo/cloudchat',
      });
      useChangesetStore.getState().setRepoFileTree('default', [
        'src/App.tsx',
        'src/components/chat/ChatArea.tsx',
        'src/components/chat/MessageBubble.tsx',
      ]);
    });

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;

    expect(onToolCall).toBeDefined();

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'propose_changes',
          args: {
            summary: 'Inspect the chat shell before updating it',
            plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Refresh the shell styling' }],
          },
        },
      });
      result.current.handleQuickSend('go ahead');
      await Promise.resolve();
    });

    let readResult: unknown;
    await act(async () => {
      readResult = await onToolCall?.({
        toolCall: {
          toolName: 'read_repo_file',
          args: {
            path: 'main.py',
          },
        },
      });
    });

    expect(readResult).toEqual(expect.stringContaining('is not present in the selected repository'));
    expect(readResult).toEqual(expect.stringContaining('src/App.tsx'));
    expect(readResult).toEqual(expect.stringContaining('src/components/chat/MessageBubble.tsx'));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects root-like placeholder repo paths before calling GitHub', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const { rerender } = renderHook(() => useChat(null));

    act(() => {
      useSettingsStore.setState((state) => ({
        ...state,
        githubPAT: 'ghp-test',
      }));
      useChangesetStore.getState().setActiveRepo('default', {
        owner: 'octo',
        name: 'cloudchat',
        defaultBranch: 'main',
        fullName: 'octo/cloudchat',
      });
      useChangesetStore.getState().setRepoFileTree('default', [
        'src/App.tsx',
      ]);
    });
    rerender();

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;

    expect(onToolCall).toBeDefined();

    let readResult: unknown;
    await act(async () => {
      readResult = await onToolCall?.({
        toolCall: {
          toolName: 'read_repo_file',
          args: {
            path: '.',
          },
        },
      });
    });

    expect(readResult).toEqual(expect.stringContaining('Choose a concrete file path'));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('blocks repo file reads until the repo tree is available', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    apiMocks.fetchRepoFileTreeResult.mockResolvedValue({
      paths: [],
      error: 'GitHub API error: tree unavailable',
    });

    const { rerender } = renderHook(() => useChat(null));

    act(() => {
      useSettingsStore.setState((state) => ({
        ...state,
        githubPAT: 'ghp-test',
      }));
      useChangesetStore.getState().setActiveRepo('default', {
        owner: 'octo',
        name: 'cloudchat',
        defaultBranch: 'main',
        fullName: 'octo/cloudchat',
      });
    });
    rerender();

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;

    expect(onToolCall).toBeDefined();

    let readResult: unknown;
    await act(async () => {
      readResult = await onToolCall?.({
        toolCall: {
          toolName: 'read_repo_file',
          args: {
            path: 'package.json',
          },
        },
      });
    });

    expect(readResult).toEqual(expect.stringContaining('could not be indexed'));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('allows repo file reads before approval so analysis turns can inspect the repo', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: 'export default function App() {}' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { rerender } = renderHook(() => useChat(null));

    act(() => {
      useSettingsStore.setState((state) => ({
        ...state,
        githubPAT: 'ghp-test',
      }));
      useChangesetStore.getState().setActiveRepo('default', {
        owner: 'octo',
        name: 'cloudchat',
        defaultBranch: 'main',
        fullName: 'octo/cloudchat',
      });
      useChangesetStore.getState().setRepoFileTree('default', [
        'src/App.tsx',
      ]);
    });
    rerender();

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;

    expect(onToolCall).toBeDefined();

    let readResult: unknown;
    await act(async () => {
      readResult = await onToolCall?.({
        toolCall: {
          toolName: 'read_repo_file',
          args: {
            path: 'src/App.tsx',
          },
        },
      });
    });

    expect(readResult).toBe('export default function App() {}');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
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

  it('only pauses a pending proposal once when Hermes re-ids the same assistant message', async () => {
    const { rerender } = renderHook(() => useChat('conv-1'));

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;

    expect(onToolCall).toBeDefined();

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'propose_changes',
          args: {
            summary: 'Refresh the repo UI shell',
            plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
          },
        },
      });
    });

    aiChatState.stop.mockClear();

    await act(async () => {
      aiChatState.messages = [
        {
          id: 'assistant-proposal-1',
          role: 'assistant',
          content: '## Proposed Changes',
          toolInvocations: [
            {
              toolCallId: 'proposal-1',
              toolName: 'propose_changes',
              state: 'result',
              args: {
                summary: 'Refresh the repo UI shell',
                plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
              },
            },
          ],
        } as unknown as { id: string; role: string; content: string },
      ];
      aiChatState.status = 'streaming';
      rerender();
      await Promise.resolve();
    });

    await waitFor(() => expect(aiChatState.stop).toHaveBeenCalledTimes(1));

    await act(async () => {
      aiChatState.messages = [
        {
          id: 'assistant-proposal-2',
          role: 'assistant',
          content: '## Proposed Changes',
          toolInvocations: [
            {
              toolCallId: 'proposal-1',
              toolName: 'propose_changes',
              state: 'result',
              args: {
                summary: 'Refresh the repo UI shell',
                plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
              },
            },
          ],
        } as unknown as { id: string; role: string; content: string },
      ];
      rerender();
      await Promise.resolve();
    });

    expect(aiChatState.stop).toHaveBeenCalledTimes(1);
  });

  it('treats approval follow-ups as continuation of the accepted repo plan', async () => {
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { result } = renderHook(() => useChat(null));

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;
    expect(onToolCall).toBeDefined();

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'propose_changes',
          args: {
            summary: 'Refresh the repo UI shell',
            plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
          },
        },
      });
    });

    await act(async () => {
      result.current.handleQuickSend('go ahead');
      await Promise.resolve();
    });

    expect(aiChatState.append).toHaveBeenCalledWith(
      { role: 'user', content: 'go ahead' },
      expect.objectContaining({
        body: expect.objectContaining({
          conversation_id: 'conv-1',
          continuing_approved_proposal: true,
        }),
      })
    );

    const continuedProposal = await onToolCall?.({
      toolCall: {
        toolName: 'propose_changes',
        args: {
          summary: 'Refresh the repo UI shell',
          plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
        },
      },
    });

    expect(continuedProposal).toContain('already approved');
    expect(continuedProposal).toContain('Continue directly with read_repo_file');
  });

  it('does not pause again when an approved Hermes continuation replays the proposal', async () => {
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { result, rerender } = renderHook(() => useChat('conv-1'));

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;

    expect(onToolCall).toBeDefined();

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'propose_changes',
          args: {
            summary: 'Refresh the repo UI shell',
            plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
          },
        },
      });
    });

    await act(async () => {
      result.current.handleQuickSend('go ahead');
      await Promise.resolve();
    });

    aiChatState.stop.mockClear();

    await act(async () => {
      aiChatState.messages = [
        { id: 'user-approval', role: 'user', content: 'go ahead' },
        {
          id: 'assistant-approved-replay',
          role: 'assistant',
          content: '',
          toolInvocations: [
            {
              toolCallId: 'proposal-replay-1',
              toolName: 'propose_changes',
              state: 'result',
              args: {
                summary: 'Refresh the repo UI shell',
                plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
              },
            },
          ],
        } as unknown as { id: string; role: string; content: string },
      ];
      aiChatState.status = 'streaming';
      rerender();
      await Promise.resolve();
    });

    expect(aiChatState.stop).not.toHaveBeenCalled();
  });

  it('keeps repo edits unlocked across tool-call continuation steps after approval', async () => {
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { result } = renderHook(() => useChat(null));

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;
    const onFinish = latestUseChatOptions?.onFinish as
      | ((message: {
          id: string; role: string; content: string; parts?: unknown[]; toolInvocations?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(onToolCall).toBeDefined();
    expect(onFinish).toBeDefined();

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'propose_changes',
          args: {
            summary: 'Refresh the repo UI shell',
            plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
          },
        },
      });
    });

    await act(async () => {
      result.current.handleQuickSend('go ahead');
      await Promise.resolve();
    });

    // continuing_approved_proposal is passed via append options (ref-based body
    // config is only picked up on the next re-render, so we verify through append).
    await waitFor(() => {
      const lastAppendCall = aiChatState.append.mock.calls.at(-1);
      const appendBody = (lastAppendCall?.[1] as { body?: Record<string, unknown> })?.body;
      expect(appendBody?.continuing_approved_proposal).toBe(true);
    });

    await act(async () => {
      await onFinish?.(
        {
          id: 'assistant-step-1',
          role: 'assistant',
          content: '',
          toolInvocations: [
            {
              toolCallId: 'tool-read-1',
              toolName: 'read_repo_file',
              state: 'result',
              args: { path: 'src/App.tsx' },
              result: 'export default function App() {}',
            },
          ],
        },
        { finishReason: 'tool-calls' },
      );
    });

    expect(dbMock.messages.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'assistant-step-1',
        role: 'assistant',
        conversationId: 'conv-1',
        toolInvocations: expect.any(Array),
      }),
    );
    // After onFinish with tool-calls, the ref stays true. Verify through
    // the most recent append call (ref-based body config needs a re-render).
    {
      const lastAppend = aiChatState.append.mock.calls.at(-1);
      const body = (lastAppend?.[1] as { body?: Record<string, unknown> })?.body;
      expect(body?.continuing_approved_proposal).toBe(true);
    }
    expect((latestUseChatOptions?.body as Record<string, unknown>)?.continuing_approved_proposal).toBeUndefined();

    const editResult = await onToolCall?.({
      toolCall: {
        toolName: 'edit_repo_file',
        args: {
          path: 'src/App.tsx',
          content: 'export default function App() { return null; }',
          description: 'Finish the approved UI update',
        },
      },
    });

    expect(editResult).toBe('Staged edit to src/App.tsx');
  });

  it('recognizes AI SDK data-stream server repo events and avoids re-running those tools locally', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          apiKey: 'test-key',
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));

    renderHook(() => useChat('conv-1'));

    const fetchInterceptor = latestUseChatOptions?.fetch as ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;

    expect(fetchInterceptor).toBeDefined();
    expect(onToolCall).toBeDefined();

    const payload = [
      formatDataStreamPart('tool_call_streaming_start', {
        toolCallId: 'edit-1',
        toolName: 'edit_repo_file',
      }),
      formatDataStreamPart('data', [{
        type: 'repo_file_edit',
        path: 'src/App.tsx',
        content: 'export default function App() { return <main>Updated</main>; }',
        originalContent: 'export default function App() { return null; }',
        description: 'Refresh the shell',
      }]),
      formatDataStreamPart('finish_message', {
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    ].join('');

    const originalFetch = global.fetch;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    ));

    try {
      await act(async () => {
        const intercepted = await fetchInterceptor?.('http://localhost:3001/functions/v1/chat');
        expect(intercepted).toBeDefined();
        await intercepted?.text();
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    const change = useChangesetStore.getState().getChangeset('default').changes['src/App.tsx'];
    expect(change).toMatchObject({
      path: 'src/App.tsx',
      action: 'edit',
      staged: true,
    });

    let toolResult: unknown;
    await act(async () => {
      toolResult = await onToolCall?.({
        toolCall: {
          toolName: 'edit_repo_file',
          args: {
            path: 'src/App.tsx',
            content: 'export default function App() { return <main>Updated</main>; }',
            description: 'Refresh the shell',
          },
        },
      });
    });

    expect(toolResult).toBe('Handled server-side');
  });

  it('rejects repo delete tool calls for paths that do not exist', async () => {
    renderHook(() => useChat('conv-1'));

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;

    expect(onToolCall).toBeDefined();

    let deleteResult: unknown;
    await act(async () => {
      deleteResult = await onToolCall?.({
        toolCall: {
          toolName: 'delete_repo_file',
          args: {
            path: 'src/missing.ts',
            reason: 'Remove dead code',
          },
        },
      });
    });

    expect(deleteResult).toBe('Error: delete_repo_file can only delete existing repo files. `src/missing.ts` is not in the indexed repo tree or staged changes.');
    expect(useChangesetStore.getState().getChangeset('default').changes['src/missing.ts']).toBeUndefined();
  });

  it('still stages text-only repo edits after an earlier server-side repo read', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          apiKey: 'test-key',
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { rerender } = renderHook(() => useChat('conv-1'));

    const fetchInterceptor = latestUseChatOptions?.fetch as ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
    expect(fetchInterceptor).toBeDefined();

    const payload = [
      formatDataStreamPart('data', [{
        type: 'repo_file_read',
        path: 'index.html',
        content: '<main>Old</main>',
      }]),
      formatDataStreamPart('finish_message', {
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    ].join('');

    const originalFetch = global.fetch;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    ));

    try {
      await act(async () => {
        const intercepted = await fetchInterceptor?.('http://localhost:3001/functions/v1/chat');
        expect(intercepted).toBeDefined();
        await intercepted?.text();
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    aiChatState.messages = [
      {
        id: 'user-edit-after-read',
        role: 'user',
        content: 'Update the HTML and CSS files directly.',
      } as unknown as { id: string; role: string; content: string },
      {
        id: 'assistant-text-edit-after-read',
        role: 'assistant',
        content: `Now that I have the current content of these files, I can propose the updated code.

Here are the updated files:

\`index.html\`
\`\`\`html
<main>Updated</main>
\`\`\`

\`styles.css\`
\`\`\`css
body { color: white; }
\`\`\``,
      } as unknown as { id: string; role: string; content: string },
    ];

    rerender();

    await waitFor(() => {
      expect(useChangesetStore.getState().getChangeset('default').changes['index.html']).toMatchObject({
        path: 'index.html',
        action: 'edit',
        content: '<main>Updated</main>',
        staged: true,
      });
      expect(useChangesetStore.getState().getChangeset('default').changes['styles.css']).toMatchObject({
        path: 'styles.css',
        action: 'edit',
        content: 'body { color: white; }',
        staged: true,
      });
    });
  });

  it('persists Hermes server-side repo edits even when the final assistant message is otherwise empty', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          apiKey: 'test-key',
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    renderHook(() => useChat('conv-1'));

    const fetchInterceptor = latestUseChatOptions?.fetch as ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
    const onFinish = latestUseChatOptions?.onFinish as
      | ((message: {
          id: string;
          role: string;
          content: string;
          toolInvocations?: unknown[];
          parts?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(fetchInterceptor).toBeDefined();
    expect(onFinish).toBeDefined();

    const payload = [
      formatDataStreamPart('data', [{
        type: 'repo_batch_edit',
        changes: [
          {
            path: 'src/App.tsx',
            action: 'edit',
            content: 'export default function App() { return <main>Updated</main>; }',
            originalContent: 'export default function App() { return null; }',
            description: 'Refresh the app shell',
          },
          {
            path: 'src/styles.css',
            action: 'edit',
            content: 'body { color: white; }',
            originalContent: 'body { color: black; }',
            description: 'Refresh the visual styling',
          },
        ],
      }]),
      formatDataStreamPart('finish_message', {
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    ].join('');

    const originalFetch = global.fetch;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    ));

    try {
      await act(async () => {
        const intercepted = await fetchInterceptor?.('http://localhost:3001/functions/v1/chat');
        expect(intercepted).toBeDefined();
        await intercepted?.text();
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    dbMock.messages.add.mockClear();

    await act(async () => {
      await onFinish?.(
        {
          id: 'assistant-empty-after-server-edit',
          role: 'assistant',
          content: '',
          toolInvocations: [],
        },
        { finishReason: 'stop' },
      );
    });

    expect(dbMock.messages.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'assistant-empty-after-server-edit',
        conversationId: 'conv-1',
        role: 'assistant',
        content: '',
        toolInvocations: [
          expect.objectContaining({
            toolName: 'batch_edit_repo_files',
            state: 'result',
            args: {
              changes: [
                expect.objectContaining({
                  path: 'src/App.tsx',
                  action: 'edit',
                }),
                expect.objectContaining({
                  path: 'src/styles.css',
                  action: 'edit',
                }),
              ],
            },
          }),
        ],
      }),
    );
  });

  it('injects a synthetic assistant turn when a Hermes repo turn finishes with only data events', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          apiKey: 'test-key',
          model: 'MiniMax-M2.7',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });
    aiChatState.messages = [
      {
        id: 'user-only-before-finish',
        role: 'user',
        content: 'Review the codebase for performance bottlenecks and refactor the most impactful areas for better efficiency.',
      },
    ];

    renderHook(() => useChat('conv-1'));

    const fetchInterceptor = latestUseChatOptions?.fetch as ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
    const onFinish = latestUseChatOptions?.onFinish as
      | ((message?: {
          id?: string;
          role?: string;
          content?: string;
          toolInvocations?: unknown[];
          parts?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(fetchInterceptor).toBeDefined();
    expect(onFinish).toBeDefined();

    const payload = [
      formatDataStreamPart('data', [{
        type: 'repo_batch_edit',
        changes: [
          {
            path: 'src/hooks/useChat.ts',
            action: 'edit',
            content: 'patched',
            originalContent: 'original',
            description: 'Preserve tool-only Hermes turns in the transcript',
          },
        ],
      }]),
      formatDataStreamPart('finish_message', {
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    ].join('');

    const originalFetch = global.fetch;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    ));

    try {
      await act(async () => {
        const intercepted = await fetchInterceptor?.('http://localhost:3001/functions/v1/chat');
        expect(intercepted).toBeDefined();
        await intercepted?.text();
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    dbMock.messages.add.mockClear();
    aiChatState.setMessages.mockClear();

    await act(async () => {
      await onFinish?.(undefined, { finishReason: 'stop' });
    });

    expect(aiChatState.setMessages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          role: 'assistant',
          content: '',
          toolInvocations: [
            expect.objectContaining({
              toolName: 'batch_edit_repo_files',
              state: 'result',
              args: {
                changes: [
                  expect.objectContaining({
                    path: 'src/hooks/useChat.ts',
                    action: 'edit',
                  }),
                ],
              },
            }),
          ],
        }),
      ]),
    );
    expect(dbMock.messages.add).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        role: 'assistant',
        content: '',
        toolInvocations: [
          expect.objectContaining({
            toolName: 'batch_edit_repo_files',
            state: 'result',
          }),
        ],
      }),
    );
  });

  it('auto-continues read-only Hermes repo analysis after a server-side repo read ends with an unknown finish', async () => {
    aiChatState.append.mockResolvedValue(undefined);

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      githubPAT: 'ghp-test',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          apiKey: 'test-key',
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    renderHook(() => useChat('conv-1'));

    const fetchInterceptor = latestUseChatOptions?.fetch as ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
    const onFinish = latestUseChatOptions?.onFinish as
      | ((message: {
          id: string;
          role: string;
          content: string;
          toolInvocations?: unknown[];
          parts?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(fetchInterceptor).toBeDefined();
    expect(onFinish).toBeDefined();

    const payload = [
      formatDataStreamPart('data', [{
        type: 'repo_file_read',
        path: 'src/App.tsx',
        content: 'export default function App() { return <main>CloudChat</main>; }',
      }]),
      formatDataStreamPart('finish_message', {
        finishReason: 'unknown',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    ].join('');

    const originalFetch = global.fetch;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    ));

    try {
      await act(async () => {
        const intercepted = await fetchInterceptor?.('http://localhost:3001/functions/v1/chat');
        expect(intercepted).toBeDefined();
        await intercepted?.text();
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    aiChatState.append.mockClear();

    await act(async () => {
      await onFinish?.(
        {
          id: 'assistant-read-only-unknown-finish',
          role: 'assistant',
          content: 'I inspected the app shell and need one more pass through the repo before I can answer fully.',
          toolInvocations: [],
        },
        { finishReason: 'unknown' },
      );
    });

    await waitFor(() => {
      expect(aiChatState.append).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('read-only repo analysis'),
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            conversation_id: 'conv-1',
            repo_edit_intent: false,
          }),
        }),
      );
    }, { timeout: 1500 });
  });

  it('auto-continues approved Hermes repo work after a later read-only stop even with staged edits', async () => {
    aiChatState.append.mockResolvedValue(undefined);

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { result } = renderHook(() => useChat('conv-1'));

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;
    const onFinish = latestUseChatOptions?.onFinish as
      | ((message: {
          id: string;
          role: string;
          content: string;
          toolInvocations?: unknown[];
          parts?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(onToolCall).toBeDefined();
    expect(onFinish).toBeDefined();

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'propose_changes',
          args: {
            summary: 'Refresh the repo UI shell',
            plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
          },
        },
      });
    });

    await act(async () => {
      result.current.handleQuickSend('go ahead');
      await Promise.resolve();
    });

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'edit_repo_file',
          args: {
            path: 'src/App.tsx',
            content: 'export default function App() { return <main>Updated</main>; }',
            description: 'Refresh the app shell',
          },
        },
      });
    });

    expect(useChangesetStore.getState().getStagedCount('default')).toBeGreaterThan(0);

    aiChatState.append.mockClear();

    await act(async () => {
      await onFinish?.(
        {
          id: 'assistant-read-stop-after-edit',
          role: 'assistant',
          content: `I've updated the shell and need one more file read before I finish the approved work.

Next I'll inspect the remaining component and then complete the rest of the accepted plan.`,
          toolInvocations: [
            {
              toolCallId: 'tool-read-2',
              toolName: 'read_repo_file',
              state: 'result',
              args: { path: 'src/components/chat/ChatArea.tsx' },
              result: 'export function ChatArea() {}',
            },
          ],
        },
        { finishReason: 'stop' },
      );
    });

    await waitFor(() => {
      expect(aiChatState.append).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Continue the accepted plan now'),
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            conversation_id: 'conv-1',
            continuing_approved_proposal: true,
          }),
        }),
      );
    }, { timeout: 1500 });
  });

  it('auto-continues approved Hermes repo work after a read-only stop when the cached proposal still looks pending', async () => {
    aiChatState.append.mockResolvedValue(undefined);

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    aiChatState.messages = [
      {
        id: 'assistant-proposal-persisted',
        role: 'assistant',
        content: '',
        toolInvocations: [
          {
            toolCallId: 'proposal-1',
            toolName: 'propose_changes',
            state: 'result',
            args: {
              summary: 'Refresh the repo UI shell',
              plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
            },
          },
        ],
      } as unknown as { id: string; role: string; content: string },
    ];

    const { result } = renderHook(() => useChat('conv-1'));

    const onFinish = latestUseChatOptions?.onFinish as
      | ((message: {
          id: string;
          role: string;
          content: string;
          toolInvocations?: unknown[];
          parts?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(onFinish).toBeDefined();

    await act(async () => {
      result.current.handleQuickSend('go ahead');
      await Promise.resolve();
    });

    aiChatState.append.mockClear();

    await act(async () => {
      await onFinish?.(
        {
          id: 'assistant-approved-read-stop-persisted',
          role: 'assistant',
          content: 'I will inspect the existing UI first and then finish the approved update.',
          toolInvocations: [
            {
              toolCallId: 'tool-read-1',
              toolName: 'read_repo_file',
              state: 'result',
              args: { path: 'src/App.tsx' },
              result: 'export default function App() {}',
            },
          ],
        },
        { finishReason: 'stop' },
      );
    });

    await waitFor(() => {
      expect(aiChatState.append).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Continue the accepted plan now'),
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            conversation_id: 'conv-1',
            continuing_approved_proposal: true,
          }),
        }),
      );
    }, { timeout: 1500 });
  });

  it('auto-continues approved Hermes repo work when a turn edits a file and then stops on a later read', async () => {
    aiChatState.append.mockResolvedValue(undefined);

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { result } = renderHook(() => useChat('conv-1'));

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;
    const onFinish = latestUseChatOptions?.onFinish as
      | ((message: {
          id: string;
          role: string;
          content: string;
          toolInvocations?: unknown[];
          parts?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(onToolCall).toBeDefined();
    expect(onFinish).toBeDefined();

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'propose_changes',
          args: {
            summary: 'Refresh the repo UI shell',
            plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
          },
        },
      });
    });

    await act(async () => {
      result.current.handleQuickSend('go ahead');
      await Promise.resolve();
    });

    aiChatState.append.mockClear();

    await act(async () => {
      await onFinish?.(
        {
          id: 'assistant-edit-then-read-stop',
          role: 'assistant',
          content: `I've updated the app shell and I need one more file read before I can finish the approved work.`,
          toolInvocations: [
            {
              toolCallId: 'tool-edit-1',
              toolName: 'edit_repo_file',
              state: 'result',
              args: {
                path: 'src/App.tsx',
                content: 'export default function App() { return <main>Updated</main>; }',
              },
              result: 'Staged edit to src/App.tsx',
            },
            {
              toolCallId: 'tool-read-3',
              toolName: 'read_repo_file',
              state: 'result',
              args: { path: 'src/components/chat/ChatArea.tsx' },
              result: 'export function ChatArea() {}',
            },
          ],
        },
        { finishReason: 'stop' },
      );
    });

    await waitFor(() => {
      expect(aiChatState.append).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Continue the accepted plan now'),
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            conversation_id: 'conv-1',
            continuing_approved_proposal: true,
          }),
        }),
      );
    }, { timeout: 1500 });
  });

  it('keeps auto-continuing approved Hermes repo work across more than two distinct read-stop turns', async () => {
    aiChatState.append.mockResolvedValue(undefined);

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { result } = renderHook(() => useChat('conv-1'));

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;
    const onFinish = latestUseChatOptions?.onFinish as
      | ((message: {
          id: string;
          role: string;
          content: string;
          toolInvocations?: unknown[];
          parts?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(onToolCall).toBeDefined();
    expect(onFinish).toBeDefined();

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'propose_changes',
          args: {
            summary: 'Refresh the repo UI shell',
            plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
          },
        },
      });
    });

    await act(async () => {
      result.current.handleQuickSend('go ahead');
      await Promise.resolve();
    });

    aiChatState.append.mockClear();

    const stopMessages = [
      {
        id: 'assistant-approved-read-stop-1',
        role: 'assistant',
        content: 'I need one more file before I can finish the approved work.',
        toolInvocations: [
          {
            toolCallId: 'tool-read-a',
            toolName: 'read_repo_file',
            state: 'result',
            args: { path: 'src/App.tsx' },
            result: 'export default function App() {}',
          },
        ],
      },
      {
        id: 'assistant-approved-read-stop-2',
        role: 'assistant',
        content: 'I checked the shell and now need another component file.',
        toolInvocations: [
          {
            toolCallId: 'tool-read-b',
            toolName: 'read_repo_file',
            state: 'result',
            args: { path: 'src/components/chat/ChatArea.tsx' },
            result: 'export function ChatArea() {}',
          },
        ],
      },
      {
        id: 'assistant-approved-read-stop-3',
        role: 'assistant',
        content: 'I inspected the layout wrapper and need one final file before editing.',
        toolInvocations: [
          {
            toolCallId: 'tool-read-c',
            toolName: 'read_repo_file',
            state: 'result',
            args: { path: 'src/components/chat/ChatInput.tsx' },
            result: 'export function ChatInput() {}',
          },
        ],
      },
    ];

    for (const [index, stopMessage] of stopMessages.entries()) {
      await act(async () => {
        await onFinish?.(stopMessage, { finishReason: 'stop' });
      });

      await waitFor(() => {
        expect(aiChatState.append).toHaveBeenCalledTimes(index + 1);
      }, { timeout: 2000 });
    }

    expect(aiChatState.append).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('Continue the accepted plan now'),
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          conversation_id: 'conv-1',
          continuing_approved_proposal: true,
        }),
      }),
    );
  });

  it('auto-continues approved Hermes repo work when the turn stops after narration without repo tools', async () => {
    aiChatState.append.mockResolvedValue(undefined);

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { result } = renderHook(() => useChat('conv-1'));

    const onToolCall = latestUseChatOptions?.onToolCall as
      | ((value: { toolCall: { toolName: string; args: Record<string, unknown> } }) => Promise<unknown>)
      | undefined;
    const onFinish = latestUseChatOptions?.onFinish as
      | ((message: {
          id: string;
          role: string;
          content: string;
          toolInvocations?: unknown[];
          parts?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(onToolCall).toBeDefined();
    expect(onFinish).toBeDefined();

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          toolName: 'propose_changes',
          args: {
            summary: 'Refresh the repo UI shell',
            plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
          },
        },
      });
    });

    await act(async () => {
      result.current.handleQuickSend('go ahead');
      await Promise.resolve();
    });

    aiChatState.append.mockClear();

    await act(async () => {
      await onFinish?.(
        {
          id: 'assistant-approved-stop-no-tools',
          role: 'assistant',
          content: 'I understand the approved plan and will continue from here.',
          toolInvocations: [],
        },
        { finishReason: 'stop' },
      );
    });

    await waitFor(() => {
      expect(aiChatState.append).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('did not execute any repo tools'),
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            conversation_id: 'conv-1',
            continuing_approved_proposal: true,
          }),
        }),
      );
    }, { timeout: 1500 });
  });

  it('does not auto-continue when the stopped turn already contains recoverable pseudo repo edits', async () => {
    aiChatState.append.mockResolvedValue(undefined);
    vi.useFakeTimers();

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { result } = renderHook(() => useChat('conv-1'));

    const onFinish = latestUseChatOptions?.onFinish as
      | ((message: {
          id: string;
          role: string;
          content: string;
          toolInvocations?: unknown[];
          parts?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(onFinish).toBeDefined();

    await act(async () => {
      await result.current.handleQuickSend('Update the app shell and make the UI feel more modern.');
    });

    aiChatState.append.mockClear();

    await act(async () => {
      await onFinish?.(
        {
          id: 'assistant-pseudo-edit-stop',
          role: 'assistant',
          content: `Applying the changes now.

[batch_edit_repo_files(changes=[{"path":"src/App.tsx","action":"edit","content":"export default function App() {\\n  return <main>Updated</main>;\\n}","description":"Refresh the app shell"}])]

The changes are staged for a pull request.`,
          toolInvocations: [],
        },
        { finishReason: 'stop' },
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    expect(aiChatState.append).not.toHaveBeenCalled();
  });

  it('does not reopen the PR flow after a read-only Hermes turn just because older staged changes exist', async () => {
    aiChatState.append.mockResolvedValue(undefined);
    aiChatState.status = 'streaming';
    aiChatState.messages = [
      {
        id: 'user-summary-request',
        role: 'user',
        content: 'Can you give me another summary?',
      } as unknown as { id: string; role: string; content: string },
      {
        id: 'assistant-summary',
        role: 'assistant',
        content: 'Summarizing the repo state now.',
      } as unknown as { id: string; role: string; content: string },
    ];

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          apiKey: 'test-key',
          model: 'meta-llama/llama-4-maverick',
        },
      },
    }));
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });
    useChangesetStore.getState().addChange('default', {
      path: 'src/App.tsx',
      action: 'edit',
      content: 'export default function App() { return <main>Updated</main>; }',
      originalContent: 'export default function App() { return <main>Original</main>; }',
      staged: true,
    });

    const onReadyForPR = vi.fn();
    const { rerender } = renderHook(() => useChat('conv-1', undefined, undefined, 'default', onReadyForPR));

    const onFinish = latestUseChatOptions?.onFinish as
      | ((message: {
          id: string;
          role: string;
          content: string;
          toolInvocations?: unknown[];
          parts?: unknown[];
        }, options?: { finishReason?: string }) => Promise<void>)
      | undefined;

    expect(onFinish).toBeDefined();

    await act(async () => {
      await onFinish?.(
        {
          id: 'assistant-summary',
          role: 'assistant',
          content: 'Here is another summary of the repository architecture and current changes.',
          toolInvocations: [],
        },
        { finishReason: 'stop' },
      );
    });

    await act(async () => {
      aiChatState.status = 'ready';
      rerender();
    });

    expect(onReadyForPR).not.toHaveBeenCalled();
  });

  it('reconstructs approval continuation from a persisted proposal after restart', async () => {
    aiChatState.messages = [
      {
        id: 'assistant-proposal',
        role: 'assistant',
        content: '',
        toolInvocations: [
          {
            toolCallId: 'proposal-1',
            toolName: 'propose_changes',
            state: 'result',
            args: {
              summary: 'Refresh the repo UI shell',
              plan: [{ path: 'src/App.tsx', action: 'edit', description: 'Update the layout shell' }],
            },
          },
        ],
      } as unknown as { id: string; role: string; content: string },
    ];

    const { result } = renderHook(() => useChat('conv-1'));

    await act(async () => {
      result.current.handleQuickSend('go ahead');
      await Promise.resolve();
    });

    expect(aiChatState.append).toHaveBeenCalledWith(
      { role: 'user', content: 'go ahead' },
      expect.objectContaining({
        body: expect.objectContaining({
          conversation_id: 'conv-1',
          continuing_approved_proposal: true,
        }),
      }),
    );
  });

  it('stages pseudo repo edits that arrive in assistant text parts without message content', async () => {
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { rerender } = renderHook(() => useChat('conv-1'));

    aiChatState.messages = [
      {
        id: 'user-edit-request',
        role: 'user',
        content: 'Update the app shell and apply the changes.',
      } as unknown as { id: string; role: string; content: string },
      {
        id: 'assistant-edit',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'text',
            text: `Applying the approved changes now.

[batch_edit_repo_files(changes=[{"path":"src/App.tsx","action":"edit","content":"export default function App() {\\n  return <main>Updated</main>;\\n}","description":"Refresh the app shell"}])]

The changes are staged for a pull request.`,
          },
        ],
      } as unknown as { id: string; role: string; content: string },
    ];

    rerender();

    await waitFor(() => {
      expect(useChangesetStore.getState().getChangeset('default').changes['src/App.tsx']).toMatchObject({
        path: 'src/App.tsx',
        action: 'edit',
        content: 'export default function App() {\n  return <main>Updated</main>;\n}',
        staged: true,
      });
    });
  });

  it('does not stage pseudo repo edits from read-only analysis turns', async () => {
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { rerender } = renderHook(() => useChat('conv-1'));

    aiChatState.messages = [
      {
        id: 'user-analysis-request',
        role: 'user',
        content: 'Analyze the codebase for bugs and suggest fixes.',
      } as unknown as { id: string; role: string; content: string },
      {
        id: 'assistant-read-only-example',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'text',
            text: `Here is an example patch you could apply:

[batch_edit_repo_files(changes=[{"path":"src/App.tsx","action":"edit","content":"export default function App() {\\n  return <main>Updated</main>;\\n}","description":"Refresh the app shell"}])]

I did not apply this change.`,
          },
        ],
      } as unknown as { id: string; role: string; content: string },
    ];

    rerender();

    await waitFor(() => {
      expect(useChangesetStore.getState().getChangeset('default').changes['src/App.tsx']).toBeUndefined();
    });
  });

  it('stages wrapped JSON batch payloads that leak into assistant text parts', async () => {
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { rerender } = renderHook(() => useChat('conv-1'));

    aiChatState.messages = [
      {
        id: 'user-json-wrapper-edit',
        role: 'user',
        content: 'Apply the app shell update directly.',
      } as unknown as { id: string; role: string; content: string },
      {
        id: 'assistant-json-wrapper-edit',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'text',
            text: `The changes have been successfully applied to the repository.

[ { "parameters": { "changes": [ { "path": "src/App.tsx", "action": "edit", "content": "export default function App() {\\n  return <main>Wrapped</main>;\\n}", "description": "Refresh the app shell" } ] } } ]`,
          },
        ],
      } as unknown as { id: string; role: string; content: string },
    ];

    rerender();

    await waitFor(() => {
      expect(useChangesetStore.getState().getChangeset('default').changes['src/App.tsx']).toMatchObject({
        path: 'src/App.tsx',
        action: 'edit',
        content: 'export default function App() {\n  return <main>Wrapped</main>;\n}',
        staged: true,
      });
    });
  });

  it('stages plain text file dumps when a Hermes model skips repo edit tool calls', async () => {
    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
    });

    const { rerender } = renderHook(() => useChat('conv-1'));

    aiChatState.messages = [
      {
        id: 'user-text-edit',
        role: 'user',
        content: 'Update the HTML and CSS files directly.',
      } as unknown as { id: string; role: string; content: string },
      {
        id: 'assistant-text-edit',
        role: 'assistant',
        content: `Now that I have the current content of these files, I can propose the updated code.

Here are the updated files:

\`index.html\`
\`\`\`html
<main>Updated</main>
\`\`\`

\`styles.css\`
\`\`\`css
body { color: white; }
\`\`\``,
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              toolCallId: 'read-local-1',
              toolName: 'read_file',
              args: { path: 'index.html' },
              state: 'result',
              result: '<main>Old</main>',
            },
          },
        ],
      } as unknown as { id: string; role: string; content: string },
    ];

    rerender();

    await waitFor(() => {
      expect(useChangesetStore.getState().getChangeset('default').changes['index.html']).toMatchObject({
        path: 'index.html',
        action: 'edit',
        content: '<main>Updated</main>',
        staged: true,
      });
      expect(useChangesetStore.getState().getChangeset('default').changes['styles.css']).toMatchObject({
        path: 'styles.css',
        action: 'edit',
        content: 'body { color: white; }',
        staged: true,
      });
    });
  });

  it('keeps chatSessionId stable when pendingConversationIdRef clears during streaming', async () => {
    const appendDeferred = deferred<void>();
    aiChatState.append.mockImplementation(() => appendDeferred.promise);

    const onConversationCreated = vi.fn();
    const { result, rerender } = renderHook(
      ({ convId }) => useChat(convId, onConversationCreated),
      { initialProps: { convId: null as string | null } },
    );

    // Start a message (creates a pending conversation)
    await act(async () => {
      result.current.handleQuickSend('Hello');
      await Promise.resolve();
    });

    // Capture the session ID passed to useAIChat before streaming
    const idBefore = (latestUseChatOptions as Record<string, unknown>)?.id;

    // Simulate streaming state
    aiChatState.status = 'streaming';
    aiChatState.messages = [
      { id: 'msg-1', role: 'user', content: 'Hello' },
      { id: 'msg-2', role: 'assistant', content: 'Hi there' },
    ];
    rerender({ convId: null });

    // Now parent sets the real conversationId (pendingConversationIdRef clears)
    rerender({ convId: 'conv-1' });

    // The id passed to useAIChat should remain stable (not flicker to 'draft:...')
    const idAfter = (latestUseChatOptions as Record<string, unknown>)?.id;
    expect(idAfter).toBe(idBefore);

    // Cleanup
    aiChatState.status = 'ready';
    appendDeferred.resolve();
    await appendDeferred.promise;
  });

  it('switches the AI chat session when changing conversations while idle', async () => {
    const { rerender } = renderHook(
      ({ convId }) => useChat(convId),
      { initialProps: { convId: 'conv-1' as string | null } },
    );

    expect((latestUseChatOptions as Record<string, unknown>)?.id).toBe('conv-1:default');

    rerender({ convId: 'conv-2' });

    await waitFor(() => {
      expect((latestUseChatOptions as Record<string, unknown>)?.id).toBe('conv-2:default');
    });
  });

  it('blocks setMessages during streaming unless forced', async () => {
    const { result, rerender } = renderHook(
      ({ convId }) => useChat(convId),
      { initialProps: { convId: 'conv-1' as string | null } },
    );

    // Simulate streaming on conv-1
    aiChatState.status = 'streaming';
    aiChatState.messages = [
      { id: 'msg-1', role: 'user', content: 'Hello' },
      { id: 'msg-2', role: 'assistant', content: 'Streaming...' },
    ];
    rerender({ convId: 'conv-1' });

    aiChatState.setMessages.mockClear();
    dbMock.messages.getByConversation.mockClear();

    // Switch to null (new thread) during streaming — would normally call setMessages([])
    rerender({ convId: null });

    // setMessages should NOT be called because isStreaming guard blocks it
    expect(aiChatState.setMessages).not.toHaveBeenCalled();

    // Stop streaming — the deferred switch should now execute
    aiChatState.status = 'ready';
    rerender({ convId: null });

    // Now setMessages should be called with empty array (clearing for new thread)
    expect(aiChatState.setMessages).toHaveBeenCalledWith([]);
  });

  it('defers conversation hydration while streaming', async () => {
    const { result, rerender } = renderHook(
      ({ convId }) => useChat(convId),
      { initialProps: { convId: 'conv-1' as string | null } },
    );

    // Simulate streaming
    aiChatState.status = 'streaming';
    aiChatState.messages = [
      { id: 'msg-1', role: 'user', content: 'Hello' },
      { id: 'msg-2', role: 'assistant', content: 'Working...' },
    ];
    rerender({ convId: 'conv-1' });

    aiChatState.setMessages.mockClear();
    dbMock.messages.getByConversation.mockClear();

    // Switch conversation during streaming
    rerender({ convId: 'conv-2' });

    // hydration should be deferred (getByConversation not called for conv-2)
    expect(dbMock.messages.getByConversation).not.toHaveBeenCalledWith('conv-2');

    // Once streaming stops, effect should re-run and hydrate
    aiChatState.status = 'ready';
    rerender({ convId: 'conv-2' });

    await waitFor(() => {
      expect(dbMock.messages.getByConversation).toHaveBeenCalledWith('conv-2');
    });
  });

  it('requires 3 stable cycles for content-matched proposals before pausing', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      autoApproveRepoChanges: false,
    }));

    const { rerender } = renderHook(() => useChat('conv-1'));

    const proposalMessage = {
      id: 'assistant-proposal',
      role: 'assistant',
      content: 'Here are the proposed changes:\n```\nindex.html\n```\n<html>Updated</html>',
      parts: [
        {
          type: 'tool-invocation',
          toolInvocation: {
            toolCallId: 'tc-propose',
            toolName: 'propose_changes',
            state: 'result',
            args: { changes: [{ action: 'edit', path: 'index.html' }] },
            result: { approved: false },
          },
        },
      ],
    };

    // First cycle with proposal - should not stop yet
    aiChatState.status = 'streaming';
    aiChatState.messages = [
      { id: 'msg-1', role: 'user', content: 'Make changes' },
      proposalMessage as unknown as { id: string; role: string; content: string },
    ];
    rerender();

    // stop() should not be called on first cycle for content-matched proposals
    // (explicit onToolCall proposals bypass the counter)
    expect(aiChatState.stop).not.toHaveBeenCalled();

    // Cleanup
    aiChatState.status = 'ready';
    aiChatState.messages = [];
    rerender();
  });

});
