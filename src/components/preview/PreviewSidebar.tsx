import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { usePreviewStore } from '@/stores/preview-store';
import { usePanelStore } from '@/stores/panel-store';
import { useChangesetStore, type FileChange } from '@/stores/changeset-store';
import { useSettingsStore } from '@/stores/settings-store';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  X,
  FileText,
  FileCode2,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Check,
  PanelsTopLeft,
  Diff,
  FolderGit2,
  Folder,
  FolderOpen,
  Loader2,
  GitBranch,
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { computeDiffLines, countContentLines, getChangeLineDelta } from '@/lib/change-diff';
import { cn } from '@/lib/utils';
import { getApiBaseUrl } from '@/lib/api';

const changeActionStyles = {
  create: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/20',
  edit: 'bg-sky-500/12 text-sky-400 border-sky-500/20',
  delete: 'bg-red-500/12 text-red-400 border-red-500/20',
} as const;

type RepoTreeNode = {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children?: RepoTreeNode[];
};

function buildRepoTree(paths: string[]): RepoTreeNode[] {
  const root: RepoTreeNode[] = [];

  for (const path of paths) {
    const segments = path.split('/').filter(Boolean);
    let currentChildren = root;
    let currentPath = '';

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isFile = index === segments.length - 1;

      let node = currentChildren.find((candidate) => candidate.path === currentPath);
      if (!node) {
        node = {
          name: segment,
          path: currentPath,
          type: isFile ? 'file' : 'folder',
          ...(isFile ? {} : { children: [] }),
        };
        currentChildren.push(node);
      }

      if (!isFile) {
        currentChildren = node.children ?? [];
      }
    }
  }

  const sortNodes = (nodes: RepoTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'folder' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    for (const node of nodes) {
      if (node.type === 'folder' && node.children) {
        sortNodes(node.children);
      }
    }
  };

  sortNodes(root);
  return root;
}

function collectFolderPaths(nodes: RepoTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === 'folder') {
      paths.push(node.path);
      if (node.children) {
        paths.push(...collectFolderPaths(node.children));
      }
    }
  }
  return paths;
}

function flattenRepoTree(
  nodes: RepoTreeNode[],
  expandedFolders: Record<string, boolean>,
  depth: number = 0,
): Array<{ node: RepoTreeNode; depth: number }> {
  const rows: Array<{ node: RepoTreeNode; depth: number }> = [];

  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.type === 'folder' && node.children && expandedFolders[node.path] !== false) {
      rows.push(...flattenRepoTree(node.children, expandedFolders, depth + 1));
    }
  }

  return rows;
}

