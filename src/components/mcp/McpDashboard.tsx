import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  CircleSlash,
  Gauge,
  Loader2,
  Network,
  Plug,
  ScrollText,
  Terminal,
  Wrench,
  Zap,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  fetchHermesMcpTelemetry,
  fetchHermesMcpServerLogs,
  HermesApiError,
  type HermesMcpTelemetry,
  type HermesMcpLiveStatus,
  type HermesMcpServerStats,
  type HermesMcpCall,
  type HermesMcpLogLine,
} from '@/lib/hermes-api';
import { cn } from '@/lib/utils';

const ACCENT = '#ff8f3f';
const POLL_MS = 2500;
const LOG_POLL_MS = 3000;
const CHART_MINUTES = 30;

// ── status presentation ──────────────────────────────────────────────────────

type StatusKind = 'connected' | 'connecting' | 'disabled' | 'failed' | 'idle';

function statusKind(s?: HermesMcpLiveStatus): StatusKind {
  if (!s) return 'idle';
  if (s.status === 'connected' || s.connected) return 'connected';
  if (s.status === 'connecting') return 'connecting';
  if (s.disabled || s.status === 'disabled') return 'disabled';
  if (s.status === 'failed') return 'failed';
  return 'idle';
}

const STATUS_META: Record<StatusKind, { label: string; dot: string; glow: string; text: string }> = {
  connected: { label: 'Connected', dot: 'bg-emerald-500', glow: 'shadow-[0_0_7px_rgba(16,185,129,0.6)]', text: 'text-emerald-400' },
  connecting: { label: 'Connecting', dot: 'bg-amber-400', glow: 'shadow-[0_0_7px_rgba(251,191,36,0.6)]', text: 'text-amber-400' },
  disabled: { label: 'Disabled', dot: 'bg-muted-foreground/40', glow: '', text: 'text-muted-foreground/60' },
  failed: { label: 'Failed', dot: 'bg-red-500', glow: 'shadow-[0_0_7px_rgba(239,68,68,0.55)]', text: 'text-red-400' },
  idle: { label: 'Idle', dot: 'bg-sky-500/70', glow: '', text: 'text-sky-400/80' },
};

function StatusDot({ kind }: { kind: StatusKind }) {
  const m = STATUS_META[kind];
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {kind === 'connecting' && (
        <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', m.dot)} />
      )}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', m.dot, m.glow)} />
    </span>
  );
}

// ── time helpers ─────────────────────────────────────────────────────────────

