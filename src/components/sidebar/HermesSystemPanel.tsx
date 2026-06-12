import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Server, Cpu, HardDrive, Activity, CircleDot } from 'lucide-react';
import { fetchHermesSystem, type HermesSystemStats } from '@/lib/hermes-api';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function HermesSystemPanel() {
  const [stats, setStats] = useState<HermesSystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setStats(await fetchHermesSystem());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load system stats');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (loading && !stats) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-[12px] text-muted-foreground/60">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Reading system info...
      </div>
    );
  }

  const host = stats?.host;
  const disk = host?.disk;
  const diskPct = disk && disk.total > 0 ? (disk.used / disk.total) * 100 : 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Server className="h-3.5 w-3.5" />
          <span className="text-[12px] font-semibold uppercase tracking-wide">System</span>
        </div>
        <button
          onClick={() => { void load(); }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {stats && (
        <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-3">
          {/* Gateway status */}
          <div className="rounded-xl border border-border/40 bg-background/40 p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">
                <Activity className="h-3.5 w-3.5" />
                Gateway
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-[11px] font-medium',
                  stats.gateway.reachable ? 'text-emerald-300' : 'text-red-400',
                )}
              >
                <CircleDot className="h-3 w-3" />
                {stats.gateway.reachable ? 'Online' : 'Offline'}
              </span>
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground/55">
              Port {stats.gateway.port}
              {stats.hermes.version ? ` · Hermes ${stats.hermes.version}` : ''}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground/55">
              {stats.providers.active
                ? `Active provider: ${stats.providers.active}`
                : 'No active provider'}
              {` · ${stats.providers.count} configured`}
            </div>
          </div>

          {/* Host facts */}
          <div className="rounded-xl border border-border/40 bg-background/40 p-3">
            <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">Host</div>
            <dl className="space-y-1.5 text-[11px]">
              {[
                ['OS', host?.os],
                ['Architecture', host?.arch],
                ['Hostname', host?.hostname],
                ['Python', host?.python_version],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground/45">{label}</dt>
                  <dd className="min-w-0 truncate text-right text-foreground/80">{value || '—'}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* CPU + memory */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-border/40 bg-background/40 p-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/35">
                <Cpu className="h-3.5 w-3.5" />
                CPU
              </div>
              <div className="mt-2 text-[18px] font-semibold leading-none text-foreground">
                {host?.cpu_count ?? '—'}
                <span className="ml-1 text-[10px] font-normal text-muted-foreground/45">cores</span>
              </div>
              {host?.load_avg && (
                <div className="mt-1.5 text-[10px] text-muted-foreground/45">
                  load {host.load_avg.map((l) => l.toFixed(2)).join(' · ')}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-border/40 bg-background/40 p-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/35">
                <HardDrive className="h-3.5 w-3.5" />
                Memory
              </div>
              <div className="mt-2 text-[18px] font-semibold leading-none text-foreground">
                {formatBytes(host?.memory_total ?? null)}
              </div>
              <div className="mt-1.5 text-[10px] text-muted-foreground/45">total physical</div>
            </div>
          </div>

          {/* Disk */}
          {disk && (
            <div className="rounded-xl border border-border/40 bg-background/40 p-3">
              <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">
                <span className="flex items-center gap-2">
                  <HardDrive className="h-3.5 w-3.5" />
                  Disk
                </span>
                <span className="text-foreground/70">{diskPct.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-background/90">
                <div
                  className={cn(
                    'h-full rounded-full',
                    diskPct > 90 ? 'bg-red-400' : diskPct > 75 ? 'bg-yellow-400' : 'bg-[linear-gradient(90deg,#59d4ff_0%,#8fffc1_100%)]',
                  )}
                  style={{ width: `${Math.max(2, diskPct)}%` }}
                />
              </div>
              <div className="mt-1.5 text-[10px] text-muted-foreground/45">
                {formatBytes(disk.used)} used · {formatBytes(disk.free)} free of {formatBytes(disk.total)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
