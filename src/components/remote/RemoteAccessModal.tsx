import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getApiBaseUrl } from '@/lib/api';
import { Smartphone, Wifi, ExternalLink, Copy, Check, Globe, Loader2, XCircle, Cloud, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RemoteInfo {
  url: string;
  lanUrl: string;
  localUrl: string;
  qrSvg: string;
}

interface TunnelStatus {
  running: boolean;
  url: string | null;
  provider: string | null;
  error: string | null;
  cloudflaredAvailable: boolean;
  brewAvailable: boolean;
}

const BASE = () => getApiBaseUrl();

export const RemoteAccessModal: React.FC<{ open: boolean; onOpenChange: (v: boolean) => void }> = ({
  open,
  onOpenChange,
}) => {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  const fetchInfo = () => {
    setLoading(true);
    setError(null);
    fetch(`${BASE()}/api/remote/info`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setInfo(data);
      })
      .catch((e) => {
        setError(e.message || 'Could not fetch remote access info');
        const origin = window.location.origin;
        if (origin && origin !== 'http://localhost:3001') {
          setInfo({ url: origin, lanUrl: origin, localUrl: origin, qrSvg: '' });
        }
      })
      .finally(() => setLoading(false));
  };

  const fetchTunnelStatus = () => {
    fetch(`${BASE()}/api/remote/tunnel/status`)
      .then((r) => r.json())
      .then(setTunnel)
      .catch(() => {});
  };

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    fetchInfo();
    fetchTunnelStatus();
  }, [open]);

  const handleStartTunnel = async () => {
    setTunnelLoading(true);
    setTunnelError(null);
    try {
      const res = await fetch(`${BASE()}/api/remote/tunnel/start`, { method: 'POST' });
      const data = await res.json();
      if (data.running) {
        setTunnel(data);
        // Refresh remote info so the QR updates with tunnel URL
        fetchInfo();
      } else {
        setTunnelError(data.error || 'Tunnel failed to start');
        setTunnel(data);
      }
    } catch (e: any) {
      setTunnelError(e.message || 'Failed to start tunnel');
    } finally {
      setTunnelLoading(false);
    }
  };

  const handleStopTunnel = async () => {
    try {
      await fetch(`${BASE()}/api/remote/tunnel/stop`, { method: 'POST' });
      setTunnel({ running: false, url: null, provider: null, error: null, cloudflaredAvailable: false, brewAvailable: false });
    } catch {}
  };

  const handleInstallCloudflared = async () => {
    setInstalling(true);
    try {
      const res = await fetch(`${BASE()}/api/remote/tunnel/install`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        fetchTunnelStatus();
      } else {
        setTunnelError(data.message || 'Install failed');
      }
    } catch {
      setTunnelError('Failed to install cloudflared');
    } finally {
      setInstalling(false);
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const activeUrl = tunnel?.running && tunnel.url ? tunnel.url : info?.url || '';
  const isServerMode = !!info?.qrSvg;

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

        {info && (
          <div className="flex flex-col items-center gap-4 w-full min-w-0">
            {/* QR Code */}
            {isServerMode && info.qrSvg ? (
              <div className="bg-white rounded-xl p-3 flex items-center justify-center overflow-hidden">
                <img
                  src={info.qrSvg}
                  alt="QR Code"
                  className="w-44 h-44 max-w-full object-contain"
                />
              </div>
            ) : (
              <div className="w-44 h-44 rounded-xl bg-muted flex items-center justify-center text-muted-foreground text-sm shrink-0">
                QR unavailable
              </div>
            )}

            {/* Active URL */}
            <div className="w-full space-y-2">
              <div className="flex items-center gap-2 px-3 py-2 bg-muted rounded-lg min-w-0">
                {tunnel?.running ? (
                  <Globe className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                ) : (
                  <Wifi className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="text-xs font-mono text-foreground truncate flex-1 select-all min-w-0">
                  {activeUrl}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleCopy(activeUrl)}
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    title="Copy URL"
                  >
                    {copied ? (
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

              {/* LAN URL hint */}
              {!tunnel?.running && info.lanUrl && info.lanUrl !== info.localUrl && (
                <p className="text-[11px] text-muted-foreground text-center">
                  Connect to the same Wi-Fi network to access via LAN
                </p>
              )}

              {/* Tunnel active hint */}
              {tunnel?.running && tunnel.url && (
                <p className="text-[11px] text-emerald-500 text-center flex items-center justify-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                  Public via {tunnel.provider === 'cloudflared' ? 'Cloudflare Tunnel' : 'Localtunnel'}
                </p>
              )}
            </div>

            {/* Tunnel section */}
            {isServerMode && (
              <div className="w-full rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Globe className="h-3.5 w-3.5" />
                    Public Access
                  </div>
                  {tunnel?.running ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500 font-medium">
                      Active
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted-foreground/10 text-muted-foreground font-medium">
                      Offline
                    </span>
                  )}
                </div>

                <p className="text-[11px] text-muted-foreground leading-relaxed break-words">
                  {tunnel?.running
                    ? 'Your Spark desktop is reachable at the URL above. Access requires the key embedded in the QR/link, so only devices that scan it can connect — still, keep the link private.'
                    : tunnel?.cloudflaredAvailable
                    ? 'Start a public tunnel to access Spark from anywhere, even outside your home network.'
                    : tunnel?.brewAvailable
                    ? 'Install Cloudflare Tunnel to get a secure public URL for remote access.'
                    : 'Install Cloudflare Tunnel (cloudflared) to access Spark from anywhere.'}
                </p>

                {tunnelError && (
                  <div className="text-[11px] text-destructive flex items-start gap-1.5">
                    <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
                    {tunnelError}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  {!tunnel?.running ? (
                    <>
                      <button
                        onClick={handleStartTunnel}
                        disabled={tunnelLoading}
                        className={cn(
                          'flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-lg text-[11px] font-medium transition-all duration-100',
                          tunnelLoading
                            ? 'bg-muted text-muted-foreground cursor-not-allowed'
                            : 'bg-foreground text-background hover:opacity-90 active:scale-[0.98]'
                        )}
                      >
                        {tunnelLoading ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Starting...
                          </>
                        ) : tunnel?.cloudflaredAvailable ? (
                          <>
                            <Globe className="h-3 w-3" />
                            Start Tunnel
                          </>
                        ) : (
                          <>
                            <Terminal className="h-3 w-3" />
                            Start Tunnel (localtunnel)
                          </>
                        )}
                      </button>
                      {!tunnel?.cloudflaredAvailable && tunnel?.brewAvailable && (
                        <button
                          onClick={handleInstallCloudflared}
                          disabled={installing}
                          className="inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg border border-border/60 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors duration-100"
                        >
                          {installing ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Cloud className="h-3 w-3" />
                          )}
                          Install
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={handleStopTunnel}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-lg border border-destructive/30 text-[11px] font-medium text-destructive hover:bg-destructive/10 transition-colors duration-100"
                    >
                      <XCircle className="h-3 w-3" />
                      Stop Tunnel
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Steps — simpler when tunnel is active */}
            {!tunnel?.running ? (
              <div className="w-full space-y-1.5 text-[11px] text-muted-foreground">
                <p className="flex items-start gap-2">
                  <span className="text-foreground/60 font-mono">1.</span>
                  Connect your phone to the same Wi-Fi as this computer
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-foreground/60 font-mono">2.</span>
                  Scan the QR with your camera or enter the URL
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-foreground/60 font-mono">3.</span>
                  Spark opens in your mobile browser
                </p>
              </div>
            ) : (
              <div className="w-full space-y-1.5 text-[11px] text-muted-foreground">
                <p className="flex items-start gap-2">
                  <span className="text-foreground/60 font-mono">1.</span>
                  Open your phone camera and scan the QR code
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-foreground/60 font-mono">2.</span>
                  Spark opens — works from anywhere, no Wi-Fi needed
                </p>
              </div>
            )}

            {!isServerMode && (
              <div className="w-full p-3 rounded-lg border border-amber-500/30 bg-amber-950/20 text-[11px] text-amber-400">
                Run in production mode (<code className="text-amber-300">npm run serve</code>) for QR codes, LAN detection, and tunnel support.
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
