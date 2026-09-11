import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickWindow } from '@/components/quick/QuickWindow';
import { handleDeepLinkNavigate, handleQuickCapture } from '@/lib/deep-link';
import { clear as clearToasts, getToasts } from '@/lib/toast';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

function resetStores() {
  window.localStorage.clear();
  clearToasts();
  useChatStore.setState((state) => ({
    ...state,
    conversations: [],
    loadConversations: vi.fn().mockResolvedValue(undefined),
  }));
  useUIStore.setState((state) => ({
    ...state,
    activeTab: 'chat',
    activeSubTab: 'threads',
    pendingPanelPrompts: {},
  }));
  usePanelStore.setState((state) => ({
    ...state,
    panels: [{ id: 'default', conversationId: null, profile: 'default' }],
    focusedPanelId: 'default',
  }));
  useSettingsStore.setState((state) => ({
    ...state,
    activeProvider: 'openai',
  }));
}

describe('QuickWindow', () => {
  const submit = vi.fn();

  beforeEach(() => {
    resetStores();
    submit.mockReset().mockResolvedValue({ ok: true });
    (window as unknown as { electronAPI?: unknown }).electronAPI = { quick: { submit } };
  });

  it('renders the capture input with the cmd-style placeholder', () => {
    render(<QuickWindow />);
    expect(screen.getByLabelText('Quick capture input')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask Spark/)).toBeInTheDocument();
  });

  it('submits trimmed text on Enter and clears the input on success', async () => {
    render(<QuickWindow />);
    const input = screen.getByLabelText('Quick capture input');
    fireEvent.change(input, { target: { value: '  hello spark  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledWith('hello spark'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  });

  it('ignores empty input on Enter', async () => {
    render(<QuickWindow />);
    fireEvent.keyDown(screen.getByLabelText('Quick capture input'), { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 20));
    expect(submit).not.toHaveBeenCalled();
  });

  it('shows a subtle error when submit rejects', async () => {
    submit.mockRejectedValueOnce(new Error('ipc down'));
    render(<QuickWindow />);
    const input = screen.getByLabelText('Quick capture input');
    fireEvent.change(input, { target: { value: 'try this' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not send/);
  });

  it('closes the window on Escape', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    try {
      render(<QuickWindow />);
      fireEvent.keyDown(screen.getByLabelText('Quick capture input'), { key: 'Escape' });
      expect(close).toHaveBeenCalled();
    } finally {
      close.mockRestore();
    }
  });
});

describe('quick capture + deep-link handlers', () => {
  beforeEach(resetStores);

  it('prefills (never sends) a new thread on capture', () => {
    handleQuickCapture('  captured thought  ');
    expect(useUIStore.getState().activeTab).toBe('chat');
    expect(usePanelStore.getState().focusedPanelId).toBe('default');
    expect(useUIStore.getState().pendingPanelPrompts.default).toEqual({
      content: 'captured thought',
      autoSend: false,
    });
  });

  it('ignores blank captures', () => {
    handleQuickCapture('   ');
    expect(useUIStore.getState().pendingPanelPrompts.default).toBeUndefined();
  });

  it('selects an existing conversation for chat links', () => {
    useChatStore.setState((state) => ({
      ...state,
      conversations: [{ id: 'conv-1' } as never],
    }));
    handleDeepLinkNavigate({ kind: 'chat', id: 'conv-1' });
    expect(usePanelStore.getState().panels[0].conversationId).toBe('conv-1');
  });

  it('notes (but does not blank the panel for) unknown chat ids', () => {
    handleDeepLinkNavigate({ kind: 'chat', id: 'nope' });
    expect(usePanelStore.getState().panels[0].conversationId).toBeNull();
    expect(getToasts().some((t) => t.message.includes('nope'))).toBe(true);
  });

  it('opens the Skills surface for skill links under hermes', () => {
    useSettingsStore.setState((state) => ({ ...state, activeProvider: 'hermes' }));
    handleDeepLinkNavigate({ kind: 'skill', name: 'composer-code' });
    expect(useUIStore.getState().activeSubTab).toBe('skills');
  });

  it('toasts skill links when no skills surface applies', () => {
    handleDeepLinkNavigate({ kind: 'skill', name: 'composer-code' });
    expect(useUIStore.getState().activeSubTab).toBe('threads');
    expect(getToasts().some((t) => t.message.includes('composer-code'))).toBe(true);
  });

  it('ignores oauth links — the localhost flow owns OAuth', () => {
    handleDeepLinkNavigate({ kind: 'oauth' });
    expect(getToasts()).toHaveLength(0);
    expect(useUIStore.getState().pendingPanelPrompts.default).toBeUndefined();
  });
});
