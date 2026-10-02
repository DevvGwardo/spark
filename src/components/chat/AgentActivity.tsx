import { useState } from 'react';
import { Search, Globe, Terminal, Eye, FileText, Code, ChevronDown, ChevronRight, Check, Zap, Layers, GitMerge, AlertTriangle, X, RotateCcw } from 'lucide-react';
import { formatToolDuration, splitToolOutputHeadTail } from '@/hooks/useChat';

export interface ToolActivityEvent {
  tool: string;
  status: 'running' | 'completed';
  input: string;
  output: string | null;
  /** Byte offset into the accumulated content stream where this tool was emitted. */
  textOffset?: number;
  /** Structured execution enrichment from tool_call_end events (additive —
   *  absent for legacy bridge streams, which degrade to the old rendering). */
  success?: boolean;
  exitCode?: number | null;
  durationMs?: number | null;
  outputTruncated?: boolean;
  outputTruncatedLines?: number;
}

const TOOL_ICONS: Record<string, typeof Search> = {
  web_search: Search,
  search: Search,
  browser: Globe,
  browse: Globe,
  terminal: Terminal,
  shell: Terminal,
  vision: Eye,
  image: Eye,
  file: FileText,
  files: FileText,
  code: Code,
  code_execution: Code,
  'moa.reference': Layers,
  'moa.aggregating': GitMerge,
  'lsp.diagnostic': AlertTriangle,
};

function getToolIcon(toolName: string) {
  const lower = toolName.toLowerCase();
  if (TOOL_ICONS[lower]) return TOOL_ICONS[lower];
  for (const [key, Icon] of Object.entries(TOOL_ICONS)) {
    if (lower.includes(key)) return Icon;
  }
  return Code;
}

function parseJsonSafe(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input.trim());
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Extract a short label from tool input JSON */
function extractLabel(tool: string, input: string): string {
  if (tool === 'moa.reference') {
    const meta = parseJsonSafe(input);
    if (meta?.label) return String(meta.label);
    return 'Advisor';
  }
  if (tool === 'moa.aggregating') {
    const meta = parseJsonSafe(input);
    if (meta?.aggregator) return String(meta.aggregator);
    return 'Synthesizing';
  }
  try {
    const parsed = JSON.parse(input.trim());
    if (parsed.path) return parsed.path.split('/').slice(-2).join('/');
    if (parsed.filename) return parsed.filename;
    if (parsed.query) return parsed.query.slice(0, 50);
    if (parsed.url) return parsed.url.slice(0, 60);
  } catch { /* ignore */ }
  return input.slice(0, 60) + (input.length > 60 ? '...' : '');
}

function isMoaEvent(tool: string): boolean {
  return tool === 'moa.reference' || tool === 'moa.aggregating';
}

function isLspDiagnosticEvent(tool: string): boolean {
  return tool === 'lsp.diagnostic';
}

function isFailedEvent(event: ToolActivityEvent): boolean {
  if (event.status !== 'completed') {
    return false;
  }
  if (event.success === false) {
    return true;
  }
  return typeof event.exitCode === 'number' && event.exitCode !== 0;
}

// HEAD+TAIL output rendering: first ~12 lines and last ~8 lines with a middle
// "… +N lines" row that expands/collapses on click. Collapsed by default when
// the output is long (> 40 lines). Server-side truncation numbers win when
// the backend reports them (outputTruncated / outputTruncatedLines).
const OUTPUT_HEAD_LINES = 12;
const OUTPUT_TAIL_LINES = 8;
const OUTPUT_COLLAPSE_THRESHOLD = 40;

