import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from '@/components/chat/ChatArea';
import { PanelProvider } from '@/contexts/PanelContext';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

vi.mock('@/components/chat/MessageBubble', () => ({
  MessageBubble: ({ message }: { message: { content: string } }) => <div>{message.content}</div>,
}));

vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock('@/components/chat/ActivityIndicator', () => ({
  ActivityIndicator: () => <div data-testid="activity-indicator" />,
}));

vi.mock('@/components/chat/WelcomeScreen', () => ({
  WelcomeScreen: () => <div data-testid="welcome-screen" />,
}));

vi.mock('@/components/chat/ApiKeyModal', () => ({
  ApiKeyModal: () => null,
}));

vi.mock('@/components/chat/ChangeApprovalModal', () => ({
  ChangeApprovalModal: () => null,
}));

vi.mock('@/lib/providers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/providers')>('@/lib/providers');
  return {
    ...actual,
    getProviderLabel: (provider: string) => provider,
  };
});

vi.mock('@/lib/proposed-changes', () => ({
  getProposalDigest: () => '',
  findPendingProposal: () => null,
}));

vi.mock('@/lib/tokens', () => ({
  getContextUsage: () => ({ used: 0, total: 1, percentage: 0 }),
}));

const baseSettingsState = useSettingsStore.getState();
const baseUiState = useUIStore.getState();

function renderChatArea(error: unknown, messages: Array<{ id: string; role: string; content: string }> = []) {
  return render(
    <PanelProvider value="panel-1">
      <ChatArea
        conversationId="conv-1"
        messages={messages}
        input=""
        setInput={() => {}}
        handleSend={() => {}}
        handleStop={() => {}}
        handleRegenerate={() => {}}
        isStreaming={false}
        error={error as Error}
        apiKeyModalOpen={false}
        setApiKeyModalOpen={() => {}}
        activeProvider="hermes"
        activeModel={useSettingsStore.getState().providers.hermes.model}
      />
    </PanelProvider>,
  );
}

describe('ChatErrorBanner', () => {
  afterEach(() => {
    useSettingsStore.setState(baseSettingsState, true);
    useUIStore.setState(baseUiState, true);
  });

  it('switches Hermes to a suggested model directly from the error banner', () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      activeProvider: 'hermes',
      providers: {
        ...useSettingsStore.getState().providers,
        hermes: {
          ...useSettingsStore.getState().providers.hermes,
          model: 'nousresearch/hermes-3-llama-3.1-405b:free',
        },
      },
    });

    renderChatArea(
      new Error("[Error: Model 'nousresearch/hermes-3-llama-3.1-405b:free' is not compatible with Hermes tool calls on OpenRouter. Choose a tool-capable model like meta-llama/llama-4-maverick, openai/gpt-4.1-mini, google/gemini-2.5-flash.]"),
    );

    fireEvent.click(screen.getByRole('button', { name: /llama-4-maverick/i }));

    expect(useSettingsStore.getState().providers.hermes.model).toBe('meta-llama/llama-4-maverick');
    expect(screen.queryByText(/switch to a tool-capable model/i)).not.toBeInTheDocument();
  });

  it('opens settings from the error banner', () => {
    renderChatArea(
      new Error("[Error: Model 'nousresearch/hermes-3-llama-3.1-405b:free' is not compatible with Hermes tool calls on OpenRouter. Choose a tool-capable model like meta-llama/llama-4-maverick, openai/gpt-4.1-mini, google/gemini-2.5-flash.]"),
    );

    fireEvent.click(screen.getByRole('button', { name: /open hermes settings/i }));

    expect(useUIStore.getState().settingsOpen).toBe(true);
  });

  it('renders a neutral local API banner for connectivity failures', () => {
    window.history.replaceState({}, '', '/?apiPort=4312#/chat');

    renderChatArea(new Error('Failed after 3 attempts. Last error: Cannot connect to API:'));

    expect(screen.getByText(/could not reach the local api server/i)).toBeInTheDocument();
    expect(screen.getByText('http://localhost:4312')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open settings/i })).toBeInTheDocument();
  });

  it('tells the user to start Hermes bridge when the Hermes runtime is unavailable', () => {
    renderChatArea(new Error('Hermes bridge is not reachable at http://localhost:3002/v1. Start hermes-bridge/main.py and try again.'));

    expect(screen.getByText(/start the hermes bridge/i)).toBeInTheDocument();
    expect(screen.getByText(/cd hermes-bridge && \.venv\/bin\/python main.py/i)).toBeInTheDocument();
    expect(screen.getByText('http://localhost:3002/v1')).toBeInTheDocument();
  });

  it('re-shows the same connectivity error after a new user message is sent', () => {
    const errorMessage = 'Failed after 3 attempts. Last error: Cannot connect to API:';
    const { rerender } = renderChatArea(new Error(errorMessage), [
      { id: 'user-1', role: 'user', content: 'first request' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    expect(screen.queryByText(/could not reach the local api server/i)).not.toBeInTheDocument();

    rerender(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[
            { id: 'user-1', role: 'user', content: 'first request' },
            { id: 'user-2', role: 'user', content: 'second request' },
          ]}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming={false}
          error={new Error(errorMessage)}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel={useSettingsStore.getState().providers.hermes.model}
        />
      </PanelProvider>,
    );

    expect(screen.getByText(/could not reach the local api server/i)).toBeInTheDocument();
  });

  it('extracts readable provider messages from structured error objects', () => {
    renderChatArea({
      error: {
        message: 'Provider quota exceeded',
      },
    });

    expect(screen.getByText('Provider quota exceeded')).toBeInTheDocument();
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
  });

  it('summarizes malformed repo tool arguments instead of dumping the raw payload', () => {
    renderChatArea(new Error(`Invalid arguments for tool batch_edit_repo_files: Type validation failed: Value: {"changes":[{"path":"server/src/index.ts","action":"edit"},{"content":"missing path and action"}]}. Error message: [{"code":"invalid_type","expected":"string","received":"undefined","path":["changes",1,"path"],"message":"Required"},{"code":"invalid_type","expected":"string","received":"undefined","path":["changes",1,"action"],"message":"Required"}]`));

    expect(screen.getByText('Invalid arguments for batch_edit_repo_files. change 2 is missing path, action.')).toBeInTheDocument();
    expect(screen.queryByText(/Type validation failed: Value:/)).not.toBeInTheDocument();
  });
});
