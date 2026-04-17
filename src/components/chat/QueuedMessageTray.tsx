import React from 'react';
import { CornerDownLeft, GitBranchPlus, Trash2 } from 'lucide-react';
import type { QueuedMessage } from '@/lib/chat-queue';
import { cn } from '@/lib/utils';

interface QueuedMessageTrayProps {
  messages: QueuedMessage[];
  onRemove?: (messageId: string) => void;
  onSteer?: (messageId: string) => void;
  disabled?: boolean;
  connected?: boolean;
  waitingForOtherPanel?: boolean;
  className?: string;
}

export const QueuedMessageTray: React.FC<QueuedMessageTrayProps> = ({
  messages,
  onRemove,
  onSteer,
  disabled = false,
  connected = false,
  waitingForOtherPanel = false,
  className,
}) => {
  if (messages.length === 0) return null;

  return (
    <div className={cn(connected ? undefined : 'px-4 pb-2', className)}>
      <div
        className={cn(
          'overflow-hidden border border-border/70 bg-card/90 shadow-[0_16px_38px_rgba(0,0,0,0.22)] backdrop-blur-sm',
          connected ? 'rounded-t-[22px] rounded-b-none border-b-0 shadow-[0_10px_24px_rgba(0,0,0,0.18)]' : 'rounded-[22px]',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2 text-xs text-muted-foreground">
          <GitBranchPlus className="h-3.5 w-3.5" />
          <span className="font-medium">{messages.length} queued message{messages.length === 1 ? '' : 's'}</span>
          {waitingForOtherPanel && (
            <span className="ml-auto truncate text-[11px] text-muted-foreground/80">
              Waiting — profile is busy in another panel
            </span>
          )}
        </div>

        <div className="divide-y divide-border/60">
          {messages.map((message, index) => (
            <div key={message.id} className="flex items-start gap-3 px-4 py-3">
              <CornerDownLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />

              <div className="min-w-0 flex-1">
                <p className="text-sm leading-relaxed text-foreground/90">
                  {message.content}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => onSteer?.(message.id)}
                  disabled={disabled}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                    disabled
                      ? 'cursor-not-allowed bg-muted text-muted-foreground'
                      : 'bg-foreground text-background hover:opacity-85'
                  )}
                >
                  {index === 0 ? 'Steer next' : 'Steer'}
                </button>
                <button
                  onClick={() => onRemove?.(message.id)}
                  disabled={disabled}
                  className={cn(
                    'rounded-full p-1.5 transition-colors',
                    disabled
                      ? 'cursor-not-allowed text-muted-foreground/50'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                  title="Remove queued message"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