function getRepoFileTone(path: string): string {
  if (/\.(tsx|jsx|ts|js)$/.test(path)) return 'text-zinc-300';
  if (/\.json$/.test(path)) return 'text-zinc-400';
  if (/\.(css|scss|sass)$/.test(path)) return 'text-zinc-300';
  if (/\.md$/.test(path)) return 'text-zinc-400';
  return 'text-zinc-500';
}

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
        <div className="flex items-center justify-between gap-1.5 min-w-0 overflow-hidden">
          <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
            <code className="truncate min-w-0 text-[11px] font-medium text-foreground/90">
              {change.path}
            </code>
          </div>
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
  const focusedPanelId = usePanelStore((state) => state.focusedPanelId);
  const preview = usePreviewStore(useShallow((state) => state.getPreview(focusedPanelId)));
  const setOpen = usePreviewStore((state) => state.setOpen);
  const setView = usePreviewStore((state) => state.setView);
  const setRailWidth = usePreviewStore((state) => state.setRailWidth);
  const changeset = useChangesetStore(useShallow((state) => state.getChangeset(focusedPanelId)));
  const getLineTotals = useChangesetStore((state) => state.getLineTotals);
  const setChangeStaged = useChangesetStore((state) => state.setChangeStaged);
  const stageAllChanges = useChangesetStore((state) => state.stageAllChanges);
  const removeChange = useChangesetStore((state) => state.removeChange);
  const clearChanges = useChangesetStore((state) => state.clearChanges);
  const cacheRepoFile = useChangesetStore((state) => state.cacheRepoFile);
  const setSelectedRepoFilePath = useChangesetStore((state) => state.setSelectedRepoFilePath);
  const { githubPAT } = useSettingsStore();
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [repoLoadingPath, setRepoLoadingPath] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const { isOpen, activeView, railWidth } = preview;
  const isResizing = useRef(false);

  const changeEntries = useMemo(() => (
    Object.values(changeset.changes).sort((left, right) => {
      if (!!left.staged !== !!right.staged) return left.staged ? 1 : -1;
      return left.path.localeCompare(right.path);
    })
  ), [changeset.changes]);

  const allTotals = getLineTotals(focusedPanelId, 'all');
  const stagedTotals = getLineTotals(focusedPanelId, 'staged');
  const unstagedTotals = getLineTotals(focusedPanelId, 'unstaged');
  const stagedCount = changeEntries.filter((change) => change.staged).length;
  const unstagedCount = changeEntries.length - stagedCount;
  const repoPaths = useMemo(
    () => [...changeset.repoFileTree].sort((left, right) => left.localeCompare(right)),
    [changeset.repoFileTree],
  );
  const cachedRepoFileCount = useMemo(
    () => repoPaths.filter((path) => changeset.repoFileCache[path] !== undefined).length,
    [changeset.repoFileCache, repoPaths],
  );
  const repoLoadPercent = repoPaths.length > 0
    ? Math.round((cachedRepoFileCount / repoPaths.length) * 100)
    : 0;
  const repoTree = useMemo(() => buildRepoTree(repoPaths), [repoPaths]);
  const repoRows = useMemo(() => flattenRepoTree(repoTree, expandedFolders), [expandedFolders, repoTree]);
  const showChangesTab = changeEntries.length > 0;
  const showRepoSection = !!changeset.activeRepo;
  const selectedRepoFilePath = changeset.selectedRepoFilePath && repoPaths.includes(changeset.selectedRepoFilePath)
    ? changeset.selectedRepoFilePath
    : null;
  const selectedRepoFileContent = selectedRepoFilePath
    ? changeset.repoFileCache[selectedRepoFilePath] ?? null
    : null;
  const selectedRepoFileLines = useMemo(
    () => (selectedRepoFileContent ?? '').split('\n'),
    [selectedRepoFileContent],
  );

  const currentView =
    activeView === 'changes' && showChangesTab
      ? 'changes'
      : showRepoSection
        ? 'repo'
        : showChangesTab
          ? 'changes'
          : 'repo';
  const repoStatusTone = changeset.repoFileTreeStatus === 'error'
    ? 'bg-rose-500/10 text-rose-200 border-rose-500/20'
    : 'bg-background/70 text-foreground border-border/70';
  const repoStatusLabel = changeset.repoFileTreeStatus === 'loading'
    ? 'Indexing repository tree...'
    : changeset.repoFileTreeStatus === 'error'
      ? 'Repository indexing failed'
      : repoPaths.length > 0
        ? `${repoPaths.length} files indexed · ${cachedRepoFileCount} cached locally`
        : 'No indexed files yet';
  const repoStatusHint = changeset.repoFileTreeStatus === 'loading'
    ? 'The workspace is fetching the full path tree. File contents will still load on demand after indexing finishes.'
    : changeset.repoFileTreeStatus === 'error'
      ? (changeset.repoFileTreeError ?? 'The repository tree could not be fetched.')
      : repoPaths.length > 0
        ? 'Selecting a repo indexes the full file list, not every file body. Contents are cached as you or the agent open them.'
        : 'This repo is attached, but no files have been indexed into the workspace yet.';

  const handleOpenRepoFile = useCallback(async (path: string) => {
    setSelectedRepoFilePath(focusedPanelId, path);
    setRepoError(null);

    if (changeset.repoFileCache[path] !== undefined) {
      return;
    }

    if (!changeset.activeRepo || !githubPAT) {
      setRepoError('GitHub access is required to load repository files.');
      return;
    }

    setRepoLoadingPath(path);
    try {
      const response = await fetch(`${getApiBaseUrl()}/functions/v1/github-integration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'read-file',
          pat: githubPAT,
          owner: changeset.activeRepo.owner,
          repo: changeset.activeRepo.name,
          path,
          ref: changeset.activeRepo.defaultBranch,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const data = await response.json();
      if (typeof data.error === 'string' && data.error) {
        throw new Error(data.error);
      }

      cacheRepoFile(focusedPanelId, path, typeof data.content === 'string' ? data.content : '');
    } catch (error) {
      setRepoError(error instanceof Error ? error.message : 'Failed to load repository file.');
    } finally {
      setRepoLoadingPath(null);
    }
  }, [cacheRepoFile, changeset.activeRepo, changeset.repoFileCache, focusedPanelId, githubPAT, setSelectedRepoFilePath]);

  useEffect(() => {
    const folderPaths = collectFolderPaths(repoTree);
    if (folderPaths.length === 0) {
      return;
    }

    setExpandedFolders((current) => {
      let mutated = false;
      const next = { ...current };

      for (const path of folderPaths) {
        if (next[path] === undefined) {
          next[path] = true;
          mutated = true;
        }
      }

      return mutated ? next : current;
    });
  }, [repoTree]);

  useEffect(() => {
    if (!showRepoSection || selectedRepoFilePath) {
      return;
    }
    setSelectedRepoFilePath(focusedPanelId, repoPaths[0] ?? null);
  }, [focusedPanelId, repoPaths, selectedRepoFilePath, setSelectedRepoFilePath, showRepoSection]);

  useEffect(() => {
    if (!selectedRepoFilePath) {
      return;
    }

    const segments = selectedRepoFilePath.split('/').slice(0, -1);
    if (segments.length === 0) {
      return;
    }

    setExpandedFolders((current) => {
      let mutated = false;
      const next = { ...current };
      let folderPath = '';

      for (const segment of segments) {
        folderPath = folderPath ? `${folderPath}/${segment}` : segment;
        if (next[folderPath] === false) {
          next[folderPath] = true;
          mutated = true;
        }
      }

      return mutated ? next : current;
    });
  }, [selectedRepoFilePath]);

  useEffect(() => {
    if (
      currentView !== 'repo' ||
      !selectedRepoFilePath ||
      changeset.repoFileCache[selectedRepoFilePath] !== undefined ||
      repoLoadingPath === selectedRepoFilePath
    ) {
      return;
    }

    void handleOpenRepoFile(selectedRepoFilePath);
  }, [changeset.repoFileCache, currentView, handleOpenRepoFile, repoLoadingPath, selectedRepoFilePath]);

  const handleResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    isResizing.current = true;
    const startX = event.clientX;
    const startWidth = railWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing.current) return;
      const nextWidth = startWidth + (startX - moveEvent.clientX);
      setRailWidth(focusedPanelId, nextWidth);
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
  }, [focusedPanelId, railWidth, setRailWidth]);

  if (!isOpen) return null;

  return (
    <div className="relative shrink-0 h-full border-l border-border bg-background/98 backdrop-blur flex flex-col overflow-hidden" style={{ width: railWidth }}>
      <div
        onMouseDown={handleResizeStart}
        className="absolute top-0 -left-1.5 z-10 h-full w-3 cursor-col-resize group"
      >
        <div className="absolute inset-y-6 bottom-6 left-1/2 w-px -translate-x-1/2 rounded-full bg-border/25 transition-colors group-hover:bg-foreground/25 group-active:bg-foreground/40" />
      </div>

      <div className="border-b border-border/80 bg-background px-3 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PanelsTopLeft className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Explorer</span>
            {showRepoSection && (
              <Badge variant="outline" className="border-border/70 bg-background/40 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Repo
              </Badge>
            )}
          </div>
          <button
            onClick={() => setOpen(focusedPanelId, false)}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-xl border border-border/70 bg-muted/20 p-1">
          <button
            onClick={() => setView(focusedPanelId, 'repo')}
            disabled={!showRepoSection}
            className={cn(
              'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              currentView === 'repo'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              !showRepoSection && 'cursor-not-allowed opacity-40',
            )}
          >
            Explorer
          </button>
          <button
            onClick={() => setView(focusedPanelId, 'changes')}
            disabled={!showChangesTab}
            className={cn(
              'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              currentView === 'changes'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              !showChangesTab && 'cursor-not-allowed opacity-40',
            )}
          >
            Changes
          </button>
        </div>
      </div>

      {currentView === 'changes' && showChangesTab ? (
        <div className="flex flex-1 min-h-0 flex-col">
          <div className="border-b border-border px-3 py-3">
            <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-muted/20 px-3 py-2.5">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Updated Lines</div>
                <div className="mt-1 flex items-center gap-2 font-mono text-sm tabular-nums">
                  <span className="text-emerald-500">+{allTotals.added}</span>
                  <span className="text-muted-foreground/30">/</span>
                  <span className="text-red-400">-{allTotals.removed}</span>
                </div>
              </div>
              <div className="text-right text-[11px] text-muted-foreground">
                <div>{unstagedCount} unstaged</div>
                <div>{stagedCount} staged</div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-xl border border-border/70 bg-background px-3 py-2">
                <div className="text-muted-foreground">Unstaged</div>
                <div className="mt-1 font-mono tabular-nums">
                  <span className="text-emerald-500">+{unstagedTotals.added}</span>
                  <span className="text-muted-foreground/30"> / </span>
                  <span className="text-red-400">-{unstagedTotals.removed}</span>
                </div>
              </div>
              <div className="rounded-xl border border-border/70 bg-background px-3 py-2">
                <div className="text-muted-foreground">Staged</div>
                <div className="mt-1 font-mono tabular-nums">
                  <span className="text-emerald-500">+{stagedTotals.added}</span>
                  <span className="text-muted-foreground/30"> / </span>
                  <span className="text-red-400">-{stagedTotals.removed}</span>
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
                  onRevert={() => removeChange(focusedPanelId, change.path)}
                  onStageToggle={() => setChangeStaged(focusedPanelId, change.path, !change.staged)}
                />
              ))}
            </div>
          </ScrollArea>

          <div className="border-t border-border p-3">
            <div className="flex gap-2">
              <button
                onClick={() => clearChanges(focusedPanelId)}
                className="flex-1 rounded-xl border border-border px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                Revert all
              </button>
              <button
                onClick={() => stageAllChanges(focusedPanelId, true)}
                className="flex-1 rounded-xl bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
              >
                Stage all
              </button>
            </div>
          </div>
        </div>
      ) : showRepoSection ? (
        <div className="flex min-h-0 flex-1 bg-background">
          <div className="flex w-[44%] min-w-[190px] flex-col border-r border-border/70 bg-muted/10">
            <div className="border-b border-border/70 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Explorer</div>
              <div className="mt-2 flex items-start gap-2 min-w-0">
                <FolderGit2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div title={changeset.activeRepo?.fullName} className="truncate text-sm font-medium text-foreground">
                    {changeset.activeRepo?.fullName}
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                    <GitBranch className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{changeset.activeRepo?.defaultBranch}</span>
                    <span className="text-border">•</span>
                    <span className="truncate">
                      {changeset.repoFileTreeStatus === 'loading'
                        ? 'Indexing...'
                        : `${repoPaths.length} files`}
                    </span>
                  </div>
                </div>
              </div>
              <div className={cn('mt-3 rounded-xl border px-3 py-2.5', repoStatusTone)}>
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="font-medium">{repoStatusLabel}</span>
                  {changeset.repoFileTreeStatus === 'ready' && repoPaths.length > 0 ? (
                    <span className="font-mono tabular-nums text-muted-foreground">{repoLoadPercent}%</span>
                  ) : changeset.repoFileTreeStatus === 'loading' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted/60">
                  {changeset.repoFileTreeStatus === 'loading' ? (
                    <div className="h-full w-2/5 animate-pulse rounded-full bg-primary/60" />
                  ) : (
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width] duration-300',
                        changeset.repoFileTreeStatus === 'error' ? 'bg-rose-400/80' : 'bg-primary/70',
                      )}
                      style={{ width: `${changeset.repoFileTreeStatus === 'error' ? 100 : repoLoadPercent}%` }}
                    />
                  )}
                </div>
                <div className="mt-2 text-[11px] leading-5 text-muted-foreground">
                  {repoStatusHint}
                </div>
              </div>
            </div>

            <ScrollArea className="flex-1 min-h-0">
              <div className="px-2 py-2">
                {changeset.repoFileTreeStatus === 'loading' && repoRows.length === 0 ? (
                  <div className="px-3 py-6 text-xs text-muted-foreground">
                    Indexing the repository tree so the workspace knows which files exist.
                  </div>
                ) : changeset.repoFileTreeStatus === 'error' && repoRows.length === 0 ? (
                  <div className="px-3 py-6 text-xs text-rose-200">
                    {changeset.repoFileTreeError ?? 'Failed to load the repository tree.'}
                  </div>
                ) : repoRows.length === 0 ? (
                  <div className="px-3 py-6 text-xs text-muted-foreground">
                    No indexed files are available for this repository yet.
                  </div>
                ) : repoRows.map(({ node, depth }) => {
                  const isFolder = node.type === 'folder';
                  const isExpanded = expandedFolders[node.path] !== false;
                  const isActive = node.path === selectedRepoFilePath;
                  const isLoaded = !isFolder && changeset.repoFileCache[node.path] !== undefined;
                  const isLoading = !isFolder && repoLoadingPath === node.path;

                  return (
                    <button
                      key={node.path}
                      onClick={() => {
                        if (isFolder) {
                          setExpandedFolders((current) => ({
                            ...current,
                            [node.path]: !isExpanded,
                          }));
                          return;
                        }

                        void handleOpenRepoFile(node.path);
                      }}
                      className={cn(
                        'group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                        isActive
                          ? 'bg-muted text-foreground'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                      )}
                      style={{ paddingLeft: `${depth * 14 + 10}px` }}
                    >
                      {isFolder ? (
                        <>
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          {isExpanded ? (
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-foreground/80" />
                          ) : (
                            <Folder className="h-3.5 w-3.5 shrink-0 text-foreground/70" />
                          )}
                        </>
                      ) : (
                        <>
                          <span className="w-3.5 shrink-0" />
                          <FileCode2 className={cn('h-3.5 w-3.5 shrink-0', getRepoFileTone(node.path))} />
                        </>
                      )}

                      <span className="min-w-0 flex-1 truncate">{node.name}</span>
                      {!isFolder && isLoading ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : !isFolder && isLoaded ? (
                        <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">cached</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </div>

          <div className="flex min-w-0 flex-1 flex-col bg-background">
            <div className="border-b border-border/70 bg-muted/10 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div title={selectedRepoFilePath ? selectedRepoFilePath.split('/').at(-1) : undefined} className="truncate text-[12px] font-medium text-foreground">
                    {selectedRepoFilePath ? selectedRepoFilePath.split('/').at(-1) : 'Select a file'}
                  </div>
                  <div title={selectedRepoFilePath ?? undefined} className="truncate text-[11px] text-muted-foreground">
                    {selectedRepoFilePath ?? 'Repository explorer ready for a future in-app editor'}
                  </div>
                </div>
              </div>
              {repoError ? (
                <div className="mt-2 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                  {repoError}
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1">
              {selectedRepoFilePath ? (
                repoLoadingPath === selectedRepoFilePath ? (
                  <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading file…
                  </div>
                ) : selectedRepoFileContent !== null ? (
                  <ScrollArea className="h-full">
                    <div className="min-w-full px-0 py-2 font-mono text-[12px] leading-6 text-foreground/90">
                      {selectedRepoFileLines.map((line, index) => (
                        <div key={`${selectedRepoFilePath}:${index + 1}`} className="grid grid-cols-[56px_minmax(0,1fr)] px-4 hover:bg-muted/20">
                          <span className="select-none pr-4 text-right text-muted-foreground/50">{index + 1}</span>
                          <code className="overflow-x-auto whitespace-pre">{line || ' '}</code>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                    Select a file to load it into the workspace explorer.
                  </div>
                )
              ) : (
                <div className="flex h-full items-center justify-center p-6">
                  <div className="max-w-[240px] text-center">
                    <FileCode2 className="mx-auto mb-4 h-10 w-10 text-muted-foreground/40" />
                    <div className="text-sm font-medium text-foreground">
                      {changeset.repoFileTreeStatus === 'loading'
                        ? 'Indexing repository'
                        : 'Repo-first workspace'}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {changeset.repoFileTreeStatus === 'loading'
                        ? 'The full file list is loading now. File contents will appear here once you open a path.'
                        : changeset.repoFileTreeStatus === 'error'
                          ? (changeset.repoFileTreeError ?? 'The repository tree could not be loaded.')
                          : 'Preview is hidden here. The rail now behaves like an explorer so it can grow into a full editor later.'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center bg-background p-6">
          <div className="max-w-[260px] text-center">
            <PanelsTopLeft className="mx-auto mb-4 h-10 w-10 text-muted-foreground/40" />
            <div className="text-sm font-medium text-foreground">Explorer is empty</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Select a repository to populate the file tree. Workspace preview is intentionally hidden in this layout.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
