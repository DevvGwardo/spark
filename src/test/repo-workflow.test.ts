import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachRepoToPanel, getPanelChatScopeId, startRepoChatInNewThread } from '@/lib/repo-workflow';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePanelStore } from '@/stores/panel-store';
import { usePreviewStore } from '@/stores/preview-store';
import { useUIStore } from '@/stores/ui-store';

const apiMocks = vi.hoisted(() => ({
  fetchRepoFileTreeResult: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  fetchRepoFileTreeResult: apiMocks.fetchRepoFileTreeResult,
}));

const activeRepo = {
  owner: 'octo',
  name: 'cloudchat',
  defaultBranch: 'main',
  fullName: 'octo/cloudchat',
  permissions: { pull: true, push: true },
};

describe('repo workflow', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();

    apiMocks.fetchRepoFileTreeResult.mockResolvedValue({
      paths: ['README.md', 'src/hooks/useChat.ts'],
      error: null,
    });

    usePanelStore.setState({
      panels: [{ id: 'default', conversationId: 'conv-1', profile: 'default' }],
      focusedPanelId: 'default',
    });

    useChangesetStore.setState({
      panelChangesets: {},
    });

    usePreviewStore.setState({
      panelPreviews: {},
    });

    useUIStore.setState({
      sidebarOpen: false,
      sidebarWidth: 320,
      settingsOpen: false,
      setupWizardOpen: false,
      repoBrowserOpen: false,
      activeTab: 'chat',
      pendingPanelPrompts: {},
    });
  });

  it('resolves the active chat scope from the current panel conversation', () => {
    expect(getPanelChatScopeId('default')).toBe('conv-1');
  });

  it('attaches repositories to the active conversation scope', async () => {
    const attached = await attachRepoToPanel({
      panelId: 'default',
      scopeId: getPanelChatScopeId('default'),
      repo: activeRepo,
      githubPAT: 'ghp_test',
      openPreview: true,
    });

    expect(attached).toBe(true);
    expect(useChangesetStore.getState().getChangeset('conv-1').activeRepo).toMatchObject({
      fullName: 'octo/cloudchat',
    });
    expect(useChangesetStore.getState().getChangeset('default').activeRepo).toBeNull();
    expect(usePreviewStore.getState().getPreview('conv-1').activeView).toBe('repo');
    expect(apiMocks.fetchRepoFileTreeResult).toHaveBeenCalledWith(
      'ghp_test',
      'octo',
      'cloudchat',
      'main',
    );
  });

  it('starts issue chats from a fresh draft scope and queues the prompt', async () => {
    const started = await startRepoChatInNewThread({
      panelId: 'default',
      repo: activeRepo,
      githubPAT: 'ghp_test',
      prompt: 'Analyze issue #42',
      openPreview: true,
      repoEditIntentOverride: false,
    });

    expect(started).toBe(true);
    expect(usePanelStore.getState().panels[0]?.conversationId).toBeNull();
    expect(useChangesetStore.getState().getChangeset('default').activeRepo).toMatchObject({
      fullName: 'octo/cloudchat',
    });
    expect(useChangesetStore.getState().getChangeset('conv-1').activeRepo).toBeNull();
    expect(usePreviewStore.getState().getPreview('default').activeView).toBe('repo');
    expect(useUIStore.getState().pendingPanelPrompts.default).toEqual({
      content: 'Analyze issue #42',
      autoSend: true,
      repoEditIntentOverride: false,
    });
  });
});
