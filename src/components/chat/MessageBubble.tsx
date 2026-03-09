import React, { useState } from 'react';
import { Copy, Check, RotateCcw, Pencil } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { Message } from '@/lib/db';
import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  streamingContent?: string;
  onRegenerate?: () => void;
  onEdit?: (content: string) => void;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isStreaming,
  streamingContent,
  onRegenerate,
  onEdit,
}) => {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const isUser = message.role === 'user';
  const displayContent = isStreaming ? (streamingContent || '') : message.content;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleEditSubmit = () => {
    onEdit?.(editContent);
    setEditing(false);
  };

  if (message.role === 'system') return null;

  return (
    <div className={cn('group mb-6', isUser ? 'flex justify-end' : '')}>
      {/* No bubble backgrounds — separation by alignment and spacing */}
      <div className={cn('relative', isUser ? 'max-w-[85%] md:max-w-[75%]' : 'w-full')}>
        {/* Role label */}
        <div className="mb-1">
          <span className="text-xs font-medium text-muted-foreground">
            {isUser ? 'You' : 'Assistant'}
          </span>
        </div>

        {editing ? (
          <div className="space-y-2">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full min-h-[80px] p-3 rounded-md bg-background border border-input text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring font-sans"
            />
            <div className="flex gap-3 justify-end">
              <button onClick={() => setEditing(false)} className="text-xs text-muted-foreground hover:text-foreground transition-colors duration-100">
                Cancel
              </button>
              <button onClick={handleEditSubmit} className="text-xs text-foreground font-medium hover:text-muted-foreground transition-colors duration-100">
                Save & Submit
              </button>
            </div>
          </div>
        ) : (
          <>
            {isUser ? (
              <p className="text-base whitespace-pre-wrap">{displayContent}</p>
            ) : isStreaming ? (
              <p className="text-base whitespace-pre-wrap streaming-cursor">{displayContent}</p>
            ) : (
              <MarkdownRenderer content={displayContent} />
            )}
          </>
        )}

        {/* Action bar */}
        {!editing && !isStreaming && displayContent && (
          <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors duration-100"
              title="Copy"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            {isUser && onEdit && (
              <button
                onClick={() => setEditing(true)}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors duration-100"
                title="Edit"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {!isUser && onRegenerate && (
              <button
                onClick={onRegenerate}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors duration-100"
                title="Regenerate"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        {message.error && (
          <p className="text-xs text-destructive mt-2">{message.error}</p>
        )}
      </div>
    </div>
  );
};
