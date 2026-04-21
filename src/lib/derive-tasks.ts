import type { HermesSessionDetail, HermesSessionMessage } from '@/lib/hermes-api';

export type TaskStatus = 'done' | 'running' | 'pending' | 'error';

export interface Task {
  id: string;
  label: string;
  status: TaskStatus;
  role: HermesSessionMessage['role'];
  index: number;
}

const TOOL_FALLBACK_LABEL = 'tool call';
const ASSISTANT_LABEL = 'assistant reply';
const MAX_LABEL_LENGTH = 60;

function truncateLabel(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_LABEL_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_LABEL_LENGTH - 3).trimEnd()}...`;
}

export function deriveTasks(detail: HermesSessionDetail): Task[] {
  const tasks: Task[] = [];
  const chat = Array.isArray(detail.chat) ? detail.chat : [];

  for (const message of chat) {
    if (typeof message.content !== 'string' || message.content.trim().length === 0) {
      continue;
    }

    if (message.role === 'tool') {
      const firstLine = message.content.split('\n')[0] ?? '';
      tasks.push({
        id: `${detail.id}-${tasks.length}`,
        label: truncateLabel(firstLine) || TOOL_FALLBACK_LABEL,
        status: 'pending',
        role: message.role,
        index: tasks.length,
      });
      continue;
    }

    if (message.role === 'assistant') {
      tasks.push({
        id: `${detail.id}-${tasks.length}`,
        label: ASSISTANT_LABEL,
        status: 'pending',
        role: message.role,
        index: tasks.length,
      });
    }
  }

  return tasks.map((task, index) => {
    const isLastTask = index === tasks.length - 1;
    if (!isLastTask) {
      return { ...task, status: 'done' };
    }

    if (detail.status === 'error') {
      return { ...task, status: 'error' };
    }

    if (detail.status === 'active') {
      return { ...task, status: 'running' };
    }

    return { ...task, status: 'done' };
  });
}
