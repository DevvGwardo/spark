import React, { useEffect, useState } from 'react';
import { Activity, Database, Loader2, Orbit, RefreshCw, Rocket, Sparkles } from 'lucide-react';
import { fetchHermesWorkspaceOverview, type HermesWorkspaceOverview } from '@/lib/hermes-api';
import { relativeTime } from '@/lib/relative-time';
import { formatCompactNumber, formatBytes } from '@/components/sidebar/hermesSidebarUtils';
import { SlotNumber } from '@/components/ui/SlotNumber';
import { cn } from '@/lib/utils';

const METRIC_CARDS = [
  { key: 'tracked_sessions', label: 'Tracked Sessions', icon: Database },
  { key: 'live_sessions', label: 'Live Sessions', icon: Activity },
  { key: 'cron_jobs', label: 'Cron Jobs', icon: Rocket },
  { key: 'skills', label: 'Skills', icon: Sparkles },
] as const;

export function HermesOverviewPanel() {
  const [overview, setOverview] = useState<HermesWorkspaceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = async () => {
    setLoading(true);
    try {
      const data = await fetchHermesWorkspaceOverview();
      setOverview(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Hermes overview');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOverview();
  }, []);

  if (loading && !overview) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-[12px] text-muted-foreground/60">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading Hermes workspace...
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="mx-3 mt-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-[12px] text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Overview</span>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/50">
            {overview?.hermes_home ?? '~/.hermes'}
          </p>
        </div>
        <button
          onClick={() => { void loadOverview(); }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          title="Refresh overview"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {overview && (
        <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-3">
          <div className="grid grid-cols-2 gap-2">
            {METRIC_CARDS.map(({ key, label, icon: Icon }) => (
              <div key={key} className="rounded-xl border border-border/40 bg-background/40 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground/60" />
                  <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/35">
                    {label.split(' ')[0]}
                  </span>
                </div>
                <SlotNumber
                  formattedValue={formatCompactNumber(overview.counts[key])}
                  className="text-[18px] font-semibold leading-none text-foreground"
                />
                <p className="mt-1 text-[10px] text-muted-foreground/55">{label}</p>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border/40 bg-background/40 p-3">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">
              <Orbit className="h-3.5 w-3.5" />
              Runtime
            </div>
            <div className="mt-3 space-y-2 text-[12px]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground/55">Session source</span>
                <span className="truncate text-right text-foreground/85">
                  {overview.session_source.available ? 'state.db online' : 'state.db missing'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground/55">Cron backend</span>
                <span className="text-foreground/85">{overview.cron_backend}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground/55">Last session</span>
                <span className="text-foreground/85">
                  {overview.last_session_started_at ? relativeTime(overview.last_session_started_at) : 'No sessions'}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border/40 bg-background/40 p-3">
            <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">Canonical Files</div>
            <div className="space-y-2">
              {overview.files.map((file) => (
                <div key={file.key} className="rounded-lg border border-border/30 bg-background/40 p-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium text-foreground">{file.label}</p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground/50">{file.description}</p>
                    </div>
                    <div className="text-right text-[10px] text-muted-foreground/45">
                      <div>{formatBytes(file.size)}</div>
                      <div>{file.modified_at ? relativeTime(file.modified_at) : 'Missing'}</div>
                    </div>
                  </div>
                  {file.preview && (
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/60">
                      {file.preview}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {overview.top_models.length > 0 && (
            <div className="rounded-xl border border-border/40 bg-background/40 p-3">
              <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">Active Models</div>
              <div className="space-y-2">
                {overview.top_models.map((model) => (
                  <div key={model.model} className="rounded-lg bg-background/40 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-[12px] text-foreground/90">{model.model}</span>
                      <span className="text-[10px] text-muted-foreground/45">
                        {formatCompactNumber(model.session_count)} sessions
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-background/90">
                      <div
                        className="h-full rounded-full bg-[linear-gradient(90deg,#ff8f3f_0%,#ffcf8c_100%)]"
                        style={{
                          width: `${Math.max(8, Math.min(100, (model.total_tokens / Math.max(overview.counts.input_tokens + overview.counts.output_tokens, 1)) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
