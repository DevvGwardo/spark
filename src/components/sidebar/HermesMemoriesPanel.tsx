import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, RefreshCw, Save } from 'lucide-react';
import { HermesApiError, fetchHermesWorkspaceFile } from '@/lib/hermes-api';
import {
  hermesKeys,
  useActiveHermesProfile,
  useHermesWorkspaceFile,
  useHermesWorkspaceFiles,
  useMemoryStatus,
  useUpdateWorkspaceFile,
} from '@/lib/hermes-queries';
import { HermesErrorState } from '@/components/hermes/HermesErrorState';
import { toHermesError } from '@/lib/hermes-errors';
import { relativeTime } from '@/lib/relative-time';
import { formatBytes, memoriesToMarkdown } from '@/components/sidebar/hermesSidebarUtils';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { JourneyPanel } from './JourneyPanel';

const DEFAULT_KEYS = ['soul', 'user', 'memory'] as const;

type MemoryTab = 'files' | 'journey';

const MEMORY_TABS: Array<{ key: MemoryTab; label: string }> = [
  { key: 'files', label: 'Files' },
  { key: 'journey', label: 'Journey' },
];

/** Shared Files/Journey switcher — both tab bodies render the same control. */
function MemoryTabBar({ tab, onChange }: { tab: MemoryTab; onChange: (tab: MemoryTab) => void }) {
  return (
    <div className="flex items-center gap-1 border-b border-border/30 px-3 py-1.5">
      {MEMORY_TABS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-current={tab === key ? 'page' : undefined}
          className={cn(
            'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
            tab === key
              ? 'bg-[hsl(var(--sidebar-active))] text-foreground'
              : 'text-muted-foreground/60 hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function HermesMemoriesPanel() {
  const [tab, setTab] = useState<MemoryTab>('files');
  const qc = useQueryClient();
  const profile = useActiveHermesProfile();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [requestedKey, setSelectedKey] = useState<string>('soul');
  const [exporting, setExporting] = useState(false);
  /** Action failures (save/export); query failures come from the queries. */
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const filesQuery = useHermesWorkspaceFiles();
  const files = useMemo(() => filesQuery.data ?? [], [filesQuery.data]);
  // Fall back to the first file when the requested one isn't in the list.
  const selectedKey = files.length === 0 || files.some((file) => file.key === requestedKey)
    ? requestedKey
    : files[0].key;
  const fileQuery = useHermesWorkspaceFile(selectedKey);
  const saveMutation = useUpdateWorkspaceFile();
  const memoryStatus = useMemoryStatus().data;
  const providerLine = memoryStatus
    ? memoryStatus.provider
      ? `External provider: ${memoryStatus.provider}${memoryStatus.plugin_available === false ? ' (unavailable)' : ''}`
      : 'Built-in MEMORY.md / USER.md'
    : null;
  const loading = filesQuery.isFetching || fileQuery.isFetching;
  const saving = saveMutation.isPending;
  const error = actionError ?? fileQuery.error ?? filesQuery.error;

  const sortedFiles = useMemo(() => {
    const rank = new Map(DEFAULT_KEYS.map((key, index) => [key, index]));
    return [...files].sort((a, b) => (rank.get(a.key as typeof DEFAULT_KEYS[number]) ?? 99) - (rank.get(b.key as typeof DEFAULT_KEYS[number]) ?? 99));
  }, [files]);

  const selectedFile = fileQuery.data;
  const selectedSummary = sortedFiles.find((file) => file.key === selectedKey);
  // An untouched file follows the server copy; only edits are held locally.
  const draft = drafts[selectedKey] ?? selectedFile?.content ?? '';
  const isDirty = !!selectedFile && draft !== selectedFile.content;

  const handleRefresh = () => {
    setActionError(null);
    void filesQuery.refetch();
    void fileQuery.refetch();
  };

  const handleSave = async () => {
    if (!selectedFile) return;
    setNotice(null);
    setActionError(null);
    try {
      const updated = await saveMutation.mutateAsync({
        fileKey: selectedKey,
        content: draft,
        version: selectedFile.version,
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[selectedKey];
        return next;
      });
      setNotice(`Saved ${updated.label}`);
    } catch (err) {
      // On 409 the mutation already loaded the latest disk version.
      setActionError(
        err instanceof HermesApiError && err.status === 409
          ? 'The file changed outside this panel. Latest disk version loaded; your draft is still in the editor.'
          : err,
      );
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setNotice(null);
    try {
      // Pull each file's content (use already-loaded detail where available)
      // without mutating editor drafts.
      const loaded = await Promise.all(
        sortedFiles.map((file) => qc.ensureQueryData({
          queryKey: hermesKeys.file(profile, file.key),
          queryFn: () => fetchHermesWorkspaceFile(file.key),
        })),
      );
      const markdown = memoriesToMarkdown(loaded);
      const blob = new Blob([markdown], { type: 'text/markdown' });
      const filename = 'hermes-memories.md';

      if (window.electronAPI?.saveFile) {
        const content = await blob.text();
        const result = await window.electronAPI.saveFile(filename, content);
        if (result.saved) {
          toast.success(`Exported to ${result.path}`);
        } else if (result.error) {
          toast.error(`Export failed: ${result.error}`);
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      toast.error(toHermesError(err, 'Failed to export memories').message);
    } finally {
      setExporting(false);
    }
  };

  if (tab === 'journey') {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <MemoryTabBar tab={tab} onChange={setTab} />
        <JourneyPanel />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <MemoryTabBar tab={tab} onChange={setTab} />
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Memories</span>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/50">
            {providerLine || selectedSummary?.path || 'Canonical Hermes files'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { void handleExport(); }}
            disabled={exporting || files.length === 0}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground disabled:opacity-40"
            title="Export memories as Markdown"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={handleRefresh}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
            title="Refresh files"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="grid grid-cols-3 gap-1">
          {sortedFiles.map((file) => (
            <button
              key={file.key}
              onClick={() => {
                setSelectedKey(file.key);
                setNotice(null);
              }}
              className={cn(
                'rounded-lg border px-2 py-2 text-left transition-colors',
                selectedKey === file.key
                  ? 'border-primary/35 bg-primary/10 text-foreground'
                  : 'border-border/30 bg-background/30 text-muted-foreground/70 hover:bg-[hsl(var(--sidebar-active))]'
              )}
            >
              <div className="text-[11px] font-medium">{file.label.replace('.md', '')}</div>
              <div className="mt-0.5 text-[9px] uppercase tracking-[0.16em] text-muted-foreground/45">
                {file.modified_at ? relativeTime(file.modified_at) : 'Missing'}
              </div>
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <HermesErrorState
          error={error}
          onRetry={handleRefresh}
          fallbackMessage="Failed to load Hermes files"
          className="mx-3 mb-2"
        />
      ) : notice ? (
        <div role="status" className="mx-3 mb-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-2 text-[11px] text-emerald-300">
          {notice}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {(filesQuery.isPending || fileQuery.isPending) && !selectedFile && !error ? (
          <div className="flex items-center justify-center py-8 text-[12px] text-muted-foreground/60">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading file...
          </div>
        ) : selectedFile ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-border/40 bg-background/40 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[12px] font-medium text-foreground">{selectedFile.label}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/50">{selectedFile.description}</p>
                </div>
                <div className="text-right text-[10px] text-muted-foreground/45">
                  <div>{formatBytes(selectedFile.size)}</div>
                  <div>{selectedFile.modified_at ? relativeTime(selectedFile.modified_at) : 'Missing'}</div>
                </div>
              </div>

              <textarea
                value={draft}
                onChange={(event) => {
                  setDrafts((current) => ({ ...current, [selectedKey]: event.target.value }));
                  setNotice(null);
                }}
                spellCheck={false}
                className="mt-3 min-h-[320px] w-full resize-none rounded-xl border border-border/40 bg-[#111111]/70 px-3 py-3 font-mono text-[11px] leading-5 text-foreground/92 outline-none transition-colors focus:border-primary/35"
              />

              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="text-[10px] text-muted-foreground/45">
                  {isDirty ? 'Unsaved changes' : 'Up to date'}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDrafts((current) => {
                      const next = { ...current };
                      delete next[selectedKey];
                      return next;
                    })}
                    disabled={!isDirty || saving}
                    className="rounded-lg px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground disabled:opacity-40"
                  >
                    Reset
                  </button>
                  <button
                    onClick={() => { void handleSave(); }}
                    disabled={!isDirty || saving}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-border/30 bg-background/30 p-4 text-[12px] text-muted-foreground/55">
            Select a Hermes file to inspect.
          </div>
        )}
      </div>
    </div>
  );
}
