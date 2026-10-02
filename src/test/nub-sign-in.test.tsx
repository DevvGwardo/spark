import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/open-external', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/nub-api', () => ({
  nubApi: {
    status: vi.fn(),
    start: vi.fn(),
    poll: vi.fn(),
    refreshKey: vi.fn(),
    logout: vi.fn(),
  },
}));

import { NubSignIn } from '@/components/settings/NubSignIn';
import { nubApi } from '@/lib/nub-api';
import { openExternalUrl } from '@/lib/open-external';
import { useSettingsStore } from '@/stores/settings-store';

const api = vi.mocked(nubApi);
const LINKED = {
  linked: true as const,
  reachable: true,
  origin: 'https://www.maiavm.com',
  instance: { id: 'inst_1', publicUrl: 'https://a', status: 'running' },
  keyPrefix: 'hermes_pk_R…X',
  keyExpiresAt: 1800000000,
};
const KEY = { apiKey: 'hermes_pk_raw', keyPrefix: 'hermes_pk_R…X', keyExpiresAt: 1800000000, models: ['glm-5.3-flash'] };

describe('NubSignIn', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useSettingsStore.getState().updateProviderConfig('nub', { apiKey: '' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('signs in through Telegram and stores the nub key as the provider key', async () => {
    api.status.mockResolvedValueOnce({ linked: false }).mockResolvedValue(LINKED);
    api.start.mockResolvedValue({ code: 'ABCD-EFGH', telegramUrl: 'https://t.me/nub?start=x', pairingUrl: null, pollInterval: 2 });
    api.poll
      .mockResolvedValueOnce({ status: 'provisioning', instanceStatus: 'booting' })
      .mockResolvedValueOnce({ status: 'ready', instance: LINKED.instance, mcpRegistered: true, ...KEY });
    const onLinked = vi.fn();
    render(<NubSignIn onLinked={onLinked} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Nub' }));

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    expect(openExternalUrl).toHaveBeenCalledWith('https://t.me/nub?start=x');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Your nub agent is starting up');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(useSettingsStore.getState().providers.nub).toMatchObject({ apiKey: 'hermes_pk_raw', model: 'glm-5.3-flash' });
    expect(await screen.findByText(/Linked to Nub/)).toBeInTheDocument();
    expect(screen.getByText(/your agent is running/)).toBeInTheDocument();
  });

  it('explains a denied sign-in and lets the user start over', async () => {
    api.status.mockResolvedValue({ linked: false });
    api.start.mockResolvedValue({ code: 'ABCD-EFGH', telegramUrl: 'https://t.me/x', pairingUrl: null, pollInterval: 2 });
    api.poll.mockResolvedValue({ status: 'denied' });
    render(<NubSignIn autoOpen={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Nub' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByRole('status')).toHaveTextContent('The sign-in was denied in Telegram.');
    expect(screen.getByRole('button', { name: 'Sign in with Nub' })).toBeEnabled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('offers Continue when already linked inside a flow that wants it', async () => {
    api.status.mockResolvedValue(LINKED);
    useSettingsStore.getState().updateProviderConfig('nub', { apiKey: 'hermes_pk_raw' });
    const onLinked = vi.fn();
    render(<NubSignIn onLinked={onLinked} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(api.refreshKey).not.toHaveBeenCalled();
  });

  it('fetches a fresh key when linked but the key is missing, and signs out', async () => {
    api.status.mockResolvedValueOnce(LINKED).mockResolvedValue({ linked: false });
    api.refreshKey.mockResolvedValue(KEY);
    api.logout.mockResolvedValue({ ok: true, revoked: true });
    render(<NubSignIn />);

    await waitFor(() => expect(useSettingsStore.getState().providers.nub.apiKey).toBe('hermes_pk_raw'));

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(useSettingsStore.getState().providers.nub.apiKey).toBe(''));
    expect(await screen.findByRole('button', { name: 'Sign in with Nub' })).toBeInTheDocument();
  });
});
