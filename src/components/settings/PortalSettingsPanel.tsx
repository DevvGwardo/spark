import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  LogIn,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import {
  fetchPortalInfo,
  fetchPortalOpenUrls,
  fetchPortalTools,
  pollPortalOAuth,
  startPortalOAuth,
  type PortalInfo,
  type PortalToolGatewayRow,
  type PortalToolsCatalog,
} from '@/lib/hermes-api';
import { openExternalUrl } from '@/lib/open-external';
import { cn } from '@/lib/utils';

function statusBadge(row: PortalToolGatewayRow) {
  if (row.via_nous) {
    return (
      <span className="text-[10px] text-emerald-500/90">via Portal</span>
    );
  }
  if (row.configured || row.active) {
    return (
      <span className="truncate text-[10px] text-muted-foreground">
        {row.provider || row.status_text}
      </span>
    );
  }
  return <span className="text-[10px] text-muted-foreground/60">not configured</span>;
}

export function PortalSettingsPanel({
  fieldLabelClass,
  settingsCardClass,
}: {
  fieldLabelClass: string;
  settingsCardClass: string;
}) {
  const [info, setInfo] = useState<PortalInfo | null>(null);
  const [tools, setTools] = useState<PortalToolsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  const [oauthUserCode, setOauthUserCode] = useState<string | null>(null);
  const [oauthVerificationUrl, setOauthVerificationUrl] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [infoRes, toolsRes] = await Promise.all([
        fetchPortalInfo(),
        fetchPortalTools(),
      ]);
      setInfo(infoRes);
      setTools(toolsRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Portal status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const beginPoll = useCallback(
    (sessionId: string, pollIntervalSec: number) => {
      stopPolling();
      const intervalMs = Math.max(1000, pollIntervalSec * 1000);
      pollTimerRef.current = setInterval(() => {
        void (async () => {
          try {
            const poll = await pollPortalOAuth(sessionId);
            if (poll.status === 'complete') {
              stopPolling();
              setOauthSessionId(null);
              setOauthUserCode(null);
              setOauthVerificationUrl(null);
              setStatus('Nous Portal login complete.');
              await load();
              return;
            }
            if (poll.status === 'error' || poll.status === 'expired') {
              stopPolling();
              setOauthSessionId(null);
              setOauthUserCode(null);
              setOauthVerificationUrl(null);
              setError(poll.error || 'Portal login failed');
            }
          } catch (err) {
            stopPolling();
            setOauthSessionId(null);
            setOauthUserCode(null);
            setOauthVerificationUrl(null);
            setError(err instanceof Error ? err.message : 'Portal login poll failed');
          }
        })();
      }, intervalMs);
    },
    [load, stopPolling],
  );

  const handleDeviceCodeLogin = useCallback(async () => {
    setOauthBusy(true);
    setError(null);
    setStatus(null);
    stopPolling();
    try {
      const start = await startPortalOAuth();
      if (!start.ok) {
        throw new Error(start.error || 'Could not start Portal login');
      }
      if (start.already_logged_in) {
        setStatus('Already logged in to Nous Portal.');
        await load();
        return;
      }
      if (!start.session_id || !start.user_code || !start.verification_url) {
        throw new Error('Portal login response was incomplete');
      }
      setOauthSessionId(start.session_id);
      setOauthUserCode(start.user_code);
      setOauthVerificationUrl(start.verification_url);
      openExternalUrl(start.verification_url);
      setStatus('Approve login in your browser, then enter the code if prompted.');
      beginPoll(start.session_id, start.poll_interval ?? 2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Portal login failed');
    } finally {
      setOauthBusy(false);
    }
  }, [beginPoll, load, stopPolling]);

  const copyUserCode = useCallback(async () => {
    if (!oauthUserCode) return;
    try {
      await navigator.clipboard.writeText(oauthUserCode);
      setStatus('User code copied.');
    } catch {
      setStatus('Copy the user code manually.');
    }
  }, [oauthUserCode]);

  const openUrls = async (kind: 'subscription' | 'login') => {
    setStatus(null);
    try {
      const urls = await fetchPortalOpenUrls();
      const target =
        kind === 'subscription' ? urls.subscription_url : urls.login_url;
      openExternalUrl(target);
      setStatus(
        kind === 'login'
          ? urls.login_hint
          : 'Opened Portal subscription page.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open Portal URL');
    }
  };

  const gatewayRows = tools?.tools?.length
    ? tools.tools
    : info?.tool_gateway ?? [];

  const configuredCount = gatewayRows.filter(
    (r) => r.via_nous || r.configured || r.active,
  ).length;

  return (
    <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={cn(fieldLabelClass, 'flex items-center gap-1.5')}>
            <Sparkles className="h-3.5 w-3.5 text-primary/90" />
            Nous Portal
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Free models + Tool Gateway via{' '}
            <span className="font-mono text-[11px]">hermes portal</span>. Use{' '}
            <span className="font-medium text-foreground/90">Login with device code</span>{' '}
            to connect without a terminal.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-border/60 p-1.5 text-muted-foreground hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-400">
          {error}
        </div>
      )}
      {status && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-400">
          {status}
        </div>
      )}

      {oauthUserCode && oauthVerificationUrl && (
        <div className="space-y-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2.5">
          <p className="text-[11px] text-muted-foreground">
            Waiting for browser approval…
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold tracking-wider text-foreground">
              {oauthUserCode}
            </span>
            <button
              type="button"
              onClick={() => void copyUserCode()}
              className="inline-flex items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <Copy className="h-3 w-3" />
              Copy
            </button>
            <button
              type="button"
              onClick={() => openExternalUrl(oauthVerificationUrl)}
              className="inline-flex items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              Reopen
            </button>
          </div>
          {oauthSessionId && (
            <p className="text-[10px] text-muted-foreground/70">
              Session active — polling for completion.
            </p>
          )}
        </div>
      )}

      {loading && !info ? (
        <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading…
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                info?.logged_in
                  ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
                  : 'border-amber-500/25 bg-amber-500/10 text-amber-400',
              )}
            >
              {info?.logged_in ? 'Logged in' : 'Not logged in'}
            </span>
            {info?.using_nous_provider && (
              <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                Nous provider
              </span>
            )}
            <span className="text-[10px] text-muted-foreground">
              Tool Gateway: {configuredCount}/{gatewayRows.length || '—'} active
            </span>
          </div>

          {info?.model_hint && (
            <p className="text-[11px] text-muted-foreground truncate">{info.model_hint}</p>
          )}

          {info?.inference_base_url && (
            <p className="truncate font-mono text-[10px] text-muted-foreground/70">
              API {info.inference_base_url}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {!info?.logged_in && (
              <button
                type="button"
                onClick={() => void handleDeviceCodeLogin()}
                disabled={oauthBusy || Boolean(oauthSessionId)}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
              >
                {oauthBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <LogIn className="h-3 w-3" />
                )}
                Login with device code
              </button>
            )}
            <button
              type="button"
              onClick={() => void openUrls('subscription')}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-[11px] text-foreground hover:bg-white/[0.03]"
            >
              <ExternalLink className="h-3 w-3" />
              Open Portal
            </button>
            <button
              type="button"
              onClick={() => void openUrls('login')}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-[11px] text-foreground hover:bg-white/[0.03]"
            >
              <Globe className="h-3 w-3" />
              Portal home
            </button>
            {info?.docs_url && (
              <button
                type="button"
                onClick={() => openExternalUrl(info.docs_url!)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/40 px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Globe className="h-3 w-3" />
                Docs
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setToolsOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 rounded-md border border-border/40 px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
          >
            {toolsOpen ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )}
            <span className="text-foreground">Tool Gateway tools</span>
            <span className="text-[10px]">({gatewayRows.length})</span>
          </button>

          {toolsOpen && (
            <div className="space-y-1 rounded-lg border border-border/40 bg-white/[0.02] p-2">
              {gatewayRows.length === 0 ? (
                <p className="px-1 py-0.5 text-[11px] text-muted-foreground">
                  No tools listed. Run{' '}
                  <span className="font-mono">hermes portal tools</span> locally.
                </p>
              ) : (
                gatewayRows.map((row) => (
                  <div
                    key={`${row.label}-${row.partner ?? ''}`}
                    className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-xs"
                  >
                    <div className="min-w-0">
                      <span className="truncate text-foreground">{row.label}</span>
                      {row.partner && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground/70">
                          {row.partner}
                        </span>
                      )}
                    </div>
                    {statusBadge(row)}
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
