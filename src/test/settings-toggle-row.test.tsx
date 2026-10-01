import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

const baseSettingsState = useSettingsStore.getState();
const baseUiState = useUIStore.getState();

describe('SettingsModal ToggleRow', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    window.localStorage.clear();
    useUIStore.setState({ settingsOpen: true, settingsSection: 'general' });
    useSettingsStore.setState({ streamResponses: true });
  });

  afterEach(() => {
    act(() => {
      useSettingsStore.setState(baseSettingsState, true);
      useUIStore.setState(baseUiState, true);
    });
    vi.unstubAllGlobals();
  });

  it('exposes switch semantics that track the setting', () => {
    render(<SettingsModal />);

    const toggle = screen.getByRole('switch', { name: 'Stream responses' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);

    expect(useSettingsStore.getState().streamResponses).toBe(false);
    expect(screen.getByRole('switch', { name: 'Stream responses' })).toHaveAttribute('aria-checked', 'false');
  });

  it('does not offer the placeholder Knowledge tab', () => {
    render(<SettingsModal />);

    expect(screen.queryByRole('button', { name: 'Knowledge' })).not.toBeInTheDocument();
  });
});
