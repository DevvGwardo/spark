import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatInput } from '@/components/chat/ChatInput';
import { useSettingsStore } from '@/stores/settings-store';

describe('ChatInput reasoning selector', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'openai',
      providers: {
        ...state.providers,
        openai: {
          ...state.providers.openai,
          model: 'gpt-5.2',
          reasoningEffort: 'high',
        },
        minimax: {
          ...state.providers.minimax,
          model: 'MiniMax-M2.5',
          reasoningEffort: 'high',
        },
      },
    }));
  });

  it('shows the reasoning selector for supported OpenAI reasoning models', () => {
    render(
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        isStreaming={false}
      />
    );

    expect(
      screen.getByRole('button', { name: /reasoning effort: high/i }),
    ).toBeInTheDocument();
  });

  it('hides the context ring on a blank new conversation', () => {
    render(
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        isStreaming={false}
      />
    );

    expect(
      screen.queryByLabelText(/context used/i),
    ).not.toBeInTheDocument();
  });

  it('shows the context ring after the conversation has message history', () => {
    render(
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        isStreaming={false}
        messages={[{ role: 'user', content: 'Build the dashboard shell.' }]}
      />
    );

    expect(
      screen.getByLabelText(/context used/i),
    ).toBeInTheDocument();
  });

  it('hides the reasoning selector for unsupported providers', () => {
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'minimax',
    }));

    render(
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        isStreaming={false}
      />
    );

    expect(
      screen.queryByRole('button', { name: /reasoning effort/i }),
    ).not.toBeInTheDocument();
  });
});
