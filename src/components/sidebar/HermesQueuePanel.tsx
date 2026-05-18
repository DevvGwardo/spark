import React, { useMemo } from 'react';
import { Clock3, Columns2, CornerDownLeft, Ghost, Send, TimerReset, UserRound } from 'lucide-react';
import { useChatQueueStore } from '@/stores/chat-queue-store';
import { usePanelStore } from '@/stores/panel-store';
import { useChatStore } from '@/stores/chat-store';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/relative-time';

function truncateContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 140) {
    return trimmed;
  }
  return `${trimmed.slice(0, 137)}...`;
}

export const HermesQueuePanel: React.FC = () => {
  const panelQueues = useChatQueueStore((s) => s.panelQueues);
  const panels = usePanelStore((s) => s.panels);
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const conversations = useChatStore((s) => s.conversations);

  const items = useMemo(() => {
    const conversationTitles = new Map(conversations.map((conversation) => [conversation.id, conversation.title]));
    return Object.values(panelQueues)
      .filter((queue) => queue.messages.length > 0 || queue.isStreaming || queue.waitingForOtherPanel)
      .map((queue) => {
        const panel = panels.find((entry) => entry.id === queue.panelId);
        const title = queue.conversationId
          ? conversationTitles.get(queue.conversationId) || 'Untitled thread'
          : 'Draft thread';

        return {
          ...queue,
          title,
          isFocused: queue.panelId === focusedPanelId,
          panelLabel: queue.panelId === 'default'
            ? 'Main panel'
            : `Panel ${Math.max(panels.findIndex((entry) => entry.id === queue.panelId), 0) + 1}`,
          panelProfile: panel?.profile || queue.profile,
        };
      })
      .sort((left, right) => {
        if (left.messages.length !== right.messages.length) {
          return right.messages.length - left.messages.length;
        }
        return right.updatedAt.localeCompare(left.updatedAt);
      });
  }, [conversations, focusedPanelId, panelQueues, panels]);

  const totalQueued = items.reduce((sum, item) => sum + item.messages.length, 0);

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-14 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-background/60">
          <CornerDownLeft className="h-6 w-6 text-muted-foreground/40" />
        </div>
        <p className="mb-1 text-[13px] font-medium text-muted-foreground/70">Nothing queued</p>
        <p className="max-w-[240px] text-[11px] leading-relaxed text-muted-foreground/50">
          Messages sent while Hermes is already streaming will appear here so users can see what is waiting next.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[1px] text-[#666666]">Queue</span>
          <span className="rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {totalQueued} pending
          </span>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <TimerReset className="h-3.5 w-3.5" />
          FIFO per panel
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {items.map((item) => (
          <section
            key={item.panelId}
            className={cn(
              'overflow-hidden rounded-[18px] border border-border/70 bg-card/80',
              item.isFocused && 'border-primary/35 shadow-[0_0_0_1px_hsl(var(--primary)/0.14)]',
            )}
          >
            <div className="border-b border-border/60 px-4 py-3">
              <div className="flex items-center gap-2">
                <Columns2 className="h-3.5 w-3.5 text-muted-foreground/70" />
                <span className="text-[12px] font-medium text-foreground">{item.panelLabel}</span>
                {item.isFocused && (
                  <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-medium text-primary">
                    Focused
                  </span>
                )}
                <span className="ml-auto rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-[10px] text-muted-foreground">
                  {item.messages.length} queued
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground/75">
                <UserRound className="h-3.5 w-3.5" />
                <span className="truncate">{item.panelProfile}</span>
                <span className="text-muted-foreground/40">•</span>
                <span className="truncate">{item.title}</span>
              </div>
              {(item.isStreaming || item.waitingForOtherPanel) && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                  {item.isStreaming && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
                      <Ghost className="h-3.5 w-3.5" />
                      Streaming now
                    </span>
                  )}
                  {item.waitingForOtherPanel && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-300">
                      <Clock3 className="h-3.5 w-3.5" />
                      Waiting on same profile
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="divide-y divide-border/50">
              {item.messages.map((message, index) => (
                <div key={message.id} className="flex gap-3 px-4 py-3">
                  <div className="mt-0.5 rounded-full bg-muted/30 p-1 text-muted-foreground/80">
                    {index === 0 ? <Send className="h-3 w-3" /> : <CornerDownLeft className="h-3 w-3" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.8px] text-muted-foreground/60">
                      <span>{index === 0 ? 'Next up' : `Queued ${index + 1}`}</span>
                      <span>•</span>
                      <span>{relativeTime(message.createdAt)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90">
                      {truncateContent(message.content)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};
