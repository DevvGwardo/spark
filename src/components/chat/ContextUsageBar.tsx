import React, { useMemo } from 'react';
import { estimateMessagesTokens, getModelContextWindow, formatTokenCount } from '@/lib/tokens';
import { useSettingsStore } from '@/stores/settings-store';
import { PROVIDERS } from '@/lib/providers';
import { cn } from '@/lib/utils';

interface ContextUsageBarProps {
  messages: { role: string; content: string }[];
}

export const ContextUsageBar: React.FC<ContextUsageBarProps> = ({ messages }) => {
  const { activeProvider, providers } = useSettingsStore();
  const config = providers[activeProvider];
  const providerInfo = PROVIDERS[activeProvider];

  const { used, total, percentage } = useMemo(() => {
    const used = estimateMessagesTokens(messages);
    const total = getModelContextWindow(config.model);
    const percentage = Math.min((used / total) * 100, 100);
    return { used, total, percentage };
  }, [messages, config.model]);

  const severity = percentage > 90 ? 'critical' : percentage > 70 ? 'warning' : 'normal';

  return (
    <div className="flex items-center gap-3 px-1">
      {/* Provider badge */}
      <span className="text-[11px] font-medium text-muted-foreground shrink-0 flex items-center gap-1.5">
        <span className={cn(
          "inline-block w-1.5 h-1.5 rounded-full",
          severity === 'critical' ? 'bg-destructive' :
          severity === 'warning' ? 'bg-amber-500' :
          'bg-emerald-500'
        )} />
        {providerInfo?.label ?? activeProvider}
        <span className="text-muted-foreground/60">·</span>
        <span className="font-mono">{config.model}</span>
      </span>

      {/* Progress bar */}
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden min-w-[60px] max-w-[160px]">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            severity === 'critical' ? 'bg-destructive' :
            severity === 'warning' ? 'bg-amber-500' :
            'bg-foreground/30'
          )}
          style={{ width: `${Math.max(percentage, 0.5)}%` }}
        />
      </div>

      {/* Token counts */}
      <span className="text-[11px] font-mono text-muted-foreground shrink-0">
        {formatTokenCount(used)}
        <span className="text-muted-foreground/50"> / </span>
        {formatTokenCount(total)}
      </span>
    </div>
  );
};
