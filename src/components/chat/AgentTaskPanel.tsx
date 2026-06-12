import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronRight, ListChecks, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolActivityEvent } from './AgentActivity';
import {
  deriveAgentTaskPanelState,
  isAgentTaskPanelEmpty,
  type PanelBackgroundProcess,
  type PanelSubagent,
  type PanelTodo,
} from '@/lib/agent-task-panel';

function TodoStatusIcon({ status }: { status: PanelTodo['status'] }) {
  if (status === 'completed') {
    return <Check className="h-3 w-3 shrink-0 text-emerald-500" aria-label="completed" />;
  }
  if (status === 'in_progress') {
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-label="in progress" />;
  }
  if (status === 'cancelled') {
    return <X className="h-3 w-3 shrink-0 text-muted-foreground/50" aria-label="cancelled" />;
  }
  return (
    <span
      aria-label="pending"
      className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-muted-foreground/50 mx-[1px]"
    />
  );
}

function RunningDot({ running }: { running: boolean }) {
  if (!running) {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />;
  }
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
    </span>
  );
}

interface SectionProps {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ label, expanded, onToggle, icon, children }: SectionProps) {
  return (
    <div className="border-b border-border/30 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-muted/30 transition-colors duration-100"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {icon}
        <span className="text-[12px] font-medium tracking-tight text-muted-foreground">{label}</span>
      </button>
      {expanded && <div className="pb-1">{children}</div>}
    </div>
  );
}

function SubagentWindow({ subagent, onClose }: { subagent: PanelSubagent; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Subagent: ${subagent.goal}`}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-[10px] border border-[#3F3F3F] bg-[#1B1B1B] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
          <Bot className="h-3.5 w-3.5 shrink-0 text-primary/80" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
            {subagent.goal}
          </span>
          {subagent.status === 'running' ? (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
              Running
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-emerald-500">
              <Check className="h-3 w-3" />
              Done
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close subagent window"
            className="ml-1 rounded p-0.5 text-muted-foreground/60 hover:bg-muted/40 hover:text-foreground transition-colors duration-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {subagent.context && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Context</div>
              <pre className="whitespace-pre-wrap rounded-md border border-border/20 bg-muted/30 p-2 font-mono text-[11px] text-muted-foreground">
                {subagent.context}
              </pre>
            </div>
          )}
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Result</div>
            {subagent.output ? (
              <pre className="whitespace-pre-wrap rounded-md border border-border/20 bg-muted/30 p-2 font-mono text-[11px] text-muted-foreground">
                {subagent.output}
              </pre>
            ) : (
              <div className="text-[11px] italic text-muted-foreground/50">
                {subagent.status === 'running' ? 'Working…' : 'No output captured.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BackgroundRow({ proc }: { proc: PanelBackgroundProcess }) {
  const [expanded, setExpanded] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const hasOutput = proc.outputLines.length > 0;

  // Keep the live tail pinned to the latest output.
  useEffect(() => {
    if (expanded && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [expanded, proc.outputLines.length]);

  return (
    <div>
      <button
        type="button"
        onClick={() => hasOutput && setExpanded((v) => !v)}
        aria-expanded={hasOutput ? expanded : undefined}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-1 pl-7 text-left transition-colors duration-100',
          hasOutput ? 'hover:bg-muted/30 cursor-pointer' : 'cursor-default',
        )}
      >
        <RunningDot running={proc.status === 'running'} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={proc.command}>
          {proc.command}
        </span>
        {hasOutput && (
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground/40 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        )}
      </button>
      {expanded && hasOutput && (
        <pre
          ref={outputRef}
          className="mx-3 mb-1.5 ml-9 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/20 bg-muted/30 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground/80"
        >
          {proc.outputLines.join('\n')}
        </pre>
      )}
    </div>
  );
}

export interface AgentTaskPanelProps {
  events: ToolActivityEvent[];
}

/**
 * Accordion panel above the composer showing the agent's live task list,
 * spawned subagents (click to open in a window), and background processes
 * with their tailed output.
 */
export function AgentTaskPanel({ events }: AgentTaskPanelProps) {
  const state = useMemo(() => deriveAgentTaskPanelState(events), [events]);
  const [tasksExpanded, setTasksExpanded] = useState(true);
  const [subagentsExpanded, setSubagentsExpanded] = useState(true);
  const [backgroundExpanded, setBackgroundExpanded] = useState(true);
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null);

  if (isAgentTaskPanelEmpty(state)) return null;

  const completedCount = state.todos.filter((t) => t.status === 'completed').length;
  const openSubagent = state.subagents.find((s) => s.id === openSubagentId) ?? null;

  return (
    <div
      data-testid="agent-task-panel"
      className="mb-1.5 overflow-hidden rounded-[10px] border border-[#3F3F3F] bg-[#1E1E1E]"
    >
      {state.todos.length > 0 && (
        <Section
          label={`Tasks ${completedCount}/${state.todos.length}`}
          expanded={tasksExpanded}
          onToggle={() => setTasksExpanded((v) => !v)}
          icon={<ListChecks className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
        >
          {state.todos.map((todo) => (
            <div key={todo.id} className="flex items-center gap-2 px-3 py-1 pl-7">
              <TodoStatusIcon status={todo.status} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[12px]',
                  todo.status === 'completed' && 'text-muted-foreground/50 line-through',
                  todo.status === 'cancelled' && 'text-muted-foreground/40 line-through',
                  todo.status === 'in_progress' && 'text-foreground',
                  todo.status === 'pending' && 'text-muted-foreground',
                )}
              >
                {todo.content}
              </span>
            </div>
          ))}
        </Section>
      )}

      {state.subagents.length > 0 && (
        <Section
          label={`${state.subagents.length} Subagent${state.subagents.length === 1 ? '' : 's'}`}
          expanded={subagentsExpanded}
          onToggle={() => setSubagentsExpanded((v) => !v)}
        >
          {state.subagents.map((subagent) => (
            <button
              key={subagent.id}
              type="button"
              onClick={() => setOpenSubagentId(subagent.id)}
              className="flex w-full items-center gap-2 px-3 py-1 pl-7 text-left hover:bg-muted/30 transition-colors duration-100"
            >
              {subagent.status === 'running' ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
              ) : (
                <Check className="h-3 w-3 shrink-0 text-emerald-500" />
              )}
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground" title={subagent.goal}>
                {subagent.goal}
              </span>
            </button>
          ))}
        </Section>
      )}

      {state.background.length > 0 && (
        <Section
          label={`${state.background.length} Background`}
          expanded={backgroundExpanded}
          onToggle={() => setBackgroundExpanded((v) => !v)}
        >
          {state.background.map((proc) => (
            <BackgroundRow key={proc.id} proc={proc} />
          ))}
        </Section>
      )}

      {openSubagent && (
        <SubagentWindow subagent={openSubagent} onClose={() => setOpenSubagentId(null)} />
      )}
    </div>
  );
}
