import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { Copy, Check, RotateCcw, Pencil, ChevronDown, Loader2, Wrench, FileCode, FileCode2, FilePlus, FileX, FileSearch, GitPullRequestDraft, CheckCircle2, ArrowRight } from 'lucide-react';
import { GhostIcon } from './GhostIcon';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useChangesetStore } from '@/stores/changeset-store';
import { useChatScopeId } from '@/contexts/PanelContext';
import { usePreviewStore } from '@/stores/preview-store';
import type { Message } from '@/lib/db';
import { computeDiffLines, getChangeLineDelta, summarizeChangeLines } from '@/lib/change-diff';
import { cn } from '@/lib/utils';
import { AgentActivity, type ToolActivityEvent } from './AgentActivity';
import { extractPseudoToolInvocations, extractTextFileEdits, getPseudoToolSourceText, stripPseudoToolInvocations } from '@/lib/pseudo-tool-calls';
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
    <sl-details ref={ref} className={className}>
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

function getToolErrorMessage(result: unknown): string | null {
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (/^(error|failed)[:\s]/i.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  if (result && typeof result === 'object') {
    const error = (result as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }
  }

  return null;
}

function getToolOutputMessage(result: unknown): string | null {
  if (typeof result === 'string') {
    return result;
  }

  if (result && typeof result === 'object') {
    const output = (result as { output?: unknown }).output;
    if (typeof output === 'string' && output.trim()) {
      return output;
    }
  }

  return null;
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
  toolActivity?: ToolActivityEvent[];
  allowPseudoRepoWrites?: boolean;
  onRegenerate?: () => void;
  onEdit?: (content: string) => void;
}

function parseToolActivityArgs(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { input: trimmed };
  } catch {
    return { input: trimmed };
  }
}

