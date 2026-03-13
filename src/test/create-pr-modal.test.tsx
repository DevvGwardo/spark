import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreatePRModal } from '@/components/github/CreatePRModal';
import { useSettingsStore } from '@/stores/settings-store';

const baseSettingsState = useSettingsStore.getState();

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CreatePRModal', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      githubPAT: 'test-pat',
    });
  });

  afterEach(() => {
    useSettingsStore.setState(baseSettingsState, true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows PR check results after creation', async () => {
    const onSuccess = vi.fn();

    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'verify-changes') {
        return jsonResponse({
          summary: {
            status: 'passed',
            findings: 0,
            commandsRun: 3,
            commandsFailed: 0,
          },
          review: {
            status: 'passed',
            summary: 'No actionable issues found.',
            findings: [],
          },
          commands: [
            {
              name: 'install',
              command: 'npm install',
              status: 'passed',
              summary: 'Command completed successfully.',
              output: '',
              exitCode: 0,
            },
          ],
        });
      }

      if (payload.action === 'create-pr') {
        return jsonResponse({
          pr: {
            number: 42,
            url: 'https://github.com/octo/cloudchat/pull/42',
            title: payload.title,
            body: payload.body,
            state: 'open',
            draft: false,
            headBranch: payload.branch,
            baseBranch: payload.baseBranch,
          },
        });
      }

      if (payload.action === 'get-pr-status') {
        return jsonResponse({
          pr: {
            number: 42,
            title: 'refactor(test): use snapshot assertions',
            body: '',
            url: 'https://github.com/octo/cloudchat/pull/42',
            state: 'open',
            draft: false,
            merged: false,
            mergeable: true,
            mergeableState: 'blocked',
            headBranch: 'ai/chat-changes-1',
            baseBranch: 'main',
          },
          checks: {
            overall: 'failing',
            summary: {
              total: 22,
              passed: 20,
              failed: 2,
              pending: 0,
            },
            providers: [
              {
                name: 'GitHub Actions',
                total: 19,
                passed: 17,
                failed: 2,
                pending: 0,
                checks: [
                  {
                    name: 'test (22.x)',
                    provider: 'GitHub Actions',
                    status: 'failure',
                    detailsUrl: 'https://github.com/octo/cloudchat/actions/runs/1',
                    summary: 'Exit code 1',
                  },
                  {
                    name: 'lint',
                    provider: 'GitHub Actions',
                    status: 'success',
                    detailsUrl: null,
                    summary: 'Completed',
                  },
                ],
              },
              {
                name: 'Vercel',
                total: 3,
                passed: 3,
                failed: 0,
                pending: 0,
                checks: [
                  {
                    name: 'preview deployment',
                    provider: 'Vercel',
                    status: 'success',
                    detailsUrl: null,
                    summary: 'Ready',
                  },
                ],
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected action: ${payload.action}`);
    }));

    render(
      <CreatePRModal
        isOpen
        onClose={() => {}}
        owner="octo"
        repo="cloudchat"
        baseBranch="main"
        files={[{ path: 'src/App.tsx', content: 'export default 1', action: 'edit' }]}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/feat: polish the workspace shell/i), {
      target: { value: 'refactor(test): use snapshot assertions' },
    });
    expect(screen.getByRole('button', { name: /^create pr$/i })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run review & checks/i }));
      await Promise.resolve();
    });

    expect(await screen.findByText(/no actionable issues found/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^create pr$/i }));
      await Promise.resolve();
    });

    expect(await screen.findByText(/2 checks failed/i)).toBeInTheDocument();
    expect(screen.getByText('GitHub Actions')).toBeInTheDocument();
    expect(screen.getByText('Vercel')).toBeInTheDocument();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /squash and merge/i })).toBeDisabled();
  });

  it('keeps create actions in a pinned footer instead of the scrollable body', () => {
    render(
      <CreatePRModal
        isOpen
        onClose={() => {}}
        owner="octo"
        repo="cloudchat"
        baseBranch="main"
        files={[{ path: 'src/App.tsx', content: 'export default 1', action: 'edit' }]}
      />,
    );

    const footer = screen.getByTestId('create-pr-modal-footer');
    const scrollRegion = screen.getByTestId('create-pr-modal-scroll-region');

    expect(within(footer).getByRole('button', { name: /^create pr$/i })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    expect(within(scrollRegion).queryByRole('button', { name: /^create pr$/i })).not.toBeInTheDocument();
  });

  it('merges the pull request from the modal once checks pass', async () => {
    let merged = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'verify-changes') {
        return jsonResponse({
          summary: {
            status: 'passed',
            findings: 0,
            commandsRun: 4,
            commandsFailed: 0,
          },
          review: {
            status: 'passed',
            summary: 'No actionable issues found.',
            findings: [],
          },
          commands: [],
        });
      }

      if (payload.action === 'create-pr') {
        return jsonResponse({
          pr: {
            number: 7,
            url: 'https://github.com/octo/cloudchat/pull/7',
            title: payload.title,
            body: payload.body,
            state: 'open',
            draft: false,
            headBranch: payload.branch,
            baseBranch: payload.baseBranch,
          },
        });
      }

      if (payload.action === 'get-pr-status') {
        return jsonResponse({
          pr: {
            number: 7,
            title: 'feat: merge flow',
            body: '',
            url: 'https://github.com/octo/cloudchat/pull/7',
            state: merged ? 'closed' : 'open',
            draft: false,
            merged,
            mergeable: true,
            mergeableState: 'clean',
            headBranch: 'ai/chat-changes-2',
            baseBranch: 'main',
          },
          checks: {
            overall: 'passing',
            summary: {
              total: 3,
              passed: 3,
              failed: 0,
              pending: 0,
            },
            providers: [
              {
                name: 'GitHub Actions',
                total: 3,
                passed: 3,
                failed: 0,
                pending: 0,
                checks: [
                  {
                    name: 'test',
                    provider: 'GitHub Actions',
                    status: 'success',
                    detailsUrl: null,
                    summary: 'Completed',
                  },
                ],
              },
            ],
          },
        });
      }

      if (payload.action === 'merge-pr') {
        merged = true;
        return jsonResponse({
          merged: {
            sha: 'abc123',
            merged: true,
            message: 'Pull Request successfully merged',
          },
        });
      }

      throw new Error(`Unexpected action: ${payload.action}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(
      <CreatePRModal
        isOpen
        onClose={() => {}}
        owner="octo"
        repo="cloudchat"
        baseBranch="main"
        files={[{ path: 'src/App.tsx', content: 'export default 1', action: 'edit' }]}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/feat: polish the workspace shell/i), {
      target: { value: 'feat: merge flow' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run review & checks/i }));
      await Promise.resolve();
    });

    expect(await screen.findByText(/verification passed/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^create pr$/i }));
      await Promise.resolve();
    });

    const mergeButton = await screen.findByRole('button', { name: /squash and merge/i });
    await waitFor(() => expect(mergeButton).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(mergeButton);
      await Promise.resolve();
    });

    expect(await screen.findByText(/pull request successfully merged/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/functions/v1/github-integration'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"action":"merge-pr"'),
      }),
    );
  });

  it('lets the user create the PR explicitly after verification fails', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'verify-changes') {
        return jsonResponse({
          summary: {
            status: 'failed',
            findings: 1,
            commandsRun: 2,
            commandsFailed: 1,
          },
          review: {
            status: 'warning',
            summary: 'Build failed after the staged changes were applied.',
            findings: [
              {
                severity: 'high',
                title: 'Build failure',
                summary: 'The staged changes break the build.',
                file: 'src/App.tsx',
                suggestion: 'Fix the regression before merging.',
              },
            ],
          },
          commands: [
            {
              name: 'build',
              command: 'npm run build',
              status: 'failed',
              summary: 'src/App.tsx:1:1 - error TS1005',
              output: 'src/App.tsx:1:1 - error TS1005',
              exitCode: 1,
            },
          ],
        });
      }

      if (payload.action === 'create-pr') {
        return jsonResponse({
          pr: {
            number: 11,
            url: 'https://github.com/octo/cloudchat/pull/11',
            title: payload.title,
            body: payload.body,
            state: 'open',
            draft: false,
            headBranch: payload.branch,
            baseBranch: payload.baseBranch,
          },
        });
      }

      if (payload.action === 'get-pr-status') {
        return jsonResponse({
          pr: {
            number: 11,
            title: 'fix: handle verifier failures',
            body: '',
            url: 'https://github.com/octo/cloudchat/pull/11',
            state: 'open',
            draft: false,
            merged: false,
            mergeable: true,
            mergeableState: 'blocked',
            headBranch: 'ai/chat-changes-3',
            baseBranch: 'main',
          },
          checks: {
            overall: 'pending',
            summary: {
              total: 1,
              passed: 0,
              failed: 0,
              pending: 1,
            },
            providers: [],
          },
        });
      }

      throw new Error(`Unexpected action: ${payload.action}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(
      <CreatePRModal
        isOpen
        onClose={() => {}}
        owner="octo"
        repo="cloudchat"
        baseBranch="main"
        files={[{ path: 'src/App.tsx', content: 'broken', action: 'edit' }]}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/feat: polish the workspace shell/i), {
      target: { value: 'fix: handle verifier failures' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run review & checks/i }));
      await Promise.resolve();
    });

    expect(await screen.findByText(/build failed after the staged changes were applied/i)).toBeInTheDocument();

    const createAnywayButton = screen.getByRole('button', { name: /create pr anyway/i });
    expect(createAnywayButton).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(createAnywayButton);
      await Promise.resolve();
    });

    expect(await screen.findByText(/pull request #11/i)).toBeInTheDocument();
  });

  it('shows a centered verification loader while review and checks are running', async () => {
    let resolveVerification: ((response: Response) => void) | null = null;

    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'verify-changes') {
        return new Promise<Response>((resolve) => {
          resolveVerification = resolve;
        });
      }

      throw new Error(`Unexpected action: ${payload.action}`);
    }));

    render(
      <CreatePRModal
        isOpen
        onClose={() => {}}
        owner="octo"
        repo="cloudchat"
        baseBranch="main"
        files={[{ path: 'client/src/App.tsx', content: 'export default 1', action: 'edit' }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /run review & checks/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/running verification/i);
    expect(screen.getAllByText(/cloning repository snapshot/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/finding project workspace/i)).toBeInTheDocument();
    expect(screen.getByText(/pulling the base branch into a clean workspace/i)).toBeInTheDocument();
    expect(screen.getByText(/%/)).toBeInTheDocument();

    resolveVerification?.(jsonResponse({
      summary: {
        status: 'passed',
        findings: 0,
        commandsRun: 2,
        commandsFailed: 0,
      },
      review: {
        status: 'passed',
        summary: 'No actionable issues found.',
        findings: [],
      },
      commands: [],
    }));

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('shows a warning headline when command checks pass but provider review is skipped', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'verify-changes') {
        return jsonResponse({
          summary: {
            status: 'warning',
            findings: 0,
            commandsRun: 2,
            commandsFailed: 0,
          },
          review: {
            status: 'skipped',
            summary: 'Provider-backed review was skipped: service unavailable.',
            findings: [],
          },
          commands: [
            {
              name: 'install',
              command: 'cd client && npm install',
              status: 'passed',
              summary: 'Command completed successfully.',
              output: '',
              exitCode: 0,
            },
          ],
        });
      }

      throw new Error(`Unexpected action: ${payload.action}`);
    }));

    render(
      <CreatePRModal
        isOpen
        onClose={() => {}}
        owner="octo"
        repo="cloudchat"
        baseBranch="main"
        files={[{ path: 'client/src/App.tsx', content: 'export default 1', action: 'edit' }]}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run review & checks/i }));
      await Promise.resolve();
    });

    expect(await screen.findByText(/provider review skipped/i)).toBeInTheDocument();
    expect(screen.getByText(/provider-backed review was skipped: service unavailable\./i)).toBeInTheDocument();
  });
});
