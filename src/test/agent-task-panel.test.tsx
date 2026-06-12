import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentTaskPanel } from '@/components/chat/AgentTaskPanel';
import { deriveAgentTaskPanelState } from '@/lib/agent-task-panel';
import type { ToolActivityEvent } from '@/components/chat/AgentActivity';

function todoEvent(todos: Array<{ id: string; content: string; status: string }>, opts: { merge?: boolean; output?: string | null } = {}): ToolActivityEvent {
  return {
    tool: 'todo',
    status: 'completed',
    input: JSON.stringify({ todos, ...(opts.merge !== undefined ? { merge: opts.merge } : {}) }),
    output: opts.output ?? null,
  };
}

describe('deriveAgentTaskPanelState', () => {
  it('derives the todo list from todo tool writes', () => {
    const state = deriveAgentTaskPanelState([
      todoEvent([
        { id: '1', content: 'scan repo', status: 'completed' },
        { id: '2', content: 'count files', status: 'in_progress' },
        { id: '3', content: 'summarize', status: 'pending' },
      ]),
    ]);
    expect(state.todos).toHaveLength(3);
    expect(state.todos[0]).toMatchObject({ content: 'scan repo', status: 'completed' });
    expect(state.todos[1].status).toBe('in_progress');
  });

  it('replaces the list on merge=false and updates by id on merge=true', () => {
    const state = deriveAgentTaskPanelState([
      todoEvent([
        { id: '1', content: 'a', status: 'pending' },
        { id: '2', content: 'b', status: 'pending' },
      ]),
      todoEvent([{ id: '1', content: 'a', status: 'completed' }], { merge: true }),
    ]);
    expect(state.todos).toHaveLength(2);
    expect(state.todos[0].status).toBe('completed');
    expect(state.todos[1].status).toBe('pending');

    const replaced = deriveAgentTaskPanelState([
      todoEvent([{ id: '1', content: 'a', status: 'pending' }]),
      todoEvent([{ id: '9', content: 'fresh plan', status: 'pending' }], { merge: false }),
    ]);
    expect(replaced.todos).toHaveLength(1);
    expect(replaced.todos[0].content).toBe('fresh plan');
  });

  it('prefers the authoritative output list when parseable', () => {
    const state = deriveAgentTaskPanelState([
      todoEvent(
        [{ id: '1', content: 'input version', status: 'pending' }],
        { output: JSON.stringify({ todos: [{ id: '1', content: 'output version', status: 'in_progress' }] }) },
      ),
    ]);
    expect(state.todos[0]).toMatchObject({ content: 'output version', status: 'in_progress' });
  });

  it('derives one subagent per delegate_task task entry', () => {
    const state = deriveAgentTaskPanelState([
      {
        tool: 'delegate_task',
        status: 'running',
        input: JSON.stringify({
          tasks: [
            { goal: 'Count the .py files', context: 'repo at ~/www' },
            { goal: 'List top-level dirs' },
          ],
          context: 'shared ctx',
        }),
        output: null,
      },
    ]);
    expect(state.subagents).toHaveLength(2);
    expect(state.subagents[0]).toMatchObject({ goal: 'Count the .py files', context: 'repo at ~/www', status: 'running' });
    expect(state.subagents[1].context).toBe('shared ctx');
  });

  it('derives a single subagent from a goal-only delegate_task', () => {
    const state = deriveAgentTaskPanelState([
      { tool: 'delegate_task', status: 'completed', input: JSON.stringify({ goal: 'Check git status' }), output: 'all clean' },
    ]);
    expect(state.subagents).toEqual([
      expect.objectContaining({ goal: 'Check git status', status: 'completed', output: 'all clean' }),
    ]);
  });

  it('tracks background terminal processes and appends process poll output', () => {
    const state = deriveAgentTaskPanelState([
      {
        tool: 'terminal',
        status: 'completed',
        input: JSON.stringify({ command: 'for i in $(seq 1 15); do echo "tick $i"; sleep 1; done', background: true }),
        output: JSON.stringify({ session_id: 'abc123', status: 'started' }),
      },
      {
        tool: 'process',
        status: 'completed',
        input: JSON.stringify({ action: 'poll', session_id: 'abc123' }),
        output: JSON.stringify({ session_id: 'abc123', status: 'running', output_preview: 'tick 1\ntick 2\ntick 3' }),
      },
    ]);
    expect(state.background).toHaveLength(1);
    expect(state.background[0].status).toBe('running');
    expect(state.background[0].outputLines).toEqual(['tick 1', 'tick 2', 'tick 3']);
  });

  it('marks a background process exited on poll status or kill', () => {
    const start: ToolActivityEvent = {
      tool: 'terminal',
      status: 'completed',
      input: JSON.stringify({ command: 'sleep 20', background: true }),
      output: JSON.stringify({ session_id: 's1' }),
    };
    const exited = deriveAgentTaskPanelState([
      start,
      { tool: 'process', status: 'completed', input: JSON.stringify({ action: 'poll', session_id: 's1' }), output: JSON.stringify({ status: 'exited', exit_code: 0 }) },
    ]);
    expect(exited.background[0].status).toBe('exited');

    const killed = deriveAgentTaskPanelState([
      start,
      { tool: 'process', status: 'completed', input: JSON.stringify({ action: 'kill', session_id: 's1' }), output: '{"status": "killed"}' },
    ]);
    expect(killed.background[0].status).toBe('exited');
  });

  it('ignores foreground terminal commands and unrelated tools', () => {
    const state = deriveAgentTaskPanelState([
      { tool: 'terminal', status: 'completed', input: JSON.stringify({ command: 'ls' }), output: 'ok' },
      { tool: 'web_search', status: 'completed', input: '{"query":"x"}', output: '[]' },
    ]);
    expect(state.background).toHaveLength(0);
    expect(state.subagents).toHaveLength(0);
    expect(state.todos).toHaveLength(0);
  });
});

