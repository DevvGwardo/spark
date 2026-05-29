import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Wifi, Power, Plug, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

// Relative paths only: the mobile view is served same-origin over the remote
// tunnel, where a phone cannot reach getApiBaseUrl()'s localhost:PORT form.

type TileState = 'idle' | 'running' | 'success' | 'failure';
type TileId = 'wake' | 'ping-bridge' | 'smart-plug';

interface TileResult {
  state: TileState;
  lastResult: string | null;
  lastTimestamp: number | null;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function stateIcon(state: TileState) {
  switch (state) {
    case 'running':
      return <Loader2 className="w-4 h-4 animate-spin text-amber-400" />;
    case 'success':
      return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    case 'failure':
      return <XCircle className="w-4 h-4 text-red-400" />;
    default:
      return null;
  }
}

function TileButton({
  tile,
  icon,
  label,
  subtitle,
  disabled,
  onClick,
}: {
  tile: TileResult;
  icon: React.ReactNode;
  label: string;
  subtitle: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || tile.state === 'running'}
      className={cn(
        'flex flex-col gap-2 w-full text-left p-4 rounded-xl border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 transition-colors min-h-[44px]',
        disabled && 'opacity-40 pointer-events-none',
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-3">
        {icon}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-neutral-200">{label}</div>
          <div className="text-xs text-neutral-500 mt-0.5">{subtitle}</div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          {stateIcon(tile.state)}
        </div>
      </div>
      {tile.lastResult && tile.lastTimestamp && (
        <div className="flex items-center gap-1.5 text-[11px] text-neutral-400 pl-1">
          <span>{tile.lastResult}</span>
          <span className="text-neutral-600">· {formatTime(tile.lastTimestamp)}</span>
        </div>
      )}
    </button>
  );
}

const RevivalPanel: React.FC = () => {
  const [tiles, setTiles] = useState<Record<TileId, TileResult>>({
    wake: { state: 'idle', lastResult: null, lastTimestamp: null },
    'ping-bridge': { state: 'idle', lastResult: null, lastTimestamp: null },
    'smart-plug': { state: 'idle', lastResult: null, lastTimestamp: null },
  });
  const [configured, setConfigured] = useState<{ wake: boolean; smartPlug: boolean } | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Env-gated actions are disabled upfront. Read which are configured from the
  // status endpoint once on mount (env can't change at runtime).
  useEffect(() => {
    let active = true;
    fetch('/api/remote/hermes-status')
      .then((r) => r.json())
      .then((d) => {
        if (active && d?.configured) setConfigured(d.configured);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const pollHermesStatus = useCallback(
    (_tileId: TileId, onSuccess: () => void, onTimeout: () => void) => {
      stopPolling();
      const start = Date.now();

      intervalRef.current = setInterval(async () => {
        try {
          const res = await fetch('/api/remote/hermes-status');
          const data = await res.json();
          if (data.online) {
            stopPolling();
            onSuccess();
            return;
          }
        } catch {
          // keep polling
        }

        if (Date.now() - start >= 60_000) {
          stopPolling();
          onTimeout();
        }
      }, 5000);
    },
    [stopPolling],
  );

  const setTile = useCallback((id: TileId, partial: Partial<TileResult>) => {
    setTiles(prev => ({ ...prev, [id]: { ...prev[id], ...partial } }));
  }, []);

  const runAction = useCallback(
    async (tileId: TileId, endpoint: string, label: string, pollAfter: boolean) => {
      setTile(tileId, { state: 'running', lastResult: null, lastTimestamp: null });

      try {
        const res = await fetch(endpoint, { method: 'POST' });

        if (res.status === 503) {
          setTile(tileId, { state: 'idle', lastResult: 'Not configured', lastTimestamp: Date.now() });
          return;
        }

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setTile(tileId, { state: 'failure', lastResult: body.error || `Error (${res.status})`, lastTimestamp: Date.now() });
          return;
        }

        const body = await res.json();
        setTile(tileId, { state: 'success', lastResult: body.message || label, lastTimestamp: Date.now() });

        if (pollAfter) {
          pollHermesStatus(
            tileId,
            () => setTile(tileId, { state: 'success', lastResult: 'Online ✓', lastTimestamp: Date.now() }),
            () => setTile(tileId, { state: 'failure', lastResult: 'Timed out', lastTimestamp: Date.now() }),
          );
        }
      } catch {
        setTile(tileId, { state: 'failure', lastResult: 'Network error', lastTimestamp: Date.now() });
      }
    },
    [setTile, pollHermesStatus],
  );

  return (
    <div className="flex flex-col gap-3 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1">
        Revival Actions
      </h2>

      <TileButton
        tile={tiles.wake}
        icon={<Wifi className="w-5 h-5 text-violet-400 shrink-0" />}
        label="Wake Computer"
        subtitle={configured?.wake === false ? 'Not configured' : 'Send Wake-on-LAN magic packet'}
        disabled={configured?.wake === false}
        onClick={() => runAction('wake', '/api/remote/wake', 'Packet sent — checking status…', true)}
      />

      <TileButton
        tile={tiles['ping-bridge']}
        icon={<Power className="w-5 h-5 text-amber-400 shrink-0" />}
        label="Ping Bridge"
        subtitle="Retry connection to the Hermes bridge"
        disabled={false}
        onClick={() => runAction('ping-bridge', '/api/remote/ping-bridge', 'Bridge reachable', false)}
      />

      <TileButton
        tile={tiles['smart-plug']}
        icon={<Plug className="w-5 h-5 text-orange-400 shrink-0" />}
        label="Smart Plug Power Cycle"
        subtitle={configured?.smartPlug === false ? 'Not configured' : 'Power-cycle the machine via smart plug'}
        disabled={configured?.smartPlug === false}
        onClick={() => runAction('smart-plug', '/api/remote/smart-plug', 'Power cycle triggered', true)}
      />
    </div>
  );
};

export default RevivalPanel;
