import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { Copy, Check, RotateCcw, Pencil, ChevronDown, Loader2, Wrench, FileCode, FilePlus, FileX, FileSearch, GitPullRequestDraft, CheckCircle2, ArrowRight } from 'lucide-react';
import { GhostIcon } from './GhostIcon';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePanelId } from '@/contexts/PanelContext';
import { usePreviewStore } from '@/stores/preview-store';
import type { Message } from '@/lib/db';
import { computeDiffLines, countContentLines, getChangeLineDelta } from '@/lib/change-diff';
import { cn } from '@/lib/utils';
import '@shoelace-style/shoelace/dist/components/details/details.js';

/**
 * React wrapper for <sl-details> that handles custom event binding.
 */
function SlDetails({
  open,
  onToggle,
  className,
  summary,
  children,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  className?: string;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onShow = () => onToggle(true);
    const onHide = () => onToggle(false);
    el.addEventListener('sl-after-show', onShow);
    el.addEventListener('sl-after-hide', onHide);
    return () => {
      el.removeEventListener('sl-after-show', onShow);
      el.removeEventListener('sl-after-hide', onHide);
    };
  }, [onToggle]);

  // Sync the open attribute
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      el.setAttribute('open', '');
    } else {
      el.removeAttribute('open');
    }
  }, [open]);

  return (
    <sl-details ref={ref} class={className}>
      <div slot="summary">{summary}</div>
      {children}
    </sl-details>
  );
}

interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  state: 'partial-call' | 'call' | 'result';
  result?: unknown;
}

interface MessagePart {
  type: 'text' | 'reasoning' | 'tool-invocation' | 'step-start' | 'source' | 'file';
  text?: string;
  reasoning?: string;
  toolInvocation?: ToolInvocation;
}

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  streamingContent?: string;
  parts?: MessagePart[];
  reasoning?: string;
  isReasoningStreaming?: boolean;
  toolInvocations?: ToolInvocation[];
  onRegenerate?: () => void;
  onEdit?: (content: string) => void;
}

/**
 * Parse out <think>...</think> blocks from content.
 * Returns the cleaned content and extracted thinking text.
 * Handles partial/unclosed tags during streaming.
 */
function parseThinkingBlocks(content: string, isStreaming: boolean): { cleanContent: string; thinking: string } {
  if (!content) return { cleanContent: '', thinking: '' };

  let thinking = '';
  let cleanContent = content;

  // Extract completed <think>...</think> blocks
  const completedPattern = /<think>([\s\S]*?)<\/think>/g;
  let match;
  while ((match = completedPattern.exec(cleanContent)) !== null) {
    thinking += (thinking ? '\n' : '') + match[1].trim();
  }
  cleanContent = cleanContent.replace(completedPattern, '');

  // Handle unclosed <think> tag during streaming (thinking still in progress)
  if (isStreaming) {
    const unclosedMatch = cleanContent.match(/<think>([\s\S]*)$/);
    if (unclosedMatch) {
      thinking += (thinking ? '\n' : '') + unclosedMatch[1].trim();
      cleanContent = cleanContent.replace(/<think>[\s\S]*$/, '');
    }
  }

  return { cleanContent: cleanContent.trim(), thinking };
}

const TOOL_LABELS: Record<string, { label: string; icon: React.ElementType }> = {
  propose_changes: { label: 'Proposing changes', icon: GitPullRequestDraft },
  read_repo_file: { label: 'Reading file', icon: FileSearch },
  edit_repo_file: { label: 'Editing file', icon: FileCode },
  create_repo_file: { label: 'Creating file', icon: FilePlus },
  delete_repo_file: { label: 'Deleting file', icon: FileX },
  batch_edit_repo_files: { label: 'Editing files', icon: FileCode },
  create_html_file: { label: 'Created HTML file', icon: FilePlus },
  create_css_file: { label: 'Created CSS file', icon: FilePlus },
  create_js_file: { label: 'Created JS file', icon: FilePlus },
  create_react_component: { label: 'Created React component', icon: FilePlus },
  create_markdown_file: { label: 'Created Markdown file', icon: FilePlus },
};

const FILE_CREATION_TOOLS = new Set([
  'create_html_file', 'create_css_file', 'create_js_file', 'create_react_component', 'create_markdown_file',
]);

