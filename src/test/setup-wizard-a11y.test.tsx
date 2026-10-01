import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupWizard } from '@/components/settings/SetupWizard';
import type { HermesBridgeStatus } from '@/lib/detect-hermes';
import { useSettingsStore } from '@/stores/settings-store';

const detectHermesBridgeMock = vi.fn<() => Promise<HermesBridgeStatus | null>>();
const openExternalUrlMock = vi.fn();

vi.mock('@/lib/detect-hermes', () => ({
  detectHermesBridge: () => detectHermesBridgeMock(),
}));

vi.mock('@/lib/open-external', () => ({
  openExternalUrl: (url: string) => openExternalUrlMock(url),
}));

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

const baseSettingsState = useSettingsStore.getState();

async function renderWizard() {
  render(<SetupWizard />);
  // Bootstrap runs bridge detection before the first step renders.
  await screen.findByRole('button', { name: /Continue/ });
}

describe('SetupWizard accessibility', () => {
  beforeEach(() => {
    window.localStorage.clear();
    detectHermesBridgeMock.mockReset();
    detectHermesBridgeMock.mockResolvedValue(bridgeWithoutCreds);
    openExternalUrlMock.mockReset();
    useSettingsStore.setState({ isSetupComplete: false });
  });

  afterEach(() => {
    act(() => {
      useSettingsStore.setState(baseSettingsState, true);
    });
  });

  it('marks Continue busy while the Hermes bridge is being checked', async () => {
    await renderWizard();

    let resolveDetection: (status: HermesBridgeStatus | null) => void = () => {};
    detectHermesBridgeMock.mockReturnValueOnce(new Promise((resolve) => { resolveDetection = resolve; }));

    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    const busy = await screen.findByRole('button', { name: /Checking/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      resolveDetection(bridgeWithoutCreds);
    });
  });

  it('labels the key visibility toggle and links to the provider key page', async () => {
    await renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /Connect with another provider/ }));
    fireEvent.click(screen.getByRole('button', { name: /^OpenAI/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    const keyInput = await screen.findByPlaceholderText('sk-...');
    expect(keyInput).toHaveAttribute('type', 'password');

    const toggle = screen.getByRole('button', { name: 'Show API key' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide API key' })).toHaveAttribute('aria-pressed', 'true');
    expect(keyInput).toHaveAttribute('type', 'text');

    const helpLink = screen.getByRole('link', { name: 'platform.openai.com/api-keys' });
    expect(helpLink).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    fireEvent.click(helpLink);
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://platform.openai.com/api-keys');
  });
});
