import type { KanbanCard } from '@/stores/kanban-store';

export function buildKanbanExecutionPrompt(card: Pick<
  KanbanCard,
  'title' | 'spec' | 'acceptanceCriteria' | 'assignedWorker' | 'reviewer'
>): string {
  const lines = [
    'Work this Kanban card as the next task.',
    `Title: ${card.title}`,
  ];

  if (card.spec.trim()) {
    lines.push('', 'Spec:', card.spec.trim());
  }

  if (card.acceptanceCriteria.length > 0) {
    lines.push('', 'Acceptance criteria:');
    for (const criterion of card.acceptanceCriteria) {
      lines.push(`- ${criterion}`);
    }
  }

  if (card.assignedWorker.trim()) {
    lines.push('', `Assigned worker: ${card.assignedWorker.trim()}`);
  }

  if (card.reviewer.trim()) {
    lines.push(`Reviewer: ${card.reviewer.trim()}`);
  }

  lines.push(
    '',
    'Start by confirming the task, inspecting the relevant context, and then continue the work in this thread.',
  );

  return lines.join('\n');
}
