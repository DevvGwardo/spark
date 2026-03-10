import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

describe('SettingsModal', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUIStore.setState({
      sidebarOpen: false,
      sidebarWidth: 256,
      settingsOpen: true,
      setupWizardOpen: false,
      activeTab: 'chat',
    });
    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'minimax',
      providers: {
        ...state.providers,
        minimax: {
          ...state.providers.minimax,
          model: 'MiniMax-M2.5',
          apiKey: 'test-key',
        },
      },
    }));
  });

  it('renders the desktop-style settings workspace and switches tabs', () => {
    render(<SettingsModal />);

    expect(screen.getByText('Workspace Settings')).toBeInTheDocument();
    expect(screen.getAllByText('MiniMax (Coding Plan)').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(screen.getByText('GitHub Integration')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.getByText('Auto-approve repo changes')).toBeInTheDocument();
  });
});
