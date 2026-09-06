import React, { useMemo } from 'react';
import { useChatScopeId } from '@/hooks/use-panel-context';
import { useChangesetStore, type FileChange } from '@/stores/changeset-store';
import { useHermesStore } from '@/stores/hermes-store';
import type { ToolActivityEvent } from './AgentActivity';
import { getToolPathArg, normalizeToolName, parseToolActivityInput } from '@/lib/tool-activity';
import { Terminal, FileCode, GitBranch, Search, Pencil, Brain, FileText, Repeat, Gavel } from 'lucide-react';

type Activity = 'thinking' | 'reading' | 'editing' | 'planning' | 'writing';

const ACTIVITY_CONFIG: Record<Activity, { label: string; Icon: typeof Terminal }> = {
  thinking: { label: 'Reasoning', Icon: Brain },
  reading: { label: 'Reading files', Icon: Search },
  editing: { label: 'Applying changes', Icon: Pencil },
  planning: { label: 'Planning changes', Icon: GitBranch },
  writing: { label: 'Generating code', Icon: FileCode },
};

interface ActivityIndicatorProps {
  isStreaming: boolean;
  messages: Array<{
    role: string;
    parts?: Array<{
      type?: string;
      toolInvocation?: {
        toolName?: string;
      };
    }>;
    toolInvocations?: Array<{
      toolName?: string;
    }>;
  }>;
  toolActivity?: ToolActivityEvent[];
  statusLabel?: string;
}

function deriveActivity(messages: ActivityIndicatorProps['messages'], toolActivity?: ToolActivityEvent[]): Activity {
  const latestToolActivity = (toolActivity || []).findLast((event) => event.status === 'running') ??
    [...(toolActivity || [])].at(-1);

  if (latestToolActivity) {
    const name = latestToolActivity.tool || '';
    // MoA advisor/aggregator phases — surface as reasoning in the compact strip;
    // full advisor cards render in AgentActivity.
    if (name === 'moa.reference' || name === 'moa.aggregating') return 'thinking';
    if (name === 'computer_use' || name === 'computer') return 'thinking';
    // normalizeToolName strips hermes title prefixes ("read: /path").
    const family = normalizeToolName(name);
    if (family === 'read_file' || family === 'search_files' || family === 'web_search') return 'reading';
    if (family === 'edit') return 'editing';
    if (name === 'propose_changes') return 'planning';
    if (['create_html_file', 'create_css_file', 'create_js_file', 'create_react_component'].includes(name)) return 'writing';
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const toolInvocations =
      (msg.parts?.filter((p) => p.type === 'tool-invocation').map((p) => p.toolInvocation)) ||
      msg.toolInvocations || [];
    if (toolInvocations.length === 0) break;
    const last = toolInvocations[toolInvocations.length - 1];
    const name = last?.toolName || '';
    const family = normalizeToolName(name);
    if (family === 'read_file' || family === 'search_files' || family === 'web_search') return 'reading';
    if (family === 'edit') return 'editing';
    if (name === 'propose_changes') return 'planning';
    if (['create_html_file', 'create_css_file', 'create_js_file', 'create_react_component'].includes(name)) return 'writing';
    break;
  }
  return 'thinking';
}

/** Extract file paths being edited from the current tool activity */
function extractActiveFiles(toolActivity?: ToolActivityEvent[]): string[] {
  if (!toolActivity?.length) return [];
  const files: string[] = [];
  const running = toolActivity.filter((e) => e.status === 'running');
  const events = running.length > 0 ? running : toolActivity.slice(-3);

  for (const event of events) {
    const parsed = parseToolActivityInput(event.input);
    const target = getToolPathArg(parsed as Record<string, unknown>);
    if (target) files.push(target);
    if (Array.isArray(parsed.changes)) {
      for (const change of parsed.changes) {
        if (change && typeof change === 'object' && 'path' in change && typeof (change as Record<string, unknown>).path === 'string') {
          files.push((change as Record<string, unknown>).path as string);
        }
      }
    }
  }
  return [...new Set(files)];
}

/** Shorten a file path to just the filename or last 2 segments */
function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

/** Compact live path for the fluent status line (last 2 segments). */
function shortenLivePath(path: string): string {
  return shortenPath(path);
}

