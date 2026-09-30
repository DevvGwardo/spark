import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/chat/ChatInput';

/**
 * Interactive behavior of the composer: keyboard dead-ends (Enter with an
 * unmatching slash command, outside-click dismissal, IME composition), the
 * command popover's combobox/listbox semantics, and up-arrow history.
 */
describe('ChatInput send + command suggestions', () => {
  const onSend = vi.fn();

  function Harness() {
    const [value, setValue] = useState('');
    return <ChatInput value={value} onChange={setValue} onSend={onSend} isStreaming={false} />;
  }

  beforeEach(() => {
    onSend.mockClear();
  });

  it('sends a slash-prefixed line when no command matches instead of swallowing Enter', async () => {
    // Typing an unknown slash command opens the (empty) popover; Enter must
    // fall through to send rather than silently doing nothing.
    render(<Harness />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '/zzzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it('selects a matching command with Enter (popover still works)', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '/help' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // /help is a known local no-arg command — it executes instead of sending.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('closes the command popover when clicking outside', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '/h' } });
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('exposes combobox/listbox semantics with aria-activedescendant', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('enterKeyHint')).toBe('send');

    fireEvent.change(input, { target: { value: '/h' } });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const controlsId = input.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    expect(screen.getByRole('listbox').id).toBe(controlsId);
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    expect(input.getAttribute('aria-activedescendant')).toMatch(/opt-/);
  });

  it('does not send while an IME composition is in progress', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('restores previously sent messages with ArrowUp when the composer is empty', async () => {
    const sent = vi.fn();
    function HistoryHarness() {
      const [value, setValue] = useState('');
      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSend={() => {
            sent();
            setValue('');
          }}
          isStreaming={false}
        />
      );
    }
    render(<HistoryHarness />);
    const input = screen.getByRole('combobox') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'check git status' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('check git status');
  });
});