function stripHermesActivityText(content: string): string {
  if (!content) {
    return '';
  }

  const filteredLines = content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('>')) {
        return true;
      }

      const normalized = trimmed
        .replace(/^>\s*/, '')
        .replace(/[*_`]/g, '')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, '\'')
        .trim();

      if (!normalized) {
        return false;
      }

      return !(
        /^"?proposing changes"?$/i.test(normalized) ||
        /^"?reading file"?(?:\s+—\s+.+)?$/i.test(normalized) ||
        /^"?editing file"?(?:\s+—\s+.+)?$/i.test(normalized) ||
        /^"?editing files"?(?:\s+—\s+.+)?$/i.test(normalized) ||
        /^"?creating file"?(?:\s+—\s+.+)?$/i.test(normalized) ||
        /^"?deleting file"?(?:\s+—\s+.+)?$/i.test(normalized) ||
        /^"?thinking\.\.\."?$/i.test(normalized) ||
        /^"?done\s+[—-]\s+read\s+\d+\s+chars"?$/i.test(normalized) ||
        /^"?done\s*[—-]:?\s*.+$/i.test(normalized) ||
        /^"?failed:?\s*.+$/i.test(normalized) ||
        /^"?found\s+\d+\s+results?"?$/i.test(normalized) ||
        /^"?fetched\s+\d+\s+chars"?$/i.test(normalized)
      );
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return filteredLines.trim();
}

/**
 * Detect Hermes tool-start activity lines (e.g. "> **Reading file** — `path`").
 * These mark where a tool call begins in the content stream.
 */
function isHermesToolStartLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('>')) return false;
  const normalized = trimmed
    .replace(/^>\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .trim();
  if (!normalized) return false;
  return /^"?(?:reading file|editing files?|creating file|deleting file|proposing changes|searching the web|reading webpage|running command|writing file|running python|listing repositories)/i.test(normalized);
}

/**
 * Detect Hermes activity end/status lines (e.g. "> *Done — read 1,234 chars*").
 */
function isHermesEndOrStatusLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('>')) return false;
  const normalized = trimmed
    .replace(/^>\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .trim();
  if (!normalized) return true;
  return (
    /^"?thinking\.\.\."?$/i.test(normalized) ||
    /^"?done\s+[—-]\s+read\s+\d+\s+chars"?$/i.test(normalized) ||
    /^"?done\s*[—-]:?\s*.+$/i.test(normalized) ||
    /^"?failed:?\s*.+$/i.test(normalized) ||
    /^"?found\s+\d+\s+results?"?$/i.test(normalized) ||
    /^"?fetched\s+\d+\s+chars"?$/i.test(normalized) ||
    /^"?search complete"?$/i.test(normalized)
  );
}

/**
 * Split raw content into interleaved text and tool-invocation parts based on
 * Hermes activity markers. Returns null if no markers are found (not a Hermes response).
 */
function buildInterleavedHermesParts(
  rawContent: string,
  toolInvocations: ToolInvocation[],
): MessagePart[] | null {
  if (!rawContent || toolInvocations.length === 0) return null;

  const lines = rawContent.split('\n');
  let hasAnyToolStart = false;
  for (const line of lines) {
    if (isHermesToolStartLine(line)) {
      hasAnyToolStart = true;
      break;
    }
  }
  if (!hasAnyToolStart) return null;

  const result: MessagePart[] = [];
  let textBuffer: string[] = [];
  let toolIdx = 0;

  for (const line of lines) {
    if (isHermesToolStartLine(line)) {
      const text = textBuffer.join('\n').trim();
      if (text) {
        result.push({ type: 'text', text });
      }
      textBuffer = [];
      if (toolIdx < toolInvocations.length) {
        result.push({ type: 'tool-invocation', toolInvocation: toolInvocations[toolIdx] });
        toolIdx++;
      }
    } else if (isHermesEndOrStatusLine(line)) {
      // Skip completion/status lines — they pair with tool starts
    } else {
      textBuffer.push(line);
    }
  }

  const remainingText = textBuffer.join('\n').trim();
  if (remainingText) {
    result.push({ type: 'text', text: remainingText });
  }
  while (toolIdx < toolInvocations.length) {
    result.push({ type: 'tool-invocation', toolInvocation: toolInvocations[toolIdx] });
    toolIdx++;
  }

  return result;
}

function sanitizeAssistantTextContent(content: string, isStreaming: boolean): string {
  if (!content) {
    return '';
  }

  return stripPseudoToolInvocations(stripHermesActivityText(content), isStreaming);
}

const TOOL_STATE_PRIORITY: Record<ToolInvocation['state'], number> = {
  'partial-call': 0,
  call: 1,
  result: 2,
};

function getToolInvocationKey(invocation: ToolInvocation, fallbackIndex: number): string {
  if (invocation.toolCallId) {
    return invocation.toolCallId;
  }

  const path = typeof invocation.args?.path === 'string' ? invocation.args.path : '';
  const filename = typeof invocation.args?.filename === 'string' ? invocation.args.filename : '';
  const batchPaths = Array.isArray(invocation.args?.changes)
    ? invocation.args.changes
        .map((change) =>
          change && typeof change === 'object'
            ? `${typeof change.action === 'string' ? change.action : ''}:${typeof change.path === 'string' ? change.path : ''}`
            : '',
        )
        .join('|')
    : '';

  return `${invocation.toolName}:${path}:${filename}:${batchPaths || fallbackIndex}`;
}

function mergeToolInvocations(current: ToolInvocation, incoming: ToolInvocation): ToolInvocation {
  const currentPriority = TOOL_STATE_PRIORITY[current.state] ?? 0;
  const incomingPriority = TOOL_STATE_PRIORITY[incoming.state] ?? 0;
  const preferred = incomingPriority >= currentPriority ? incoming : current;
  const fallback = preferred === incoming ? current : incoming;

  return {
    ...fallback,
    ...preferred,
    args: preferred.args ?? fallback.args,
    result: preferred.result ?? fallback.result,
  };
}

function dedupeAssistantParts(parts: MessagePart[]): MessagePart[] {
  const deduped: MessagePart[] = [];
  const toolIndexByKey = new Map<string, number>();

  for (const part of parts) {
    if (part.type !== 'tool-invocation' || !part.toolInvocation) {
      deduped.push(part);
      continue;
    }

    const key = getToolInvocationKey(part.toolInvocation, deduped.length);
    const existingIndex = toolIndexByKey.get(key);

    if (existingIndex === undefined) {
      toolIndexByKey.set(key, deduped.length);
      deduped.push(part);
      continue;
    }

    const existingPart = deduped[existingIndex];
    if (existingPart?.toolInvocation) {
      deduped[existingIndex] = {
        ...existingPart,
        toolInvocation: mergeToolInvocations(existingPart.toolInvocation, part.toolInvocation),
      };
    }
  }

  return deduped;
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
  web_search: { label: 'Searching web', icon: FileSearch },
  search: { label: 'Searching', icon: FileSearch },
  browse_url: { label: 'Reading webpage', icon: FileSearch },
  browser: { label: 'Browsing', icon: FileSearch },
  run_command: { label: 'Running command', icon: Wrench },
  terminal: { label: 'Running command', icon: Wrench },
  execute_python: { label: 'Running Python', icon: Wrench },
  read_file: { label: 'Reading file', icon: FileSearch },
  write_file: { label: 'Writing file', icon: FilePlus },
  create_html_file: { label: 'Created HTML file', icon: FilePlus },
  create_css_file: { label: 'Created CSS file', icon: FilePlus },
  create_js_file: { label: 'Created JS file', icon: FilePlus },
  create_react_component: { label: 'Created React component', icon: FilePlus },
  create_markdown_file: { label: 'Created Markdown file', icon: FilePlus },
};

const FILE_CREATION_TOOLS = new Set([
  'create_html_file', 'create_css_file', 'create_js_file', 'create_react_component', 'create_markdown_file',
]);
const REPO_TOOL_NAMES = new Set([
  'propose_changes',
  'read_repo_file',
  'edit_repo_file',
  'create_repo_file',
  'delete_repo_file',
  'batch_edit_repo_files',
]);
const REPO_WRITE_TOOL_NAMES = new Set([
  'edit_repo_file',
  'create_repo_file',
  'delete_repo_file',
  'batch_edit_repo_files',
]);

const ACTION_BADGE: Record<string, { label: string; className: string; icon: React.ElementType }> = {
  create: { label: 'Created', className: 'bg-green-500/15 text-green-400 border-green-500/30', icon: FilePlus },
  edit:   { label: 'Modified', className: 'bg-orange-500/15 text-orange-400 border-orange-500/30', icon: FileCode },
  delete: { label: 'Deleted', className: 'bg-red-500/15 text-red-400 border-red-500/30', icon: FileX },
};

function getFileAction(toolName: string, fallback?: string): 'create' | 'edit' | 'delete' | null {
  if (fallback === 'create' || fallback === 'edit' || fallback === 'delete') {
    return fallback;
  }

  if (toolName === 'create_repo_file') return 'create';
  if (toolName === 'delete_repo_file') return 'delete';
  if (toolName === 'edit_repo_file' || toolName === 'batch_edit_repo_files') return 'edit';
  return null;
}

function getToolTarget(invocation: ToolInvocation): string | null {
  const path = typeof invocation.args?.path === 'string' ? invocation.args.path : null;
  if (path) {
    return path;
  }

  if (typeof invocation.args?.filename === 'string') {
    return invocation.args.filename;
  }

  if (typeof invocation.args?.query === 'string') {
    return invocation.args.query;
  }

  if (typeof invocation.args?.url === 'string') {
    return invocation.args.url;
  }

  if (typeof invocation.args?.command === 'string') {
    return invocation.args.command;
  }

  if (typeof invocation.args?.input === 'string') {
    return invocation.args.input;
  }

  return null;
}

function getToolDisplayLabel(
  toolName: string,
  affectedCount: number,
  batchChanges?: Array<{ path: string; action: string; content?: string }>,
): string {
  if (toolName === 'batch_edit_repo_files' && batchChanges && batchChanges.length > 0) {
    const creates = batchChanges.filter((c) => c.action === 'create').length;
    const deletes = batchChanges.filter((c) => c.action === 'delete').length;
    const edits = batchChanges.length - creates - deletes;
    const total = batchChanges.length;
    const fileSuffix = total === 1 ? 'file' : 'files';

    // Single-action batches
    if (creates === total) return `Creating ${total} ${fileSuffix}`;
    if (deletes === total) return `Deleting ${total} ${fileSuffix}`;
    if (edits === total) return `Editing ${total} ${fileSuffix}`;

    // Mixed batch — just show count
    return `Updating ${total} ${fileSuffix}`;
  }

  if (toolName === 'edit_repo_file' && affectedCount > 1) {
    return `Editing ${affectedCount} files`;
  }

  return (TOOL_LABELS[toolName] || { label: toolName }).label;
}

function FileChangeMetaBadge({
  filePath,
  toolName,
  content,
  action,
  showStaged,
}: {
  filePath?: string;
  toolName: string;
  content?: string;
  action?: string;
  showStaged: boolean;
}) {
  const scopeId = useChatScopeId();
  const changeset = useChangesetStore((s) => s.getChangeset(scopeId));
  const stagedChange = filePath ? changeset.changes[filePath] : undefined;
  const resolvedAction = getFileAction(toolName, action);

  const change = React.useMemo(() => {
    if (stagedChange) return stagedChange;
    if (!filePath || !resolvedAction) return null;

    return {
      path: filePath,
      action: resolvedAction,
      content: content ?? '',
      originalContent: changeset.repoFileCache[filePath],
    };
  }, [changeset.repoFileCache, content, filePath, resolvedAction, stagedChange]);

  if (!change) {
    if (!showStaged) return null;
    return (
      <span className="ml-1 flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] font-medium text-green-400">
        <ArrowRight className="h-2.5 w-2.5" />
        staged
      </span>
    );
  }

  const { affectedLines, rangeLabel } = summarizeChangeLines(change);
  const { added, removed } = getChangeLineDelta(change);

  if (!showStaged && affectedLines === 0 && !rangeLabel && added === 0 && removed === 0) {
    return null;
  }

  return (
    <span className="ml-1 flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px] font-medium">
      {showStaged && (
        <>
          <ArrowRight className="h-2.5 w-2.5 text-green-400" />
          <span className="text-green-400">staged</span>
        </>
      )}
      {affectedLines > 0 && (
        <span className="text-foreground/70">
          {affectedLines} line{affectedLines === 1 ? '' : 's'}
        </span>
      )}
      {rangeLabel && <span className="text-muted-foreground">{rangeLabel}</span>}
      {showStaged && added > 0 && <span className="text-green-400">+{added}</span>}
      {showStaged && removed > 0 && <span className="text-red-400">-{removed}</span>}
    </span>
  );
}

function StagedFileSummary({ paths }: { paths: string[] }) {
  const scopeId = useChatScopeId();
  const changes = useChangesetStore((s) => s.getChangeset(scopeId).changes);
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

/** Collapsible code preview of edited lines for a file change. */
function FileEditPreview({ filePath }: { filePath: string }) {
  const scopeId = useChatScopeId();
  const change = useChangesetStore((s) => s.getChangeset(scopeId).changes[filePath]);
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

  const lineCount = change?.action === 'delete'
    ? (change.originalContent || '').split('\n').length
    : (change?.content || '').split('\n').length;
  const lineNumbers = diffLines
    .map((line) => (line.lineNum === null ? '' : String(line.lineNum)))
    .join('\n');

  useLayoutEffect(() => {
    if (contentRef.current) {
      setIsOverflowing(contentRef.current.scrollHeight > COLLAPSED_HEIGHT);
    }
  }, [diffLines]);

  if (!change || diffLines.length === 0) return null;

  return (
    <div className="chat-code-block mt-2">
      <div className="chat-code-block__titlebar">
        <div className="chat-code-block__window-controls" aria-hidden="true">
          <span className="chat-code-block__window-dot chat-code-block__window-dot--red" />
          <span className="chat-code-block__window-dot chat-code-block__window-dot--amber" />
          <span className="chat-code-block__window-dot chat-code-block__window-dot--green" />
        </div>
        <div className="chat-code-block__tab">
          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="chat-code-block__filename">{filePath}</span>
        </div>
      </div>

      <div className="chat-code-block__meta">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full shrink-0"
            style={{
              backgroundColor:
                change.action === 'create' ? '#4ec9b0' :
                change.action === 'delete' ? '#f14c4c' :
                '#569cd6',
            }}
          />
          <span className="chat-code-block__language">
            {change.action === 'create' ? 'Created' : change.action === 'delete' ? 'Deleted' : 'Modified'}
          </span>
        </div>
        <span className="chat-code-block__line-count">
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
      </div>

      <div className="chat-code-block__body">
        <div
          ref={contentRef}
          className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
          style={{ maxHeight: expanded ? `${contentRef.current?.scrollHeight || 2000}px` : `${COLLAPSED_HEIGHT}px` }}
        >
          <div className="chat-code-block__editor">
            <pre aria-hidden="true" className="chat-code-block__gutter text-[12px] leading-[1.65] text-right pr-3 pl-2 font-mono text-gray-600">
              {lineNumbers}
            </pre>
            <div className="chat-code-block__viewport">
              <pre className="chat-code-block__pre text-[12px] leading-[1.65]">
                {diffLines.map((line, i) => {
                  const bgClass =
                    line.type === 'added' ? 'bg-[#2ea04322]' :
                    line.type === 'removed' ? 'bg-[#f8514922]' :
                    '';
                  const textClass =
                    line.type === 'added' ? 'text-[#7ee787]' :
                    line.type === 'removed' ? 'text-[#ff7b72]' :
                    'text-[#d4d4d4]';
                  const prefix =
                    line.type === 'added' ? '+' :
                    line.type === 'removed' ? '-' :
                    ' ';
                  const isSeparator = line.content === '···' && line.lineNum === null;

                  if (isSeparator) {
                    return (
                      <div key={i} className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start px-4 py-0.5 text-[#5d6570]">
                        <span className="select-none text-center">·</span>
                        <span>···</span>
                      </div>
                    );
                  }

                  return (
                    <div key={i} className={cn('grid grid-cols-[1.25rem_minmax(0,1fr)] items-start px-4 py-0.5', bgClass)}>
                      <span className={cn('select-none text-center', textClass)}>{prefix}</span>
                      <span className={cn(textClass, 'whitespace-pre')}>{line.content || ' '}</span>
                    </div>
                  );
                })}
              </pre>
            </div>
          </div>
        </div>

        {/* Fade overlay + show more button when collapsed and overflowing */}
        {isOverflowing && !expanded && (
          <div className="absolute bottom-0 left-0 right-0">
            <div className="chat-code-block__fade" />
            <div className="chat-code-block__footer">
              <button
                onClick={() => setExpanded(true)}
                className="chat-code-block__toggle"
              >
                Show more
                <ChevronDown className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}

        {/* Collapse button when expanded */}
        {isOverflowing && expanded && (
          <div className="chat-code-block__footer chat-code-block__footer--expanded">
            <button
              onClick={() => setExpanded(false)}
              className="chat-code-block__toggle"
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
  const scopeId = useChatScopeId();
  const [expanded, setExpanded] = useState(false);
  const toolInfo = TOOL_LABELS[invocation.toolName] || { label: invocation.toolName, icon: Wrench };
  const Icon = toolInfo.icon;
  const isComplete = invocation.state === 'result';
  const isInProgress = invocation.state === 'call' || invocation.state === 'partial-call';
  const errorMessage = getToolErrorMessage(invocation.result);
  const hasError = !!errorMessage;
  const isExecTool = invocation.toolName === 'run_command' || invocation.toolName === 'terminal' || invocation.toolName === 'execute_python';
  const outputMessage = getToolOutputMessage(invocation.result);
  const hasOutput = isComplete && !hasError && isExecTool && !!outputMessage && outputMessage !== '(no output)';
  const progressLabel = invocation.toolName === 'read_repo_file' || invocation.toolName === 'read_file' ? 'Reading...'
    : invocation.toolName === 'run_command' || invocation.toolName === 'terminal' ? 'Running...'
    : invocation.toolName === 'execute_python' ? 'Executing...'
    : invocation.toolName === 'write_file' ? 'Writing...'
    : 'In progress';
  const panelChanges = useChangesetStore((s) => s.getChangeset(scopeId).changes);

  // Extract file info from args
  const filePath = invocation.args?.path as string | undefined;
  const toolTarget = getToolTarget(invocation);
  const artifactFilename = invocation.args?.filename as string | undefined;
  const batchChangesRaw = invocation.args?.changes;
  const batchChanges = Array.isArray(batchChangesRaw)
    ? batchChangesRaw as Array<{ path: string; action: string; content?: string }>
    : undefined;
  const isBatch = invocation.toolName === 'batch_edit_repo_files' && batchChanges && batchChanges.length > 0;
  const shouldFocusPrimaryBatchFile = !!(isBatch && isInProgress && batchChanges && batchChanges.length > 0);
  const primaryBatchChange = shouldFocusPrimaryBatchFile ? batchChanges?.[0] : undefined;
  const primaryBatchPath = primaryBatchChange?.path;
  const isFileCreationTool = FILE_CREATION_TOOLS.has(invocation.toolName);
  const stagedPaths = React.useMemo(
    () =>
      Object.values(panelChanges)
        .filter((change) => change.staged)
        .map((change) => change.path),
    [panelChanges],
  );

  // Determine which file paths this tool call affected (for staging display)
  const isFileModifyingTool = ['edit_repo_file', 'create_repo_file', 'delete_repo_file', 'batch_edit_repo_files'].includes(invocation.toolName);
  const affectedPaths: string[] = isBatch
    ? batchChanges!.map((c) => c.path)
    : filePath && isFileModifyingTool
      ? [filePath]
      : isFileModifyingTool
        ? stagedPaths
        : [];
  const focusedFilePath = filePath || primaryBatchPath;
  const toolTargetLabel = toolTarget || focusedFilePath || (affectedPaths.length === 1 ? affectedPaths[0] : null);
  const displayLabel = shouldFocusPrimaryBatchFile
    ? (primaryBatchChange?.action === 'create' ? 'Creating file' : primaryBatchChange?.action === 'delete' ? 'Deleting file' : 'Editing file')
    : getToolDisplayLabel(invocation.toolName, affectedPaths.length, batchChanges);
  const showMultiFileList = affectedPaths.length > 1 && (!shouldFocusPrimaryBatchFile && (isBatch || (!filePath && isFileModifyingTool)));

  const handlePreviewClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const previewStore = usePreviewStore.getState();
    const preview = previewStore.getPreview(scopeId);
    const changeset = useChangesetStore.getState().getChangeset(scopeId);
    // Focus the file in the preview if it exists
    if (artifactFilename) {
      const file = preview.files.find((f) => f.filename === artifactFilename);
      if (file) previewStore.setActiveFile(scopeId, file.id);
    }
    if (changeset.activeRepo) {
      previewStore.setView(scopeId, 'repo');
    } else if (Object.keys(changeset.changes).length > 0) {
      previewStore.setView(scopeId, 'changes');
    }
    previewStore.setOpen(scopeId, true);
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
              {isComplete ? 'Open in workspace' : 'Creating...'}
            </div>
          </div>
          <span className={cn(
            'shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide',
            fileExt === 'html' ? 'bg-orange-500/15 text-orange-400' :
            fileExt === 'css' ? 'bg-zinc-500/15 text-zinc-400' :
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
    <div className="rounded-md border border-amber-500/20 bg-amber-500/5 my-1.5 overflow-hidden">
      {/* Accordion header — always visible, click to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-amber-500/10 transition-colors"
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-amber-500/70 transition-transform duration-200 flex-shrink-0',
            expanded ? 'rotate-0' : '-rotate-90'
          )}
        />
        {isInProgress ? (
          <GhostIcon />
        ) : isComplete ? (
          <CheckCircle2 className={cn('h-3.5 w-3.5 shrink-0', hasError ? 'text-amber-500' : 'text-green-500')} />
        ) : (
          <Icon className="h-3.5 w-3.5 text-amber-500/70 shrink-0" />
        )}
        <span className="text-[11px] font-medium text-amber-600/80 dark:text-amber-400/80">
          {displayLabel}
        </span>
        {toolTargetLabel && (
          <code
            className="text-[11px] text-foreground/70 bg-muted/50 px-1.5 py-0.5 rounded font-mono truncate max-w-[300px]"
            title={toolTargetLabel}
          >
            {toolTargetLabel}
          </code>
        )}
        {shouldFocusPrimaryBatchFile && affectedPaths.length > 1 && (
          <span className="text-[11px] text-foreground/60">+{affectedPaths.length - 1} more queued</span>
        )}
        {!shouldFocusPrimaryBatchFile && affectedPaths.length > 1 && (
          <span className="text-[11px] text-foreground/60">({affectedPaths.length} files)</span>
        )}
        {isInProgress && (
          <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-primary/80 ml-auto">
            {progressLabel}
          </span>
        )}
        {(isFileModifyingTool && focusedFilePath) && (
          <FileChangeMetaBadge
            filePath={focusedFilePath}
            toolName={invocation.toolName}
            action={primaryBatchChange?.action}
            content={typeof invocation.args?.content === 'string' ? invocation.args.content : primaryBatchChange?.content}
            showStaged={isComplete}
          />
        )}
        {!isInProgress && hasError && (
          <span className="ml-auto text-[10px] text-amber-500/70">error</span>
        )}
        {!isInProgress && isComplete && !hasError && (
          <span className="ml-auto text-[10px] text-muted-foreground/60">done</span>
        )}
      </button>

      {/* Accordion body — slides open */}
      <div
        className={cn(
          'overflow-hidden transition-all duration-200 ease-in-out',
          expanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'
        )}
      >
        <div className="px-3 pb-2 pt-0.5 space-y-1">
          {(isInProgress || isLatest) && (
            <div className="mt-1">
              <div className="chat-tool-glimmer__track">
                <div className="chat-tool-glimmer__bar chat-tool-glimmer__bar--long" />
                <div className="chat-tool-glimmer__bar chat-tool-glimmer__bar--short" />
              </div>
            </div>
          )}

          {hasError && (
            <div className="text-[12px] text-amber-400/90 whitespace-pre-wrap">
              {errorMessage}
            </div>
          )}

          {/* Command/execution output */}
          {hasOutput && (
            <div>
              <pre className="text-[11px] font-mono text-foreground/80 bg-muted/30 rounded-md px-2.5 py-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all">
                {outputMessage}
              </pre>
            </div>
          )}

          {/* Code diff preview — shown when expanded for completed file-modifying tools */}
          {isComplete && isFileModifyingTool && !isBatch && filePath && (
            <FileEditPreview filePath={filePath} />
          )}

          {/* Batch file list */}
          {showMultiFileList && (
            <div className="space-y-0.5">
              {affectedPaths.map((p, idx) => (
                <div key={idx}>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                    <FileCode className="h-3 w-3 shrink-0" />
                    <code className="font-mono text-foreground/70 text-[11px] bg-muted/40 px-1 py-0.5 rounded truncate min-w-0">{p}</code>
                    {batchChanges?.[idx]?.action && (
                      <span className="text-muted-foreground/50 text-[10px]">{batchChanges[idx].action}</span>
                    )}
                    <FileChangeMetaBadge
                      filePath={p}
                      toolName={invocation.toolName}
                      action={batchChanges?.[idx]?.action}
                      content={batchChanges?.[idx]?.content}
                      showStaged={isComplete}
                    />
                  </div>
                  {isComplete && <FileEditPreview filePath={p} />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const MessageBubble: React.FC<MessageBubbleProps> = React.memo(function MessageBubble({
  message,
  isStreaming,
  streamingContent,
  parts,
  reasoning,
  isReasoningStreaming,
  toolInvocations,
  toolActivity,
  allowPseudoRepoWrites = true,
  onRegenerate,
  onEdit,
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const prevReasoningStreamingRef = useRef(false);
  const isUser = message.role === 'user';

  const rawContent = isStreaming ? (streamingContent || '') : message.content;
  const hasStructuredRepoToolInvocations = Boolean(
    toolInvocations?.some((invocation) => REPO_TOOL_NAMES.has(invocation.toolName)) ||
    parts?.some((part) => part.type === 'tool-invocation' && part.toolInvocation && REPO_TOOL_NAMES.has(part.toolInvocation.toolName)),
  );
  const pseudoToolInvocations = React.useMemo(() => {
    if (isUser || hasStructuredRepoToolInvocations) return [];
    const sourceText = getPseudoToolSourceText({ content: rawContent, parts });
    const pseudoInvocations = extractPseudoToolInvocations(sourceText)
      .filter((invocation) => allowPseudoRepoWrites || !REPO_WRITE_TOOL_NAMES.has(invocation.toolName))
      .map((invocation, index) => ({
        toolCallId: `pseudo-${message.id}-${index}`,
        toolName: invocation.toolName,
        args: invocation.args,
        state: 'result' as const,
        result: { synthesized: true },
      }));
    if (pseudoInvocations.length > 0) {
      return pseudoInvocations;
    }
    if (!allowPseudoRepoWrites) {
      return [];
    }
    return extractTextFileEdits(sourceText).map((edit, index) => ({
      toolCallId: `text-edit-${message.id}-${index}`,
      toolName: 'edit_repo_file',
      args: {
        path: edit.path,
        content: edit.content,
      },
      state: 'result' as const,
      result: { synthesized: true, source: 'text-file-edit' },
    }));
  }, [allowPseudoRepoWrites, hasStructuredRepoToolInvocations, isUser, message.id, parts, rawContent]);
  const normalizedRawContent = React.useMemo(() => {
    if (isUser) return rawContent;
    // Always strip raw pseudo tool call text from content, even when structured
    // tool invocations exist — the model may embed the raw call in content AND
    // return a structured tool invocation, causing duplicate display.
    // Pass isStreaming so partial (unclosed) calls are also truncated.
    return sanitizeAssistantTextContent(rawContent, !!isStreaming);
  }, [isUser, rawContent, isStreaming]);

  // Parse out inline <think> blocks from content (some models embed these directly)
  const parsed = !isUser ? parseThinkingBlocks(normalizedRawContent, !!isStreaming) : null;
  const displayContent = parsed ? parsed.cleanContent : normalizedRawContent;

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
  const synthesizedToolInvocations = React.useMemo(() => {
    if (isUser || !Array.isArray(toolActivity) || toolActivity.length === 0) {
      return [];
    }

    return toolActivity.map((event, index) => ({
      toolCallId: `activity-${message.id}-${index}`,
      toolName: event.tool,
      args: parseToolActivityArgs(event.input),
      state: event.status === 'completed' ? 'result' as const : 'call' as const,
      ...(event.status === 'completed'
        ? {
            result: event.output
              ? (/^(error|failed)[:\s]/i.test(event.output.trim())
                  ? { error: event.output.trim() }
                  : { output: event.output })
              : { ok: true },
          }
        : {}),
    }));
  }, [isUser, message.id, toolActivity]);
  const orderedParts = React.useMemo(() => {
    if (isUser) return [];

    const normalizedParts = Array.isArray(parts) ? [...parts] : [];
    const hasTextPart = normalizedParts.some((part) => part.type === 'text' && part.text?.trim());
    const hasReasoningPart = normalizedParts.some((part) => part.type === 'reasoning' && part.reasoning?.trim());
    const hasToolPart = normalizedParts.some((part) => part.type === 'tool-invocation');

    if (!hasReasoningPart && effectiveReasoning) {
      normalizedParts.unshift({ type: 'reasoning', reasoning: effectiveReasoning });
    }

    // If parts already has tool invocations (from AI SDK streaming), they're interleaved
    if (hasToolPart) {
      if (!hasTextPart && displayContent) {
        normalizedParts.push({ type: 'text', text: displayContent });
      }
      return dedupeAssistantParts(normalizedParts);
    }

    // Determine which fallback tool invocations to use (priority order)
    const fallbackTools = pseudoToolInvocations.length > 0
      ? pseudoToolInvocations
      : (toolInvocations && toolInvocations.length > 0)
        ? toolInvocations
        : synthesizedToolInvocations;

    // Try to interleave tool invocations with text using Hermes activity markers
    if (fallbackTools.length > 0 && !hasTextPart) {
      const interleaved = buildInterleavedHermesParts(rawContent, fallbackTools);
      if (interleaved) {
        normalizedParts.push(...interleaved);
        return dedupeAssistantParts(normalizedParts);
      }
    }

    // Fallback: interleave text parts with tool invocations.
    // If parts contains multiple text entries (from AI SDK streaming that splits
    // text at tool call boundaries), use them to reconstruct interleaved order.
    // Otherwise, fall back to text-first-then-tools.
    const textPartsFromParts = normalizedParts.filter(
      (part): part is { type: 'text'; text: string } =>
        part.type === 'text' && typeof part.text === 'string',
    );

    if (fallbackTools.length > 0 && textPartsFromParts.length > 1) {
      // Multiple text entries in parts — they represent text segments split at
      // tool call boundaries during streaming.  Reconstruct interleaved order:
      // text₁, tool₁, text₂, tool₂, …, remaining text, remaining tools.
      const result: MessagePart[] = [];
      let toolIdx = 0;
      for (const textPart of textPartsFromParts) {
        result.push(textPart);
        if (toolIdx < fallbackTools.length) {
          result.push({ type: 'tool-invocation', toolInvocation: fallbackTools[toolIdx] });
          toolIdx++;
        }
      }
      // Append any trailing text from displayContent not yet in parts
      // (can happen during streaming when text arrives after the last tool)
      if (displayContent) {
        const partsText = textPartsFromParts.map((p) => p.text).join('');
        if (displayContent.length > partsText.length) {
          const trailing = displayContent.slice(partsText.length).trim();
          if (trailing) {
            result.push({ type: 'text', text: trailing });
          }
        }
      }
      while (toolIdx < fallbackTools.length) {
        result.push({ type: 'tool-invocation', toolInvocation: fallbackTools[toolIdx] });
        toolIdx++;
      }
      return dedupeAssistantParts(result);
    }

    // Simple fallback: text first, then tools
    if (!hasTextPart && displayContent) {
      normalizedParts.push({ type: 'text', text: displayContent });
    }

    if (fallbackTools.length > 0) {
      normalizedParts.push(
        ...fallbackTools.map((toolInvocation) => ({
          type: 'tool-invocation' as const,
          toolInvocation,
        })),
      );
    }

    return dedupeAssistantParts(normalizedParts);
  }, [displayContent, effectiveReasoning, isUser, parts, pseudoToolInvocations, rawContent, synthesizedToolInvocations, toolInvocations]);

  const lastToolIndex = React.useMemo(() =>
    orderedParts.reduce((last, p, i) => (p.type === 'tool-invocation' ? i : last), -1),
    [orderedParts],
  );

  const showAgentActivity = Boolean(toolActivity?.length) && synthesizedToolInvocations.length === 0;

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

  const formattedTime = React.useMemo(() => {
    if (!message.timestamp) return null;
    const date = new Date(message.timestamp);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }, [message.timestamp]);

  if (message.role === 'system') return null;

  return (
    <div className={cn('group mb-6', isUser ? '' : '')}>
      <div className={cn('relative min-w-0 overflow-hidden', isUser ? 'w-full' : 'w-full')}>
        {formattedTime && !editing && (
          <span className="text-[10px] text-muted-foreground/50 mb-1 block opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {formattedTime}
          </span>
        )}
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
              orderedParts.map((part, index) => {
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
                  // Also strip malformed repo payload dumps and Hermes status lines when
                  // they leak through text parts instead of message.content.
                  const stripped = sanitizeAssistantTextContent(part.text, !!isStreaming);
                  const cleanedText = parseThinkingBlocks(stripped, !!isStreaming).cleanContent;
                  if (!cleanedText) return null;
                  return (
                    <div key={`text-${index}`} className={index > 0 ? 'mt-3' : undefined}>
                      <MarkdownRenderer content={cleanedText} />
                    </div>
                  );
                }

                return null;
              })
            )}
            {showAgentActivity && toolActivity && toolActivity.length > 0 && (
              <AgentActivity events={toolActivity} />
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
});
