import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Play, Square, Clock, ListChecks, Loader2, X, ChevronDown, ChevronUp,
  Circle, CheckCircle2, AlertCircle, PauseCircle
} from 'lucide-react';
import { useTaskOrchestratorStore } from '@/stores/task-orchestrator-store';
import { getApiBaseUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

// ─── Types ─────────────────────────────────────────────────────────────────

interface QueuedTask {
  id: string;
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  assignedWorker: string | null;
  status: 'queued' | 'running' | 'done' | 'review' | 'blocked' | 'failed';
  startedAt?: number;
  completedAt?: number;
  reportSummary?: string;
}

interface QueueState {
  queued: QueuedTask[];
  running: QueuedTask[];
  completed: QueuedTask[];
  stats: { completed: number; failed: number };
  enabled: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function elapsed(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function ago(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; dot: string; label: string }> = {
  queued:   { icon: <PauseCircle className="h-3 w-3" />, dot: 'bg-blue-500',       label: 'Queued' },
  running:  { icon: <Loader2 className="h-3 w-3 animate-spin" />, dot: 'bg-amber-500 animate-pulse', label: 'Running' },
  done:     { icon: <CheckCircle2 className="h-3 w-3" />, dot: 'bg-emerald-500',   label: 'Done' },
  review:   { icon: <AlertCircle className="h-3 w-3" />, dot: 'bg-purple-500',    label: 'Review' },
  blocked:  { icon: <AlertCircle className="h-3 w-3" />, dot: 'bg-red-500',       label: 'Blocked' },
  failed:   { icon: <X className="h-3 w-3" />,           dot: 'bg-red-500',       label: 'Failed' },
};

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  const idRef = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => {
    idRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => { if (idRef.current) clearInterval(idRef.current); };
  }, []);
  return <>{elapsed(startedAt)}</>;
}

// ─── Task Card Component ───────────────────────────────────────────────────

function TaskItem({ task }: { task: QueuedTask }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.queued;
  const hasDetails = task.spec || task.acceptanceCriteria.length > 0 || task.reportSummary;

  return (
    <div
      className={cn(
        'group rounded-lg border px-2.5 py-2 transition-colors',
        task.status === 'running' && 'border-amber-500/20 bg-amber-500/[0.03]',
        task.status === 'queued' && 'border-blue-500/20 bg-blue-500/[0.02]',
        task.status === 'done' && 'border-emerald-500/15 bg-emerald-500/[0.02]',
        task.status === 'blocked' && 'border-red-500/20 bg-red-500/[0.03]',
        task.status === 'review' && 'border-purple-500/20 bg-purple-500/[0.03]',
        !['running', 'queued', 'done', 'blocked', 'review'].includes(task.status) && 'border-border/30 bg-background/30',
        expanded && 'border-primary/30',
      )}
    >
      {/* Row 1: status dot, title, status badge */}
      <div className="flex items-center gap-2">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', cfg.dot)} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12px] font-medium cursor-pointer',
            'text-foreground/90'
          )}
          onClick={() => hasDetails && setExpanded(!expanded)}
          title={hasDetails ? 'Toggle details' : undefined}
        >
          {task.title}
        </span>
        <span className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border/30 bg-background/50 px-1.5 py-px text-[9px] font-medium text-muted-foreground/70">
          {cfg.icon}
          <span>{cfg.label}</span>
        </span>
        {task.startedAt && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">
            {task.status === 'running' ? (
              <ElapsedTimer startedAt={task.startedAt} />
            ) : task.completedAt ? (
              ago(task.completedAt)
            ) : (
              elapsed(task.startedAt)
            )}
          </span>
        )}
        {hasDetails && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 rounded p-0.5 text-muted-foreground/30 hover:text-foreground"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        )}
      </div>

      {/* Row 2: assigned worker */}
      {task.assignedWorker && (
        <div className="mt-1 pl-3.5 text-[10px] text-muted-foreground/50">
          @{task.assignedWorker}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-border/20 pt-2 pl-3.5">
          {task.spec && (
            <p className="text-[10px] leading-relaxed text-muted-foreground/70">{task.spec}</p>
          )}
          {task.acceptanceCriteria.length > 0 && (
            <ul className="list-inside list-disc space-y-0.5">
              {task.acceptanceCriteria.map((c, i) => (
                <li key={i} className="text-[10px] text-muted-foreground/60">{c}</li>
              ))}
            </ul>
          )}
          {task.reportSummary && (
            <div className="mt-1 rounded-md border border-border/20 bg-background/40 px-2 py-1">
              <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground/50">Report</span>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/80">{task.reportSummary}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Section Component ─────────────────────────────────────────────────────

function TaskSection({ title, tasks, emptyMsg, color }: {
  title: string;
  tasks: QueuedTask[];
  emptyMsg: string;
  color: string;
}) {
  if (tasks.length === 0) return null;
  return (
    <>
      <div className="px-3 pb-1 pt-2">
        <span className={cn('inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide', color)}>
          <Circle className="h-2 w-2" />
          {title} ({tasks.length})
        </span>
      </div>
      <div className="space-y-1 px-3 pb-2">
        {tasks.map((task) => (
          <TaskItem key={task.id} task={task} />
        ))}
      </div>
    </>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────────

export function TaskQueuePanel() {
  const {
    enabled,
    activeTasks,
    stats,
    loading,
    error,
    fetchStatus,
    startOrchestrator,
    stopOrchestrator,
    dispatchNow,
    cancelTask,
  } = useTaskOrchestratorStore();

  const [cancelling, setCancelling] = useState<string | null>(null);
  const [queueState, setQueueState] = useState<QueueState | null>(null);
  const [queueLoading, setQueueLoading] = useState(false);

  // Fetch orchestrator status + queue state
  const refresh = useCallback(async () => {
    await fetchStatus();
    setQueueLoading(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/hermes/orchestrator/queue`);
      if (res.ok) {
        const data = await res.json();
        setQueueState(data);
      }
    } catch {
      // ignore
    } finally {
      setQueueLoading(false);
    }
  }, [fetchStatus]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleCancel = useCallback(async (cardId: string) => {
    setCancelling(cardId);
    await cancelTask(cardId);
    setCancelling(null);
  }, [cancelTask]);

  // Determine what to render from queue API or fall back to basic orchestrator state
  const queuedItems = queueState?.queued ?? [];
  const runningItems = queueState?.running ?? (activeTasks.map(t => ({
    id: t.cardId,
    title: t.cardId.slice(0, 12) + '...',
    spec: '',
    acceptanceCriteria: [] as string[],
    assignedWorker: null as string | null,
    status: 'running' as const,
    startedAt: t.startedAt,
  })));
  const completedItems = queueState?.completed ?? [];
  const hasQueueData = queueState !== null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5">
          <ListChecks className="h-3.5 w-3.5 text-muted-foreground/60" />
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            Task Queue
          </span>
          <span className="text-[11px] font-mono text-muted-foreground/50">
            {runningItems.length}/{stats.startedAt ? stats.completed + stats.failed + runningItems.length : '-'}
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 pb-2">
        <button
          onClick={enabled ? stopOrchestrator : startOrchestrator}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors',
            enabled
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
              : 'border-border/40 text-muted-foreground/60 hover:text-foreground hover:border-border/70'
          )}
        >
          {enabled ? (
            <><Square className="h-3 w-3" /> Auto</>
          ) : (
            <><Play className="h-3 w-3" /> Manual</>
          )}
        </button>
        <button
          onClick={dispatchNow}
          disabled={loading || !enabled}
          className="inline-flex items-center gap-1 rounded-md border border-border/40 px-2 py-1 text-[10px] font-medium text-muted-foreground/60 transition-colors hover:border-border/70 hover:text-foreground disabled:opacity-40"
          title="Dispatch queued cards now"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Clock className="h-3 w-3" />}
          Dispatch
        </button>
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-red-300">
          {error}
        </div>
      )}

      {/* Queue content */}
      <div className="flex-1 overflow-y-auto">
        {queueLoading && !queueState && (
          <div className="flex items-center justify-center py-8 text-muted-foreground/60">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            <span className="text-[11px]">Loading queue...</span>
          </div>
        )}

        {/* Queued section */}
        <TaskSection
          title="Queued"
          tasks={queuedItems}
          emptyMsg="No cards waiting"
          color="text-blue-400/70"
        />

        {/* Running section */}
        <TaskSection
          title="Running"
          tasks={runningItems}
          emptyMsg="No active tasks"
          color="text-amber-400/70"
        />

        {/* Completed section */}
        <TaskSection
          title="Completed"
          tasks={completedItems}
          emptyMsg="No completed tasks"
          color="text-emerald-400/70"
        />

        {/* Empty state */}
        {!queueLoading && queuedItems.length === 0 && runningItems.length === 0 && completedItems.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/50">
            <ListChecks className="mb-2 h-7 w-7 opacity-40" />
            <span className="text-[11px]">No tasks in queue</span>
            <span className="mt-1 text-[10px] opacity-60">
              {enabled ? 'Add cards to the kanban board and set them to Ready' : 'Enable auto-dispatch above'}
            </span>
          </div>
        )}
      </div>

      {/* Stats footer */}
      <div className="border-t border-border/20 px-3 py-2">
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground/50">
          <span>Done: <span className="font-mono text-emerald-400/70">{stats.completed}</span></span>
          <span>Failed: <span className="font-mono text-red-400/70">{stats.failed}</span></span>
          {queuedItems.length > 0 && (
            <span>Queued: <span className="font-mono text-blue-400/70">{queuedItems.length}</span></span>
          )}
          {runningItems.length > 0 && (
            <span>Running: <span className="font-mono text-amber-400/70">{runningItems.length}</span></span>
          )}
        </div>
      </div>
    </div>
  );
}