function FileChip({ path, status }: { path: string; status: 'active' | 'done' }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-muted/60 border border-border/40 text-[11px] font-mono text-muted-foreground">
      <span
        className={`h-1.5 w-1.5 rounded-full shrink-0 ${
          status === 'active' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500'
        }`}
      />
      <FileText className="h-3 w-3 shrink-0 opacity-50" />
      <span className="truncate max-w-[180px]">{shortenPath(path)}</span>
    </span>
  );
}

export const ActivityIndicator: React.FC<ActivityIndicatorProps> = ({ isStreaming, messages, toolActivity, statusLabel }) => {
  const scopeId = useChatScopeId();
  // Loop mode progress — read from the hermes store so the strip shows
  // "Loop 2/5 · judging" instead of a generic label during loop runs.
  const loopPhase = useHermesStore((s) => s.loops[scopeId]?.phase ?? 'idle');
  const loopIteration = useHermesStore((s) => s.loops[scopeId]?.iteration ?? 0);
  const loopMax = useHermesStore((s) => s.loops[scopeId]?.config.maxIterations ?? 0);
  const loopActive = isStreaming && (loopPhase === 'agent' || loopPhase === 'judge');
  const stagedPaths = useChangesetStore((state) => {
    const scope = state.panelChangesets[scopeId];
    if (!scope) return '';
    // Return a stable string to avoid infinite re-renders from new array refs
    return Object.values(scope.changes)
      .filter((c): c is FileChange => !!c && c.staged === true)
      .map((c) => c.path)
      .sort()
      .join('\n');
  });

  const activity = useMemo(
    () => (isStreaming ? deriveActivity(messages, toolActivity) : 'thinking'),
    [isStreaming, messages, toolActivity],
  );

  const activeFiles = useMemo(
    () => extractActiveFiles(toolActivity),
    [toolActivity],
  );

  // Combine active files from tool activity + staged changes
  const allFiles = useMemo(() => {
    const set = new Set(activeFiles);
    if (stagedPaths) {
      for (const p of stagedPaths.split('\n')) {
        set.add(p);
      }
    }
    return [...set];
  }, [activeFiles, stagedPaths]);

  if (!isStreaming) return null;

  const config = ACTIVITY_CONFIG[activity];
  const Icon = config.Icon;
  // Codex-style fluency: when a single file is live, name it inline
  // ("Reading server/routes/chat.ts") instead of a generic plural.
  const singleLiveFile = allFiles.length === 1 ? shortenLivePath(allFiles[0]) : null;
  const baseLabel = loopActive
    ? loopPhase === 'judge'
      ? `Judging iteration ${loopIteration}/${loopMax}`
      : `Loop ${loopIteration}/${loopMax}`
    : statusLabel || config.label;
  const label = !loopActive && !statusLabel && singleLiveFile
    ? `${config.label.replace(/s$/, '')} ${singleLiveFile}`
    : baseLabel;
  const LoopIcon = loopPhase === 'judge' ? Gavel : Repeat;

  return (
    <div className="flex flex-col items-center gap-1.5 py-2 animate-in fade-in duration-150" aria-live="polite">
      {/* Status line — Codex-style fluent verb, shimmering while live */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0 max-w-full">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 opacity-75 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        {loopActive ? (
          <LoopIcon className={`h-3 w-3 shrink-0 ${loopPhase === 'judge' ? 'text-amber-400' : 'text-emerald-400'}`} />
        ) : (
          <Icon className="h-3 w-3 opacity-70 shrink-0" />
        )}
        <span className="font-medium tracking-tight truncate glimmer-text" title={label}>{label}</span>
        {allFiles.length > 0 && (
          <span className="text-muted-foreground/50 font-mono text-[10px]">
            {allFiles.length} {allFiles.length === 1 ? 'file' : 'files'}
          </span>
        )}
      </div>

      {/* File chips */}
      {allFiles.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-1 max-w-[480px]">
          {allFiles.slice(0, 5).map((path) => (
            <FileChip
              key={path}
              path={path}
              status={activeFiles.includes(path) ? 'active' : 'done'}
            />
          ))}
          {allFiles.length > 5 && (
            <span className="text-[10px] text-muted-foreground/60 font-mono px-1">
              +{allFiles.length - 5} more
            </span>
          )}
        </div>
      )}
    </div>
  );
};
