
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoIssueBrowser } from '@/components/github/RepoIssueBrowser';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

const baseSettingsState = useSettingsStore.getState();
const basePanelState = usePanelStore.getState();
const baseUiState = useUIStore.getState();
const baseChangesetState = useChangesetStore.getState();

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RepoIssueBrowser', () => {
  beforeEach(() => {
    useChangesetStore.setState(baseChangesetState, true);
    useSettingsStore.setState({ ...baseSettingsState, githubPAT: 'test-pat' }, true);
    usePanelStore.setState({ ...basePanelState, focusedPanelId: 'default' }, true);
    useUIStore.setState({ ...baseUiState, activeTab: 'github' }, true);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    useChangesetStore.setState(baseChangesetState, true);
    useSettingsStore.setState(baseSettingsState, true);
    usePanelStore.setState(basePanelState, true);
    useUIStore.setState(baseUiState, true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates a new issue from the browser composer', async () => {
    const createdIssue = {
      id: 91,
      number: 12,
      title: 'Add issue composer',
      body: 'Users should be able to create issues without leaving the repo browser.',
      html_url: 'https://github.com/octo/cloudchat/issues/12',
      state: 'open',
      comments: 0,
      created_at: '2026-03-13T12:00:00Z',
      updated_at: '2026-03-13T12:00:00Z',
      user: {
        login: 'octocat',
        avatar_url: null,
      },
      labels: [],
    };

    let listIssuesCalls = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));

      if (payload.action === 'list-repos') {
        return jsonResponse({
          repos: [
            {
              id: 1,
              name: 'cloudchat',
              full_name: 'octo/cloudchat',
              private: false,
              description: 'Issue browser repo',
              default_branch: 'main',
              html_url: 'https://github.com/octo/cloudchat',
              fork: false,
              owner: { login: 'octo', avatar_url: null },
              permissions: { pull: true, push: true, admin: false },
              stargazers_count: 3,
              forks_count: 1,
              language: 'TypeScript',
              localClone: { exists: false, path: null },
            },
          ],
        });
      }

      if (payload.action === 'list-issues') {
        listIssuesCalls += 1;
        return jsonResponse({
          issues: listIssuesCalls > 1 ? [createdIssue] : [],
          totalCount: listIssuesCalls > 1 ? 1 : 0,
          incompleteResults: false,
          page: 1,
          perPage: 25,
          totalPages: 1,
          hasPreviousPage: false,
          hasNextPage: false,
        });
      }

      if (payload.action === 'create-issue') {
        expect(payload.owner).toBe('octo');
        expect(payload.repo).toBe('cloudchat');
        expect(payload.title).toBe('Add issue composer');
        expect(payload.body).toBe('Users should be able to create issues without leaving the repo browser.');

        return jsonResponse({
          issue: createdIssue,
        });
      }

      if (payload.action === 'list-linked-prs') {
        return jsonResponse({ prs: [] });
      }

      throw new Error(`Unexpected action: ${payload.action}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(
      <RepoIssueBrowser
        isOpen
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText('octo/cloudchat')).toBeInTheDocument();

    // Wait for the issues list to load (the "New issue" button is in the issues header)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new issue/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /new issue/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/drafting a new issue/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/title/i), {
        target: { value: 'Add issue composer' },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/details/i), {
        target: { value: 'Users should be able to create issues without leaving the repo browser.' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^create issue$/i }));
    });

    expect((await screen.findAllByText('Add issue composer')).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /fix issue/i })).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('hands the selected remote repo to chat when explaining an issue', async () => {
    const remoteIssue = {
      id: 4242,
      number: 42,
      title: 'Explain missing local repo handoff',
      body: 'The explain action should switch chat context to this repo even without a local clone.',
      html_url: 'https://github.com/upstream/remote-chat/issues/42',
      state: 'open',
      comments: 0,
      created_at: '2026-03-13T12:00:00Z',
      updated_at: '2026-03-13T12:00:00Z',
      user: {
        login: 'octocat',
        avatar_url: null,
      },
      labels: [],
    };

    useChangesetStore.getState().setActiveRepo('default', {
      owner: 'local',
      name: 'workspace-repo',
      defaultBranch: 'main',
      fullName: 'local/workspace-repo',
      localPath: '/tmp/workspace-repo',
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));

      if (payload.action === 'list-repos') {
        return jsonResponse({
          repos: [
            {
              id: 2,
              name: 'remote-chat',
              full_name: 'upstream/remote-chat',
              private: false,
              description: 'Remote-only repo',
              default_branch: 'main',
              html_url: 'https://github.com/upstream/remote-chat',
              fork: false,
              owner: { login: 'upstream', avatar_url: null },
              permissions: { pull: true, push: false, admin: false },
              stargazers_count: 12,
              forks_count: 4,
              language: 'TypeScript',
              localClone: { exists: false, path: null },
            },
          ],
        });
      }

      if (payload.action === 'list-issues') {
        if (payload.owner === 'upstream' && payload.repo === 'remote-chat') {
          return jsonResponse({
            issues: [remoteIssue],
            totalCount: 1,
            incompleteResults: false,
            page: 1,
            perPage: 25,
            totalPages: 1,
            hasPreviousPage: false,
            hasNextPage: false,
          });
        }

        return jsonResponse({
          issues: [],
          totalCount: 0,
          incompleteResults: false,
          page: 1,
          perPage: 25,
          totalPages: 1,
          hasPreviousPage: false,
          hasNextPage: false,
        });
      }

      if (payload.action === 'list-linked-prs') {
        return jsonResponse({ prs: [] });
      }

      if (payload.action === 'repo-activity') {
        return jsonResponse({
          days: Array.from({ length: 30 }, (_, index) => (index === 27 ? 1 : index === 29 ? 2 : 0)),
          totalCommits: 3,
          openedIssues: 11,
          openedPullRequests: 7,
        });
      }

      if (payload.action === 'read-tree') {
        expect(payload.owner).toBe('upstream');
        expect(payload.repo).toBe('remote-chat');
        return jsonResponse({
          items: [
            { path: 'README.md', type: 'file' },
            { path: 'src/index.ts', type: 'file' },
          ],
        });
      }

      throw new Error(`Unexpected action: ${payload.action}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(
      <RepoIssueBrowser
        isOpen
        onClose={() => {}}
      />,
    );

    expect((await screen.findAllByText('Explain missing local repo handoff')).length).toBeGreaterThan(0);
    expect(await screen.findByText('3 main commits')).toBeInTheDocument();
    expect(await screen.findByText('7 PRs')).toBeInTheDocument();
    expect(await screen.findByText('11 issues')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Explain$/i }));
    });

    await waitFor(() => {
      expect(useChangesetStore.getState().getChangeset('default').activeRepo).toMatchObject({
        owner: 'upstream',
        name: 'remote-chat',
        fullName: 'upstream/remote-chat',
      });
    });

    expect(useChangesetStore.getState().getChangeset('default').activeRepo?.localPath).toBeUndefined();
    expect(useUIStore.getState().pendingPanelPrompts.default).toMatchObject({
      autoSend: true,
      repoEditIntentOverride: false,
    });
    expect(useUIStore.getState().pendingPanelPrompts.default?.content).toContain(
      'Explain GitHub issue #42 in upstream/remote-chat.',
    );
  });
});
