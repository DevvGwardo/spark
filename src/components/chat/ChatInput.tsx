import React, { useRef, useEffect } from 'react';
import { ArrowUp, Square, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ContextUsageBar } from './ContextUsageBar';
import { useChangesetStore } from '@/stores/changeset-store';

interface ChatInputProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  messages?: { role: string; content: string }[];
}

export const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  disabled,
  messages = [],
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { activeRepo, isRepoMode } = useChangesetStore();

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
      if (!isStreaming && safeValue.trim()) onSend();
    }
  };

  return (
    <div className="w-full max-w-[720px] mx-auto px-4 pb-4 pt-2">
      {isRepoMode && activeRepo && (
        <div className="flex items-center gap-1.5 mb-2 px-1 text-xs text-primary">
          <GitBranch className="h-3 w-3" />
          <span className="font-medium">{activeRepo.fullName}</span>
          <span className="text-muted-foreground">— editing mode</span>
        </div>
      )}
      {messages.length > 0 && (
        <div className="mb-2">
          <ContextUsageBar messages={messages} />
        </div>
      )}
      <div className="relative flex items-end gap-2 border border-border rounded-2xl px-4 py-3">
        <textarea
          ref={textareaRef}
          value={safeValue}
          onChange={(e) => {
            if (typeof onChange === 'function') onChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Message..."
          rows={1}
          disabled={disabled}
          className={cn(
            "flex-1 resize-none bg-transparent text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none min-h-[20px] max-h-[200px]",
            disabled && "opacity-50"
          )}
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            className="flex-shrink-0 p-2 rounded-md bg-foreground text-background hover:opacity-80 transition-opacity duration-100"
            title="Stop generating"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!safeValue.trim() || disabled}
            className={cn(
              "flex-shrink-0 p-2 rounded-md transition-opacity duration-100",
              safeValue.trim()
                ? "bg-foreground text-background hover:opacity-80"
                : "bg-muted text-muted-foreground"
            )}
            title="Send message"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="text-center text-xs text-muted-foreground mt-3">
        CloudChat can make mistakes. Verify important information.
      </p>
    </div>
  );
};
