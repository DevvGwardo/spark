import React, { useState } from 'react';
import { ChevronRight, Users, Copy, Check, ArrowRight } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { cn } from '@/lib/utils';

export interface BuddyResponse {
  /** Unique identifier for this response */
  id: string;
  /** The buddy model name (e.g., "claude-sonnet-4", "gpt-4o") */
  modelName: string;
  /** The content of the buddy's response */
  content: string;
  /** When the response was received */
  timestamp?: string;
  /** Token count if available */
  tokenCount?: number;
  /** Whether this response is currently streaming */
  isStreaming?: boolean;
}

interface BuddyComparisonPanelProps {
  /** The primary (Hermes) response */
  primaryResponse?: {
    content: string;
    modelName?: string;
    timestamp?: string;
  };
  /** The buddy/secondary model response */
  buddyResponse?: BuddyResponse | null;
  /** Whether to auto-expand when buddy response arrives */
  autoExpandOnArrival?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Callback when user wants to use the buddy response */
  onUseBuddyResponse?: (content: string) => void;
  /** Callback when user wants to copy the buddy response */
  onCopyBuddyResponse?: (content: string) => void;
}

/**
 * A collapsible panel that shows a comparison between Hermes's response
 * and a secondary "buddy" model's response.
 * 
 * Designed to appear after Hermes completes generating, showing what
 * an alternative model would have responded with.
 */
export function BuddyComparisonPanel({
  primaryResponse,
  buddyResponse,
  autoExpandOnArrival = false,
  className,
  onUseBuddyResponse,
  onCopyBuddyResponse,
}: BuddyComparisonPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Auto-expand when buddy response arrives if enabled
  const hasBuddyResponse = !!buddyResponse?.content;

  React.useEffect(() => {
    if (autoExpandOnArrival && hasBuddyResponse) {
      setExpanded(true);
    }
  }, [autoExpandOnArrival, hasBuddyResponse]);

  const handleCopy = async () => {
    if (!buddyResponse?.content) return;
    try {
      await navigator.clipboard.writeText(buddyResponse.content);
      setCopied(true);
      onCopyBuddyResponse?.(buddyResponse.content);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleUseResponse = () => {
    if (!buddyResponse?.content) return;
    onUseBuddyResponse?.(buddyResponse.content);
  };

  // Don't render anything if there's no buddy response
  if (!hasBuddyResponse) {
    return null;
  }

  const palette = {
    border: 'border-emerald-500/20',
    bg: 'bg-emerald-500/5',
    hoverBg: 'hover:bg-emerald-500/10',
    icon: 'text-emerald-500/70',
    label: 'text-emerald-500 dark:text-emerald-400',
    pill: 'bg-emerald-500/15 text-emerald-500 dark:text-emerald-400',
  };

  return (
    <div className={cn('rounded-lg border border-border/40 bg-background/40', className)}>
      {/* Header - always visible, clickable to expand/collapse */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-3 text-left transition-colors',
          palette.hoverBg,
        )}
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 flex-shrink-0 transition-transform duration-150',
            palette.icon,
            expanded && 'rotate-90',
          )}
        />
        <Users className={cn('h-4 w-4 flex-shrink-0', palette.icon)} />
        <span className={cn('text-xs font-semibold uppercase tracking-[0.14em] flex-shrink-0', palette.label)}>
          Buddy Comparison
        </span>
        <span className={cn('rounded px-2 py-0.5 text-[10px] font-medium flex-shrink-0', palette.pill)}>
          {buddyResponse.modelName}
        </span>
        {buddyResponse.isStreaming && (
          <span className="flex h-2 w-2 flex-shrink-0">
            <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        )}
        {!expanded && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
            {buddyResponse.content.slice(0, 100)}{buddyResponse.content.length > 100 ? '…' : ''}
          </span>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/30">
          {/* Primary response summary (Hermes) */}
          {primaryResponse && (
            <div className="border-b border-border/20 bg-muted/20 px-4 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Hermes Response
                </span>
                {primaryResponse.modelName && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                    {primaryResponse.modelName}
                  </span>
                )}
              </div>
              <p className="text-[12px] leading-relaxed text-muted-foreground line-clamp-2">
                {primaryResponse.content.slice(0, 200)}{primaryResponse.content.length > 200 ? '…' : ''}
              </p>
            </div>
          )}

          {/* Buddy response content */}
          <div className="relative px-4 py-3">
            {/* Action buttons */}
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-500">
                  Buddy Response
                </span>
                {buddyResponse.tokenCount && (
                  <span className="text-[9px] text-muted-foreground/60">
                    ~{buddyResponse.tokenCount.toLocaleString()} tokens
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground"
                  title="Copy buddy response"
                >
                  {copied ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      Copy
                    </>
                  )}
                </button>
                {onUseBuddyResponse && (
                  <button
                    type="button"
                    onClick={handleUseResponse}
                    className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-500 transition-colors hover:bg-emerald-500/20"
                    title="Use this response"
                  >
                    <ArrowRight className="h-3 w-3" />
                    Use
                  </button>
                )}
              </div>
            </div>

          {/* Buddy content rendered as markdown */}
          <div className="prose-sm prose-invert max-w-none [&_*]:text-[13px]">
            <MarkdownRenderer content={buddyResponse.content} />
          </div>

            {/* Timestamp */}
            {buddyResponse.timestamp && (
              <div className="mt-3 text-[10px] text-muted-foreground/50">
                Received {new Date(buddyResponse.timestamp).toLocaleTimeString()}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A compact inline version of the buddy comparison for use within message bubbles.
 */
export function BuddyResponseBadge({
  modelName,
  onClick,
  className,
}: {
  modelName: string;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20',
        onClick && 'cursor-pointer',
        className,
      )}
    >
      <Users className="h-3 w-3" />
      <span>{modelName}</span>
    </button>
  );
}

export default BuddyComparisonPanel;
