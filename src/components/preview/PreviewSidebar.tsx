import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { usePreviewStore } from '@/stores/preview-store';
import { usePanelStore } from '@/stores/panel-store';
import { useChangesetStore, type FileChange } from '@/stores/changeset-store';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  X,
  RotateCcw,
  Check,
  Diff,
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { computeDiffLines, countContentLines, getChangeLineDelta } from '@/lib/change-diff';
import { cn } from '@/lib/utils';
import { getChatScopeId } from '@/lib/chat-scope';

const changeActionStyles = {
  create: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/20',
  edit: 'bg-sky-500/12 text-sky-400 border-sky-500/20',
  delete: 'bg-red-500/12 text-red-400 border-red-500/20',
} as const;

function ChangeDiff({ change }: { change: FileChange }) {
  const diffLines = useMemo(() => {
    if (change.action === 'create') {
      return (change.content || '').split('\n').slice(0, 60).map((line, index) => ({
        type: 'added' as const,
        lineNum: index + 1,
        content: line,
      }));
    }

    if (change.action === 'delete') {
      return (change.originalContent || '').split('\n').slice(0, 60).map((line, index) => ({
        type: 'removed' as const,
        lineNum: index + 1,
        content: line,
      }));
    }

    if (!change.originalContent) {
      return (change.content || '').split('\n').slice(0, 60).map((line, index) => ({
        type: 'added' as const,
        lineNum: index + 1,
        content: line,
      }));
    }

    return computeDiffLines(change.originalContent, change.content, 2);
  }, [change]);

  if (diffLines.length === 0) return null;

  return (
    <pre className="overflow-x-auto overflow-y-auto max-w-full py-1 text-[11px] leading-[18px] font-mono">
      {diffLines.map((line, index) => {
        const isSeparator = line.lineNum === null && line.content === '···';
        if (isSeparator) {
          return (
            <div key={index} className="px-2 text-muted-foreground/30">
              <span className="inline-block w-7" />
              <span>···</span>
            </div>
          );
        }

        const tone =
          line.type === 'added'
            ? 'text-emerald-400'
            : line.type === 'removed'
              ? 'text-red-400'
              : 'text-muted-foreground/50';
        const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';

        return (
          <div key={index} className={cn('px-2', tone)}>
            <span className="inline-block w-7 pr-2 text-right text-muted-foreground/20 select-none">
              {line.lineNum}
            </span>
            <span className="select-none">{prefix}</span>
            <span>{' '}{line.content}</span>
          </div>
        );
      })}
    </pre>
  );
}

function ChangeRow({
  change,
  expanded,
  onToggle,
  onRevert,
  onStageToggle,
}: {
  change: FileChange;
  expanded: boolean;
  onToggle: () => void;
  onRevert: () => void;
  onStageToggle: () => void;
}) {
  const { added, removed } = getChangeLineDelta(change);

  return (
    <div className="rounded-xl border border-border/50 bg-background/60 overflow-hidden">
      <div className="px-2.5 py-2 space-y-1.5 min-w-0 overflow-hidden">
        <div className="flex items-start justify-between gap-1.5 min-w-0">
          <code className="break-all text-[11px] font-medium leading-snug text-foreground/90">
            {change.path}
          </code>
          <div className="flex items-center shrink-0 gap-1.5">
            <span className={cn('rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide', changeActionStyles[change.action])}>
              {change.action}
            </span>
            <span className="text-[10px] font-mono tabular-nums">
              {added > 0 && <span className="text-emerald-500">+{added}</span>}
              {added > 0 && removed > 0 && <span className="text-muted-foreground/40">/</span>}
              {removed > 0 && <span className="text-red-400">-{removed}</span>}
              {added === 0 && removed === 0 && <span className="text-muted-foreground">~{countContentLines(change.content)}L</span>}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onRevert}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Revert</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onStageToggle}
                className={cn(
                  'rounded-md p-1 transition-colors',
                  change.staged
                    ? 'text-emerald-400 hover:bg-emerald-500/10'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{change.staged ? 'Unstage file' : 'Stage file'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onToggle}
                className={cn(
                  'rounded-md p-1 transition-colors',
                  expanded
                    ? 'text-sky-400 hover:bg-sky-500/10'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <Diff className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{expanded ? 'Hide diff' : 'Show diff'}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/40 overflow-hidden">
          <ChangeDiff change={change} />
        </div>
      )}
    </div>
  );
}

