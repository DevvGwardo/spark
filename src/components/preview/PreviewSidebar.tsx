import React, { useMemo, useState } from 'react';
import { usePreviewStore, type PreviewFile } from '@/stores/preview-store';
import { usePanelStore } from '@/stores/panel-store';
import { useChangesetStore, type FileChange } from '@/stores/changeset-store';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  X,
  Eye,
  FileText,
  Palette,
  Code,
  Trash2,
  BookOpen,
  FileCode2,
  ChevronDown,
  RotateCcw,
  Check,
  PanelsTopLeft,
  Diff,
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { computeDiffLines, countContentLines, getChangeLineDelta } from '@/lib/change-diff';
import { cn } from '@/lib/utils';

const fileTypeIcons: Record<string, React.ElementType> = {
  html: FileText,
  css: Palette,
  js: Code,
  jsx: Code,
  tsx: Code,
  ts: Code,
  md: BookOpen,
};

const fileTypeColors: Record<string, string> = {
  html: 'bg-orange-100 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400',
  css: 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
  js: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400',
  jsx: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/20 dark:text-cyan-400',
  tsx: 'bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400',
  ts: 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
  md: 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400',
};

const changeActionStyles = {
  create: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/20',
  edit: 'bg-sky-500/12 text-sky-400 border-sky-500/20',
  delete: 'bg-red-500/12 text-red-400 border-red-500/20',
} as const;

function generateHtmlPreview(files: PreviewFile[], activeFileId: string | null) {
  const htmlFiles = files.filter((file) => file.type === 'html');
  const cssFiles = files.filter((file) => file.type === 'css');
  const jsFiles = files.filter((file) => file.type === 'js');
  const mainHtml = htmlFiles.find((file) => file.id === activeFileId) || htmlFiles[0];
  if (!mainHtml) return '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <style>
    html, body {
      background: #ffffff;
      color: #1a1a1a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin: 0;
      padding: 16px;
    }
  </style>
  ${cssFiles.map((file) => `<style>\n${file.content}\n</style>`).join('\n')}
</head>
<body>
  ${mainHtml.content}
  ${jsFiles.map((file) => `<script>\n${file.content}\n</script>`).join('\n')}
</body>
</html>`;
}

function generateReactPreview(files: PreviewFile[], activeFileId: string | null) {
  const jsxFiles = files.filter((file) => file.type === 'jsx' || file.type === 'tsx');
  const cssFiles = files.filter((file) => file.type === 'css');
  const mainComponent =
    jsxFiles.find((file) => file.id === activeFileId) ||
    jsxFiles.find((file) => file.filename.toLowerCase().includes('app')) ||
    jsxFiles[0];

  if (!mainComponent) return '<div>No React component found</div>';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>React Preview</title>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  ${cssFiles.map((file) => `<style>\n${file.content}\n</style>`).join('\n')}
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect, useCallback } = React;
    ${jsxFiles.map((file) => file.content).join('\n\n')}
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(${mainComponent.filename.replace(/\.(jsx|tsx)$/, '')}));
  </script>
</body>
</html>`;
}

function generateNextjsPreview(files: PreviewFile[], activeFileId: string | null) {
  const jsxFiles = files.filter((file) => file.type === 'jsx' || file.type === 'tsx');
  const cssFiles = files.filter((file) => file.type === 'css');
  const pageComponent =
    jsxFiles.find((file) => file.filename.includes('pages/') || file.filename.includes('app/')) ||
    jsxFiles.find((file) => file.id === activeFileId) ||
    jsxFiles[0];

  if (!pageComponent) return '<div>No Next.js page component found</div>';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Next.js Preview</title>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  ${cssFiles.map((file) => `<style>\n${file.content}\n</style>`).join('\n')}
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect, useCallback } = React;
    const useRouter = () => ({ push: (href) => console.log('Navigate to:', href), pathname: '/', query: {} });
    const Link = ({ href, children, ...props }) =>
      React.createElement('a', { href, onClick: (e) => { e.preventDefault(); }, ...props }, children);
    const Image = ({ src, alt, width, height, ...props }) =>
      React.createElement('img', { src, alt, width, height, ...props });
    ${jsxFiles.map((file) => file.content).join('\n\n')}
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(${pageComponent.filename.replace(/\.(jsx|tsx)$/, '')}));
  </script>
