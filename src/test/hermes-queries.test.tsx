import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/hermes-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hermes-api')>();
  return {
    ...actual,
    fetchHermesWorkspaceOverview: vi.fn(),
    fetchHermesWorkspaceFiles: vi.fn(),
    fetchHermesWorkspaceFile: vi.fn(),
    updateHermesWorkspaceFile: vi.fn(),
    fetchHermesSkills: vi.fn(),
    fetchSkillsHub: vi.fn(),
    installHubSkill: vi.fn(),
    fetchHermesProjects: vi.fn(),
    activateHermesProject: vi.fn(),
    fetchHermesMcpServers: vi.fn(),
    installHermesMcpServer: vi.fn(),
  };
});

import * as api from '@/lib/hermes-api';
import { HermesApiError } from '@/lib/hermes-api';
import {
  BridgeReadyContext,
  hermesKeys,
  useActivateHermesProject,
  useHermesMcpServers,
  useHermesProjects,
  useHermesSkills,
  useHermesWorkspaceFile,
  useHermesWorkspaceOverview,
  useInstallHermesMcpServer,
  useInstallHubSkill,
  useSkillsHub,
  useUpdateWorkspaceFile,
} from '@/lib/hermes-queries';
import { readinessPollInterval } from '@/lib/bridge-readiness';
import { useProfilesStore } from '@/stores/profiles-store';
import { createTestQueryClient } from './support/query-client';

const mocked = vi.mocked(api);

function setup(options: { bridgeReady?: boolean } = {}) {
  const client = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <BridgeReadyContext.Provider value={options.bridgeReady ?? true}>{children}</BridgeReadyContext.Provider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}

function file(key: string, content: string, version = 'v1') {
  return {
    key,
    label: `${key}.md`,
    description: '',
    path: `/h/${key}.md`,
    size: content.length,
    modified_at: null,
    version,
    preview: '',
    content,
  } as unknown as api.HermesWorkspaceFile;
}

beforeEach(() => {
  vi.clearAllMocks();
  useProfilesStore.setState({ activeProfile: 'default' });
});

describe('hermesKeys', () => {
  it('scopes every key by profile so profiles never share a cache entry', () => {
    expect(hermesKeys.overview('a')).not.toEqual(hermesKeys.overview('b'));
    expect(hermesKeys.file('a', 'soul').slice(0, 2)).toEqual(hermesKeys.all('a'));
    expect(hermesKeys.files('a')).toEqual(hermesKeys.file('a', 'soul').slice(0, -1));
  });
});

