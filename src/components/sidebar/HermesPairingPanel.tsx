import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Link2, UserCheck, Clock } from 'lucide-react';
import { fetchHermesPairing, type HermesPairingState } from '@/lib/hermes-api';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

export function HermesPairingPanel() {
  const [state, setState] = useState<HermesPairingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setState(await fetchHermesPairing());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pairing state');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const pending = state?.pending ?? [];
  const approved = state?.approved ?? [];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Link2 className="h-3.5 w-3.5" />
          <span className="text-[12px] font-semibold uppercase tracking-wide">Pairing</span>
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

      {loading && !state ? (
        <div className="flex flex-1 items-center justify-center px-4 text-[12px] text-muted-foreground/60">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading pairing...
        </div>
      ) : pending.length === 0 && approved.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-muted-foreground/50">
          No pairing requests or approved users.
        </div>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-3">
          {pending.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">
                <Clock className="h-3 w-3" />
                Pending ({pending.length})
              </div>
              <div className="space-y-1.5">
                {pending.map((req, i) => (
                  <div key={`${req.platform}-${req.code}-${i}`} className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-foreground/90">{req.platform}</span>
                      <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-[11px] text-yellow-300">{req.code}</code>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground/50">
                      {req.user_name || req.user_id || 'unknown user'}
                      {req.created_at ? ` · ${relativeTime(req.created_at)}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {approved.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/45">
                <UserCheck className="h-3 w-3" />
                Approved ({approved.length})
              </div>
              <div className="space-y-1.5">
                {approved.map((user, i) => (
                  <div key={`${user.platform}-${user.user_id}-${i}`} className="rounded-xl border border-border/40 bg-background/40 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] text-foreground/90">{user.user_name || user.user_id}</span>
                      <span className="shrink-0 rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground/55">{user.platform}</span>
                    </div>
                    {user.approved_at && (
                      <div className="mt-1 text-[10px] text-muted-foreground/40">paired {relativeTime(user.approved_at)}</div>
                    )}
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
