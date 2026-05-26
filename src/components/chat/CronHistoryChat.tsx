import { useEffect, useRef } from 'react';
import { ArrowLeft, Clock, CheckCircle2, XCircle, Loader2, AlertCircle, RefreshCw, Play } from 'lucide-react';
import { useCronStore, type CronJob, type CronRun } from '@/stores/cron-store';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';
import { parseToolCalls, type Segment } from '@/lib/tool-call-parser';
import { ToolCallAccordion } from './ToolCallAccordion';

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

function RunStatusIcon({ status }: { status: CronRun['status'] }) {
  if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />;
  if (status === 'error') return <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" />;
  if (status === 'running') return <Loader2 className="h-4 w-4 text-blue-400 animate-spin flex-shrink-0" />;
  return <Clock className="h-4 w-4 text-muted-foreground/50 flex-shrink-0" />;
}

function scheduleLabel(job: CronJob): string {
  return job.schedule_display ?? job.schedule;
}

export function CronHistoryChat() {
  const selectedCronJobId = useUIStore((s) => s.selectedCronJobId);
  const setSelectedCronJobId = useUIStore((s) => s.setSelectedCronJobId);
  const { jobs, runHistory, loading, error, fetchJobs, fetchRunHistory, runJob } = useCronStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const job = jobs.find((j) => j.id === selectedCronJobId);
  const history = selectedCronJobId ? (runHistory[selectedCronJobId] ?? []) : [];

  // Fetch job list if empty, then fetch history
  useEffect(() => {
    if (!selectedCronJobId) return;
    if (jobs.length === 0) {
      void fetchJobs();
    }
    void fetchRunHistory(selectedCronJobId);
  }, [selectedCronJobId, fetchJobs, fetchRunHistory, jobs.length]);

  // Auto-scroll to top on new data
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [history.length]);

  if (!selectedCronJobId) return null;

  const handleRefresh = () => {
    if (selectedCronJobId) {
      void fetchRunHistory(selectedCronJobId);
    }
  };

  const handleRunNow = () => {
    if (selectedCronJobId) {
      void runJob(selectedCronJobId);
      // Refresh history shortly after to pick up the new run
      setTimeout(() => void fetchRunHistory(selectedCronJobId), 2000);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 bg-background/80 backdrop-blur-sm">
        <button
          onClick={() => setSelectedCronJobId(null)}
          className="p-1.5 rounded-md hover:bg-muted transition-colors"
          title="Back to chat"
        >
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-medium truncate">
              {job?.name || job?.id || 'Cron Job'}
            </h2>
            {job && (
              <span className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                job.status === 'active' ? 'bg-green-500/10 text-green-400' :
                job.status === 'paused' ? 'bg-yellow-500/10 text-yellow-400' :
                'bg-muted text-muted-foreground'
              )}>
                {job.status}
              </span>
            )}
          </div>
          {job && (
            <p className="text-[11px] text-muted-foreground/60 truncate mt-0.5">
              {scheduleLabel(job)} &middot; {job.prompt}
            </p>
          )}
        </div>
        <button
          onClick={handleRunNow}
          className="p-1.5 rounded-md hover:bg-muted transition-colors"
          title="Run now"
        >
          <Play className="h-4 w-4 text-blue-400" />
        </button>
        <button
          onClick={handleRefresh}
          className="p-1.5 rounded-md hover:bg-muted transition-colors"
          title="Refresh history"
        >
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* Run history as chat messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading && history.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/50" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
            <span className="text-[12px] text-red-400">{error}</span>
          </div>
        ) : !job ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-[12px] text-muted-foreground/50">Job not found</span>
          </div>
        ) : history.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Clock className="h-8 w-8 text-muted-foreground/20 mb-3" />
            <p className="text-[13px] text-muted-foreground/50">No runs yet</p>
            <p className="text-[11px] text-muted-foreground/30 mt-1">
              This cron job hasn't executed yet
            </p>
          </div>
        ) : (
          history.map((run) => (
            <RunCard key={run.run_id} run={run} jobPrompt={job.prompt} />
          ))
        )}
      </div>
    </div>
  );
}

function RunCard({ run, jobPrompt }: { run: CronRun; jobPrompt: string }) {
  const isRunning = run.status === 'running';
  const isError = run.status === 'error';

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 overflow-hidden">
      {/* System-style header: shows this was a cron run */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border/30">
        <RunStatusIcon status={run.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-muted-foreground/80">
              Run {run.run_id}
            </span>
            <span className={cn(
              'text-[9px] px-1.5 py-0.5 rounded-full font-medium',
              isError ? 'bg-red-500/10 text-red-400' :
              isRunning ? 'bg-blue-500/10 text-blue-400' :
              'bg-green-500/10 text-green-400'
            )}>
              {run.status}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground/50">
              {formatTimestamp(run.started_at)}
            </span>
            {run.duration_ms !== null && (
              <span className="text-[10px] text-muted-foreground/40">
                ({formatDuration(run.duration_ms)})
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Prompt that triggered this run */}
      <div className="px-3 py-2 border-b border-border/20 bg-blue-500/5">
        <p className="text-[10px] text-blue-400/70 uppercase tracking-wide mb-0.5">Prompt</p>
        <p className="text-[12px] text-foreground/80 whitespace-pre-wrap break-words">
          {jobPrompt}
        </p>
      </div>

      {/* Output — parse tool calls and render as accordions + plain text */}
      {run.output && (
        <div className="px-3 py-2">
          <p className="text-[10px] text-green-400/70 uppercase tracking-wide mb-0.5">Output</p>
          <div className="max-h-[200px] overflow-auto space-y-1">
            {(() => {
              const segments = parseToolCalls(run.output);
              return segments.map((seg, i) => {
                if (seg.type === 'tool') {
                  return <ToolCallAccordion key={i} segment={seg} />;
                }
                return (
                  <p
                    key={i}
                    className="text-[12px] text-foreground/80 whitespace-pre-wrap break-words leading-relaxed"
                  >
                    {(seg as Segment & { type: 'text' }).content}
                  </p>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* Error */}
      {isError && run.error && (
        <div className="px-3 py-2 bg-red-500/5 border-t border-red-500/10">
          <p className="text-[10px] text-red-400/70 uppercase tracking-wide mb-0.5">Error</p>
          <p className="text-[12px] text-red-400/90 whitespace-pre-wrap break-words">
            {run.error}
          </p>
        </div>
      )}

      {/* Running indicator */}
      {isRunning && (
        <div className="px-3 py-2 bg-blue-500/5 border-t border-blue-500/10">
          <div className="flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
            <span className="text-[12px] text-blue-400/80">Running...</span>
          </div>
        </div>
      )}
    </div>
  );
}
