import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Save } from 'lucide-react';
import {
  HermesApiError,
  fetchHermesWorkspaceFile,
  fetchHermesWorkspaceFiles,
  updateHermesWorkspaceFile,
  type HermesWorkspaceFile,
  type HermesWorkspaceFileSummary,
} from '@/lib/hermes-api';
import { relativeTime } from '@/lib/relative-time';
import { formatBytes } from '@/components/sidebar/hermesSidebarUtils';
import { cn } from '@/lib/utils';

const DEFAULT_KEYS = ['soul', 'user', 'memory'] as const;

export function HermesMemoriesPanel() {
  const [files, setFiles] = useState<HermesWorkspaceFileSummary[]>([]);
  const [details, setDetails] = useState<Record<string, HermesWorkspaceFile>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedKey, setSelectedKey] = useState<string>('soul');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const nextFiles = await fetchHermesWorkspaceFiles();
      setFiles(nextFiles);
      setError(null);
      setSelectedKey((current) => (
        nextFiles.some((file) => file.key === current)
          ? current
          : (nextFiles[0]?.key ?? 'soul')
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Hermes files');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFile = useCallback(async (fileKey: string, options?: { preserveDraft?: boolean }) => {
    try {
      const file = await fetchHermesWorkspaceFile(fileKey);
      setDetails((current) => ({ ...current, [fileKey]: file }));
      setDrafts((current) => ({
        ...current,
        [fileKey]: options?.preserveDraft ? (current[fileKey] ?? file.content) : file.content,
      }));
      setFiles((current) => current.map((item) => item.key === fileKey ? file : item));
      setError(null);
      return file;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file');
      return null;
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedKey) return;
    if (details[selectedKey]) return;
    void loadFile(selectedKey);
  }, [details, loadFile, selectedKey]);

  const sortedFiles = useMemo(() => {
    const rank = new Map(DEFAULT_KEYS.map((key, index) => [key, index]));
    return [...files].sort((a, b) => (rank.get(a.key as typeof DEFAULT_KEYS[number]) ?? 99) - (rank.get(b.key as typeof DEFAULT_KEYS[number]) ?? 99));
  }, [files]);

  const selectedFile = details[selectedKey];
  const selectedSummary = sortedFiles.find((file) => file.key === selectedKey);
  const draft = drafts[selectedKey] ?? selectedFile?.content ?? '';
  const isDirty = !!selectedFile && draft !== selectedFile.content;

  const handleSave = async () => {
    if (!selectedFile) return;
    setSaving(true);
    setNotice(null);
    try {
      const updated = await updateHermesWorkspaceFile(selectedKey, draft, selectedFile.version);
      setDetails((current) => ({ ...current, [selectedKey]: updated }));
      setFiles((current) => current.map((file) => file.key === selectedKey ? updated : file));
      setDrafts((current) => ({ ...current, [selectedKey]: updated.content }));
      setError(null);
      setNotice(`Saved ${updated.label}`);
    } catch (err) {
      if (err instanceof HermesApiError && err.status === 409) {
        const nextFile = err.data.file as HermesWorkspaceFile | undefined;
        if (nextFile) {
          setDetails((current) => ({ ...current, [selectedKey]: nextFile }));
          setFiles((current) => current.map((file) => file.key === selectedKey ? nextFile : file));
        }
        setError('The file changed outside this panel. Latest disk version loaded; your draft is still in the editor.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to save file');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Memories</span>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/50">
            {selectedSummary?.path ?? 'Canonical Hermes files'}
          </p>
        </div>
        <button
          onClick={() => {
            void loadList();
            if (selectedKey) void loadFile(selectedKey, { preserveDraft: true });
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          title="Refresh files"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
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
                  ? 'border-[#ff8f3f]/35 bg-[#ff8f3f]/10 text-foreground'
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

      {(error || notice) && (
        <div className={cn(
          'mx-3 mb-2 rounded-xl border p-2 text-[11px]',
          error
            ? 'border-red-500/20 bg-red-500/10 text-red-300'
            : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
        )}>
          {error ?? notice}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {loading && !selectedFile ? (
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
                className="mt-3 min-h-[320px] w-full resize-none rounded-xl border border-border/40 bg-[#111111]/70 px-3 py-3 font-mono text-[11px] leading-5 text-foreground/92 outline-none transition-colors focus:border-[#ff8f3f]/35"
              />

              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="text-[10px] text-muted-foreground/45">
                  {isDirty ? 'Unsaved changes' : 'Up to date'}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDrafts((current) => ({ ...current, [selectedKey]: selectedFile.content }))}
                    disabled={!isDirty || saving}
                    className="rounded-lg px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground disabled:opacity-40"
                  >
                    Reset
                  </button>
                  <button
                    onClick={() => { void handleSave(); }}
                    disabled={!isDirty || saving}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#ff8f3f] px-2.5 py-1.5 text-[11px] font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
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