export const PreviewSidebar: React.FC = () => {
  const panels = usePanelStore((state) => state.panels);
  const focusedPanelId = usePanelStore((state) => state.focusedPanelId);
  const focusedPanel = panels.find((panel) => panel.id === focusedPanelId);
  const scopeId = getChatScopeId(focusedPanelId, focusedPanel?.conversationId ?? null);
  const preview = usePreviewStore(useShallow((state) => state.getPreview(scopeId)));
  const setOpen = usePreviewStore((state) => state.setOpen);
  const setRailWidth = usePreviewStore((state) => state.setRailWidth);
  const changeset = useChangesetStore(useShallow((state) => state.getChangeset(scopeId)));
  const getLineTotals = useChangesetStore((state) => state.getLineTotals);
  const setChangeStaged = useChangesetStore((state) => state.setChangeStaged);
  const stageAllChanges = useChangesetStore((state) => state.stageAllChanges);
  const removeChange = useChangesetStore((state) => state.removeChange);
  const clearChanges = useChangesetStore((state) => state.clearChanges);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const { isOpen, railWidth } = preview;
  const isResizing = useRef(false);

  const changeEntries = useMemo(() => (
    Object.values(changeset.changes).sort((left, right) => {
      if (!!left.staged !== !!right.staged) return left.staged ? 1 : -1;
      return left.path.localeCompare(right.path);
    })
  ), [changeset.changes]);

  const allTotals = getLineTotals(scopeId, 'all');
  const stagedTotals = getLineTotals(scopeId, 'staged');
  const unstagedTotals = getLineTotals(scopeId, 'unstaged');
  const stagedCount = changeEntries.filter((change) => change.staged).length;
  const unstagedCount = changeEntries.length - stagedCount;
  const hasChanges = changeEntries.length > 0;

  const handleResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    isResizing.current = true;
    const startX = event.clientX;
    const startWidth = railWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing.current) return;
      const nextWidth = startWidth + (startX - moveEvent.clientX);
      setRailWidth(scopeId, nextWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [railWidth, scopeId, setRailWidth]);

  // Only show the sidebar when there are actual code changes to review
  if (!isOpen || !hasChanges) return null;

  return (
    <div className="relative shrink-0 h-full border-l border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-bg))] flex flex-col overflow-hidden" style={{ width: railWidth }}>
      <div
        onMouseDown={handleResizeStart}
        className="absolute top-0 -left-1.5 z-10 h-full w-3 cursor-col-resize group"
      >
        <div className="absolute inset-y-6 bottom-6 left-1/2 w-px -translate-x-1/2 rounded-full bg-border/25 transition-colors group-hover:bg-foreground/25 group-active:bg-foreground/40" />
      </div>

      <div className="h-[44px] flex items-center justify-between px-3.5 py-2.5 border-b border-[hsl(var(--border))] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Diff className="h-3.5 w-3.5 text-[#888888]" />
          <span className="text-[12px] font-medium text-[#888888]">Changes</span>
          {changeEntries.length > 0 && (
            <span className="bg-[#2a2a2a] rounded-[4px] px-1.5 py-0.5 font-mono text-[9px] text-[#666666]">{changeEntries.length} files</span>
          )}
        </div>
        <button
          onClick={() => setOpen(scopeId, false)}
          className="rounded-lg p-1.5 text-[#666666] transition-colors hover:bg-white/5 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-1 min-h-0 flex-col">
        <div className="border-b border-border px-3 py-3">
          <div className="flex items-center justify-between px-1 py-1">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold uppercase tracking-[1px] text-[#666666]">Updated Lines</span>
                <span className="text-[#888888] text-[10px]">{changeEntries.length} files</span>
              </div>
              <div className="mt-1 flex items-center gap-2 font-mono text-[20px] font-semibold tabular-nums">
                <span className="text-[#34D399]">+{allTotals.added}</span>
                <span className="text-[#444444]">/</span>
                <span className="text-[#F87171]">-{allTotals.removed}</span>
              </div>
            </div>
            <div className="text-right text-[11px] text-muted-foreground">
              <div>{unstagedCount} unstaged</div>
              <div>{stagedCount} staged</div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-3.5 text-[11px]">
            <div>
              <div className="text-[#666666] text-[10px] font-medium">Unstaged</div>
              <div className="text-[#555555] font-mono text-[9px] tabular-nums">
                <span className="text-[#34D399]">+{unstagedTotals.added}</span>
                <span className="text-[#555555]"> / </span>
                <span className="text-[#F87171]">-{unstagedTotals.removed}</span>
              </div>
            </div>
            <div>
              <div className="text-[#e0e0e0] text-[10px] font-semibold">Staged</div>
              <div className="text-[#555555] font-mono text-[9px] tabular-nums">
                <span className="text-[#34D399]">+{stagedTotals.added}</span>
                <span className="text-[#555555]"> / </span>
                <span className="text-[#F87171]">-{stagedTotals.removed}</span>
              </div>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-2 p-2">
            {changeEntries.map((change) => (
              <ChangeRow
                key={change.path}
                change={change}
                expanded={!!expandedPaths[change.path]}
                onToggle={() => setExpandedPaths((state) => ({ ...state, [change.path]: !state[change.path] }))}
                onRevert={() => removeChange(scopeId, change.path)}
                onStageToggle={() => setChangeStaged(scopeId, change.path, !change.staged)}
              />
            ))}
          </div>
        </ScrollArea>

        <div className="border-t border-[#2a2a2a] p-3.5">
          <div className="flex gap-2">
            <button
              onClick={() => clearChanges(scopeId)}
              className="flex-1 rounded-[8px] border border-[#333333] h-[34px] text-[12px] font-medium text-[#999999] transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              Revert all
            </button>
            <button
              onClick={() => stageAllChanges(scopeId, true)}
              className="flex-1 rounded-[8px] bg-primary h-[34px] text-[12px] font-semibold text-[#0C0C0C] transition-opacity hover:opacity-90"
            >
              Stage all
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
