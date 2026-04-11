import React, { useState, useEffect, useRef } from 'react';
import { Clock, Wrench, Square } from 'lucide-react';

interface StreamingStatusBarProps {
  isStreaming: boolean;
  toolCallCount: number;
  statusLabel?: string;
  embedded?: boolean;
  currentTool?: string;
  onStop?: () => void;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

export const StreamingStatusBar: React.FC<StreamingStatusBarProps> = ({
  isStreaming,
  toolCallCount,
  statusLabel,
  embedded = false,
  currentTool,
  onStop,
}) => {
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (isStreaming) {
      startTimeRef.current = Date.now();
      setElapsed(0);
      const interval = setInterval(() => {
        if (startTimeRef.current) {
          setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }
      }, 1000);
      return () => clearInterval(interval);
    } else {
      startTimeRef.current = null;
    }
  }, [isStreaming]);

  if (!isStreaming) return null;

  if (embedded) {
    return (
      <div className="flex items-center justify-between border-b border-primary/10 bg-primary/[0.04] px-4 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/40" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary/70" />
          </span>
          <Clock className="h-3 w-3" />
          <span className="tabular-nums">{formatElapsed(elapsed)}</span>
        </div>
        {statusLabel || currentTool ? (
          <div className="min-w-0 flex-1 px-3 text-center">
            <span className="truncate text-[11px] text-foreground/80">
              {currentTool || statusLabel}
            </span>
          </div>
        ) : <div className="flex-1" />}
        <div className="flex items-center gap-1.5">
          <Wrench className="h-3 w-3" />
          <span className="tabular-nums">{toolCallCount} tool{toolCallCount !== 1 ? 's' : ''}</span>
        </div>
        {onStop && (
          <button
            onClick={onStop}
            className="ml-2 flex items-center justify-center rounded-[6px] bg-red-500/10 border border-red-500/30 text-red-500 hover:bg-red-500/20 transition-colors duration-100"
            title="Stop generating"
            style={{ width: 22, height: 22, minWidth: 22 }}
          >
            <Square className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-[720px] mx-auto px-4">
      <div
        className="mx-auto flex items-center justify-between px-4 py-1.5 text-xs text-muted-foreground border border-border border-b-0 bg-card/80 backdrop-blur-sm rounded-t-xl"
        style={{ width: '85%' }}
      >
        <div className="flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          <span className="tabular-nums">{formatElapsed(elapsed)}</span>
        </div>
        {statusLabel || currentTool ? (
          <div className="min-w-0 flex-1 px-3 text-center">
            <span className="truncate text-[11px] text-foreground/80">
              {currentTool || statusLabel}
            </span>
          </div>
        ) : <div className="flex-1" />}
        <div className="flex items-center gap-1.5">
          <Wrench className="h-3 w-3" />
          <span className="tabular-nums">{toolCallCount} tool{toolCallCount !== 1 ? 's' : ''}</span>
        </div>
        {onStop && (
          <button
            onClick={onStop}
            className="ml-2 flex items-center justify-center rounded-[6px] bg-red-500/10 border border-red-500/30 text-red-500 hover:bg-red-500/20 transition-colors duration-100"
            title="Stop generating"
            style={{ width: 22, height: 22, minWidth: 22 }}
          >
            <Square className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    </div>
  );
};
