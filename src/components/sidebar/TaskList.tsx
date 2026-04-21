import { AlertTriangle, Check, Circle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Task } from '@/lib/derive-tasks';

interface TaskListProps {
  tasks: Task[];
}

function TaskStatusIcon({ status }: { status: Task['status'] }) {
  if (status === 'done') {
    return <Check className="h-3.5 w-3.5 text-emerald-400" />;
  }
  if (status === 'running') {
    return <Loader2 className="h-3.5 w-3.5 animate-pulse text-blue-400" />;
  }
  if (status === 'error') {
    return <AlertTriangle className="h-3.5 w-3.5 text-red-400" />;
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />;
}

export function TaskList({ tasks }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className="text-[11px] text-muted-foreground/60">No activity yet.</p>;
  }

  return (
    <div className="space-y-1.5">
      {tasks.map((task) => (
        <div
          key={task.id}
          className={cn(
            'flex items-start gap-2 rounded-md border border-border/30 bg-background/40 px-2 py-1.5',
            task.status === 'running' && 'border-blue-500/20 bg-blue-500/5',
            task.status === 'error' && 'border-red-500/20 bg-red-500/5',
          )}
        >
          <div className="mt-0.5 flex-shrink-0">
            <TaskStatusIcon status={task.status} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] leading-relaxed break-words text-foreground/90">{task.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
