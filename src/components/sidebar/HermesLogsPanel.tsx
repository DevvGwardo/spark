import { useCallback, useEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Loader2, RefreshCw, ScrollText, Play, Pause } from 'lucide-react';
import {
  fetchHermesLogs,
  type HermesLogsResponse,
  type HermesLogEntry,
  type HermesLogFile,
  type HermesLogLevel,
} from '@/lib/hermes-api';
import { cn } from '@/lib/utils';

const LOG_FILES: Array<{ key: HermesLogFile; label: string }> = [
  { key: 'agent', label: 'Agent' },
  { key: 'errors', label: 'Errors' },
  { key: 'gateway', label: 'Gateway' },
];

const LEVELS: HermesLogLevel[] = ['ALL', 'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];

const LINE_COUNTS = [50, 100, 200, 500];

const REFRESH_MS = 5000;

const LEVEL_COLOR: Record<string, string> = {
  DEBUG: 'text-muted-foreground/50',
  INFO: 'text-sky-300/80',
  WARNING: 'text-yellow-400',
  ERROR: 'text-red-400',
  CRITICAL: 'text-red-300',
};

export function HermesLogsPanel() {
  const [file, setFile] = useState<HermesLogFile>('agent');
  const [level, setLevel] = useState<HermesLogLevel>('ALL');
  const [component, setComponent] = useState<string>('ALL');
  const [lines, setLines] = useState<number>(200);
  const [live, setLive] = useState(false);

  const [data, setData] = useState<HermesLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    try {
      const result = await fetchHermesLogs({ file, level, component, lines });
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Hermes logs');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [file, level, component, lines]);

  // Reset the component filter when switching files — its component set changes.
  useEffect(() => {
    setComponent('ALL');
  }, [file]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live tail: re-poll on an interval and pin the view to the newest line.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      void load(true);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [live, load]);

  const renderLogEntry = useCallback((_index: number, entry: HermesLogEntry) => (
    <div className="rounded px-1.5 py-0.5 font-mono text-[10.5px] leading-relaxed hover:bg-[hsl(var(--sidebar-active))]/40">
      <div className="flex items-baseline gap-2">
        {entry.ts && (
          <span className="shrink-0 text-muted-foreground/35">{entry.ts.slice(11, 19)}</span>
        )}
        <span className={cn('shrink-0 font-semibold', LEVEL_COLOR[entry.level] ?? 'text-muted-foreground/60')}>
          {entry.level}
        </span>
        {entry.component !== '-' && (
          <span className="shrink-0 truncate text-violet-300/60">{entry.component}</span>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words text-foreground/80">{entry.message}</div>
    </div>
  ), []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <ScrollText className="h-3.5 w-3.5" />
          <span className="text-[12px] font-semibold uppercase tracking-wide">Logs</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setLive((v) => !v)}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[10px] font-medium uppercase tracking-wide transition-colors',
              live
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'text-muted-foreground/60 hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground',
            )}
            title={live ? 'Stop live tail' : 'Live tail (5s)'}
          >
            {live ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            Live
          </button>
          <button
            onClick={() => { void load(); }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
            title="Refresh logs"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-2 px-3 pb-2">
        <div className="flex gap-1">
          {LOG_FILES.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFile(key)}
              className={cn(
                'flex-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors',
                file === key
                  ? 'bg-[hsl(var(--sidebar-active))] text-foreground'
                  : 'text-muted-foreground/60 hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as HermesLogLevel)}
            className="min-w-0 flex-1 rounded-lg border border-border/40 bg-background/40 px-2 py-1 text-[11px] text-foreground/90 outline-none"
          >
            {LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>{lvl === 'ALL' ? 'All levels' : lvl}</option>
            ))}
          </select>
          <select
            value={component}
            onChange={(e) => setComponent(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border/40 bg-background/40 px-2 py-1 text-[11px] text-foreground/90 outline-none"
          >
            <option value="ALL">All components</option>
            {(data?.components ?? []).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select
            value={lines}
            onChange={(e) => setLines(Number(e.target.value))}
            className="rounded-lg border border-border/40 bg-background/40 px-2 py-1 text-[11px] text-foreground/90 outline-none"
          >
            {LINE_COUNTS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex flex-1 items-center justify-center px-4 text-[12px] text-muted-foreground/60">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Reading logs...
        </div>
      ) : data?.missing ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-muted-foreground/50">
          No {file} log file found yet.
        </div>
      ) : data && data.entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-muted-foreground/50">
          No matching log lines.
        </div>
      ) : data ? (
        <Virtuoso
          ref={virtuosoRef}
          data={data.entries}
          className="min-h-0 flex-1 px-3 pb-3"
          itemContent={renderLogEntry}
          followOutput={live ? 'auto' : false}
        />
      ) : null}
    </div>
  );
}
