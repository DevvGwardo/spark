/**
 * BridgeSetupModal
 *
 * Shown on first launch (or after a failed bridge startup) when the Hermes
 * bridge can't run because Python, its deps, or hermes-agent are missing.
 *
 * Renders a checklist of requirements and lets the user install each one
 * with a single click. Auto-refreshes status after each install. Closes
 * itself once the bridge is reachable.
 *
 * The auth.json credential setup is handled by the existing SetupWizard,
 * which takes over once the bridge is healthy.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Check, Loader2, X, AlertCircle, Sparkles, Download, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

type BridgeStatus = NonNullable<NonNullable<typeof window.electronAPI>['bridge']> extends infer B
  ? B extends { status: () => Promise<infer S> }
    ? S
    : never
  : never;

type Phase = 'checking' | 'needs-action' | 'installing' | 'success' | 'no-electron';

interface Requirement {
  key: 'python' | 'git' | 'deps' | 'agent';
  label: string;
  description: string;
  satisfied: boolean;
  installable: boolean;
  installing: boolean;
  error?: string;
}

const POLL_INTERVAL_MS = 1500;
const SUCCESS_AUTOCLOSE_MS = 1200;

export const BridgeSetupModal: React.FC<{ onComplete: () => void }> = ({ onComplete }) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const electronAPI = window.electronAPI;
  const bridge = electronAPI?.bridge;

  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [phase, setPhase] = useState<Phase>(bridge ? 'checking' : 'no-electron');
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installing, setInstalling] = useState<Requirement['key'] | null>(null);
  const [startingBridge, setStartingBridge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async (): Promise<BridgeStatus | null> => {
    if (!bridge) return null;
    try {
      const next = await bridge.status();
      setStatus(next);
      return next;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, [bridge]);

  // Subscribe to install progress lines
  useEffect(() => {
    if (!bridge?.onInstallProgress) return;
    return bridge.onInstallProgress((line) => {
      setInstallLog((prev) => {
        const next = [...prev, line].slice(-200);
        return next;
      });
    });
  }, [bridge]);

  // Initial status + polling while waiting for bridge to come up
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      const next = await refreshStatus();
      if (cancelled) return;

      if (next?.bridgeReachable) {
        setError(null);
        setPhase('success');
        setTimeout(onComplete, SUCCESS_AUTOCLOSE_MS);
        return;
      }
      if (next && (!next.pythonPath || (!next.hermesAgentPresent && !next.gitPath) || !next.bridgeDepsInstalled || !next.hermesAgentPresent || next.lastStartError)) {
        setPhase((p) => (p === 'installing' ? 'installing' : 'needs-action'));
      } else if (next?.pythonPath && next?.bridgeDepsInstalled && next?.hermesAgentPresent && !next.bridgeReachable && !next.lastStartError) {
        // All prerequisites met, bridge just needs to be started.
        setPhase((p) => (p === 'installing' ? 'installing' : 'needs-action'));
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bridge, refreshStatus, onComplete]);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [installLog]);

  // Focus trap within modal
  useEffect(() => {
    const container = modalRef.current;
    if (!container) return;
    const focusable = container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length > 0) focusable[0].focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const els = [...focusable];
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  const requirements: Requirement[] = status
    ? [
        {
          key: 'python',
          label: 'Python interpreter',
          description: status.pythonPath
            ? `Found: ${status.pythonPath}`
            : 'CloudChat needs Python 3 to run the Hermes bridge.',
          satisfied: Boolean(status.pythonPath),
          installable: false, // user must install Python themselves
          installing: false,
        },
        {
          key: 'git',
          label: 'Git',
          description: status.hermesAgentPresent
            ? 'Not required because Hermes Agent is already installed.'
            : status.gitPath
              ? `Found: ${status.gitPath}`
              : 'Git is required to download Hermes Agent on first launch.',
          satisfied: status.hermesAgentPresent || Boolean(status.gitPath),
          installable: false,
          installing: false,
        },
        {
          key: 'deps',
          label: 'Bridge dependencies',
          description: status.bridgeDepsInstalled
            ? 'fastapi, uvicorn, httpx, pydantic installed.'
            : 'Install fastapi, uvicorn, httpx, pydantic into ~/.hermes/cloudchat-pkgs.',
          satisfied: status.bridgeDepsInstalled,
          installable: Boolean(status.pythonPath),
          installing: installing === 'deps',
        },
        {
          key: 'agent',
          label: 'Hermes Agent',
          description: status.hermesAgentPresent
            ? 'Already installed at ~/.hermes/hermes-agent.'
            : 'Clone NousResearch/hermes-agent (~1 GB) and install its Python dependencies.',
          satisfied: status.hermesAgentPresent,
          installable: Boolean(status.pythonPath && status.gitPath),
          installing: installing === 'agent',
        },
      ]
    : [];

  const canStartBridge = Boolean(
    status?.pythonPath &&
    status?.bridgeDepsInstalled &&
    status?.hermesAgentPresent &&
    !startingBridge,
  );

  const handleInstall = useCallback(
    async (key: Requirement['key']) => {
      if (!bridge) return;
      setInstalling(key);
      setError(null);
      setPhase('installing');
      setInstallLog((prev) => [...prev, `→ Installing ${key}…`]);

      try {
        const result =
          key === 'deps'
            ? await bridge.installDeps()
            : key === 'agent'
              ? await bridge.installHermesAgent()
              : { ok: false, message: 'Unsupported install target' };

        if (!result.ok) {
          setError(result.message ?? 'Install failed');
          setPhase('needs-action');
          setInstalling(null);
          return;
        }

        setInstallLog((prev) => [...prev, `✓ ${key} installed`]);
        // Try to (re)start the bridge after every successful install — once
        // deps + agent are present it should come up.
        const startResult = await bridge.start();
        if (startResult.status === 'failed') {
          setError(startResult.message ?? 'Bridge failed to start after install');
          await refreshStatus();
          setInstalling(null);
          setPhase('needs-action');
          return;
        }
        await refreshStatus();
        setInstalling(null);
        setPhase('needs-action');
      } catch (err) {
        setError((err as Error).message);
        setPhase('needs-action');
        setInstalling(null);
      }
    },
    [bridge, refreshStatus],
  );

  const handleStartBridge = useCallback(async () => {
    if (!bridge) return;
    setStartingBridge(true);
    setError(null);
    setInstallLog((prev) => [...prev, '→ Starting Hermes bridge…']);
    try {
      const result = await bridge.start();
      if (result.status === 'failed') {
        setError(result.message ?? 'Bridge failed to start');
        setPhase('needs-action');
        return;
      }
      setInstallLog((prev) => [...prev, '✓ Hermes bridge started']);
      const next = await refreshStatus();
      if (!next?.bridgeReachable) {
        setError(next?.lastStartError ?? 'Hermes bridge is still unavailable.');
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase('needs-action');
    } finally {
      setStartingBridge(false);
    }
  }, [bridge, refreshStatus]);

  if (phase === 'no-electron') {
    // Browser/dev mode without Electron — bridge management isn't applicable.
    return null;
  }

  const allSatisfied = requirements.every((r) => r.satisfied);

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="Hermes Bridge Setup" className="fixed inset-0 z-[100] flex items-center justify-center bg-background/85 backdrop-blur-sm">
      <div className="w-[480px] max-w-[92vw] rounded-xl border border-border/60 bg-card shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/60">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[14px] font-semibold tracking-tight">Setting up Hermes</h2>
            <p className="text-[12px] text-muted-foreground">
              {phase === 'success'
                ? 'Bridge is ready. Continuing…'
                : 'CloudChat needs a few things to run the Hermes Agent.'}
            </p>
          </div>
          {allSatisfied && phase === 'success' && (
            <Check className="h-5 w-5 text-emerald-400" />
          )}
        </div>

        <div className="px-5 py-4 space-y-2.5">
          {!status && (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking your system…
            </div>
          )}

          {requirements.map((req) => (
            <div
              key={req.key}
              className={cn(
                'flex items-start gap-3 rounded-lg border border-border/40 px-3 py-2.5',
                req.satisfied && 'bg-emerald-500/5 border-emerald-500/20',
                req.installing && 'bg-primary/5 border-primary/30',
              )}
            >
              <div className="flex h-5 w-5 items-center justify-center mt-0.5 shrink-0">
                {req.installing ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : req.satisfied ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : req.installable ? (
                  <Download className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-amber-400" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium">{req.label}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 break-words">
                  {req.description}
                </div>
                {!req.satisfied && req.key === 'python' && (
                  <div className="mt-2 text-[11px] text-muted-foreground">
                    Install Python 3.10+ from{' '}
                    <a
                      href="https://www.python.org/downloads/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2"
                    >
                      python.org
                    </a>
                    , then click Refresh.
                  </div>
                )}
                {!req.satisfied && req.key === 'git' && (
                  <div className="mt-2 text-[11px] text-muted-foreground">
                    Install{' '}
                    <a
                      href="https://git-scm.com/downloads"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2"
                    >
                      Git
                    </a>
                    , then click Refresh.
                  </div>
                )}
              </div>
              {!req.satisfied && req.installable && !req.installing && (
                <button
                  onClick={() => handleInstall(req.key)}
                  disabled={installing !== null}
                  className="ml-2 shrink-0 inline-flex h-7 items-center rounded-md border border-border/60 bg-background/65 px-2.5 text-[11px] font-medium hover:bg-background/90 disabled:opacity-40"
                >
                  Install
                </button>
              )}
            </div>
          ))}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
              {error}
            </div>
          )}

          {!error && status?.lastStartError && !status.bridgeReachable && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200">
              {status.lastStartError}
            </div>
          )}

          {installLog.length > 0 && (
            <div
              ref={logRef}
              className="mt-3 max-h-32 overflow-y-auto rounded-md border border-border/40 bg-muted/30 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
            >
              {installLog.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-border/60 bg-muted/10">
          <div className="flex items-center gap-2">
            {status?.processHealth && !status?.bridgeReachable && (
              <span className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                status.processHealth === 'crashed' && 'bg-red-500/10 text-red-400',
                status.processHealth === 'starting' && 'bg-sky-500/10 text-sky-300',
                status.processHealth === 'stopped' && 'bg-amber-500/10 text-amber-300',
              )}>
                {status.processHealth === 'crashed' && 'Crashed'}
                {status.processHealth === 'starting' && 'Starting…'}
                {status.processHealth === 'stopped' && 'Stopped'}
              </span>
            )}
            <button
              onClick={() => refreshStatus()}
              disabled={installing !== null || startingBridge}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background/65 px-2.5 text-[11px] font-medium hover:bg-background/90 disabled:opacity-40"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
            {canStartBridge && !status?.bridgeReachable && (
              <button
                onClick={handleStartBridge}
                disabled={startingBridge}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 text-[11px] font-medium text-primary hover:bg-primary/15 disabled:opacity-40"
              >
                {startingBridge ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
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
      </div>
    </div>
  );
};
