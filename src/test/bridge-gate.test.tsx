import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/detect-hermes', () => ({
  detectHermesBridge: vi.fn(),
}));

import { detectHermesBridge } from '@/lib/detect-hermes';
import { BridgeGate } from '@/components/hermes/BridgeGate';
import { __resetBridgeReadinessForTests, type BridgeReadiness } from '@/lib/bridge-readiness';
import { bridgeReadinessKey, useBridgeQueriesEnabled } from '@/lib/hermes-queries';
import { useUIStore } from '@/stores/ui-store';
import { renderWithQueryClient } from './support/query-client';

const detect = vi.mocked(detectHermesBridge);

function readiness(partial: Partial<BridgeReadiness>): BridgeReadiness {
  return { state: 'ready', since: 1, attempt: 0, lastError: null, stderrTail: [], ...partial };
}

/** Stub fetch so /api/bridge/readiness answers with each value in turn (last one repeats). */
function stubReadiness(...answers: Array<BridgeReadiness | 404>) {
  let call = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (!String(url).includes('/api/bridge/readiness')) throw new Error(`unexpected fetch ${url}`);
    const answer = answers[Math.min(call++, answers.length - 1)];
    if (answer === 404) return new Response('Not found', { status: 404 });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A child that reports whether its queries may run, and keeps local state. */
function Probe() {
  const enabled = useBridgeQueriesEnabled();
  const [draft, setDraft] = useState('');
  return (
    <div>
      <span data-testid="probe">{enabled ? 'queries-on' : 'queries-off'}</span>
      <input aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
    </div>
  );
}

beforeEach(() => {
  __resetBridgeReadinessForTests();
  detect.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BridgeGate', () => {
  it('renders the panel with queries enabled when the bridge is ready', async () => {
    stubReadiness(readiness({ state: 'ready' }));
    renderWithQueryClient(<BridgeGate><Probe /></BridgeGate>);
    expect(await screen.findByText('queries-on')).toBeInTheDocument();
  });

  it('shows a starting state instead of the panel while the bridge comes up', async () => {
    stubReadiness(readiness({ state: 'starting', attempt: 0 }));
    renderWithQueryClient(<BridgeGate><Probe /></BridgeGate>);
    expect(await screen.findByText('Hermes is starting…')).toBeInTheDocument();
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });

  it('renders degraded content with a subtle indicator', async () => {
    stubReadiness(readiness({ state: 'degraded', lastError: 'MCP telemetry offline' }));
    renderWithQueryClient(<BridgeGate><Probe /></BridgeGate>);
    expect(await screen.findByText('queries-on')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Hermes degraded — MCP telemetry offline');
  });

  it('shows lastError and a collapsible stderr tail when crashed, with Set up and Retry', async () => {
    const fetchMock = stubReadiness(
      readiness({ state: 'crashed', attempt: 3, lastError: 'ImportError: no module named run_agent', stderrTail: ['Traceback', '  boom'] }),
    );
    const requestBridgeSetup = vi.fn();
    useUIStore.setState({ requestBridgeSetup });
    renderWithQueryClient(<BridgeGate><Probe /></BridgeGate>);

    expect(await screen.findByText('Hermes bridge crashed')).toBeInTheDocument();
    expect(screen.getByText('ImportError: no module named run_agent')).toBeInTheDocument();
    expect(screen.getByText('attempt 3')).toBeInTheDocument();
    const summary = screen.getByText(/stderr · last 2 lines/);
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText(/Traceback/)).toBeInTheDocument();
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /set up/i }));
    expect(requestBridgeSetup).toHaveBeenCalledTimes(1);

    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('keeps an already-rendered panel mounted under a reconnecting strip and pauses its queries', async () => {
    stubReadiness(readiness({ state: 'ready' }));
    const { client } = renderWithQueryClient(<BridgeGate><Probe /></BridgeGate>);
    expect(await screen.findByText('queries-on')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'unsaved' } });

    act(() => {
      client.setQueryData(bridgeReadinessKey, { ...readiness({ state: 'restarting', attempt: 1 }), source: 'readiness' });
    });

    expect(await screen.findByText('queries-off')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to Hermes… · attempt 1');
    // Same input instance: the panel was not remounted.
    expect(screen.getByLabelText('draft')).toHaveValue('unsaved');
  });

  describe('fallback when /api/bridge/readiness does not exist (404)', () => {
    it('treats a reachable health probe as ready', async () => {
      stubReadiness(404);
      detect.mockResolvedValue({ isReachable: true } as Awaited<ReturnType<typeof detectHermesBridge>>);
      renderWithQueryClient(<BridgeGate><Probe /></BridgeGate>);
      expect(await screen.findByText('queries-on')).toBeInTheDocument();
      expect(detect).toHaveBeenCalledWith({ force: true });
    });

    it('treats an unreachable health probe as offline with a Set up action', async () => {
      stubReadiness(404);
      detect.mockResolvedValue(null);
      renderWithQueryClient(<BridgeGate><Probe /></BridgeGate>);
      expect(await screen.findByText('Hermes bridge offline')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /set up/i })).toBeInTheDocument();
      expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
    });

    it('stops asking the missing route on every poll', async () => {
      const fetchMock = stubReadiness(404);
      detect.mockResolvedValue({ isReachable: true } as Awaited<ReturnType<typeof detectHermesBridge>>);
      const { client } = renderWithQueryClient(<BridgeGate><Probe /></BridgeGate>);
      await screen.findByText('queries-on');
      await act(() => client.refetchQueries({ queryKey: bridgeReadinessKey }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(detect).toHaveBeenCalledTimes(2);
    });
  });

  it('reports offline when the API server itself is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    renderWithQueryClient(<BridgeGate><Probe /></BridgeGate>);
    expect(await screen.findByText('Hermes bridge offline')).toBeInTheDocument();
    expect(detect).not.toHaveBeenCalled();
  });
});
