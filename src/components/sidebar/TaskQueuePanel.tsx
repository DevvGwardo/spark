import React, { useEffect, useState, useCallback } from 'react';
import { Play, Square, Clock, ListChecks, Loader2, X } from 'lucide-react';
import { useTaskOrchestratorStore } from '@/stores/task-orchestrator-store';
import { cn } from '@/lib/utils';

function elapsed(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{elapsed(startedAt)}</>;
}

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

  useEffect(() => {
    fetchStatus();
    const id = setInterval(() => fetchStatus(), 5000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const handleCancel = useCallback(async (cardId: string) => {
    setCancelling(cardId);
    await cancelTask(cardId);
    setCancelling(null);
  }, [cancelTask]);

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
            {activeTasks.length}/{stats.startedAt ? stats.completed + stats.failed + activeTasks.length : '-'}
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
            <><Square className="h-3 w-3" /> Auto: ON</>
          ) : (
            <><Play className="h-3 w-3" /> Auto: OFF</>
          )}
        </button>
        <button
          onClick={dispatchNow}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border border-border/40 px-2 py-1 text-[10px] font-medium text-muted-foreground/60 transition-colors hover:border-border/70 hover:text-foreground disabled:opacity-40"
          title="Dispatch now"
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

      {/* Active Tasks */}
      <div className="px-3 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50">
          Running ({activeTasks.length})
        </span>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {activeTasks.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/50">
            <ListChecks className="mb-2 h-7 w-7 opacity-40" />
            <span className="text-[11px]">No active tasks</span>
            <span className="mt-1 text-[10px] opacity-60">
              {enabled ? 'Waiting for ready cards...' : 'Enable auto-dispatch above'}
            </span>
          </div>
        )}

        {loading && activeTasks.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground/60">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            <span className="text-[11px]">Loading...</span>
          </div>
        )}

        {activeTasks.map((task) => (
          <div
            key={task.cardId}
            className="group relative rounded-lg border border-amber-500/20 bg-amber-500/[0.03] px-2.5 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 animate-pulse" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/90">
                {task.cardId.slice(0, 12)}...
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                <ElapsedTimer startedAt={task.startedAt} />
              </span>
              <button
                onClick={() => handleCancel(task.cardId)}
                disabled={cancelling === task.cardId}
                className="shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100 disabled:opacity-40"
                title="Cancel task"
              >
                {cancelling === task.cardId ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <X className="h-3 w-3" />
                )}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Stats footer */}
      <div className="border-t border-border/20 px-3 py-2">
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground/50">
          <span>Done: <span className="font-mono text-emerald-400/70">{stats.completed}</span></span>
          <span>Failed: <span className="font-mono text-red-400/70">{stats.failed}</span></span>
          {stats.startedAt && (
            <span className="ml-auto font-mono">
              <ElapsedTimer startedAt={stats.startedAt} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
