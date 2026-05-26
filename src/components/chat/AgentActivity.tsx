import { useState } from 'react';
import { Search, Globe, Terminal, Eye, FileText, Code, ChevronDown, ChevronRight, Check, Zap } from 'lucide-react';

export interface ToolActivityEvent {
  tool: string;
  status: 'running' | 'completed';
  input: string;
  output: string | null;
  /** Byte offset into the accumulated content stream where this tool was emitted. */
  textOffset?: number;
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
};

function getToolIcon(toolName: string) {
  const lower = toolName.toLowerCase();
  for (const [key, Icon] of Object.entries(TOOL_ICONS)) {
    if (lower.includes(key)) return Icon;
  }
  return Code;
}

/** Extract a short label from tool input JSON */
function extractLabel(_tool: string, input: string): string {
  try {
    const parsed = JSON.parse(input.trim());
    if (parsed.path) return parsed.path.split('/').slice(-2).join('/');
    if (parsed.filename) return parsed.filename;
    if (parsed.query) return parsed.query.slice(0, 50);
    if (parsed.url) return parsed.url.slice(0, 60);
  } catch { /* ignore */ }
  return input.slice(0, 60) + (input.length > 60 ? '...' : '');
}

function ToolEvent({ event }: { event: ToolActivityEvent }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getToolIcon(event.tool);
  const isRunning = event.status === 'running';
  const label = extractLabel(event.tool, event.input);

  return (
    <div className="border-b border-border/30 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors duration-75"
      >
        {isRunning ? (
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
          </span>
        ) : (
          <Check className="w-3 h-3 text-emerald-500 shrink-0" />
        )}
        <Icon className="w-3 h-3 text-muted-foreground/60 shrink-0" />
        <span className="text-muted-foreground font-mono text-[11px] truncate">
          {event.tool}
        </span>
        <span className="text-muted-foreground/40 font-mono text-[10px] truncate ml-1">
          {label}
        </span>
        <div className="ml-auto shrink-0">
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground/40" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground/40" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          <div className="text-[11px] text-muted-foreground/70">
            <span className="font-medium text-muted-foreground">Input</span>
            <pre className="font-mono whitespace-pre-wrap mt-1 bg-muted/30 rounded-md p-2 max-h-32 overflow-auto text-[10px] border border-border/20">
              {event.input}
            </pre>
          </div>
          {event.output && (
            <div className="text-[11px] text-muted-foreground/70">
              <span className="font-medium text-muted-foreground">Output</span>
              <pre className="font-mono whitespace-pre-wrap mt-1 bg-muted/30 rounded-md p-2 max-h-32 overflow-auto text-[10px] border border-border/20">
                {event.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentActivity({ events }: { events: ToolActivityEvent[] }) {
  const [expanded, setExpanded] = useState(false);

  if (events.length === 0) return null;

  const completedCount = events.filter((e) => e.status === 'completed').length;
  const runningCount = events.filter((e) => e.status === 'running').length;

  return (
    <div className="mt-2 rounded-lg border border-border/50 bg-muted/20 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/30 transition-colors duration-75"
      >
        <Zap className="w-3.5 h-3.5 text-primary/80 shrink-0" />
        <span className="text-xs text-muted-foreground font-medium tracking-tight">
          {runningCount > 0 ? `${runningCount} running` : `${completedCount} completed`}
        </span>
        <div className="flex items-center gap-1 ml-1">
          {runningCount > 0 && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
            </span>
          )}
          {completedCount > 0 && (
            <span className="text-[10px] text-emerald-500/70 font-mono">
              {completedCount} done
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
            <ToolEvent key={`${event.tool}-${i}`} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
