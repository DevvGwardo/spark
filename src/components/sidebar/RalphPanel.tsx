import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Square, RefreshCw, Infinity as InfinityIcon } from 'lucide-react';
import { useRalphStore, type RalphRunView } from '@/stores/ralph-store';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

// ─── Ralph panel ───────────────────────────────────────────────────────────
// Start and watch fresh-agent Ralph runs. One objective, N rounds, the
// workspace dir is the memory. Compact single-panel treatment matching the
// other hermes sidebar panels.

const STATUS_STYLES: Record<string, string> = {
  running: 'text-amber-400',
  complete: 'text-emerald-400',
  blocked: 'text-red-400',
  'budget-limited': 'text-zinc-400',
  'round-failed': 'text-red-400',
  failed: 'text-red-400',
  cancelled: 'text-zinc-500',
};

function statusStyle(label: string): string {
  return STATUS_STYLES[label] ?? 'text-zinc-400';
}

function elapsed(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [, setNow] = useState(Date.now());
  const idRef = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => {
    idRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => { if (idRef.current) clearInterval(idRef.current); };
  }, []);
  return <>{elapsed(startedAt)}</>;
}

function RunCard({ run }: { run: RalphRunView }) {
  const cancelRun = useRalphStore((s) => s.cancelRun);
  const inFlight = run.finishedAt === null;

  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn('text-[10px] font-semibold uppercase tracking-wide', statusStyle(run.statusLabel))}>
              {run.statusLabel}
            </span>
            <span className="text-[10px] text-zinc-500">
              round {run.roundsStarted}/{run.maxRounds}
            </span>
            {inFlight && (
              <span className="text-[10px] text-zinc-500">
                · <ElapsedTimer startedAt={run.createdAt} />
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-zinc-200">{run.objective}</p>
        </div>
        {inFlight && (
          <button
            onClick={() => cancelRun(run.id).catch((e) => toast.error(e.message))}
            title="Cancel run"
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
          >
            <Square className="h-3 w-3" />
          </button>
        )}
      </div>

      {run.finalReport && (
        <p className="mt-1.5 line-clamp-2 text-[11px] text-zinc-400">{run.finalReport.summary}</p>
      )}
      {!run.finalReport && run.error && (
        <p className="mt-1.5 line-clamp-2 text-[11px] text-red-400/80">{run.error}</p>
      )}

      {run.rounds.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-300">
            {run.rounds.length} round{run.rounds.length === 1 ? '' : 's'} logged
          </summary>
          <div className="mt-1 space-y-0.5">
            {[...run.rounds].reverse().map((r) => (
              <div key={r.round} className="flex items-baseline gap-1.5 text-[10px]">
                <span className="w-8 shrink-0 text-zinc-600">#{r.round}</span>
                <span className={cn('shrink-0', statusStyle(r.status))}>{r.status}</span>
                <span className="truncate text-zinc-400">{r.summary}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <p className="mt-1.5 truncate text-[10px] text-zinc-600" title={run.workspaceDir}>
        {run.workspaceDir}
      </p>
    </div>
  );
}

export function RalphPanel() {
  const { runs, loading, error, fetchRuns, startRun } = useRalphStore();
  const [objective, setObjective] = useState('');
  const [maxRounds, setMaxRounds] = useState('5');
  const [workspace, setWorkspace] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void fetchRuns();
  }, [fetchRuns]);

  // Poll while any run is in flight.
  const anyInFlight = runs.some((r) => r.finishedAt === null);
  useEffect(() => {
    if (!anyInFlight) return;
    const id = setInterval(() => void fetchRuns(), 5000);
    return () => clearInterval(id);
  }, [anyInFlight, fetchRuns]);

  const handleStart = async () => {
    if (!objective.trim()) return;
    setStarting(true);
    try {
      const parsed = Math.max(1, Math.min(256, parseInt(maxRounds, 10) || 5));
      await startRun(objective.trim(), parsed, workspace.trim() || undefined);
      setObjective('');
      toast.success('Ralph loop started');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to start');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex items-center gap-1.5">
          <InfinityIcon className="h-3.5 w-3.5 text-zinc-400" />
          <span className="text-xs font-medium text-zinc-200">Ralph Loop</span>
        </div>
        <button
          onClick={() => void fetchRuns()}
          className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          title="Refresh"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="space-y-1.5 px-3 pb-3">
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Objective — e.g. 'fix all failing tests in ~/spark' (immutable across rounds)"
          rows={3}
          className="w-full resize-none rounded-md border border-border bg-transparent px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex gap-1.5">
          <input
            value={maxRounds}
            onChange={(e) => setMaxRounds(e.target.value)}
            inputMode="numeric"
            className="w-14 rounded-md border border-border bg-transparent px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-ring"
            title="Max rounds"
          />
          <input
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder="Workspace dir (optional)"
            className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <button
          onClick={() => void handleStart()}
          disabled={starting || !objective.trim()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-zinc-800 py-1.5 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          Start loop
        </button>
      </div>

      {error && (
        <p className="px-3 pb-2 text-[11px] text-red-400">{error}</p>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {runs.length === 0 && !loading && (
          <p className="px-1 text-[11px] text-zinc-600">
            No runs yet. Each round spawns a completely fresh agent — only the
            structured report and the workspace carry over.
          </p>
        )}
        {runs.map((run) => (
          <RunCard key={run.id} run={run} />
        ))}
      </div>
    </div>
  );
}
