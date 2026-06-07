import React, { useCallback, useEffect, useState } from 'react';
import { Check, Code2, ExternalLink, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchCursorComposerBridge, type CursorComposerBridgeStatus } from '@/lib/hermes-api';

const cardClass = 'rounded-[10px] border border-[#2a2a2a] bg-white/[0.02] overflow-hidden';
const buttonClass = 'rounded-[10px] px-4 py-2 text-[13px] font-medium transition-colors duration-100';

export default function CursorComposerTab() {
  const [status, setStatus] = useState<CursorComposerBridgeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchCursorComposerBridge();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Cursor Composer bridge status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connected = status?.connected ?? false;
  const bridge = status?.bridge;

  return (
    <div className="space-y-4 p-1">
      <div className={cardClass}>
        <div className="flex items-start gap-3 border-b border-[#2a2a2a] px-4 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-violet-500/10">
            <Code2 className="h-5 w-5 text-violet-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-foreground">Cursor Composer Bridge</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Hermes delegates coding to Composer 2.5 on this Mac via the local bridge at
              {' '}<code className="text-[11px]">127.0.0.1:8790</code>. Chat from Spark/Hermes;
              Composer edits repos with <code className="text-[11px]">composer-code</code>.
            </p>
          </div>
          <button
            onClick={() => { void load(); }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground/60 hover:bg-white/[0.04] hover:text-foreground"
            title="Refresh status"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          {loading && !status ? (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking bridge...
            </div>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 rounded-[10px] border border-red-500/20 bg-red-500/10 p-3 text-[12px] text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {status ? (
            <>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
                    connected
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : 'bg-amber-500/10 text-amber-300',
                  )}
                >
                  {connected ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                  {connected ? 'Bridge reachable' : 'Bridge down'}
                </span>
                {status.skills_ready ? (
                  <span className="text-[11px] text-muted-foreground">Skills installed</span>
                ) : (
                  <span className="text-[11px] text-amber-300">Install cursor-composer skill</span>
                )}
              </div>

              <dl className="grid gap-2 text-[12px]">
                <div className="flex justify-between gap-4 border-b border-[#2a2a2a]/60 py-2">
                  <dt className="text-muted-foreground">API</dt>
                  <dd className="truncate font-mono text-[11px] text-foreground">{bridge?.api_url ?? status.bridge_repo}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-[#2a2a2a]/60 py-2">
                  <dt className="text-muted-foreground">Health</dt>
                  <dd className="font-mono text-[11px] text-foreground">{bridge?.health_url ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-muted-foreground">Skills</dt>
                  <dd className="text-foreground">
                    {Object.entries(status.skills ?? {})
                      .map(([name, ok]) => `${name}${ok ? ' ✓' : ' ✗'}`)
                      .join(' · ') || '—'}
                  </dd>
                </div>
              </dl>

              {!connected && bridge?.detail ? (
                <p className="text-[11px] text-muted-foreground">{bridge.detail}</p>
              ) : null}

              <div className="flex flex-wrap gap-2 pt-1">
                <a
                  href="https://github.com"
                  onClick={(e) => {
                    e.preventDefault();
                    window.open(`file://${status.bridge_repo}`, '_blank');
                  }}
                  className={cn(buttonClass, 'inline-flex items-center gap-2 border border-[#2a2a2a] bg-white/[0.03] text-foreground hover:bg-white/[0.06]')}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open bridge folder
                </a>
              </div>

              <div className="rounded-[10px] bg-white/[0.02] p-3 text-[11px] leading-relaxed text-muted-foreground">
                <p className="font-medium text-foreground/80">From Hermes chat</p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground/90">
                  Use Composer with a worktree on ~/my-repo to add the health endpoint
                </p>
                <p className="mt-2 font-medium text-foreground/80">Start bridge (launchd)</p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground/90">
                  launchctl kickstart -k gui/$(id -u)/com.gwardo.cursor-composer-bridge
                </p>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
