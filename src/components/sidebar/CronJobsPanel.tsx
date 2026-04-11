import React, { useEffect, useState, useMemo } from 'react';
import { Plus, X, Pause, Play, PlayCircle, Trash2, Clock, AlertCircle, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { useCronStore, type CronJob, type CronRun } from '@/stores/cron-store';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/relative-time';

const SCHEDULE_PRESETS = [
  { label: 'Every 5 min', cron: '*/5 * * * *' },
  { label: 'Every 15 min', cron: '*/15 * * * *' },
  { label: 'Every 30 min', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily (midnight)', cron: '0 0 * * *' },
  { label: 'Daily (9 AM)', cron: '0 9 * * *' },
  { label: 'Weekly (Mon 9 AM)', cron: '0 9 * * 1' },
] as const;

function cronToHuman(cron: string): string | null {
  const trimmed = cron.trim();
  for (const p of SCHEDULE_PRESETS) {
    if (p.cron === trimmed) return p.label;
  }
  // Basic pattern matching for custom cron
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every N minutes
  if (min.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${min.slice(2)} minutes`;
  }
  // Every N hours
  if (min === '0' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${hour.slice(2)} hours`;
  }
  // Specific time daily
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    if (!isNaN(h) && !isNaN(m)) {
      const period = h >= 12 ? 'PM' : 'AM';
      const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `Daily at ${displayH}:${m.toString().padStart(2, '0')} ${period}`;
    }
  }
  return null;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function relativeTimeFuture(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'any moment';
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `in ${days}d`;
}

function RunStatusIcon({ status }: { status: CronRun['status'] }) {
  if (status === 'success') return <CheckCircle2 className="h-3 w-3 text-green-500 flex-shrink-0" />;
  if (status === 'error') return <XCircle className="h-3 w-3 text-red-400 flex-shrink-0" />;
  return <Loader2 className="h-3 w-3 text-blue-400 animate-spin flex-shrink-0" />;
}

function statusClasses(job: CronJob) {
  if (job.status === 'paused') {
    return {
      dot: 'bg-yellow-500',
      badge: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
    };
  }
  if (job.status === 'completed') {
    return {
      dot: 'bg-slate-400',
      badge: 'bg-slate-500/15 text-slate-500 dark:text-slate-300',
    };
  }
  if (job.last_status === 'error') {
    return {
      dot: 'bg-red-400',
      badge: 'bg-red-500/15 text-red-500 dark:text-red-300',
    };
  }
  return {
    dot: 'bg-green-500',
    badge: 'bg-green-500/15 text-green-600 dark:text-green-400',
  };
}

function scheduleLabel(job: CronJob): string {
  return job.schedule_display ?? cronToHuman(job.schedule) ?? job.schedule;
}

export interface CronJobsPanelProps {
  conversationId?: string | null;
  conversationTitle?: string | null;
}

export function filterJobsForConversation(jobs: CronJob[], conversationId?: string | null): CronJob[] {
  if (!conversationId) {
    return jobs;
  }
  return jobs.filter((job) => job.conversation_id === conversationId);
}

function CronJobRow({
  job,
  expanded,
  onToggle,
  highlightConversation,
}: {
  job: CronJob;
  expanded: boolean;
  onToggle: () => void;
  highlightConversation?: boolean;
}) {
  const { pauseJob, resumeJob, runJob, deleteJob, fetchRunHistory, runHistory } = useCronStore();
  const isPaused = job.status === 'paused';
  const isCompleted = job.status === 'completed';
  const statusStyle = statusClasses(job);
  const history = runHistory[job.id] ?? [];

  useEffect(() => {
    if (expanded) {
      fetchRunHistory(job.id);
    }
  }, [expanded, job.id, fetchRunHistory]);

  return (
    <div className="rounded-lg hover:bg-[hsl(var(--sidebar-active))] transition-colors">
      {/* Summary row — clickable */}
      <div
        className="group flex items-start gap-2 px-3 py-2 cursor-pointer"
        onClick={onToggle}
      >
        <div className="flex-shrink-0 mt-0.5">
          <div className={cn(
            'w-2 h-2 rounded-full',
            statusStyle.dot
          )} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium truncate">{job.name || job.id}</span>
            <span className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
              statusStyle.badge
            )}>
              {job.status}
            </span>
            {highlightConversation && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400">
                This chat
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5">
            {scheduleLabel(job)}
          </p>
          <p className="text-[11px] text-muted-foreground/50 truncate mt-0.5">{job.prompt}</p>
          {!highlightConversation && job.conversation_title && (
            <p className="text-[10px] text-muted-foreground/40 truncate mt-0.5">
              Linked to {job.conversation_title}
            </p>
          )}
        </div>
        <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {!isCompleted && (isPaused ? (
            <button onClick={(e) => { e.stopPropagation(); resumeJob(job.id); }} className="p-1 rounded hover:bg-background/50" title="Resume">
              <Play className="h-3.5 w-3.5 text-green-500" />
            </button>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); pauseJob(job.id); }} className="p-1 rounded hover:bg-background/50" title="Pause">
              <Pause className="h-3.5 w-3.5 text-yellow-500" />
            </button>
          ))}
          <button onClick={(e) => { e.stopPropagation(); runJob(job.id); }} className="p-1 rounded hover:bg-background/50" title="Run now">
            <PlayCircle className="h-3.5 w-3.5 text-blue-500" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); deleteJob(job.id); }} className="p-1 rounded hover:bg-background/50" title="Delete">
            <Trash2 className="h-3.5 w-3.5 text-red-400" />
          </button>
        </div>
      </div>

      {/* Expanded detail view */}
      {expanded && (
        <div className="mx-3 mb-2 p-3 rounded-lg bg-background/50 border border-border/50 space-y-2.5 text-[12px]">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground/60">ID</span>
            <span className="font-mono text-[11px]">{job.id}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground/60">Schedule</span>
            <span className="font-mono">{job.schedule}</span>
          </div>
          <div>
            <span className="text-muted-foreground/60 block mb-1">Prompt</span>
            <p className="text-[11px] bg-background/80 rounded p-2 whitespace-pre-wrap break-words">{job.prompt}</p>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground/60">Status</span>
            <span className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
              statusStyle.badge
            )}>
              {job.status}
            </span>
          </div>
          {job.conversation_title && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground/60">Linked chat</span>
              <span className="text-[11px] truncate ml-4">{job.conversation_title}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground/60">Created</span>
            <span className="text-[11px]">{new Date(job.created_at).toLocaleString()}</span>
          </div>
          {job.last_run && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground/60">Last run</span>
              <span className="text-[11px]">{relativeTime(job.last_run)} ({new Date(job.last_run).toLocaleString()})</span>
            </div>
          )}
          {job.next_run && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground/60">Next run</span>
              <span className="text-[11px]">
                {relativeTimeFuture(job.next_run)} ({new Date(job.next_run).toLocaleString()})
              </span>
            </div>
          )}

          {/* Run history */}
          <div className="pt-1 border-t border-border/30">
            <span className="text-muted-foreground/60 text-[11px] font-medium block mb-1.5">Run History</span>
            {history.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/40 italic">No run history yet</p>
            ) : (
              <div className="space-y-1.5">
                {history.slice(0, 5).map((run) => (
                  <div key={run.run_id} className="bg-background/80 rounded p-2 space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <RunStatusIcon status={run.status} />
                      <span className="text-[11px] text-muted-foreground/70">
                        {relativeTime(run.started_at)}
                      </span>
                      <span className="text-[10px] text-muted-foreground/40 ml-auto">
                        {formatDuration(run.duration_ms)}
                      </span>
                    </div>
                    {run.status === 'error' && run.error && (
                      <p className="text-[10px] text-red-400/80 truncate">{run.error}</p>
                    )}
                    {run.status === 'success' && run.output && (
                      <p className="text-[10px] text-muted-foreground/50 truncate">
                        {run.output.slice(0, 200)}
                      </p>
                    )}
                    {run.status === 'running' && (
                      <p className="text-[10px] text-blue-400/70">Running...</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function CronJobsPanel({ conversationId = null, conversationTitle = null }: CronJobsPanelProps) {
  const { jobs, loading, error, fetchJobs, createJob } = useCronStore();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [customMode, setCustomMode] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [showAllJobs, setShowAllJobs] = useState(false);

  const scheduleHuman = useMemo(() => schedule ? cronToHuman(schedule) : null, [schedule]);
  const showingConversationScope = !!conversationId && !showAllJobs;
  const visibleJobs = showingConversationScope
    ? filterJobsForConversation(jobs, conversationId)
    : jobs;

  useEffect(() => {
    if (!conversationId) {
      setShowAllJobs(true);
    } else {
      setShowAllJobs(false);
    }
  }, [conversationId]);

  useEffect(() => {
    fetchJobs(showingConversationScope ? conversationId : null);
  }, [conversationId, fetchJobs, showingConversationScope]);

  const handleCreate = async () => {
    if (!schedule.trim() || !prompt.trim()) return;
    setCreating(true);
    try {
      await createJob(
        schedule.trim(),
        prompt.trim(),
        name.trim() || undefined,
        {
          conversationId,
          conversationTitle,
        },
      );
      setName('');
      setSchedule('');
      setPrompt('');
      setShowForm(false);
    } catch {
      // error is in store
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide">Cron Jobs</span>
          {showingConversationScope && conversationTitle && (
            <p className="text-[11px] text-muted-foreground/50 truncate mt-0.5">
              Showing jobs for {conversationTitle}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {conversationId && (
            <button
              onClick={() => setShowAllJobs((current) => !current)}
              className="px-2 py-1 text-[10px] rounded hover:bg-[hsl(var(--sidebar-active))] text-muted-foreground/70"
              title={showingConversationScope ? 'Show all jobs' : 'Show only jobs for this chat'}
            >
              {showingConversationScope ? 'All' : 'This chat'}
            </button>
          )}
          <button
            onClick={() => setShowForm(!showForm)}
            className="p-1 rounded hover:bg-[hsl(var(--sidebar-active))] transition-colors"
            title={showForm ? 'Cancel' : 'Create job'}
          >
            {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="mx-3 mb-2 p-3 rounded-lg bg-background/50 border border-border/50 space-y-2.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            className="w-full px-2 py-1.5 text-[12px] rounded bg-background border border-border/50 outline-none focus:border-primary/50"
          />

          {/* Schedule presets */}
          <div>
            <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wide mb-1 block">Schedule</span>
            <div className="flex flex-wrap gap-1">
              {SCHEDULE_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  onClick={() => { setSchedule(p.cron); setCustomMode(false); }}
                  className={cn(
                    'px-2 py-1 text-[10px] rounded-full border transition-colors',
                    schedule === p.cron && !customMode
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border/50 text-muted-foreground/60 hover:bg-[hsl(var(--sidebar-active))]'
                  )}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => setCustomMode(true)}
                className={cn(
                  'px-2 py-1 text-[10px] rounded-full border transition-colors',
                  customMode
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border/50 text-muted-foreground/60 hover:bg-[hsl(var(--sidebar-active))]'
                )}
              >
                Custom
              </button>
            </div>
          </div>

          {/* Custom cron input */}
          {customMode && (
            <input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="* * * * *  (minute hour day month weekday)"
              className="w-full px-2 py-1.5 text-[12px] font-mono rounded bg-background border border-border/50 outline-none focus:border-primary/50"
            />
          )}

          {/* Human-readable confirmation */}
          {schedule && (
            <p className="text-[10px] text-muted-foreground/50">
              {scheduleHuman ? `Runs: ${scheduleHuman}` : `Cron: ${schedule}`}
            </p>
          )}
          {conversationTitle && (
            <p className="text-[10px] text-muted-foreground/50">
              This job will be linked to {conversationTitle}.
            </p>
          )}

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Prompt to execute..."
            rows={2}
            className="w-full px-2 py-1.5 text-[12px] rounded bg-background border border-border/50 outline-none focus:border-primary/50 resize-none"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowForm(false); setCustomMode(false); }}
              className="px-2.5 py-1 text-[11px] rounded hover:bg-[hsl(var(--sidebar-active))]"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !schedule.trim() || !prompt.trim()}
              className="px-2.5 py-1 text-[11px] rounded bg-primary text-primary-foreground disabled:opacity-40 hover:opacity-90"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-3 mb-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
          <span className="text-[11px] text-red-400">{error}</span>
        </div>
      )}

      {/* Job list */}
      <div className="flex-1 overflow-y-auto px-1">
        {loading && visibleJobs.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-[12px] text-muted-foreground/50">Loading...</span>
          </div>
        ) : visibleJobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 px-4">
            <Clock className="h-8 w-8 text-muted-foreground/30 mb-2" />
            <p className="text-[12px] text-muted-foreground/50 text-center">
              {showingConversationScope ? 'No cron jobs linked to this chat yet' : 'No cron jobs yet'}
            </p>
            <p className="text-[11px] text-muted-foreground/40 text-center mt-1">
              Click + to create one
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {visibleJobs.map((job) => (
              <CronJobRow
                key={job.id}
                job={job}
                expanded={selectedJobId === job.id}
                highlightConversation={!!conversationId && job.conversation_id === conversationId}
                onToggle={() => useUIStore.getState().setSelectedCronJobId(job.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
