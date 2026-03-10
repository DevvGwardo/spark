import React, { useMemo } from 'react';
import { getContextUsage } from '@/lib/tokens';
import { cn } from '@/lib/utils';

interface ContextUsageBarProps {
  messages: { role: string; content: string }[];
  model: string;
}

export const ContextUsageBar: React.FC<ContextUsageBarProps> = ({ messages, model }) => {
  const { percentage } = useMemo(() => getContextUsage(messages, model), [messages, model]);

  const severity = percentage > 90 ? 'critical' : percentage > 70 ? 'warning' : 'normal';
  const circumference = 2 * Math.PI * 14;
  const dashOffset = circumference - (percentage / 100) * circumference;

  return (
    <div
      aria-label={`${Math.round(percentage)}% of context used`}
      title={`${Math.round(percentage)}% of context used`}
      className="inline-flex items-center justify-center rounded-full border border-border/60 bg-background/45 p-1 shadow-[0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-sm"
    >
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
        <svg className="h-8 w-8 -rotate-90" viewBox="0 0 36 36" aria-hidden="true">
          <circle
            cx="18"
            cy="18"
            r="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="text-border/80"
          />
          <circle
            cx="18"
            cy="18"
            r="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className={cn(
              'transition-[stroke-dashoffset] duration-300',
              severity === 'critical' ? 'text-destructive' :
              severity === 'warning' ? 'text-amber-500' :
              'text-emerald-500'
            )}
          />
        </svg>
        <span className="absolute text-[10px] font-semibold tabular-nums tracking-[-0.02em] text-foreground">
          {Math.round(percentage)}%
        </span>
      </div>
    </div>
  );
};