function TruncatedOutput({
  text,
  outputTruncated,
  outputTruncatedLines,
}: {
  text: string;
  outputTruncated?: boolean;
  outputTruncatedLines?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const split = splitToolOutputHeadTail(text, {
    headLines: OUTPUT_HEAD_LINES,
    tailLines: OUTPUT_TAIL_LINES,
  });
  const serverHidden = outputTruncated ? Math.max(0, outputTruncatedLines ?? 0) : 0;
  const isLong = split.totalLines > OUTPUT_COLLAPSE_THRESHOLD;
  const hiddenLines = isLong ? Math.max(split.hiddenLines, serverHidden) : serverHidden;
  const hasTail = split.tail.length > 0;
  const showEllipsis = hiddenLines > 0;

  const preClass = 'font-mono whitespace-pre-wrap mt-1 bg-muted/30 rounded-md p-2 max-h-32 overflow-auto text-[10px] border border-border/20';

  if (!showEllipsis) {
    return <pre className={preClass}>{text}</pre>;
  }

  const label = `… +${hiddenLines} line${hiddenLines === 1 ? '' : 's'}`;

  return (
    <>
      <pre className={preClass}>{split.head}</pre>
      {hasTail ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-1 flex w-full items-center gap-1 rounded-md border border-border/30 bg-muted/20 px-2 py-1 text-[10px] font-mono text-muted-foreground/70 transition-colors duration-75 hover:bg-muted/40 hover:text-muted-foreground"
        >
          <span>{expanded ? 'Hide middle' : label}</span>
          <ChevronDown className={`h-3 w-3 transition-transform duration-100 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      ) : (
        <div className="mt-1 px-2 py-1 text-[10px] font-mono text-muted-foreground/50">
          {label} (truncated server-side)
        </div>
      )}
      {expanded && hasTail && <pre className={preClass}>{split.tail}</pre>}
    </>
  );
}

function ToolEvent({ event, onRetry }: { event: ToolActivityEvent; onRetry?: (toolName: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getToolIcon(event.tool);
  const isRunning = event.status === 'running';
  const isFailed = isFailedEvent(event);
  const label = extractLabel(event.tool, event.input);
  const moa = isMoaEvent(event.tool);
  const lsp = isLspDiagnosticEvent(event.tool);
  const meta = moa || lsp ? parseJsonSafe(event.input) : null;
  const duration = typeof event.durationMs === 'number' && event.durationMs !== null
    ? formatToolDuration(event.durationMs)
    : null;
  const exitCode = typeof event.exitCode === 'number' ? event.exitCode : null;

  const title =
    event.tool === 'moa.reference'
      ? `Advisor${meta?.label ? ` · ${meta.label}` : ''}`
      : event.tool === 'moa.aggregating'
        ? `Aggregating${meta?.aggregator ? ` · ${meta.aggregator}` : ''}`
        : event.tool === 'lsp.diagnostic'
          ? `LSP${meta?.path ? ` · ${String(meta.path).split('/').slice(-2).join('/')}` : ''}`
          : event.tool;

  // Lifecycle verbs: "Running <name>" (spinner), "Ran <name>" (green),
  // "Failed <name>" (red + ✗ exit code). MoA/LSP cards keep their own labels.
  const statusPrefix = isRunning ? 'Running' : isFailed ? 'Failed' : 'Ran';

  return (
    <div className={`border-b border-border/30 last:border-b-0 ${moa ? 'bg-primary/[0.03]' : ''} ${lsp ? 'bg-amber-500/[0.04]' : ''}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors duration-75"
      >
        {isRunning ? (
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping motion-reduce:animate-none rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
          </span>
        ) : isFailed ? (
          <X className="w-3 h-3 text-red-500 shrink-0" />
        ) : (
          <Check className="w-3 h-3 text-emerald-500 shrink-0" />
        )}
        <Icon className={`w-3 h-3 shrink-0 ${moa ? 'text-primary/80' : lsp ? 'text-amber-400/80' : isFailed ? 'text-red-500/70' : 'text-muted-foreground/60'}`} />
        <span className={`font-mono text-[11px] truncate ${moa || lsp ? 'text-foreground/80' : isFailed ? 'text-red-500/90' : isRunning ? 'text-muted-foreground' : 'text-emerald-500/90'}`}>
          {(moa || lsp) ? title : `${statusPrefix} ${title}`}
        </span>
        {!moa && !lsp && (
          <span className="text-muted-foreground/40 font-mono text-[10px] truncate ml-1">
            {label}
          </span>
        )}
        {event.tool === 'moa.reference' && meta?.index != null && meta?.count != null && (
          <span className="text-[10px] font-mono text-muted-foreground/50 ml-1">
            {Number(meta.index) + 1}/{String(meta.count)}
          </span>
        )}
        {isFailed && exitCode !== null && (
          <span className="text-[10px] font-mono text-red-500/90 shrink-0">
            ✗ ({exitCode})
          </span>
        )}
        {!isRunning && duration && (
          <span className={`text-[10px] font-mono shrink-0 ${isFailed ? 'text-red-400/70' : 'text-emerald-500/80'}`}>
            {isFailed ? '•' : '✓'} {duration}
          </span>
        )}
        <div className="ml-auto shrink-0">
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground/40" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground/40" />
          )}
        </div>
      </button>
      {isFailed && onRetry && (
        <div className="flex items-center justify-end gap-2 px-3 pb-1.5">
          <button
            type="button"
            onClick={() => onRetry(event.tool)}
            className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-0.5 text-[10px] font-medium text-red-400 transition-colors duration-100 hover:bg-red-500/10"
            title={`Retry ${event.tool} with the same arguments`}
          >
            <RotateCcw className="h-2.5 w-2.5" />
            Retry
          </button>
        </div>
      )}
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          {lsp && event.output ? (
            <div className="text-[11px] text-muted-foreground/70">
              <span className="font-medium text-amber-400/90">Diagnostics</span>
              {meta?.source_tool ? (
                <span className="ml-2 font-mono text-[10px] text-muted-foreground/50">
                  via {String(meta.source_tool)}
                </span>
              ) : null}
              <TruncatedOutput text={event.output} />
            </div>
          ) : moa && event.output ? (
            <div className="text-[11px] text-muted-foreground/70">
              <span className="font-medium text-muted-foreground">
                {event.tool === 'moa.reference' ? 'Advice' : 'Status'}
              </span>
              <TruncatedOutput text={event.output} />
            </div>
          ) : (
            <>
              <div className="text-[11px] text-muted-foreground/70">
                <span className="font-medium text-muted-foreground">Input</span>
                <pre className="font-mono whitespace-pre-wrap mt-1 bg-muted/30 rounded-md p-2 max-h-32 overflow-auto text-[10px] border border-border/20">
                  {event.input}
                </pre>
              </div>
              {event.output && (
                <div className="text-[11px] text-muted-foreground/70">
                  <span className="font-medium text-muted-foreground">Output</span>
                  <TruncatedOutput
                    text={event.output}
                    outputTruncated={event.outputTruncated}
                    outputTruncatedLines={event.outputTruncatedLines}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentActivity({
  events,
  onRetryTool,
}: {
  events: ToolActivityEvent[];
  /** Explicit retry for a failed tool (name-based; the runtime looks up the
   *  stored args). Optional so legacy consumers keep working unchanged. */
  onRetryTool?: (toolName: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (events.length === 0) return null;

  const completedCount = events.filter((e) => e.status === 'completed').length;
  const runningCount = events.filter((e) => e.status === 'running').length;
  const failedCount = events.filter((e) => isFailedEvent(e)).length;
  const moaAdvisorCount = events.filter((e) => e.tool === 'moa.reference').length;
  const lspCount = events.filter((e) => e.tool === 'lsp.diagnostic').length;
  const hasMoa = moaAdvisorCount > 0 || events.some((e) => e.tool === 'moa.aggregating');
  const hasLsp = lspCount > 0;

  let headerLabel: string;
  if (hasMoa) {
    if (runningCount > 0) {
      headerLabel = `MoA · ${runningCount} running`;
    } else if (moaAdvisorCount > 0) {
      headerLabel = `MoA · ${moaAdvisorCount} advisor${moaAdvisorCount === 1 ? '' : 's'}`;
    } else {
      headerLabel = 'MoA · synthesizing';
    }
  } else if (hasLsp) {
    headerLabel = `LSP · ${lspCount} diagnostic${lspCount === 1 ? '' : 's'}`;
  } else if (runningCount > 0) {
    headerLabel = `${runningCount} running`;
  } else {
    headerLabel = `${completedCount} completed${failedCount > 0 ? ` · ${failedCount} failed` : ''}`;
  }

  return (
    <div className="mt-2 rounded-lg border border-border/50 bg-muted/20 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/30 transition-colors duration-75"
      >
        {hasMoa ? (
          <Layers className="w-3.5 h-3.5 text-primary/80 shrink-0" />
        ) : hasLsp ? (
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400/80 shrink-0" />
        ) : (
          <Zap className="w-3.5 h-3.5 text-primary/80 shrink-0" />
        )}
        <span className="text-xs text-muted-foreground font-medium tracking-tight">
          {headerLabel}
        </span>
        <div className="flex items-center gap-1 ml-1">
          {runningCount > 0 && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75 motion-reduce:animate-none" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
            </span>
          )}
          {completedCount > 0 && !hasMoa && (
            <span className="text-[10px] text-emerald-500/70 font-mono">
              {completedCount} done
            </span>
          )}
          {failedCount > 0 && !hasMoa && (
            <span className="text-[10px] text-red-500/70 font-mono">
              {failedCount} failed
            </span>
          )}
        </div>
        <div className="ml-auto">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/40" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border/30">
          {events.map((event, i) => (
            <ToolEvent key={`${event.tool}-${i}`} event={event} onRetry={onRetryTool} />
          ))}
        </div>
      )}
    </div>
  );
}
