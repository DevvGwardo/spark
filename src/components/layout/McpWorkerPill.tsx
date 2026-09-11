import React, { useEffect, useRef, useState } from 'react';
import type { McpWorkerStatus } from '@/electron.d';
import { cn } from '@/lib/utils';

type McpPillState = 'checking' | 'empty' | 'ready' | 'starting' | 'failed';

interface McpWorkerPillProps {
  /** Optional click handler (e.g. open MCP settings). No-op by default — no modal invented. */
  onClick?: () => void;
  className?: string;
}

const STATE_META: Record<McpPillState, { dot: string; pulse?: boolean }> = {
  checking: { dot: 'bg-muted-foreground/50', pulse: true },
  empty: { dot: 'bg-muted-foreground/50' },
  ready: { dot: 'bg-emerald-500' },
  starting: { dot: 'bg-amber-400', pulse: true },
  failed: { dot: 'bg-red-500' },
};

function aggregate(workers: McpWorkerStatus[]): McpPillState {
  if (workers.length === 0) return 'empty';
  if (workers.some((w) => w.state === 'failed')) return 'failed';
  if (workers.some((w) => w.state === 'starting')) return 'starting';
  if (workers.every((w) => w.state === 'ready')) return 'ready';
  return 'empty';
}

/**
 * Compact header pill surfacing MCP worker status. Polls
 * window.electronAPI.mcpWorker.status() on mount + every 8s; silent in web
 * mode (no electronAPI) where it renders a grey idle pill.
 */
export const McpWorkerPill: React.FC<McpWorkerPillProps> = ({ onClick, className }) => {
  const [workers, setWorkers] = useState<McpWorkerStatus[]>([]);
  const [checking, setChecking] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const poll = () => {
      const api = window.electronAPI?.mcpWorker;
      if (!api) {
        if (mountedRef.current) {
          setWorkers([]);
          setChecking(false);
        }
        return;
      }
      api
        .status()
        .then((status) => {
          if (!mountedRef.current) return;
          setWorkers(Array.isArray(status) ? status : []);
          setChecking(false);
        })
        .catch(() => {
          if (mountedRef.current) setChecking(false);
        });
    };

    poll();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') poll();
    }, 8000);

    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
    };
  }, []);

  const state: McpPillState = checking ? 'checking' : aggregate(workers);
  const { dot, pulse } = STATE_META[state];
  const count = workers.length;
  const label = checking ? 'MCP' : `MCP ${count}`;
  const tooltip =
    workers.length === 0
      ? 'MCP workers: none running'
      : `MCP workers:\n${workers.map((w) => `${w.serverId}: ${w.state}`).join('\n')}`;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={tooltip}
      aria-label={`MCP workers ${label}${state === 'failed' ? ' — a worker failed' : ''}`}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-2.5 text-[11px] font-medium text-muted-foreground transition-colors duration-100',
        onClick ? 'hover:bg-background/85 hover:text-foreground cursor-pointer' : 'cursor-default',
        className,
      )}
    >
      <span
        data-testid="mcp-worker-dot"
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot, pulse && 'motion-safe:animate-pulse')}
      />
      <span className="whitespace-nowrap tabular-nums">{label}</span>
    </button>
  );
};
