import { useState } from 'react';
import { Search, Globe, Terminal, Eye, FileText, Code, ChevronDown, ChevronRight, Loader2, Check } from 'lucide-react';

export interface ToolActivityEvent {
  tool: string;
  status: 'running' | 'completed';
  input: string;
  output: string | null;
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

function ToolEvent({ event }: { event: ToolActivityEvent }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getToolIcon(event.tool);
  const isRunning = event.status === 'running';

  return (
    <div className="border-b border-zinc-200 dark:border-zinc-700 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
      >
        {isRunning ? (
          <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin shrink-0" />
        ) : (
          <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
        )}
        <Icon className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <span className="text-zinc-700 dark:text-zinc-300 truncate font-medium">
          {event.tool}
        </span>
        <span className="text-zinc-400 dark:text-zinc-500 truncate text-xs ml-auto mr-2">
          {event.input.slice(0, 80)}{event.input.length > 80 ? '...' : ''}
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-medium">Input:</span>{' '}
            <span className="font-mono">{event.input}</span>
          </div>
          {event.output && (
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              <span className="font-medium">Output:</span>{' '}
              <pre className="font-mono whitespace-pre-wrap mt-1 bg-zinc-100 dark:bg-zinc-800 rounded p-2 max-h-40 overflow-auto">
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
  const summary = runningCount > 0
    ? `${runningCount} tool${runningCount > 1 ? 's' : ''} running...`
    : `${completedCount} tool${completedCount > 1 ? 's' : ''} used`;

  return (
    <div className="mt-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
      >
        {runningCount > 0 ? (
          <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
        ) : (
          <Check className="w-4 h-4 text-green-500 shrink-0" />
        )}
        <span className="text-zinc-600 dark:text-zinc-400 font-medium">
          Agent Activity
        </span>
        <span className="text-zinc-400 dark:text-zinc-500 text-xs ml-1">
          {summary}
        </span>
        <div className="ml-auto">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-zinc-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-zinc-400" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-zinc-700">
          {events.map((event, i) => (
            <ToolEvent key={`${event.tool}-${i}`} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
