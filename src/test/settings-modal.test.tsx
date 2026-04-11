import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

const validateApiKeyMock = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    validateApiKey: (...args: Parameters<typeof actual.validateApiKey>) => validateApiKeyMock(...args),
  };
});

describe('SettingsModal', () => {
  beforeEach(() => {
    window.localStorage.clear();
    validateApiKeyMock.mockReset();
    validateApiKeyMock.mockResolvedValue({ valid: true, models: [] });
    useUIStore.setState({
      sidebarOpen: false,
      sidebarWidth: 256,
      settingsOpen: true,
      setupWizardOpen: false,
      repoBrowserOpen: false,
      activeTab: 'chat',
      pendingPanelPrompts: {},
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

  it('renders the settings modal with vertical nav and switches tabs', () => {
    render(<SettingsModal />);

    expect(screen.getByText('Settings')).toBeInTheDocument();
    // Provider list view shows provider cards
    expect(screen.getAllByText('MiniMax (Coding Plan)').length).toBeGreaterThan(0);

    // Switch to GitHub tab via sidebar nav
    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(screen.getByText('Personal Access Token')).toBeInTheDocument();

    // Switch to General tab via sidebar nav
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.getByText('Stream responses')).toBeInTheDocument();
  });

  it('shows local runtime startup guidance for Hermes providers', async () => {
    validateApiKeyMock.mockResolvedValue({
      valid: false,
      error: 'Hermes bridge is not reachable at http://localhost:3002/v1. Start hermes-bridge/main.py and try again.',
    });

    useSettingsStore.setState((state) => ({
      ...state,
      activeProvider: 'hermes',
      providers: {
        ...state.providers,
        hermes: {
          ...state.providers.hermes,
          apiKey: 'openrouter-key',
        },
      },
    }));

    render(<SettingsModal />);

    // Click the Hermes Agent card to enter detail view
    fireEvent.click(screen.getByText('Hermes Agent').closest('button')!);

    expect(await screen.findByText(/hermes needs its local bridge running/i)).toBeInTheDocument();
    expect(screen.getByText(/cd hermes-bridge && \.venv\/bin\/python main.py/i)).toBeInTheDocument();
    expect(screen.getByText(/start hermes-bridge\/main\.py and try again\./i)).toBeInTheDocument();
  });
});
