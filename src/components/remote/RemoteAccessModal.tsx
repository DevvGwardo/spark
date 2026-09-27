import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getApiBaseUrl } from '@/lib/api';
import { Smartphone, Wifi, ExternalLink, Copy, Check, Globe, Loader2, RefreshCw, XCircle } from 'lucide-react';

interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  needsLogin: boolean;
  hostname: string | null;
  url: string | null;
  authUrl: string | null;
  serveConfigured: boolean;
  error: string | null;
}

interface RemoteInfo {
  url: string;
  localUrl: string;
  qrSvg: string;
  tailscale: TailscaleInfo;
  setupCommand: string;
}

export const RemoteAccessModal: React.FC<{ open: boolean; onOpenChange: (v: boolean) => void }> = ({
  open,
  onOpenChange,
}) => {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'url' | 'cmd' | null>(null);

  const fetchInfo = () => {
    setLoading(true);
    setError(null);
    fetch(`${getApiBaseUrl()}/api/remote/info`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setInfo(data);
      })
      .catch((e) => {
        setError(e.message || 'Could not fetch remote access info');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    setCopied(null);
    fetchInfo();
  }, [open]);

  const handleCopy = async (text: string, which: 'url' | 'cmd') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // clipboard write may fail in some browsers
    }
  };

  const ts = info?.tailscale;
  const ready = Boolean(ts?.serveConfigured && info?.url);
  const activeUrl = ready && info ? info.url : info?.localUrl ?? '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px] max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4" />
            Remote Access
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            Loading...
          </div>
        )}

        {error && !info && (
          <div className="py-4 text-sm text-destructive text-center">
            {error}
            <p className="text-muted-foreground text-xs mt-2">
              Remote access is only available when running in production mode (SERVE_FRONTEND=true).
            </p>
          </div>
        )}

        {info && ts && (
          <div className="flex flex-col items-center gap-4 w-full min-w-0">
            {/* QR Code */}
            {ready && info.qrSvg ? (
              <div className="bg-white rounded-xl p-3 flex items-center justify-center overflow-hidden">
                <img
                  src={info.qrSvg}
                  alt="QR Code"
                  className="w-44 h-44 max-w-full object-contain"
                />
              </div>
            ) : (
              <div className="w-44 h-44 rounded-xl bg-muted flex items-center justify-center text-muted-foreground text-sm shrink-0 text-center px-3">
                QR available once Spark is exposed to your tailnet
              </div>
            )}

            {/* Active URL */}
            <div className="w-full space-y-2">
              <div className="flex items-center gap-2 px-3 py-2 bg-muted rounded-lg min-w-0">
                {ready ? (
                  <Globe className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                ) : (
                  <Wifi className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="text-xs font-mono text-foreground truncate flex-1 select-all min-w-0">
                  {activeUrl}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleCopy(activeUrl, 'url')}
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    title="Copy URL"
                  >
                    {copied === 'url' ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <a
                    href={activeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    title="Open URL"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
            </div>

            {/* Tailscale status */}
            <div className="w-full rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <Globe className="h-3.5 w-3.5" />
                  Tailscale
                </div>
                <div className="flex items-center gap-2">
                  {!ts.installed ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium">
                      Not installed
                    </span>
                  ) : !ts.running ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted-foreground/10 text-muted-foreground font-medium">
                      Stopped
                    </span>
                  ) : ready ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500 font-medium">
                      Active
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 font-medium">
                      Not exposed
                    </span>
                  )}
                  <button
                    onClick={fetchInfo}
                    disabled={loading}
                    title="Refresh status"
                    aria-label="Refresh status"
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                  </button>
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground leading-relaxed break-words">
                {!ts.installed
                  ? 'Install Tailscale to reach Spark from your phone, anywhere — without exposing it to the public internet.'
                  : !ts.running
                    ? 'Start Tailscale on this computer, then expose Spark with the command below.'
                    : ready
                      ? 'Reachable from any device signed in to your tailnet. Nothing is exposed to the public internet.'
                      : 'Tailscale is running. Run the command below to expose Spark to your tailnet.'}
              </p>

              {ts.error && (
                <div className="text-[11px] text-destructive flex items-start gap-1.5">
                  <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
                  {ts.error}
                </div>
              )}

              {/* Copy-paste setup command — we never run this for the user. */}
              {ts.installed && ts.running && !ready && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 px-3 py-2 bg-background rounded-lg border border-border/60 min-w-0">
                    <code className="text-[11px] font-mono text-foreground truncate flex-1 select-all min-w-0">
                      {info.setupCommand}
                    </code>
                    <button
                      onClick={() => handleCopy(info.setupCommand, 'cmd')}
                      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                      title="Copy command"
                      aria-label="Copy setup command"
                    >
                      {copied === 'cmd' ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Run this in a terminal. Spark never changes your Tailscale configuration itself.
                  </p>
                </div>
              )}
            </div>

            {/* Steps */}
            <div className="w-full space-y-1.5 text-[11px] text-muted-foreground">
              {ready ? (
                <>
                  <p className="flex items-start gap-2">
                    <span className="text-foreground/60 font-mono">1.</span>
                    Install Tailscale on your phone and sign in to the same tailnet
                  </p>
                  <p className="flex items-start gap-2">
                    <span className="text-foreground/60 font-mono">2.</span>
                    Scan the QR with your camera
                  </p>
                  <p className="flex items-start gap-2">
                    <span className="text-foreground/60 font-mono">3.</span>
                    Spark opens in your mobile browser
                  </p>
                </>
              ) : (
                <>
                  <p className="flex items-start gap-2">
                    <span className="text-foreground/60 font-mono">1.</span>
                    Install and start Tailscale on this computer
                  </p>
                  <p className="flex items-start gap-2">
                    <span className="text-foreground/60 font-mono">2.</span>
                    Run the serve command above
                  </p>
                  <p className="flex items-start gap-2">
                    <span className="text-foreground/60 font-mono">3.</span>
                    Refresh this dialog to get the QR code
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
