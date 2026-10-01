import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesBridgeStatus } from '@/lib/detect-hermes';
import { useSettingsStore } from '@/stores/settings-store';

const bridgeWithoutCreds: HermesBridgeStatus = {
  isReachable: true,
  hasOpenRouterCreds: false,
  hasMiniMaxCreds: false,
  providerCredentials: {},
  hasAnyCreds: false,
  defaultModelCredentialed: false,
  credentialSources: { authJson: false, env: false, openclawGateway: false },
  credentialSourcesMinimax: { env: false, openclawGateway: false },
  launchTokenPresent: false,
  brainInitialized: false,
  activeRequests: 0,
};

vi.mock('@/lib/detect-hermes', () => ({ detectHermesBridge: vi.fn(async () => bridgeWithoutCreds) }));
vi.mock('@/lib/open-external', () => ({ openExternalUrl: vi.fn() }));
// The sign-in flow itself is covered by nub-sign-in.test.tsx; here it just
// reports success the way the real component does once the key is stored.
vi.mock('@/components/settings/NubSignIn', () => ({
  NubSignIn: ({ onLinked }: { onLinked?: () => void }) => (
    <button
      type="button"
      onClick={() => {
        useSettingsStore.getState().updateProviderConfig('nub', { apiKey: 'hermes_pk_raw' });
        onLinked?.();
      }}
    >
      fake nub sign-in
    </button>
  ),
}));

import { SetupWizard } from '@/components/settings/SetupWizard';

const baseSettingsState = useSettingsStore.getState();

describe('SetupWizard with Nub', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useSettingsStore.setState({ isSetupComplete: false });
  });

  afterEach(() => {
    act(() => {
      useSettingsStore.setState(baseSettingsState, true);
    });
  });

  it('offers Sign in with Nub up front and finishes with Nub as the active provider', async () => {
    render(<SetupWizard />);
    await screen.findByRole('button', { name: /Continue/ });

    fireEvent.click(screen.getByRole('button', { name: /Sign in with Nub/ }));
    expect(screen.getByRole('button', { name: /Sign in with Nub/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('sk-...')).not.toBeInTheDocument();
    // Let the 200ms step transition settle (a real sign-in takes seconds).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    fireEvent.click(screen.getByRole('button', { name: 'fake nub sign-in' }));

    fireEvent.click(await screen.findByRole('button', { name: /Start Chatting/ }));
    const state = useSettingsStore.getState();
    expect(state.isSetupComplete).toBe(true);
    expect(state.activeProvider).toBe('nub');
    expect(state.providers.nub).toMatchObject({ apiKey: 'hermes_pk_raw', model: 'glm-5.3-flash' });
  });
});

