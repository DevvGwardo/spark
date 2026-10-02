import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '@/components/overlay/CommandPalette';
import { paletteFilter } from '@/lib/palette-filter';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';
import type { Conversation } from '@/lib/db';

const baseChat = useChatStore.getState();
const basePanel = usePanelStore.getState();
const baseSettings = useSettingsStore.getState();
const baseUi = useUIStore.getState();

const conversation = (id: string, title: string, updatedAt: string): Conversation => ({
  id,
  title,
  provider: 'hermes',
  model: 'm',
  systemPrompt: '',
  createdAt: updatedAt,
  updatedAt,
});

describe('paletteFilter', () => {
  it('ranks label prefix over word prefix over substring over keyword', () => {
    expect(paletteFilter('Settings Providers', 'set')).toBe(1);
    expect(paletteFilter('Toggle terminal', 'term')).toBe(0.8);
    expect(paletteFilter('Browse repo issues', 'ssue')).toBe(0.6);
    expect(paletteFilter('Browse repo issues', 'git', ['github'])).toBe(0.4);
  });

  it('hides subsequence-only matches', () => {
    expect(paletteFilter('Go to Sessions', 'set', ['section'])).toBe(0);
    expect(paletteFilter('Switch to dark theme', 'set')).toBe(0);
  });
});

describe('CommandPalette', () => {
  const onOpenChange = vi.fn();
  const onOpenRemoteAccess = vi.fn();

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    useSettingsStore.setState({ activeProvider: 'hermes', theme: 'dark' });
    useChatStore.setState({
      conversations: [
        conversation('c1', 'Older thread', '2026-09-01T00:00:00Z'),
        conversation('c2', 'Fix flaky e2e', '2026-10-01T00:00:00Z'),
      ],
    });
  });

  afterEach(() => {
    act(() => {
      useChatStore.setState(baseChat, true);
      usePanelStore.setState(basePanel, true);
      useSettingsStore.setState(baseSettings, true);
      useUIStore.setState(baseUi, true);
    });
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const renderPalette = () =>
    render(<CommandPalette open onOpenChange={onOpenChange} onOpenRemoteAccess={onOpenRemoteAccess} />);

  it('runs real actions and closes', () => {
    renderPalette();
    fireEvent.click(screen.getByText('Settings: GitHub'));
    expect(useUIStore.getState().settingsOpen).toBe(true);
    expect(useUIStore.getState().settingsSection).toBe('github');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('switches theme and navigates to sidebar sections', () => {
    renderPalette();
    fireEvent.click(screen.getByText('Switch to light theme'));
    expect(useSettingsStore.getState().theme).toBe('light');

    fireEvent.click(screen.getByText('Skills'));
    expect(useUIStore.getState().activeSubTab).toBe('skills');
    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it('lists recent threads newest first and opens one', () => {
    const openConversation = vi.fn(() => 'panel');
    usePanelStore.setState({ openConversation });
    renderPalette();
    const titles = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(titles.findIndex((t) => t.startsWith('Fix flaky e2e'))).toBeLessThan(
      titles.findIndex((t) => t.startsWith('Older thread')),
    );
    fireEvent.click(screen.getByText('Fix flaky e2e'));
    expect(openConversation).toHaveBeenCalledWith('c2');
  });

  it('hides Hermes-only commands for other providers', () => {
    useSettingsStore.setState({ activeProvider: 'openai' });
    renderPalette();
    expect(screen.queryByText('Toggle Hermes terminal')).toBeNull();
    expect(screen.queryByText('Go to')).toBeNull();
  });
});
