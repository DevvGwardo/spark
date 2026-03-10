import React, { useRef, useEffect } from 'react';
import { ArrowUp, Square, Plus, ChevronDown, Mic, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';
import { PROVIDERS, REASONING_EFFORTS, supportsReasoningEffort } from '@/lib/providers';
import type { QueuedMessage } from '@/lib/chat-queue';
import { StreamingStatusBar } from './StreamingStatusBar';
import { QueuedMessageTray } from './QueuedMessageTray';
import { ContextUsageBar } from './ContextUsageBar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ChatInputProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  isStreaming: boolean;
  toolCallCount?: number;
  disabled?: boolean;
  messages?: { role: string; content: string }[];
  activeProvider?: string;
  activeModel?: string;
  queuedMessages?: QueuedMessage[];
  onRemoveQueuedMessage?: (messageId: string) => void;
  onSteerQueuedMessage?: (messageId: string) => void;
}

const REASONING_EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
} as const;

export const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  toolCallCount = 0,
  disabled,
  messages = [],
  activeModel,
  queuedMessages = [],
  onRemoveQueuedMessage,
  onSteerQueuedMessage,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { activeProvider: selectedProvider, providers, updateProviderConfig } = useSettingsStore();
  const config = providers[selectedProvider];
  const providerInfo = PROVIDERS[selectedProvider];
  const models = providerInfo?.models || [];
  const displayModel = config.model.split('/').pop() || config.model;
  const meterModel = activeModel ?? config.model;
  const reasoningSupported = supportsReasoningEffort(selectedProvider, config.model);
  const reasoningLabel = REASONING_EFFORT_LABELS[config.reasoningEffort];

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  }, [value]);

  const safeValue = value ?? '';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (safeValue.trim()) onSend();
    }
  };

  const hasContent = messages.length > 0;
  const hasMessageHistory = messages.some((message) => message.content.trim().length > 0);
  const hasQueuedMessages = queuedMessages.length > 0;
  const canQueueDraft = isStreaming && !!safeValue.trim() && !disabled;

  return (
    <div className="w-full max-w-[720px] mx-auto px-4 pb-3 pt-2">
      <div className="flex flex-col">
        <QueuedMessageTray
          messages={queuedMessages}
          onRemove={onRemoveQueuedMessage}
          onSteer={onSteerQueuedMessage}
          disabled={disabled}
          connected={hasQueuedMessages}
        />

        <div
          className={cn(
            'relative overflow-hidden border border-border bg-card',
            hasQueuedMessages ? 'rounded-b-2xl rounded-t-none border-t-0' : 'rounded-2xl',
          )}
        >
          <StreamingStatusBar
            isStreaming={isStreaming}
            toolCallCount={toolCallCount}
            embedded
          />

          {hasMessageHistory && (
            <div className="flex justify-end px-3 pt-3 pb-0">
              <ContextUsageBar
                messages={messages}
                model={meterModel}
              />
            </div>
          )}

          {/* Textarea area */}
          <div className="flex items-end gap-2 px-4 py-3">
            <textarea
              ref={textareaRef}
              value={safeValue}
              onChange={(e) => {
                if (typeof onChange === 'function') onChange(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              placeholder={hasContent ? 'Ask for follow-up changes' : 'What do you want to build?'}
              rows={1}
              disabled={disabled}
              className={cn(
                "flex-1 resize-none bg-transparent text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none min-h-[20px] max-h-[200px]",
                disabled && "opacity-50"
              )}
            />
          </div>

          {/* Bottom toolbar — Codex style */}
          <div className="flex items-center gap-1 px-3 pb-2.5">
            {/* Plus button */}
            <button
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100"
              title="Attach"
            >
              <Plus className="h-4 w-4" />
            </button>

            {/* Model selector */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100">
                  {displayModel}
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
                {models.map((model) => {
                  const label = model.split('/').pop() || model;
                  return (
                    <DropdownMenuItem
                      key={model}
                      onClick={() => updateProviderConfig(selectedProvider, { model })}
                      className={model === config.model ? 'bg-accent' : ''}
                    >
                      <span className="text-xs">{label}</span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {reasoningSupported && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label={`Reasoning effort: ${reasoningLabel}`}
                    title="Adjust reasoning effort"
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100"
                  >
                    {`Reasoning: ${reasoningLabel}`}
                    <ChevronDown className="h-3 w-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {REASONING_EFFORTS.map((level) => (
                    <DropdownMenuItem
                      key={level}
                      onClick={() => updateProviderConfig(selectedProvider, { reasoningEffort: level })}
                      className={level === config.reasoningEffort ? 'bg-accent' : ''}
                    >
                      <span className="text-xs">{REASONING_EFFORT_LABELS[level]}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <div className="flex-1" />

            {/* Mic button */}
            <button
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100"
              title="Voice input"
            >
              <Mic className="h-4 w-4" />
            </button>

            {/* Send / Stop */}
            {isStreaming ? (
              <>
                {canQueueDraft && (
                  <button
                    onClick={onSend}
                    className="flex items-center gap-1.5 rounded-full border border-border/80 bg-background/80 px-3 py-1.5 text-xs font-medium text-foreground transition-colors duration-100 hover:bg-muted"
                    title="Queue this message"
                  >
                    <CornerDownLeft className="h-3.5 w-3.5" />
                    Queue
                  </button>
                )}
                <button
                  onClick={onStop}
                  className="p-2 rounded-full bg-foreground text-background hover:opacity-80 transition-opacity duration-100"
                  title="Stop generating"
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <button
                onClick={onSend}
                disabled={!safeValue.trim() || disabled}
                className={cn(
                  "p-2 rounded-full transition-opacity duration-100",
                  safeValue.trim()
                    ? "bg-foreground text-background hover:opacity-80"
                    : "bg-muted text-muted-foreground"
                )}
                title="Send message"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
