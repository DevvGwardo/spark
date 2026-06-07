/**
 * WebBridgeSetup
 *
 * The browser/headless counterpart to BridgeSetupModal's Electron flow. When
 * CloudChat runs as a plain server (no Electron IPC), this drives the
 * server-side bridge manager over /api/bridge/* so a user — including one on a
 * phone over a tunnel — can install deps and start the bridge with one click,
 * or copy the one-command script to run on the host.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Loader2, X, AlertCircle, Sparkles, Download, RefreshCw, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getApiBaseUrl } from '@/lib/api';
import { OnboardingMotionConfig, SOFT_SPRING, SPRING, EASE_OUT } from '@/components/onboarding/motion';

interface ServerBridgeStatus {
  pythonPath: string | null;
  bridgeDepsInstalled: boolean;
  bridgeReachable: boolean;
  bridgeRunning: boolean;
  lastStartError: string | null;
  bridgePort: number;
  processHealth: 'running' | 'stopped' | 'crashed' | 'starting';
}

const POLL_INTERVAL_MS = 1500;
const SUCCESS_AUTOCLOSE_MS = 1200;
const START_COMMAND = './scripts/start-bridge.sh';

export const WebBridgeSetup: React.FC<{ onComplete: () => void }> = ({ onComplete }) => {
  const [status, setStatus] = useState<ServerBridgeStatus | null>(null);
  const [busy, setBusy] = useState<null | 'install' | 'start'>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const refresh = useCallback(async (): Promise<ServerBridgeStatus | null> => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/bridge/status`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const next = (await res.json()) as ServerBridgeStatus;
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  // Poll until the bridge is reachable, then auto-close.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const next = await refresh();
      if (cancelled) return;
      if (next?.bridgeReachable) {
        setDone(true);
        setTimeout(onComplete, SUCCESS_AUTOCLOSE_MS);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, onComplete]);

  const post = useCallback(
    async (path: string): Promise<{ ok: boolean; message?: string }> => {
      try {
        const res = await fetch(`${getApiBaseUrl()}${path}`, { method: 'POST', signal: AbortSignal.timeout(180_000) });
        const data = await res.json().catch(() => ({}));
        if (path.endsWith('/start')) return { ok: data.status !== 'failed', message: data.message };
        return { ok: Boolean(data.ok), message: data.message };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'request failed' };
      }
    },
    [],
  );

  const handleInstall = useCallback(async () => {
    setBusy('install');
    setError(null);
    const result = await post('/api/bridge/install-deps');
    if (!result.ok) setError(result.message ?? 'Dependency install failed');
    await refresh();
    // Deps in place — try to bring it up immediately.
    if (result.ok) await post('/api/bridge/start');
    await refresh();
    setBusy(null);
  }, [post, refresh]);

  const handleStart = useCallback(async () => {
    setBusy('start');
    setError(null);
    const result = await post('/api/bridge/start');
    if (!result.ok) setError(result.message ?? 'Bridge failed to start');
    const next = await refresh();
    if (result.ok && !next?.bridgeReachable) {
      setError(next?.lastStartError ?? 'Bridge is still unavailable.');
    }
    setBusy(null);
  }, [post, refresh]);

  const copyCommand = useCallback(() => {
    navigator.clipboard?.writeText(START_COMMAND).catch(() => {});
  }, []);

  const pythonOk = Boolean(status?.pythonPath);
  const depsOk = Boolean(status?.bridgeDepsInstalled);
  const reachable = Boolean(status?.bridgeReachable);

  const rows: Array<{ label: string; ok: boolean; detail: string }> = status
    ? [
        { label: 'Python interpreter', ok: pythonOk, detail: status.pythonPath ?? 'Python 3 not found on the host.' },
        { label: 'Bridge dependencies', ok: depsOk, detail: depsOk ? 'fastapi, uvicorn, httpx, pydantic installed.' : 'Not installed yet.' },
        { label: 'Bridge running', ok: reachable, detail: reachable ? `Listening on :${status.bridgePort}.` : 'Not started.' },
      ]
    : [];

  return (
    <OnboardingMotionConfig>
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Hermes Bridge Setup"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/85 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={EASE_OUT}
    >
      <motion.div
        className="w-[480px] max-w-[92vw] rounded-xl border border-border/60 bg-card shadow-2xl overflow-hidden"
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={SOFT_SPRING}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/60">
          <motion.div
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"
            animate={done ? { scale: [1, 1.12, 1] } : {}}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            <Sparkles className="h-4 w-4" />
          </motion.div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[14px] font-semibold tracking-tight">Setting up Hermes</h2>
            <p className="text-[12px] text-muted-foreground">
              {done ? 'Bridge is ready. Continuing…' : 'Start the Hermes bridge on the computer hosting Spark.'}
            </p>
          </div>
          {done && (
            <motion.div initial={{ scale: 0, rotate: -15 }} animate={{ scale: 1, rotate: 0 }} transition={SPRING}>
              <Check className="h-5 w-5 text-emerald-400" />
            </motion.div>
          )}
        </div>

        <div className="px-5 py-4 space-y-2.5">
          {!status && (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking the host…
            </div>
          )}

          {rows.map((row, i) => (
            <motion.div
              key={row.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1], delay: 0.04 + i * 0.06 }}
              className={cn(
                'flex items-start gap-3 rounded-lg border border-border/40 px-3 py-2.5 transition-colors duration-300',
                row.ok && 'bg-emerald-500/5 border-emerald-500/20',
              )}
            >
              <div className="flex h-5 w-5 items-center justify-center mt-0.5 shrink-0">
                {row.ok ? (
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={SPRING}>
                    <Check className="h-4 w-4 text-emerald-400" />
                  </motion.div>
                ) : (
                  <AlertCircle className="h-4 w-4 text-amber-400" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium">{row.label}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 break-words">{row.detail}</div>
              </div>
            </motion.div>
          ))}

          {status && !pythonOk && (
            <div className="text-[11px] text-muted-foreground">
              Install Python 3.10+ from{' '}
              <a href="https://www.python.org/downloads/" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">python.org</a>{' '}
              on the host, then click Refresh.
            </div>
          )}

          {/* One-command fallback for users sitting at the host machine. */}
          {status && !reachable && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">Or run on the host:</span>
              <button
                onClick={copyCommand}
                className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-background/70 px-2.5 py-1 text-[11px] font-mono text-foreground hover:bg-background"
              >
                {START_COMMAND}
                <Copy className="h-3 w-3" />
              </button>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300 break-words">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-border/60 bg-muted/10">
          <div className="flex items-center gap-2">
            <button
              onClick={() => refresh()}
              disabled={busy !== null}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background/65 px-2.5 text-[11px] font-medium hover:bg-background/90 disabled:opacity-40"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
            {pythonOk && !depsOk && !reachable && (
              <button
                onClick={handleInstall}
                disabled={busy !== null}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background/65 px-2.5 text-[11px] font-medium hover:bg-background/90 disabled:opacity-40"
              >
                {busy === 'install' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                Install dependencies
              </button>
            )}
            {depsOk && !reachable && (
              <button
                onClick={handleStart}
                disabled={busy !== null}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 text-[11px] font-medium text-primary hover:bg-primary/15 disabled:opacity-40"
              >
                {busy === 'start' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Start bridge
              </button>
            )}
          </div>
          <button
            onClick={onComplete}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
            Skip for now
          </button>
        </div>
      </motion.div>
    </motion.div>
    </OnboardingMotionConfig>
  );
};