describe('query hooks', () => {
  it('fetches through the hermes-api function and caches under the profile key', async () => {
    mocked.fetchHermesWorkspaceOverview.mockResolvedValue({ hermes_home: '/h' } as api.HermesWorkspaceOverview);
    useProfilesStore.setState({ activeProfile: 'work' });
    const { client, wrapper } = setup();

    const { result } = renderHook(() => useHermesWorkspaceOverview(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.hermes_home).toBe('/h');
    expect(client.getQueryData(hermesKeys.overview('work'))).toEqual({ hermes_home: '/h' });
  });

  it('does not fetch while the bridge gate reports not-ready', async () => {
    mocked.fetchHermesWorkspaceOverview.mockResolvedValue({ hermes_home: '/h' } as api.HermesWorkspaceOverview);
    const { wrapper } = setup({ bridgeReady: false });

    const { result } = renderHook(() => useHermesWorkspaceOverview(), { wrapper });

    await new Promise((r) => setTimeout(r, 20));
    expect(mocked.fetchHermesWorkspaceOverview).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.isPending).toBe(true);
  });

  it('surfaces failures as the thrown error without retrying', async () => {
    mocked.fetchHermesSkills.mockRejectedValue(new HermesApiError('boom', 500));
    const { wrapper } = setup();

    const { result } = renderHook(() => useHermesSkills(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(HermesApiError);
    expect(mocked.fetchHermesSkills).toHaveBeenCalledTimes(1);
  });

  it('skips the per-file query until a key is selected', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useHermesWorkspaceFile(null), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(mocked.fetchHermesWorkspaceFile).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('only fetches the skills hub when enabled', async () => {
    mocked.fetchSkillsHub.mockResolvedValue([]);
    const { wrapper } = setup();
    const { rerender } = renderHook(({ enabled }) => useSkillsHub({ enabled }), {
      wrapper,
      initialProps: { enabled: false },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(mocked.fetchSkillsHub).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(mocked.fetchSkillsHub).toHaveBeenCalledTimes(1));
  });
});

describe('mutation hooks', () => {
  it('writes a saved file into both the file and the list caches', async () => {
    const saved = file('soul', 'new', 'v2');
    mocked.updateHermesWorkspaceFile.mockResolvedValue(saved);
    const { client, wrapper } = setup();
    client.setQueryData(hermesKeys.files('default'), [file('soul', 'old'), file('user', 'u')]);

    const { result } = renderHook(() => useUpdateWorkspaceFile(), { wrapper });
    await act(() => result.current.mutateAsync({ fileKey: 'soul', content: 'new', version: 'v1' }));

    expect(mocked.updateHermesWorkspaceFile).toHaveBeenCalledWith('soul', 'new', 'v1');
    expect(client.getQueryData(hermesKeys.file('default', 'soul'))).toEqual(saved);
    const list = client.getQueryData<api.HermesWorkspaceFileSummary[]>(hermesKeys.files('default'));
    expect(list?.[0]).toEqual(saved);
    expect(list?.[1].key).toBe('user');
  });

  it('loads the latest disk version on a 409 conflict', async () => {
    const latest = file('soul', 'disk', 'v9');
    mocked.updateHermesWorkspaceFile.mockRejectedValue(new HermesApiError('conflict', 409, { file: latest }));
    const { client, wrapper } = setup();

    const { result } = renderHook(() => useUpdateWorkspaceFile(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({ fileKey: 'soul', content: 'mine', version: 'v1' }),
      ).rejects.toBeInstanceOf(HermesApiError);
    });

    expect(client.getQueryData(hermesKeys.file('default', 'soul'))).toEqual(latest);
  });

  it('marks a hub skill installed and invalidates the installed list', async () => {
    mocked.installHubSkill.mockResolvedValue(undefined);
    mocked.fetchHermesSkills.mockResolvedValue([]);
    const { client, wrapper } = setup();
    client.setQueryData(hermesKeys.skillsHub('default'), [
      { name: 'a', installed: false },
      { name: 'b', installed: false },
    ]);
    const { result } = renderHook(() => ({ skills: useHermesSkills(), install: useInstallHubSkill() }), { wrapper });
    await waitFor(() => expect(result.current.skills.isSuccess).toBe(true));
    expect(mocked.fetchHermesSkills).toHaveBeenCalledTimes(1);

    await act(() => result.current.install.mutateAsync('b'));

    expect(client.getQueryData(hermesKeys.skillsHub('default'))).toEqual([
      { name: 'a', installed: false },
      { name: 'b', installed: true },
    ]);
    await waitFor(() => expect(mocked.fetchHermesSkills).toHaveBeenCalledTimes(2));
  });

  it('refetches MCP servers after an install', async () => {
    mocked.fetchHermesMcpServers.mockResolvedValue([]);
    mocked.installHermesMcpServer.mockResolvedValue({ ok: true } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => ({ servers: useHermesMcpServers(), install: useInstallHermesMcpServer() }), { wrapper });
    await waitFor(() => expect(result.current.servers.isSuccess).toBe(true));

    await act(() => result.current.install.mutateAsync('brave-search'));

    await waitFor(() => expect(mocked.fetchHermesMcpServers).toHaveBeenCalledTimes(2));
  });

  it('replaces the cached project list and assumes the activated slug when the response omits it', async () => {
    mocked.fetchHermesProjects.mockResolvedValue({ ok: true, projects: [], active_slug: 'old' });
    mocked.activateHermesProject.mockResolvedValue({
      ok: true,
      projects: [{ slug: 'next', name: 'Next', id: '1', folders: [] }],
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => ({ list: useHermesProjects(), use: useActivateHermesProject() }), { wrapper });
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    await act(() => result.current.use.mutateAsync('next'));

    await waitFor(() => expect(result.current.list.data?.active_slug).toBe('next'));
    expect(result.current.list.data?.projects.map((p) => p.slug)).toEqual(['next']);
  });

  it('turns an ok:false project response into an error', async () => {
    mocked.activateHermesProject.mockResolvedValue({ ok: false, projects: [], error: 'nope' });
    const { wrapper } = setup();
    const { result } = renderHook(() => useActivateHermesProject(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync('x')).rejects.toThrow('nope');
    });
  });
});

describe('readinessPollInterval', () => {
  it('polls fast while coming up and relaxes once ready', () => {
    expect(readinessPollInterval(undefined)).toBe(2_000);
    expect(readinessPollInterval('starting')).toBe(2_000);
    expect(readinessPollInterval('restarting')).toBe(2_000);
    expect(readinessPollInterval('ready')).toBe(15_000);
    expect(readinessPollInterval('degraded')).toBe(15_000);
  });
});