const ACTION_BADGE: Record<string, { label: string; className: string; icon: React.ElementType }> = {
  create: { label: 'Created', className: 'bg-green-500/15 text-green-400 border-green-500/30', icon: FilePlus },
  edit:   { label: 'Modified', className: 'bg-blue-500/15 text-blue-400 border-blue-500/30', icon: FileCode },
  delete: { label: 'Deleted', className: 'bg-red-500/15 text-red-400 border-red-500/30', icon: FileX },
};

function StagedFileSummary({ paths }: { paths: string[] }) {
  const panelId = usePanelId();
  const changes = useChangesetStore((s) => s.getChangeset(panelId).changes);
  const relevantChanges = paths
    .map((p) => changes[p])
    .filter(Boolean);

  if (relevantChanges.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      {relevantChanges.map((change) => {
        const badge = ACTION_BADGE[change.action] || ACTION_BADGE.edit;
        const BadgeIcon = badge.icon;
        return (
          <div key={change.path} className="flex items-center gap-2 text-xs">
            <BadgeIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="font-mono text-foreground/70 truncate">{change.path}</span>
            <span className={cn('ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium border', badge.className)}>
              {badge.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function LineDiffBadge({ filePath, toolName }: { filePath?: string; toolName: string }) {
  const panelId = usePanelId();
  const change = useChangesetStore((s) => filePath ? s.getChangeset(panelId).changes[filePath] : undefined);

  if (!change) {
    return (
      <span className="ml-1 flex items-center gap-1 text-[10px] font-medium text-green-400">
        <ArrowRight className="h-2.5 w-2.5" />
        staged
      </span>
    );
  }

  const newLines = (change.content || '').split('\n').length;
  const oldLines = countContentLines(change.originalContent);

  if (change.action === 'create') {
    return (
      <span className="ml-1 flex items-center gap-1.5 text-[10px] font-medium">
        <ArrowRight className="h-2.5 w-2.5 text-green-400" />
        <span className="text-green-400">staged</span>
        <span className="text-green-400">+{newLines}</span>
      </span>
    );
  }

  if (change.action === 'delete') {
    return (
      <span className="ml-1 flex items-center gap-1.5 text-[10px] font-medium">
        <ArrowRight className="h-2.5 w-2.5 text-green-400" />
        <span className="text-green-400">staged</span>
        <span className="text-red-400">-{oldLines}</span>
      </span>
    );
  }

  const { added, removed } = getChangeLineDelta(change);

  return (
    <span className="ml-1 flex items-center gap-1.5 text-[10px] font-medium">
      <ArrowRight className="h-2.5 w-2.5 text-green-400" />
      <span className="text-green-400">staged</span>
      {added > 0 && <span className="text-green-400">+{added}</span>}
      {removed > 0 && <span className="text-red-400">-{removed}</span>}
      {added === 0 && removed === 0 && <span className="text-muted-foreground">~{newLines}L</span>}
    </span>
  );
}

/** Collapsible code preview of edited lines for a file change. */
function FileEditPreview({ filePath }: { filePath: string }) {
  const panelId = usePanelId();
  const change = useChangesetStore((s) => s.getChangeset(panelId).changes[filePath]);
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const COLLAPSED_HEIGHT = 140; // px

  const diffLines = React.useMemo(() => {
    if (!change) return [];
    if (change.action === 'create') {
      // For new files, show first lines as all added
      return (change.content || '').split('\n').slice(0, 30).map((line, i) => ({
        type: 'added' as const,
        lineNum: i + 1,
        content: line,
      }));
    }
    if (change.action === 'delete') {
      return (change.originalContent || '').split('\n').slice(0, 30).map((line, i) => ({
        type: 'removed' as const,
        lineNum: i + 1,
        content: line,
      }));
    }
    // edit
    if (!change.originalContent) return [];
    return computeDiffLines(change.originalContent, change.content);
  }, [change]);

  useLayoutEffect(() => {
    if (contentRef.current) {
      setIsOverflowing(contentRef.current.scrollHeight > COLLAPSED_HEIGHT);
    }
  }, [diffLines]);

  if (!change || diffLines.length === 0) return null;

  return (
    <div className="mt-2 rounded-lg border border-border/50 overflow-hidden bg-[hsl(var(--code-bg))]">
      {/* Diff content */}
      <div className="relative">
        <div
          ref={contentRef}
          className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
          style={{ maxHeight: expanded ? `${contentRef.current?.scrollHeight || 2000}px` : `${COLLAPSED_HEIGHT}px` }}
        >
          <pre className="text-[12px] leading-[1.65] font-mono m-0 p-0">
            {diffLines.map((line, i) => {
              const bgClass =
                line.type === 'added' ? 'bg-green-500/10' :
                line.type === 'removed' ? 'bg-red-500/10' :
                '';
              const textClass =
                line.type === 'added' ? 'text-green-400' :
                line.type === 'removed' ? 'text-red-400' :
                'text-muted-foreground/70';
              const prefix =
                line.type === 'added' ? '+' :
                line.type === 'removed' ? '-' :
                ' ';
              const isSeparator = line.content === '···' && line.lineNum === null;

              if (isSeparator) {
                return (
                  <div key={i} className="px-3 py-0.5 text-muted-foreground/40 select-none">
                    <span className="inline-block w-8" />
                    <span className="text-[11px]">···</span>
                  </div>
                );
              }

              return (
                <div key={i} className={cn('px-3 hover:brightness-125', bgClass)}>
                  <span className="inline-block w-8 text-right pr-3 text-muted-foreground/30 select-none text-[11px]">
                    {line.lineNum}
                  </span>
                  <span className={cn('select-none', textClass)}>{prefix}</span>
                  <span className={textClass}> {line.content}</span>
                </div>
              );
            })}
          </pre>
        </div>

        {/* Fade overlay + show more button when collapsed and overflowing */}
        {isOverflowing && !expanded && (
          <div className="absolute bottom-0 left-0 right-0">
            <div className="h-10 bg-gradient-to-t from-[hsl(var(--code-bg))] to-transparent" />
            <div className="flex justify-end px-3 pb-1.5 bg-[hsl(var(--code-bg))]">
              <button
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors duration-150 font-medium"
              >
                Show more
                <ChevronDown className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}

        {/* Collapse button when expanded */}
        {isOverflowing && expanded && (
          <div className="flex justify-end px-3 py-1.5 border-t border-border/30">
            <button
              onClick={() => setExpanded(false)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors duration-150 font-medium"
            >
              Show less
              <ChevronDown className="h-3 w-3 rotate-180" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolInvocationDisplay({ invocation, isLatest }: { invocation: ToolInvocation; isLatest?: boolean }) {
  const panelId = usePanelId();
  const [expanded, setExpanded] = useState(false);
  const toolInfo = TOOL_LABELS[invocation.toolName] || { label: invocation.toolName, icon: Wrench };
  const Icon = toolInfo.icon;
  const isComplete = invocation.state === 'result';
  const isInProgress = invocation.state === 'call' || invocation.state === 'partial-call';

  // Extract file info from args
  const filePath = invocation.args?.path;
  const artifactFilename = invocation.args?.filename as string | undefined;
  const batchChanges = invocation.args?.changes as Array<{ path: string; action: string }> | undefined;
  const isBatch = invocation.toolName === 'batch_edit_repo_files' && batchChanges && batchChanges.length > 0;
  const isFileCreationTool = FILE_CREATION_TOOLS.has(invocation.toolName);

  // Determine which file paths this tool call affected (for staging display)
  const isFileModifyingTool = ['edit_repo_file', 'create_repo_file', 'delete_repo_file', 'batch_edit_repo_files'].includes(invocation.toolName);
  const affectedPaths: string[] = isBatch
    ? batchChanges!.map((c) => c.path)
    : filePath && isFileModifyingTool
      ? [filePath]
      : [];

  const handlePreviewClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const previewStore = usePreviewStore.getState();
    const preview = previewStore.getPreview(panelId);
    // Focus the file in the preview if it exists
    if (artifactFilename) {
      const file = preview.files.find((f) => f.filename === artifactFilename);
      if (file) previewStore.setActiveFile(panelId, file.id);
    }
    previewStore.setView(panelId, 'preview');
    previewStore.setOpen(panelId, true);
  };

  // For file creation tools, show as a Claude-style artifact card
  if (isFileCreationTool) {
    const fileExt = artifactFilename?.split('.').pop()?.toLowerCase() || invocation.toolName.replace('create_', '').replace('_file', '').replace('_component', '');
    const fileContent = invocation.args?.content as string | undefined;

    return (
      <div
        onClick={isComplete ? handlePreviewClick : undefined}
        className={cn(
          'my-3 rounded-xl border border-border overflow-hidden w-[280px] transition-all duration-150',
          isComplete && 'cursor-pointer hover:border-primary/50 hover:shadow-md hover:shadow-primary/5'
        )}
      >
        {/* Mini preview area */}
        <div className="h-[120px] bg-white relative overflow-hidden">
          {fileContent ? (
            <div
              className="absolute inset-0 p-3 text-[6px] leading-[8px] text-gray-800 font-mono overflow-hidden pointer-events-none select-none"
              style={{ transform: 'scale(1)', transformOrigin: 'top left' }}
            >
              <pre className="whitespace-pre-wrap">{fileContent.slice(0, 800)}</pre>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <Icon className="h-8 w-8 text-gray-300" />
            </div>
          )}
          {/* Fade overlay at bottom */}
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-white to-transparent" />
          {isInProgress && (
            <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
        {/* Footer with file info */}
        <div className="flex items-center gap-2 px-3 py-2.5 bg-muted/40 border-t border-border">
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">
              {artifactFilename || 'Untitled'}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {isComplete ? 'Click to open preview' : 'Creating...'}
            </div>
          </div>
          <span className={cn(
            'shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide',
            fileExt === 'html' ? 'bg-orange-500/15 text-orange-400' :
            fileExt === 'css' ? 'bg-blue-500/15 text-blue-400' :
            fileExt === 'js' ? 'bg-yellow-500/15 text-yellow-400' :
            fileExt === 'jsx' || fileExt === 'tsx' ? 'bg-purple-500/15 text-purple-400' :
            'bg-muted text-muted-foreground'
          )}>
            {fileExt}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="my-1.5">
      {/* Tool header row */}
      <div className="flex items-center gap-2 text-[13px] py-0.5">
        {isInProgress ? (
          <GhostIcon />
        ) : isComplete ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
        ) : (
          <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <span className={cn("text-muted-foreground", (isInProgress || isLatest) && "glimmer-text")}>
          {toolInfo.label}
        </span>
        {filePath && (
          <code className={cn("text-[12px] text-foreground/80 bg-muted/50 px-1.5 py-0.5 rounded font-mono truncate max-w-[350px]", (isInProgress || isLatest) && "glimmer-text")} title={filePath}>
            {filePath}
          </code>
        )}
        {isBatch && (
          <span className="text-foreground/70 text-[12px]">({batchChanges.length} files)</span>
        )}
        {isComplete && isFileModifyingTool && (
          <LineDiffBadge filePath={filePath} toolName={invocation.toolName} />
        )}
      </div>

      {/* Code diff preview — shown by default for completed file-modifying tools */}
      {isComplete && isFileModifyingTool && !isBatch && filePath && (
        <FileEditPreview filePath={filePath} />
      )}

      {/* Batch file list */}
      {isBatch && (
        <div className="mt-1 space-y-0.5 pl-6">
          {(isComplete ? affectedPaths : batchChanges!.map((c) => c.path)).map((p, idx) => (
            <div key={idx}>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileCode className="h-3 w-3 shrink-0" />
                <code className="font-mono text-foreground/70 text-[11px] bg-muted/40 px-1 py-0.5 rounded truncate">{p}</code>
                {!isComplete && batchChanges?.[idx]?.action && (
                  <span className="text-muted-foreground/50 text-[10px]">{batchChanges[idx].action}</span>
                )}
              </div>
              {isComplete && <FileEditPreview filePath={p} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isStreaming,
  streamingContent,
  parts,
  reasoning,
  isReasoningStreaming,
  toolInvocations,
  onRegenerate,
  onEdit,
}) => {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const prevReasoningStreamingRef = useRef(false);
  const isUser = message.role === 'user';

  const rawContent = isStreaming ? (streamingContent || '') : message.content;

  // Parse out inline <think> blocks from content (some models embed these directly)
  const parsed = !isUser ? parseThinkingBlocks(rawContent, !!isStreaming) : null;
  const displayContent = parsed ? parsed.cleanContent : rawContent;

  // Also extract <think> blocks from text parts (models may embed them in streamed text parts)
  const partsThinking = React.useMemo(() => {
    if (isUser || !Array.isArray(parts)) return '';
    return parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => parseThinkingBlocks(p.text!, !!isStreaming).thinking)
      .filter(Boolean)
      .join('\n');
  }, [isUser, parts, isStreaming]);

  // Merge inline thinking with reasoning from AI SDK parts
  const effectiveReasoning = [reasoning, parsed?.thinking, partsThinking].filter(Boolean).join('\n') || undefined;
  const effectiveReasoningStreaming = isReasoningStreaming || (!!isStreaming && !!(parsed?.thinking || partsThinking) && !parsed?.cleanContent);
  const orderedParts = React.useMemo(() => {
    if (isUser) return [];

    const normalizedParts = Array.isArray(parts) ? [...parts] : [];
    const hasTextPart = normalizedParts.some((part) => part.type === 'text' && part.text?.trim());
    const hasReasoningPart = normalizedParts.some((part) => part.type === 'reasoning' && part.reasoning?.trim());

    if (!hasReasoningPart && effectiveReasoning) {
      normalizedParts.unshift({ type: 'reasoning', reasoning: effectiveReasoning });
    }

    if (!hasTextPart && displayContent) {
      normalizedParts.push({ type: 'text', text: displayContent });
    }

    if (normalizedParts.length === 0 && toolInvocations?.length) {
      normalizedParts.push(
        ...toolInvocations.map((toolInvocation) => ({
          type: 'tool-invocation' as const,
          toolInvocation,
        }))
      );
    }

    return normalizedParts;
  }, [displayContent, effectiveReasoning, isUser, parts, toolInvocations]);

  // Auto-open thinking when reasoning starts streaming, auto-close when done
  useEffect(() => {
    if (effectiveReasoningStreaming && !prevReasoningStreamingRef.current) {
      setThinkingOpen(true);
    } else if (!effectiveReasoningStreaming && prevReasoningStreamingRef.current) {
      setThinkingOpen(false);
    }
    prevReasoningStreamingRef.current = !!effectiveReasoningStreaming;
  }, [effectiveReasoningStreaming]);

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
    <div className={cn('group mb-6', isUser ? '' : '')}>
      <div className={cn('relative', isUser ? 'w-full' : 'w-full')}>
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
              <p className="text-sm whitespace-pre-wrap font-medium">{displayContent}</p>
            ) : (
              (() => {
                const lastToolIndex = orderedParts.reduce((last, p, i) =>
                  p.type === 'tool-invocation' ? i : last, -1);
                return orderedParts.map((part, index) => {
                if (part.type === 'step-start') {
                  return null;
                }

                if (part.type === 'reasoning' && part.reasoning) {
                  return (
                    <div key={`reasoning-${index}`} className="mb-3">
                      <SlDetails
                        open={thinkingOpen}
                        onToggle={setThinkingOpen}
                        className="thinking-details"
                        summary={
                          <div className="flex items-center gap-1.5 text-xs">
                            {effectiveReasoningStreaming && (
                              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                            )}
                            <span className="font-medium font-mono text-muted-foreground">
                              {effectiveReasoningStreaming ? 'Thinking...' : 'Thinking'}
                            </span>
                          </div>
                        }
                      >
                        <div
                          className="pl-3 border-l-2 border-muted-foreground/20 text-sm text-muted-foreground leading-relaxed"
                          style={{ fontSize: '0.8rem' }}
                        >
                          <MarkdownRenderer content={part.reasoning} />
                        </div>
                      </SlDetails>
                    </div>
                  );
                }

                if (part.type === 'tool-invocation' && part.toolInvocation) {
                  return (
                    <ToolInvocationDisplay
                      key={part.toolInvocation.toolCallId || `tool-${index}`}
                      invocation={part.toolInvocation}
                      isLatest={isStreaming && index === lastToolIndex}
                    />
                  );
                }

                if (part.type === 'text' && part.text?.trim()) {
                  // Strip any inline <think> blocks that the model embedded in text content
                  const cleanedText = parseThinkingBlocks(part.text, !!isStreaming).cleanContent;
                  if (!cleanedText) return null;
                  return (
                    <div key={`text-${index}`} className={index > 0 ? 'mt-3' : undefined}>
                      <MarkdownRenderer content={cleanedText} />
                    </div>
                  );
                }

                return null;
              });
              })()
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
