import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextualSuggestions } from '@/components/chat/ContextualSuggestions';
import { PanelProvider } from '@/contexts/PanelContext';
import { useChangesetStore } from '@/stores/changeset-store';

vi.useFakeTimers();

function renderWithPanel(ui: React.ReactElement) {
  return render(
    <PanelProvider value="panel-1">{ui}</PanelProvider>,
  );
}

const bugAnalysisMessages = [
  { role: 'user', content: 'Find and fix bugs' },
  {
    role: 'assistant',
    content:
      'I found several bugs in the codebase. Here are the issues I identified:\n1. Missing null check\n2. Race condition',
  },
];

describe('ContextualSuggestions', () => {
  beforeEach(() => {
    useChangesetStore.setState({
      panelChangesets: {
        'panel-1': {
          activeRepo: { owner: 'test', name: 'repo', defaultBranch: 'main', fullName: 'test/repo' },
          isRepoMode: true,
          changes: {},
          repoFileTree: [],
          repoFileTreeStatus: 'idle',
          repoFileCache: {},
          pullRequest: null,
        },
      },
    });
  });

  it('renders nothing while streaming', () => {
    const onSend = vi.fn();
    const { container } = renderWithPanel(
      <ContextualSuggestions
        messages={bugAnalysisMessages}
        isStreaming={true}
        onSend={onSend}
      />,
    );

    act(() => { vi.advanceTimersByTime(500); });
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing with fewer than 2 messages', () => {
    const onSend = vi.fn();
    const { container } = renderWithPanel(
      <ContextualSuggestions
        messages={[{ role: 'user', content: 'hi' }]}
        isStreaming={false}
        onSend={onSend}
      />,
    );

    act(() => { vi.advanceTimersByTime(500); });
    expect(container.innerHTML).toBe('');
  });

  it('shows suggestion buttons after streaming stops', () => {
    const onSend = vi.fn();
    renderWithPanel(
      <ContextualSuggestions
        messages={bugAnalysisMessages}
        isStreaming={false}
        onSend={onSend}
      />,
    );

    act(() => { vi.advanceTimersByTime(500); });

    const buttons = screen.getAllByRole('button');
    // Should have suggestion buttons (3-4) plus possible scroll arrows
    const suggestionButtons = buttons.filter(
      (b) => !b.getAttribute('aria-label')?.includes('Scroll'),
    );
    expect(suggestionButtons.length).toBeGreaterThanOrEqual(3);
  });

  it('calls onSend with the prompt when a suggestion is clicked', () => {
    const onSend = vi.fn();
    renderWithPanel(
      <ContextualSuggestions
        messages={bugAnalysisMessages}
        isStreaming={false}
        onSend={onSend}
      />,
    );

    act(() => { vi.advanceTimersByTime(500); });

    const buttons = screen.getAllByRole('button').filter(
      (b) => !b.getAttribute('aria-label')?.includes('Scroll'),
    );
    fireEvent.click(buttons[0]);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(typeof onSend.mock.calls[0][0]).toBe('string');
    expect(onSend.mock.calls[0][0].length).toBeGreaterThan(0);
  });

  it('hides suggestions after a suggestion is clicked', () => {
    const onSend = vi.fn();
    const { container } = renderWithPanel(
      <ContextualSuggestions
        messages={bugAnalysisMessages}
        isStreaming={false}
        onSend={onSend}
      />,
    );

    act(() => { vi.advanceTimersByTime(500); });

    const buttons = screen.getAllByRole('button').filter(
      (b) => !b.getAttribute('aria-label')?.includes('Scroll'),
    );
    fireEvent.click(buttons[0]);

    // After clicking, suggestions should be dismissed
    expect(container.innerHTML).toBe('');
  });
});
