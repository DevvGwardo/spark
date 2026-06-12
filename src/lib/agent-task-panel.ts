import type { ToolActivityEvent } from '@/components/chat/AgentActivity';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface PanelTodo {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface PanelSubagent {
  id: string;
  goal: string;
  context?: string;
  status: 'running' | 'completed';
  output: string | null;
}

export interface PanelBackgroundProcess {
  id: string;
  command: string;
  status: 'running' | 'exited';
  sessionId?: string;
  outputLines: string[];
}

export interface AgentTaskPanelState {
  todos: PanelTodo[];
  subagents: PanelSubagent[];
  background: PanelBackgroundProcess[];
}

const VALID_TODO_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed', 'cancelled']);
const MAX_OUTPUT_LINES = 40;

function safeParseJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Best-effort extraction of a JSON string field from possibly truncated JSON. */
function extractJsonStringField(raw: string, field: string): string | null {
  const match = raw.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function normalizeTodos(raw: unknown): PanelTodo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item, index) => ({
      id: String(item.id ?? index),
      content: String(item.content ?? '').trim(),
      status: VALID_TODO_STATUSES.has(item.status as TodoStatus) ? item.status as TodoStatus : 'pending',
    }))
    .filter((item) => item.content.length > 0);
}

function applyTodoWrite(current: PanelTodo[], incoming: PanelTodo[], merge: boolean): PanelTodo[] {
  if (!merge) return incoming;
  const byId = new Map(current.map((item) => [item.id, item]));
  const next = [...current];
  for (const item of incoming) {
    const existing = byId.get(item.id);
    if (existing) {
      existing.content = item.content || existing.content;
      existing.status = item.status;
    } else {
      next.push(item);
      byId.set(item.id, item);
    }
  }
  return next;
}

function deriveSubagents(event: ToolActivityEvent, eventIndex: number): PanelSubagent[] {
  const args = safeParseJson(event.input) ?? {};
  const status: PanelSubagent['status'] = event.status === 'completed' ? 'completed' : 'running';
  const sharedContext = typeof args.context === 'string' ? args.context : undefined;

  const tasks = Array.isArray(args.tasks)
    ? args.tasks.filter((task): task is Record<string, unknown> => !!task && typeof task === 'object')
    : [];

  if (tasks.length > 0) {
    return tasks.map((task, taskIndex) => ({
      id: `subagent-${eventIndex}-${taskIndex}`,
      goal: String(task.goal ?? 'Subagent task').trim() || 'Subagent task',
      context: typeof task.context === 'string' ? task.context : sharedContext,
      status,
      output: event.output,
    }));
  }

  const goal = typeof args.goal === 'string' && args.goal.trim()
    ? args.goal.trim()
    : extractJsonStringField(event.input, 'goal') ?? 'Subagent task';

  return [{
    id: `subagent-${eventIndex}-0`,
    goal,
    context: sharedContext,
    status,
    output: event.output,
  }];
}

function appendOutputLines(target: PanelBackgroundProcess, text: string | null | undefined): void {
  if (!text) return;
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    if (target.outputLines.at(-1) !== line) {
      target.outputLines.push(line);
    }
  }
  if (target.outputLines.length > MAX_OUTPUT_LINES) {
    target.outputLines.splice(0, target.outputLines.length - MAX_OUTPUT_LINES);
  }
}

/**
 * Derive the composer panel state (todo list, subagents, background processes)
 * from the ordered tool-activity event stream of a conversation.
 *
 * Tool sources (Hermes agent):
 * - `todo` — task list writes ({todos, merge}); replace unless merge=true.
 * - `delegate_task` — subagent spawns ({goal} or {tasks: [{goal}, ...]}).
 * - `terminal` with background=true — background process starts; the tool
 *   output carries the session_id.
 * - `process` (poll/log/wait/kill) — live status + output for a session_id.
 */
export function deriveAgentTaskPanelState(events: ToolActivityEvent[]): AgentTaskPanelState {
  let todos: PanelTodo[] = [];
  const subagents: PanelSubagent[] = [];
  const background: PanelBackgroundProcess[] = [];
  const backgroundBySession = new Map<string, PanelBackgroundProcess>();

  events.forEach((event, index) => {
    const tool = event.tool.toLowerCase();

    if (tool === 'todo') {
      const args = safeParseJson(event.input);
      // Prefer the authoritative output list when parseable (it reflects the
      // post-merge state); fall back to applying the input write locally.
      const output = safeParseJson(event.output);
      const outputTodos = normalizeTodos(output?.todos);
      if (outputTodos.length > 0) {
        todos = outputTodos;
      } else if (args && Array.isArray(args.todos)) {
        todos = applyTodoWrite(todos, normalizeTodos(args.todos), args.merge === true);
      }
      return;
    }

    if (tool === 'delegate_task') {
      subagents.push(...deriveSubagents(event, index));
      return;
    }

    if (tool === 'terminal') {
      const args = safeParseJson(event.input);
      if (!args || args.background !== true || typeof args.command !== 'string') return;
      const sessionId = event.output ? extractJsonStringField(event.output, 'session_id') ?? undefined : undefined;
      const proc: PanelBackgroundProcess = {
        id: `bg-${index}`,
        command: args.command,
        status: 'running',
        sessionId,
        outputLines: [],
      };
      background.push(proc);
      if (sessionId) backgroundBySession.set(sessionId, proc);
      return;
    }

    if (tool === 'process') {
      const args = safeParseJson(event.input);
      const sessionId = args && args.session_id != null
        ? String(args.session_id)
        : event.output ? extractJsonStringField(event.output, 'session_id') : null;
      const proc = (sessionId && backgroundBySession.get(sessionId)) || background.at(-1);
      if (!proc || !event.output) return;

      // Late session binding: a poll result can reveal the session_id of a
      // process whose start output was truncated.
      if (sessionId && !proc.sessionId) {
        proc.sessionId = sessionId;
        backgroundBySession.set(sessionId, proc);
      }

      const action = args && typeof args.action === 'string' ? args.action : '';
      if (action === 'kill') {
        proc.status = 'exited';
        return;
      }

      const statusField = extractJsonStringField(event.output, 'status');
      if (statusField === 'exited') proc.status = 'exited';
      else if (statusField === 'running') proc.status = 'running';

      const preview = extractJsonStringField(event.output, 'output_preview')
        ?? extractJsonStringField(event.output, 'output');
      appendOutputLines(proc, preview);
    }
  });

  return { todos, subagents, background };
}

export function isAgentTaskPanelEmpty(state: AgentTaskPanelState): boolean {
  return state.todos.length === 0 && state.subagents.length === 0 && state.background.length === 0;
}
