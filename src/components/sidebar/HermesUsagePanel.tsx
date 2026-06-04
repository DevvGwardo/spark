import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Coins, Loader2, RefreshCw } from 'lucide-react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { fetchHermesWorkspaceUsage, type HermesUsageOverview } from '@/lib/hermes-api';
import { relativeTime } from '@/lib/relative-time';
import { formatCompactNumber, formatUsd, usageBudgetLevel } from '@/components/sidebar/hermesSidebarUtils';
import { SlotNumber } from '@/components/ui/SlotNumber';
import { cn } from '@/lib/utils';

const SUMMARY_FIELDS = [
  { key: 'session_count', label: 'Sessions' },
  { key: 'message_count', label: 'Messages' },
  { key: 'input_tokens', label: 'Input' },
  { key: 'output_tokens', label: 'Output' },
] as const;

// Soft monthly spend budget used purely to color the cost figure.
const USAGE_BUDGET_USD = 50;

const BUDGET_LEVEL_COLOR = {
  ok: 'text-foreground',
  warn: 'text-yellow-400',
  over: 'text-red-400',
} as const;

export function HermesUsagePanel() {
  const [usage, setUsage] = useState<HermesUsageOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = async () => {
    setLoading(true);
    try {
      const data = await fetchHermesWorkspaceUsage();
      setUsage(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Hermes usage');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadUsage();
  }, []);

  const maxModelTokens = useMemo(
    () => Math.max(...(usage?.top_models.map((model) => model.total_tokens) ?? [1])),
    [usage]
  );
  const maxDayTokens = useMemo(
    () => Math.max(...(usage?.recent_days.map((day) => day.total_tokens) ?? [1])),
    [usage]
  );

  if (loading && !usage) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-[12px] text-muted-foreground/60">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Reading Hermes usage...
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Usage</span>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/50">
            {usage?.last_session_started_at ? `Last session ${relativeTime(usage.last_session_started_at)}` : 'No historical sessions yet'}
          </p>
        </div>
        <button
          onClick={() => { void loadUsage(); }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          title="Refresh usage"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {usage && (
        <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-3">
          <div className="grid grid-cols-2 gap-2">
            {SUMMARY_FIELDS.map(({ key, label }) => (
              <div key={key} className="rounded-xl border border-border/40 bg-background/40 p-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/35">{label}</div>
                <SlotNumber
                  formattedValue={formatCompactNumber(usage[key])}
                  className="mt-2 text-[18px] font-semibold leading-none text-foreground"
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-border/40 bg-background/40 p-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/35">
                <Coins className="h-3.5 w-3.5" />
                Cost
              </div>
              <SlotNumber
                formattedValue={formatUsd(usage.cost_usd)}
                className={cn(
                  'mt-2 text-[18px] font-semibold leading-none',
                  BUDGET_LEVEL_COLOR[usageBudgetLevel(usage.cost_usd, USAGE_BUDGET_USD)],
                )}
              />
              <p className="mt-1 text-[10px] text-muted-foreground/45">
                Estimated from the Hermes session store
              </p>
            </div>
            <div className="rounded-xl border border-border/40 bg-background/40 p-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/35">
                <BarChart3 className="h-3.5 w-3.5" />
                Total Tokens
              </div>
              <SlotNumber
                formattedValue={formatCompactNumber(usage.total_tokens)}
                className="mt-2 text-[18px] font-semibold leading-none text-foreground"
              />
              <div className="mt-1 text-[10px] text-muted-foreground/45">
                <SlotNumber formattedValue={formatCompactNumber(usage.tool_call_count)} /> tool calls recorded
              </div>
            </div>
          </div>

          {usage.top_models.length > 0 && (
            <div className="rounded-xl border border-border/40 bg-background/40 p-3">
              <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">Top Models</div>
              <div className="space-y-2">
                {usage.top_models.map((model) => (
                  <div key={model.model} className="rounded-lg bg-background/35 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-[12px] text-foreground/90">{model.model}</span>
                      <span className="text-[10px] text-muted-foreground/45">
                        {formatCompactNumber(model.total_tokens)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-background/90">
                      <div
                        className="h-full rounded-full bg-[linear-gradient(90deg,#59d4ff_0%,#8fffc1_100%)]"
                        style={{ width: `${Math.max(8, (model.total_tokens / maxModelTokens) * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground/45">
                      <span>{formatCompactNumber(model.session_count)} sessions</span>
                      <span>{formatUsd(model.cost_usd)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border/40 bg-background/40 p-3">
            <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">Recent Activity</div>
            <div className="flex h-28 items-end gap-1.5">
              {usage.recent_days.slice(-7).map((day) => (
                <div key={day.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <div className="flex h-20 w-full items-end rounded-lg bg-background/70 px-1.5 py-1">
                    <div
                      className="w-full rounded-md bg-[linear-gradient(180deg,#ffb86b_0%,#ff8f3f_100%)]"
                      style={{
                        height: `${Math.max(day.total_tokens > 0 ? 14 : 0, (day.total_tokens / maxDayTokens) * 100)}%`,
                      }}
                      title={`${day.day}: ${formatCompactNumber(day.total_tokens)} tokens`}
                    />
                  </div>
                  <div className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/35">
                    {day.day.slice(5).replace('-', '/')}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground/45">
              {usage.first_session_started_at
                ? `History begins ${relativeTime(usage.first_session_started_at)}`
                : 'No session history recorded yet.'}
            </p>
          </div>

          {/* Token history area chart */}

          <div className="rounded-xl border border-border/40 bg-background/40 p-3">
            <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">
              Token Usage Over Time
            </div>
            <div className="h-40 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={usage.recent_days}>
                  <defs>
                    <linearGradient id="tokenGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#59d4ff" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#59d4ff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground) / 0.6)' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value: string) => value.slice(5).replace('-', '/')}
                    minTickGap={16}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground) / 0.6)' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => formatCompactNumber(value)}
                    width={32}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: '11px',
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '6px',
                      color: 'hsl(var(--popover-foreground))',
                    }}
                    formatter={(value: number) => [formatCompactNumber(value), 'Tokens']}
                    labelFormatter={(label) => `Day: ${label}`}
                  />
                  <Area
                    type="monotone"
                    dataKey="total_tokens"
                    stroke="#59d4ff"
                    strokeWidth={2}
                    fill="url(#tokenGradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Top Models bar chart */}

          {usage.top_models.length > 0 && (
            <div className="rounded-xl border border-border/40 bg-background/40 p-3">
              <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">
                Model Token Distribution
              </div>
              <div className="h-60 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={usage.top_models}
                    layout="vertical"
                    margin={{ top: 0, right: 4, left: 0, bottom: 0 }}
                  >
                    <XAxis
                      type="number"
                      tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground) / 0.6)' }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value) => formatCompactNumber(value)}
                    />
                    <YAxis
                      type="category"
                      dataKey="model"
                      tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground) / 0.6)' }}
                      tickLine={false}
                      axisLine={false}
                      width={90}
                      interval={0}
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: '11px',
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '6px',
                        color: 'hsl(var(--popover-foreground))',
                      }}
                      formatter={(value: number) => [formatCompactNumber(value), 'Tokens']}
                    />
                    <Bar
                      dataKey="total_tokens"
                      fill="#59d4ff"
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
