import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/hermes-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hermes-api')>();
  return {
    ...actual,
    fetchHermesWorkspaceOverview: vi.fn(),
    fetchHermesDashboardUrl: vi.fn(async () => ({ ok: false, url: null })),
    fetchHermesWorkspaceFiles: vi.fn(),
    fetchHermesWorkspaceFile: vi.fn(),
    updateHermesWorkspaceFile: vi.fn(),
    fetchMemoryStatus: vi.fn(async () => ({ provider: null })),
  };
});

// Journey tab is not under test and fetches on its own.
vi.mock('@/components/sidebar/JourneyPanel', () => ({ JourneyPanel: () => null }));

import * as api from '@/lib/hermes-api';
import { HermesApiError } from '@/lib/hermes-api';
import { HermesOverviewPanel } from '@/components/sidebar/HermesOverviewPanel';
import { HermesMemoriesPanel } from '@/components/sidebar/HermesMemoriesPanel';
import { renderWithQueryClient } from './support/query-client';

const mocked = vi.mocked(api);

const OVERVIEW = {
  hermes_home: '/Users/me/.hermes',
  session_source: { kind: 'sqlite', path: '/x', available: true },
  cron_backend: 'hermes',
  counts: { tracked_sessions: 3, live_sessions: 1, cron_jobs: 0, skills: 2, messages: 0, input_tokens: 0, output_tokens: 0 },
  files: [],
  top_models: [],
  last_session_started_at: null,
} as unknown as api.HermesWorkspaceOverview;

function memFile(content: string, version: string) {
  return {
    key: 'soul', label: 'SOUL.md', description: 'Persona', path: '/h/SOUL.md',
    size: content.length, modified_at: null, version, preview: '', content,
  } as unknown as api.HermesWorkspaceFile;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HermesOverviewPanel', () => {
  it('renders the overview from the query', async () => {
    mocked.fetchHermesWorkspaceOverview.mockResolvedValue(OVERVIEW);
    renderWithQueryClient(<HermesOverviewPanel />);
    expect(await screen.findByText('/Users/me/.hermes')).toBeInTheDocument();
    expect(screen.getByText('Tracked Sessions')).toBeInTheDocument();
  });

  it('shows the error envelope with a working Retry instead of a raw message', async () => {
    mocked.fetchHermesWorkspaceOverview
      .mockRejectedValueOnce(
        new HermesApiError('Bridge restarting', 503, {
          error: { code: 'BRIDGE_STARTING', message: 'Bridge restarting', retryable: true },
        }),
      )
      .mockResolvedValueOnce(OVERVIEW);
    renderWithQueryClient(<HermesOverviewPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Hermes is still starting');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('/Users/me/.hermes')).toBeInTheDocument();
    expect(mocked.fetchHermesWorkspaceOverview).toHaveBeenCalledTimes(2);
  });
});

describe('HermesMemoriesPanel', () => {
  it('saves a draft and keeps the editor in sync with the saved copy', async () => {
    mocked.fetchHermesWorkspaceFiles.mockResolvedValue([memFile('hello', 'v1')]);
    mocked.fetchHermesWorkspaceFile.mockResolvedValue(memFile('hello', 'v1'));
    mocked.updateHermesWorkspaceFile.mockResolvedValue(memFile('hello world', 'v2'));
    renderWithQueryClient(<HermesMemoriesPanel />);

    const editor = await screen.findByDisplayValue('hello');
    fireEvent.change(editor, { target: { value: 'hello world' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Saved SOUL.md')).toBeInTheDocument();
    expect(mocked.updateHermesWorkspaceFile).toHaveBeenCalledWith('soul', 'hello world', 'v1');
    expect(screen.getByText('Up to date')).toBeInTheDocument();
  });

  it('on a 409 loads the disk version but keeps the draft in the editor', async () => {
    mocked.fetchHermesWorkspaceFiles.mockResolvedValue([memFile('hello', 'v1')]);
    mocked.fetchHermesWorkspaceFile.mockResolvedValue(memFile('hello', 'v1'));
    mocked.updateHermesWorkspaceFile.mockRejectedValue(
      new HermesApiError('conflict', 409, { file: memFile('changed on disk', 'v7') }),
    );
    renderWithQueryClient(<HermesMemoriesPanel />);

    const editor = await screen.findByDisplayValue('hello');
    fireEvent.change(editor, { target: { value: 'my edit' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The file changed outside this panel');
    expect(screen.getByDisplayValue('my edit')).toBeInTheDocument();

    // The next save goes against the version the conflict returned.
    mocked.updateHermesWorkspaceFile.mockResolvedValueOnce(memFile('my edit', 'v8'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(mocked.updateHermesWorkspaceFile).toHaveBeenLastCalledWith('soul', 'my edit', 'v7'),
    );
  });
});