</body>
</html>`;
}

function generateMarkdownPreview(files: PreviewFile[], activeFileId: string | null) {
  const mdFiles = files.filter((file) => file.type === 'md');
  const mainMd = mdFiles.find((file) => file.id === activeFileId) || mdFiles[0];
  if (!mainMd) return '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Markdown Preview</title>
  <style>
    html, body {
      background: #ffffff;
      color: #111827;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin: 0;
      padding: 24px;
      line-height: 1.6;
    }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
    pre { background: #f3f4f6; padding: 16px; border-radius: 8px; overflow-x: auto; }
  </style>
</head>
<body>
  <div id="content"></div>
  <script>
    function renderMarkdown(md) {
      return '<pre>' + md.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>';
    }
    document.getElementById('content').innerHTML = renderMarkdown(${JSON.stringify(mainMd.content)});
  </script>
</body>
</html>`;
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
  const preview = usePreviewStore((state) => state.getPreview(focusedPanelId));
  const setOpen = usePreviewStore((state) => state.setOpen);
  const setActiveFile = usePreviewStore((state) => state.setActiveFile);
  const removeFile = usePreviewStore((state) => state.removeFile);
  const setView = usePreviewStore((state) => state.setView);
  const changeset = useChangesetStore((state) => state.getChangeset(focusedPanelId));
  const getLineTotals = useChangesetStore((state) => state.getLineTotals);
  const setChangeStaged = useChangesetStore((state) => state.setChangeStaged);
  const stageAllChanges = useChangesetStore((state) => state.stageAllChanges);
  const removeChange = useChangesetStore((state) => state.removeChange);
  const clearChanges = useChangesetStore((state) => state.clearChanges);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const { isOpen, files, activeFileId, projectType, activeView } = preview;

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
  const activeFile = files.find((file) => file.id === activeFileId) || files[0] || null;

  const previewHtml = useMemo(() => {
    if (files.length === 0) return '';
    if (activeFile?.type === 'md') return generateMarkdownPreview(files, activeFileId);
    if (projectType === 'react') return generateReactPreview(files, activeFileId);
    if (projectType === 'nextjs') return generateNextjsPreview(files, activeFileId);
    return generateHtmlPreview(files, activeFileId);
  }, [activeFile, activeFileId, files, projectType]);

  if (!isOpen) return null;

  const showChangesTab = changeEntries.length > 0;
  const showPreviewTab = files.length > 0;
  const currentView = activeView === 'changes' && !showChangesTab
    ? 'preview'
    : activeView || (showChangesTab ? 'changes' : 'preview');

  return (
    <div className="shrink-0 w-[430px] max-w-[430px] h-full border-l border-border bg-background/95 backdrop-blur flex flex-col overflow-hidden">
      <div className="border-b border-border px-3 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PanelsTopLeft className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Workspace</span>
            {showChangesTab && (
              <Badge variant="outline" className="text-[10px]">
                {changeEntries.length} {changeEntries.length === 1 ? 'change' : 'changes'}
              </Badge>
            )}
          </div>
          <button
            onClick={() => setOpen(focusedPanelId, false)}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-xl border border-border/70 bg-muted/30 p-1">
          <button
            onClick={() => setView(focusedPanelId, 'changes')}
            disabled={!showChangesTab}
            className={cn(
              'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              currentView === 'changes'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              !showChangesTab && 'cursor-not-allowed opacity-40'
            )}
          >
            Changes
          </button>
          <button
            onClick={() => setView(focusedPanelId, 'preview')}
            disabled={!showPreviewTab}
            className={cn(
              'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              currentView === 'preview'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              !showPreviewTab && 'cursor-not-allowed opacity-40'
            )}
          >
            Preview
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
      ) : showPreviewTab ? (
        <>
          <div className="border-b border-border px-3 py-3">
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Live preview</span>
              <Badge variant="secondary" className="text-[10px] uppercase">
                {projectType}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {files.length} {files.length === 1 ? 'file' : 'files'}
              </Badge>
            </div>

            <div className="mt-3 space-y-1">
              {files.map((file) => {
                const IconComponent = fileTypeIcons[file.type];
                return (
                  <div
                    key={file.id}
                    onClick={() => setActiveFile(focusedPanelId, file.id)}
                    className={cn(
                      'group flex cursor-pointer items-center justify-between rounded-xl border border-border/70 px-3 py-2 transition-colors hover:bg-muted/30',
                      file.id === activeFileId && 'bg-muted/40'
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <IconComponent className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-xs">{file.filename}</span>
                      <Badge variant="outline" className={cn('h-4 px-1 text-[10px]', fileTypeColors[file.type])}>
                        {file.type}
                      </Badge>
                    </div>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        removeFile(focusedPanelId, file.id);
                      }}
                      className="rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex-1">
            {files.length === 0 ? (
              <div className="flex h-full items-center justify-center p-6">
                <div className="text-center">
                  <Eye className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" />
                  <div className="text-sm font-medium">No preview files</div>
                </div>
              </div>
            ) : (
              <iframe
                srcDoc={previewHtml}
                className="h-full w-full border-0"
                sandbox="allow-scripts allow-same-origin"
                title="HTML Preview"
              />
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="text-center">
            <PanelsTopLeft className="mx-auto mb-4 h-10 w-10 text-muted-foreground/40" />
            <div className="text-sm font-medium">No workspace items</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Stage repo changes or generate preview files to populate this panel.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