describe('AgentTaskPanel', () => {
  it('renders nothing when there is no panel-relevant activity', () => {
    const { container } = render(<AgentTaskPanel events={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the task progress header and rows', () => {
    render(
      <AgentTaskPanel
        events={[
          todoEvent([
            { id: '1', content: 'scan repo', status: 'completed' },
            { id: '2', content: 'count files', status: 'in_progress' },
          ]),
        ]}
      />,
    );
    expect(screen.getByText('Tasks 1/2')).toBeInTheDocument();
    expect(screen.getByText('scan repo')).toBeInTheDocument();
    expect(screen.getByText('count files')).toBeInTheDocument();
  });

  it('collapses a section when its header is clicked', () => {
    render(
      <AgentTaskPanel
        events={[todoEvent([{ id: '1', content: 'scan repo', status: 'pending' }])]}
      />,
    );
    fireEvent.click(screen.getByText('Tasks 0/1'));
    expect(screen.queryByText('scan repo')).not.toBeInTheDocument();
  });

  it('opens a subagent window with goal and result on click', () => {
    render(
      <AgentTaskPanel
        events={[
          { tool: 'delegate_task', status: 'completed', input: JSON.stringify({ goal: 'Check git status' }), output: 'clean tree' },
        ]}
      />,
    );
    expect(screen.getByText('1 Subagent')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Check git status'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('clean tree')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close subagent window'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('expands background output tail on click', () => {
    render(
      <AgentTaskPanel
        events={[
          {
            tool: 'terminal',
            status: 'completed',
            input: JSON.stringify({ command: 'sleep 20 && echo "backup done"', background: true }),
            output: JSON.stringify({ session_id: 's1' }),
          },
          {
            tool: 'process',
            status: 'completed',
            input: JSON.stringify({ action: 'poll', session_id: 's1' }),
            output: JSON.stringify({ status: 'running', output_preview: 'tick 1\ntick 2' }),
          },
        ]}
      />,
    );
    expect(screen.getByText('1 Background')).toBeInTheDocument();
    fireEvent.click(screen.getByText('sleep 20 && echo "backup done"'));
    expect(screen.getByText(/tick 1/)).toBeInTheDocument();
  });
});
