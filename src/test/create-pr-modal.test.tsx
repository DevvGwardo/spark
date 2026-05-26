
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

/** Build an SSE Response that streams progress events then a final result. */
function sseVerificationResponse(result: unknown) {
  const progressEvents = [
    { type: 'progress', step: 'cloning', label: 'Cloning repository snapshot', detail: 'Pulling the base branch into a clean workspace.' },
    { type: 'progress', step: 'applying_changes', label: 'Applying file changes', detail: 'Writing staged changes into the cloned workspace.' },
    { type: 'progress', step: 'finding_workspace', label: 'Finding project workspace', detail: 'Locating the package.json closest to the changed files.' },
    { type: 'progress', step: 'installing', label: 'Installing dependencies', detail: 'Running npm install in repo root.' },
    { type: 'progress', step: 'running_scripts', label: 'Running validation scripts', detail: 'Checking lint, types, tests, and build scripts when available.' },
    { type: 'progress', step: 'reviewing', label: 'Generating provider review', detail: 'Asking the selected model for a final code review pass.' },
  ];

  const chunks = [
    ...progressEvents.map((e) => `data: ${JSON.stringify(e)}\n\n`),
    `data: ${JSON.stringify({ type: 'result', ...(result as Record<string, unknown>) })}\n\n`,
  ];

  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
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
    const onPullRequestCreated = vi.fn();

    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'verify-changes') {
        return sseVerificationResponse({
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
        onPullRequestCreated={onPullRequestCreated}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/feat: polish the workspace shell/i), {
      target: { value: 'refactor(test): use snapshot assertions' },
    });
    expect(screen.getByRole('button', { name: /^create pr$/i })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run checks/i }));
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
    expect(onPullRequestCreated).toHaveBeenCalledWith(expect.objectContaining({ number: 42 }));
    expect(screen.getByRole('button', { name: /squash and merge/i })).toBeDisabled();
  });

  it('submits draft PR intent to the server', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));

      if (payload.action === 'verify-changes') {
        return sseVerificationResponse({
          summary: {
            status: 'passed',
            findings: 0,
            commandsRun: 1,
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
        expect(payload.draft).toBe(true);
        return jsonResponse({
          pr: {
            number: 51,
            url: 'https://github.com/octo/cloudchat/pull/51',
            title: payload.title,
            body: payload.body,
            state: 'open',
            draft: true,
            headBranch: payload.branch,
            baseBranch: payload.baseBranch,
          },
        });
      }

      if (payload.action === 'get-pr-status') {
        return jsonResponse({
          pr: {
            number: 51,
            title: 'docs: create a draft PR',
            body: '',
            url: 'https://github.com/octo/cloudchat/pull/51',
            state: 'open',
            draft: true,
            merged: false,
            mergeable: true,
            mergeableState: 'blocked',
            headBranch: 'ai/chat-changes-51',
            baseBranch: 'main',
          },
          checks: {
            overall: 'pending',
            summary: {
              total: 0,
              passed: 0,
              failed: 0,
              pending: 0,
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
        files={[{ path: 'docs/notes.md', content: '# Notes', action: 'create' }]}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/feat: polish the workspace shell/i), {
      target: { value: 'docs: create a draft PR' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run checks/i }));
      await Promise.resolve();
    });

    fireEvent.click(screen.getByLabelText(/create as draft/i));
    expect(screen.getByRole('button', { name: /create draft pr/i })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create draft pr/i }));
      await Promise.resolve();
    });

    expect(await screen.findByText(/pull request #51/i)).toBeInTheDocument();
  });

  it('reopens an existing pull request in review mode', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'get-pr-status') {
        return jsonResponse({
          pr: {
            number: 21,
            title: 'feat: persisted review',
            body: '',
            url: 'https://github.com/octo/cloudchat/pull/21',
            state: 'open',
            draft: false,
            merged: false,
            mergeable: true,
            mergeableState: 'clean',
            headBranch: 'ai/chat-changes-21',
            baseBranch: 'main',
          },
          checks: {
            overall: 'passing',
            summary: {
              total: 1,
              passed: 1,
              failed: 0,
              pending: 0,
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
        files={[]}
        initialPullRequest={{
          number: 21,
          url: 'https://github.com/octo/cloudchat/pull/21',
          title: 'feat: persisted review',
          body: '',
          state: 'open',
          draft: false,
          headBranch: 'ai/chat-changes-21',
          baseBranch: 'main',
        }}
      />,
    );

    expect(await screen.findByText(/pull request #21/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view on github/i })).toHaveAttribute(
      'href',
      'https://github.com/octo/cloudchat/pull/21',
    );
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
    // Footer is now inside the scroll region per V2 design
    expect(within(scrollRegion).getByRole('button', { name: /^create pr$/i })).toBeInTheDocument();
  });

  it('merges the pull request from the modal once checks pass', async () => {
    let merged = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'verify-changes') {
        return sseVerificationResponse({
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
      fireEvent.click(screen.getByRole('button', { name: /run checks/i }));
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
        return sseVerificationResponse({
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
      fireEvent.click(screen.getByRole('button', { name: /run checks/i }));
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

  it('surfaces GitHub authentication errors from create-pr responses', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'verify-changes') {
        return sseVerificationResponse({
          summary: {
            status: 'passed',
            findings: 0,
            commandsRun: 1,
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
        return new Response(JSON.stringify({
          error: 'GitHub API error: {"message":"Bad credentials","status":"401"}',
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
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
      target: { value: 'fix: surface auth errors' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run checks/i }));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^create pr$/i }));
      await Promise.resolve();
    });

    expect(await screen.findByText(/GitHub authentication failed: Bad credentials\./i)).toBeInTheDocument();
    expect(screen.getByText(/Update your GitHub PAT in Settings and retry\./i)).toBeInTheDocument();
    expect(screen.queryByText(/pull request #/i)).not.toBeInTheDocument();
  });

  it('shows a centered verification loader while review and checks are running', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'verify-changes') {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            // Send the first progress event so the overlay renders step labels
            const event = { type: 'progress', step: 'cloning', label: 'Cloning repository snapshot', detail: 'Pulling the base branch into a clean workspace.' };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
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

    fireEvent.click(screen.getByRole('button', { name: /run checks/i }));

    const statusEl = await screen.findByRole('status');
    expect(statusEl).toHaveTextContent(/cloning repository snapshot/i);
    expect(screen.getByText(/finding project workspace/i)).toBeInTheDocument();
    expect(screen.getByText(/%/)).toBeInTheDocument();

    // Close the stream with the result to finish the verification
    await act(async () => {
      const result = {
        type: 'result',
        summary: { status: 'passed', findings: 0, commandsRun: 2, commandsFailed: 0 },
        review: { status: 'passed', summary: 'No actionable issues found.', findings: [] },
        commands: [],
      };
      streamController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(result)}\n\n`));
      streamController?.close();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('shows a warning headline when command checks pass but provider review is skipped', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      if (payload.action === 'verify-changes') {
        return sseVerificationResponse({
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
      fireEvent.click(screen.getByRole('button', { name: /run checks/i }));
      await Promise.resolve();
    });

    expect(await screen.findByText(/provider review skipped/i)).toBeInTheDocument();
    expect(screen.getByText(/provider-backed review was skipped: service unavailable\./i)).toBeInTheDocument();
  });
});