function relTime(tsSeconds: number | null | undefined, now: number): string {
  if (!tsSeconds) return 'never';
  const d = Math.max(0, now / 1000 - tsSeconds);
  if (d < 1) return 'just now';
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function clockLabel(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Strip the mcp_<server>_ prefix so the tool name reads cleanly. */
function shortTool(tool: string): string {
  // Drop the leading "mcp_" namespace; the server name is shown separately.
  return tool.startsWith('mcp_') ? tool.replace(/^mcp_/, '') : tool;
}

// ── chart data ───────────────────────────────────────────────────────────────

interface ChartPoint {
  minute: number;
  label: string;
  calls: number;
  errors: number;
}

function bucketsToSeries(
  buckets: [number, number, number][],
  nowMinute: number,
  span = CHART_MINUTES,
): ChartPoint[] {
  const map = new Map<number, [number, number]>();
  for (const [m, c, e] of buckets) map.set(m, [c, e]);
  const out: ChartPoint[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const minute = nowMinute - i;
    const [c, e] = map.get(minute) ?? [0, 0];
    out.push({ minute, label: clockLabel(minute * 60), calls: c, errors: e });
  }
  return out;
}

function mergeAllBuckets(servers: Record<string, HermesMcpServerStats>): [number, number, number][] {
  const map = new Map<number, [number, number]>();
  for (const st of Object.values(servers)) {
    for (const [m, c, e] of st.buckets) {
      const cur = map.get(m) ?? [0, 0];
      map.set(m, [cur[0] + c, cur[1] + e]);
    }
  }
  return [...map.entries()].map(([m, [c, e]]) => [m, c, e] as [number, number, number]);
}

// ── small UI atoms ───────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneText =
    tone === 'good' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-400' : tone === 'bad' ? 'text-red-400' : 'text-foreground';
  return (
    <div className="flex flex-col rounded-xl border border-border/30 bg-background/30 p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/55">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className={cn('mt-1.5 font-mono text-[20px] font-semibold leading-none tabular-nums', toneText)}>{value}</div>
      {sub && <div className="mt-1 text-[10px] text-muted-foreground/45">{sub}</div>}
    </div>
  );
}

function MiniSparkline({ data, color = ACCENT }: { data: ChartPoint[]; color?: string }) {
  const empty = data.every((d) => d.calls === 0);
  return (
    <div className="h-9 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`spark-${color}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={empty ? 0.05 : 0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="calls"
            stroke={color}
            strokeWidth={1.5}
            strokeOpacity={empty ? 0.25 : 1}
            fill={`url(#spark-${color})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div className="rounded-lg border border-border/50 bg-background/95 px-2.5 py-1.5 text-[10px] shadow-lg backdrop-blur">
      <div className="font-mono text-muted-foreground/70">{p.label}</div>
      <div className="mt-0.5 text-foreground">
        {p.calls} call{p.calls === 1 ? '' : 's'}
        {p.errors > 0 && <span className="ml-1.5 text-red-400">· {p.errors} err</span>}
      </div>
    </div>
  );
}

// ── server card ──────────────────────────────────────────────────────────────

function ServerCard({
  name,
  status,
  stats,
  toolCount,
  nowMinute,
  now,
  onClick,
}: {
  name: string;
  status?: HermesMcpLiveStatus;
  stats?: HermesMcpServerStats;
  toolCount: number;
  nowMinute: number;
  now: number;
  onClick: () => void;
}) {
  const kind = statusKind(status);
  const meta = STATUS_META[kind];
  const series = useMemo(() => bucketsToSeries(stats?.buckets ?? [], nowMinute), [stats?.buckets, nowMinute]);
  const errRate = stats && stats.calls > 0 ? stats.errors / stats.calls : 0;
  const transport = status?.transport ?? 'stdio';

  return (
    <button
      onClick={onClick}
      className="group flex flex-col rounded-xl border border-border/30 bg-background/30 p-3.5 text-left transition-all hover:border-[#ff8f3f]/40 hover:bg-background/50"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot kind={kind} />
          <span className="truncate text-[13px] font-semibold text-foreground">{name}</span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-background/50 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground/60">
          {transport === 'http' ? <Network className="h-2.5 w-2.5" /> : <Terminal className="h-2.5 w-2.5" />}
          {transport === 'http' ? 'HTTP' : 'Stdio'}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <span className={cn('text-[10px] font-medium', meta.text)}>{meta.label}</span>
        <span className="text-[10px] text-muted-foreground/40">·</span>
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/50">
          <Wrench className="h-2.5 w-2.5" />
          {toolCount}
        </span>
      </div>

      <div className="mt-2.5 -mx-1">
        <MiniSparkline data={series} color={kind === 'failed' ? '#ef4444' : ACCENT} />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1 text-center">
        <div>
          <div className="font-mono text-[13px] font-semibold tabular-nums text-foreground">{stats?.calls ?? 0}</div>
          <div className="text-[8.5px] uppercase tracking-wide text-muted-foreground/40">calls</div>
        </div>
        <div>
          <div className={cn('font-mono text-[13px] font-semibold tabular-nums', errRate > 0 ? 'text-red-400' : 'text-foreground')}>
            {stats?.errors ?? 0}
          </div>
          <div className="text-[8.5px] uppercase tracking-wide text-muted-foreground/40">errors</div>
        </div>
        <div>
          <div className="font-mono text-[13px] font-semibold tabular-nums text-foreground">
            {stats?.avg_latency_ms != null ? `${Math.round(stats.avg_latency_ms)}` : '—'}
            {stats?.avg_latency_ms != null && <span className="text-[9px] text-muted-foreground/40">ms</span>}
          </div>
          <div className="text-[8.5px] uppercase tracking-wide text-muted-foreground/40">avg</div>
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-between border-t border-border/20 pt-2 text-[10px] text-muted-foreground/45">
        <span className="truncate">
          {stats?.last_tool ? shortTool(stats.last_tool) : 'no activity yet'}
        </span>
        <span className="inline-flex items-center gap-0.5 shrink-0 text-muted-foreground/35 transition-colors group-hover:text-[#ff8f3f]">
          {relTime(stats?.last_call_at, now)}
          <ChevronRight className="h-3 w-3" />
        </span>
      </div>
    </button>
  );
}

// ── activity feed row ────────────────────────────────────────────────────────

function CallRow({ call, now, showServer }: { call: HermesMcpCall; now: number; showServer?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-[11px] hover:bg-background/40">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', call.ok ? 'bg-emerald-500' : 'bg-red-500')} />
      {showServer && <span className="shrink-0 text-muted-foreground/45">{call.server}</span>}
      <span className="min-w-0 flex-1 truncate text-foreground/85">{shortTool(call.tool)}</span>
      {call.latency_ms != null && (
        <span className="shrink-0 tabular-nums text-muted-foreground/45">{Math.round(call.latency_ms)}ms</span>
      )}
      <span className="w-14 shrink-0 text-right text-muted-foreground/35">{relTime(call.ts, now)}</span>
    </div>
  );
}

// ── server detail drawer ─────────────────────────────────────────────────────

function ServerDetail({
  name,
  status,
  stats,
  tools,
  nowMinute,
  now,
  onClose,
}: {
  name: string;
  status?: HermesMcpLiveStatus;
  stats?: HermesMcpServerStats;
  tools: string[];
  nowMinute: number;
  now: number;
  onClose: () => void;
}) {
  const kind = statusKind(status);
  const meta = STATUS_META[kind];
  const series = useMemo(() => bucketsToSeries(stats?.buckets ?? [], nowMinute, CHART_MINUTES), [stats?.buckets, nowMinute]);
  const errRate = stats && stats.calls > 0 ? (stats.errors / stats.calls) * 100 : 0;

  const [logs, setLogs] = useState<HermesMcpLogLine[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsErr, setLogsErr] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const loadLogs = useCallback(async () => {
    try {
      const lines = await fetchHermesMcpServerLogs(name, 200);
      setLogs(lines);
      setLogsErr(null);
    } catch (err) {
      setLogsErr(err instanceof HermesApiError ? err.message : 'Could not read logs.');
    } finally {
      setLogsLoading(false);
    }
  }, [name]);

  useEffect(() => {
    setLogsLoading(true);
    void loadLogs();
    const id = setInterval(() => void loadLogs(), LOG_POLL_MS);
    return () => clearInterval(id);
  }, [loadLogs]);

  useEffect(() => {
    if (autoScroll) logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logs, autoScroll]);

  // Esc closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-20 flex justify-end bg-black/40 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-2xl flex-col border-l border-border/40 bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${name} details`}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <StatusDot kind={kind} />
            <span className="truncate text-[15px] font-semibold text-foreground">{name}</span>
            <span className={cn('rounded-full border border-border/40 px-2 py-0.5 text-[10px] font-medium', meta.text)}>
              {meta.label}
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/50">
              {status?.transport === 'http' ? <Network className="h-3 w-3" /> : <Terminal className="h-3 w-3" />}
              {status?.transport === 'http' ? 'HTTP' : 'Stdio'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {status?.error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/8 px-3 py-2 text-[11px] text-red-300/85">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-all font-mono">{status.error}</span>
            </div>
          )}

          {/* stats grid */}
          <div className="grid grid-cols-4 gap-2">
            <StatCard icon={Zap} label="Calls" value={stats?.calls ?? 0} />
            <StatCard icon={AlertTriangle} label="Errors" value={stats?.errors ?? 0} tone={(stats?.errors ?? 0) > 0 ? 'bad' : 'default'} />
            <StatCard
              icon={Gauge}
              label="Avg latency"
              value={stats?.avg_latency_ms != null ? `${Math.round(stats.avg_latency_ms)}` : '—'}
              sub={stats?.avg_latency_ms != null ? 'milliseconds' : undefined}
            />
            <StatCard
              icon={Activity}
              label="Error rate"
              value={`${errRate.toFixed(0)}%`}
              tone={errRate > 20 ? 'bad' : errRate > 0 ? 'warn' : 'good'}
            />
          </div>

          {/* activity chart */}
          <div className="rounded-xl border border-border/30 bg-background/30 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
                Activity · last {CHART_MINUTES}m
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/40">
                last call {relTime(stats?.last_call_at, now)}
              </span>
            </div>
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series} margin={{ top: 4, right: 0, bottom: 0, left: -28 }}>
                  <XAxis dataKey="label" tick={{ fontSize: 8, fill: 'hsl(var(--muted-foreground))' }} interval={Math.ceil(CHART_MINUTES / 6)} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 8, fill: 'hsl(var(--muted-foreground))' }} allowDecimals={false} width={28} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,143,63,0.08)' }} />
                  <Bar dataKey="calls" fill={ACCENT} radius={[2, 2, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="errors" fill="#ef4444" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* tools */}
          <div className="rounded-xl border border-border/30 bg-background/30 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Wrench className="h-3.5 w-3.5 text-muted-foreground/55" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
                Tools
              </span>
              <span className="text-[11px] text-muted-foreground/40">{tools.length}</span>
            </div>
            {tools.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/45">No tools registered for this server yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tools.map((t) => (
                  <span
                    key={t}
                    className="rounded-md border border-border/35 bg-background/50 px-2 py-0.5 font-mono text-[10px] text-foreground/80"
                  >
                    {shortTool(t)}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* recent calls */}
          <div className="rounded-xl border border-border/30 bg-background/30">
            <div className="flex items-center gap-2 border-b border-border/25 px-3 py-2">
              <Activity className="h-3.5 w-3.5 text-muted-foreground/55" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
                Recent calls
              </span>
            </div>
            {!stats?.recent.length ? (
              <p className="px-3 py-3 text-[11px] text-muted-foreground/45">No calls recorded yet.</p>
            ) : (
              <div className="max-h-52 overflow-y-auto py-1">
                {[...stats.recent].reverse().map((c, i) => (
                  <CallRow key={`${c.ts}-${i}`} call={c} now={now} />
                ))}
              </div>
            )}
          </div>

          {/* live logs */}
          <div className="rounded-xl border border-border/30 bg-[#0a0a0a]/60">
            <div className="flex items-center justify-between border-b border-border/25 px-3 py-2">
              <div className="flex items-center gap-2">
                <ScrollText className="h-3.5 w-3.5 text-muted-foreground/55" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
                  Live logs
                </span>
                {logsLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/50" />}
                <span className="inline-flex items-center gap-1 text-[9px] text-emerald-400/70">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> streaming
                </span>
              </div>
              <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground/55">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="h-3 w-3 accent-[#ff8f3f]"
                />
                auto-scroll
              </label>
            </div>
            <div className="max-h-64 overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed">
              {logsErr ? (
                <span className="text-red-400/80">{logsErr}</span>
              ) : logs.length === 0 && !logsLoading ? (
                <span className="text-muted-foreground/40">No log output captured for this server.</span>
              ) : (
                logs.map((l, i) =>
                  l.marker ? (
                    <div key={i} className="my-1 text-[10px] uppercase tracking-wide text-[#ff8f3f]/60">
                      {l.line}
                    </div>
                  ) : (
                    <div key={i} className="whitespace-pre-wrap break-all text-foreground/70">
                      {l.line}
                    </div>
                  ),
                )
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── main dashboard ───────────────────────────────────────────────────────────

export function McpDashboard() {
  const [tel, setTel] = useState<HermesMcpTelemetry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [live, setLive] = useState(true);

  const load = useCallback(async () => {
    try {
      const t = await fetchHermesMcpTelemetry();
      setTel(t);
      setError(null);
    } catch (err) {
      setError(err instanceof HermesApiError ? err.message : 'Could not reach the bridge.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (!live) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load, live]);

  // Drive relative timestamps without a full reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const nowMinute = Math.floor(now / 60000);

  // Union of servers known from live status + servers that have recorded stats.
  const serverNames = useMemo(() => {
    const set = new Set<string>();
    tel?.status.forEach((s) => set.add(s.name));
    if (tel) Object.keys(tel.servers).forEach((n) => set.add(n));
    if (tel) Object.keys(tel.tools).forEach((n) => set.add(n));
    return [...set].sort();
  }, [tel]);

  const statusByName = useMemo(() => {
    const m = new Map<string, HermesMcpLiveStatus>();
    tel?.status.forEach((s) => m.set(s.name, s));
    return m;
  }, [tel]);

  const overview = useMemo(() => {
    const connected = tel?.status.filter((s) => statusKind(s) === 'connected').length ?? 0;
    const failed = tel?.status.filter((s) => statusKind(s) === 'failed').length ?? 0;
    const tools = Object.values(tel?.tools ?? {}).reduce((a, t) => a + t.length, 0);
    let calls = 0;
    let errors = 0;
    let latSum = 0;
    let latN = 0;
    for (const st of Object.values(tel?.servers ?? {})) {
      calls += st.calls;
      errors += st.errors;
      if (st.avg_latency_ms != null) {
        latSum += st.avg_latency_ms * st.calls;
        latN += st.calls;
      }
    }
    return {
      connected,
      failed,
      tools,
      calls,
      errors,
      errRate: calls > 0 ? (errors / calls) * 100 : 0,
      avgLatency: latN > 0 ? latSum / latN : null,
      total: serverNames.length,
    };
  }, [tel, serverNames.length]);

  const globalSeries = useMemo(
    () => bucketsToSeries(mergeAllBuckets(tel?.servers ?? {}), nowMinute, CHART_MINUTES),
    [tel?.servers, nowMinute],
  );

  const peakCalls = useMemo(() => Math.max(1, ...globalSeries.map((p) => p.calls)), [globalSeries]);

  // resolve selected server tool list
  const selectedTools = selected ? tel?.tools[selected] ?? [] : [];

  if (loading && !tel) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground/60">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading MCP telemetry…
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* sub-header / overview */}
      <div className="border-b border-border/30 px-5 py-3">
        <div className="mx-auto max-w-6xl">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground/50">
              <span className="inline-flex items-center gap-1.5">
                <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/40')} />
                {live ? 'Live' : 'Paused'}
              </span>
              <span>·</span>
              <span className="font-mono">
                tracking since {tel ? clockLabel(tel.tracking_since) : '—'}
              </span>
            </div>
            <button
              onClick={() => setLive((v) => !v)}
              className="rounded-lg border border-border/50 bg-background/50 px-2.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {live ? 'Pause live updates' : 'Resume live updates'}
            </button>
          </div>

          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/8 px-3 py-2 text-[11px] text-red-300/80">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard icon={Plug} label="Servers" value={overview.total} sub={`${overview.connected} connected`} tone={overview.connected > 0 ? 'good' : 'default'} />
            <StatCard icon={CircleSlash} label="Failed" value={overview.failed} tone={overview.failed > 0 ? 'bad' : 'default'} />
            <StatCard icon={Wrench} label="Tools" value={overview.tools} />
            <StatCard icon={Zap} label="Tool calls" value={overview.calls} sub="all-time" />
            <StatCard icon={Gauge} label="Avg latency" value={overview.avgLatency != null ? `${Math.round(overview.avgLatency)}ms` : '—'} />
            <StatCard icon={Activity} label="Error rate" value={`${overview.errRate.toFixed(0)}%`} tone={overview.errRate > 20 ? 'bad' : overview.errRate > 0 ? 'warn' : 'good'} />
          </div>
        </div>
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-6xl space-y-6">
          {/* aggregate-activity */}
          <section className="rounded-xl border border-border/30 bg-background/30 p-3.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
                Aggregate activity · last {CHART_MINUTES}m
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/40">peak {peakCalls}/min</span>
            </div>
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={globalSeries} margin={{ top: 4, right: 4, bottom: 0, left: -28 }}>
                  <defs>
                    <linearGradient id="global-area" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" tick={{ fontSize: 8, fill: 'hsl(var(--muted-foreground))' }} interval={Math.ceil(CHART_MINUTES / 8)} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 8, fill: 'hsl(var(--muted-foreground))' }} allowDecimals={false} width={28} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: ACCENT, strokeOpacity: 0.3 }} />
                  <Area type="monotone" dataKey="calls" stroke={ACCENT} strokeWidth={1.5} fill="url(#global-area)" isAnimationActive={false} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* server grid */}
          <section>
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">Servers</h2>
              <span className="text-[11px] text-muted-foreground/40">{serverNames.length}</span>
            </div>
            {serverNames.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/40 py-12">
                <Network className="mb-2 h-6 w-6 text-muted-foreground/30" />
                <p className="text-[12px] text-muted-foreground/50">No MCP servers detected for your agent yet.</p>
                <p className="mt-1 text-[11px] text-muted-foreground/35">Install one from the Store tab to get started.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {serverNames.map((name) => (
                  <ServerCard
                    key={name}
                    name={name}
                    status={statusByName.get(name)}
                    stats={tel?.servers[name]}
                    toolCount={tel?.tools[name]?.length ?? statusByName.get(name)?.tools ?? 0}
                    nowMinute={nowMinute}
                    now={now}
                    onClick={() => setSelected(name)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* live-feed */}
          <section className="rounded-xl border border-border/30 bg-background/30">
            <div className="flex items-center gap-2 border-b border-border/25 px-3 py-2">
              <Activity className="h-3.5 w-3.5 text-muted-foreground/55" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
                Live activity feed
              </span>
            </div>
            {!tel?.recent.length ? (
              <p className="px-3 py-4 text-[11px] text-muted-foreground/45">
                No MCP tool calls recorded yet. Activity appears here the moment your agent invokes an MCP tool.
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto py-1">
                {[...tel.recent].reverse().map((c, i) => (
                  <CallRow key={`${c.ts}-${i}`} call={c} now={now} showServer />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {selected && (
        <ServerDetail
          name={selected}
          status={statusByName.get(selected)}
          stats={tel?.servers[selected]}
          tools={selectedTools}
          nowMinute={nowMinute}
          now={now}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
