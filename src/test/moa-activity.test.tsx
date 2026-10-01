import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentActivity, type ToolActivityEvent } from '@/components/chat/AgentActivity';
import { getActiveRunningTool, getRunningToolLabel } from '@/lib/tool-activity';

describe('AgentActivity MoA events', () => {
  it('renders MoA advisor cards', () => {
    const events: ToolActivityEvent[] = [
      {
        tool: 'moa.reference',
        status: 'completed',
        input: JSON.stringify({ label: 'Architect', index: 0, count: 2 }),
        output: 'Use a thin adapter layer.',
      },
    ];

    render(<AgentActivity events={events} />);
    expect(screen.getByText(/MoA · 1 advisor/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/Advisor · Architect/)).toBeInTheDocument();
  });

  it('renders MoA aggregating header', () => {
    const events: ToolActivityEvent[] = [
      {
        tool: 'moa.aggregating',
        status: 'running',
        input: JSON.stringify({ aggregator: 'writer' }),
        output: null,
      },
    ];

    render(<AgentActivity events={events} />);
    expect(screen.getByText(/synthesizing|running/i)).toBeInTheDocument();
  });

  it('renders a compact MoA header when only aggregating completed', () => {
    const events: ToolActivityEvent[] = [
      {
        tool: 'moa.aggregating',
        status: 'completed',
        input: JSON.stringify({ aggregator: 'writer' }),
        output: 'done',
      },
    ];

    render(<AgentActivity events={events} />);
    expect(screen.getByText(/MoA/)).toBeInTheDocument();
  });
});

describe('AgentActivity LSP diagnostics', () => {
  it('surfaces lsp.diagnostic events with amber styling', () => {
    const events: ToolActivityEvent[] = [
      {
        tool: 'lsp.diagnostic',
        status: 'completed',
        input: JSON.stringify({ path: '/tmp/foo.py', source_tool: 'write_file' }),
        output: 'ERROR [10:1] NameError: foo is not defined',
      },
    ];

    render(<AgentActivity events={events} />);
    expect(screen.getByText(/LSP · 1 diagnostic/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/LSP · tmp\/foo.py/)).toBeInTheDocument();
  });
});

describe('AgentActivity fluent streaming (Codex-style)', () => {
  it('auto-expands a running tool so no click is needed to see it', () => {
    const events: ToolActivityEvent[] = [
      {
        tool: 'read_repo_file',
        status: 'running',
        input: JSON.stringify({ path: 'src/app.ts' }),
        output: null,
      },
    ];

    render(<AgentActivity events={events} />);
    // Fluent header names the live tool…
    expect(screen.getByText('Reading src/app.ts')).toBeInTheDocument();
    // …and the running row is already visible (auto-expanded).
    expect(screen.getByText(/Running read_repo_file/)).toBeInTheDocument();
  });

  it('formats running verbs per tool kind', () => {
    expect(getRunningToolLabel({ tool: 'read_repo_file', input: '{"path":"a/b/c.ts"}' })).toBe('Reading b/c.ts');
    expect(getRunningToolLabel({ tool: 'terminal', input: '{"command":"npm test"}' })).toBe('Running npm test');
    expect(getRunningToolLabel({ tool: 'web_search', input: '{"query":"vitest"}' })).toBe('Searching vitest');
    expect(getActiveRunningTool([
      { tool: 'search', status: 'completed', input: '{}', output: 'done' },
      { tool: 'terminal', status: 'running', input: '{"command":"ls"}', output: null },
    ])?.tool).toBe('terminal');
    expect(getActiveRunningTool([
      { tool: 'search', status: 'completed', input: '{}', output: 'done' },
    ])).toBeNull();
  });
});
