import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpWorkerPill } from '@/components/layout/McpWorkerPill';
import type { McpWorkerStatus } from '@/electron.d';

function mockStatus(workers: McpWorkerStatus[]) {
  window.electronAPI = {
    versions: { electron: '1', node: '1', chrome: '1' },
    platform: 'test',
    homeDir: '/tmp',
    apiPort: 3001,
    mcpWorker: { status: vi.fn().mockResolvedValue(workers), spawn: vi.fn() },
  } as unknown as Window['electronAPI'];
}

afterEach(() => {
  window.electronAPI = undefined;
  vi.restoreAllMocks();
});

describe('McpWorkerPill', () => {
  it('renders the worker count when all workers are ready', async () => {
    mockStatus([
      { serverId: 'a', state: 'ready', restarts: 0 },
      { serverId: 'b', state: 'ready', pid: 123, restarts: 1 },
    ]);
    render(<McpWorkerPill />);
    expect(await screen.findByText('MCP 2')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-worker-dot')).toHaveClass('bg-emerald-500');
  });

  it('shows a red dot when any worker failed and lists servers in the tooltip', async () => {
    mockStatus([
      { serverId: 'a', state: 'ready', restarts: 0 },
      { serverId: 'b', state: 'failed', restarts: 3 },
    ]);
    render(<McpWorkerPill />);
    expect(await screen.findByText('MCP 2')).toBeInTheDocument();
    const dot = screen.getByTestId('mcp-worker-dot');
    expect(dot).toHaveClass('bg-red-500');
    const pill = screen.getByRole('button', { name: /mcp workers/i });
    expect(pill).toHaveAttribute('title', expect.stringContaining('a: ready'));
    expect(pill).toHaveAttribute('title', expect.stringContaining('b: failed'));
  });

  it('shows a grey idle pill when no workers are running', async () => {
    mockStatus([]);
    render(<McpWorkerPill />);
    expect(await screen.findByText('MCP 0')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-worker-dot')).toHaveClass('bg-muted-foreground/50');
  });

  it('shows a grey idle pill in web mode without electronAPI', async () => {
    window.electronAPI = undefined;
    render(<McpWorkerPill />);
    await waitFor(() => expect(screen.getByText('MCP 0')).toBeInTheDocument());
    expect(screen.getByTestId('mcp-worker-dot')).toHaveClass('bg-muted-foreground/50');
  });

  it('shows an amber dot while a worker is starting', async () => {
    mockStatus([{ serverId: 'a', state: 'starting', restarts: 0 }]);
    render(<McpWorkerPill />);
    expect(await screen.findByText('MCP 1')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-worker-dot')).toHaveClass('bg-amber-400');
  });
});
