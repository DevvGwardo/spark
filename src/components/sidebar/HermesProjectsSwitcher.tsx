import { useEffect, useState } from 'react';
import { FolderKanban, Link2, Loader2, Plus } from 'lucide-react';
import type { HermesProject } from '@/lib/hermes-api';
import {
  useActivateHermesProject,
  useBindHermesProjectBoard,
  useCreateHermesProject,
  useHermesProjects,
} from '@/lib/hermes-queries';
import { HermesErrorState } from '@/components/hermes/HermesErrorState';
import { cn } from '@/lib/utils';

function shortenPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

/**
 * Dense Hermes project switcher — list, activate, create (name + primary folder).
 * Mounted in the System ops sidebar card.
 */
export function HermesProjectsSwitcher() {
  const projectsQuery = useHermesProjects();
  const projects = projectsQuery.data?.projects ?? [];
  const activeSlug = projectsQuery.data?.active_slug ?? null;
  const activateMutation = useActivateHermesProject();
  const createMutation = useCreateHermesProject();
  const bindMutation = useBindHermesProjectBoard();
  const [busy, setBusy] = useState<string | null>(null);
  /** Action failures (or a client-side validation message). */
  const [actionError, setActionError] = useState<unknown>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPrimary, setNewPrimary] = useState('');
  const [boardSlug, setBoardSlug] = useState('');
  const error = actionError ?? projectsQuery.error;

  const activeProject = projects.find(
    (p) => p.active || p.slug === activeSlug || p.id === activeSlug,
  );

  useEffect(() => {
    setBoardSlug(activeProject?.board_slug ?? '');
  }, [activeProject?.board_slug, activeProject?.slug]);

  const onUse = async (project: HermesProject) => {
    const ref = project.slug || project.id;
    if (!ref) return;
    setBusy(ref);
    setActionError(null);
    try {
      await activateMutation.mutateAsync(ref);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setActionError('Project name required');
      return;
    }
    setBusy('create');
    setActionError(null);
    try {
      await createMutation.mutateAsync({
        name,
        primary_folder: newPrimary.trim() || undefined,
        use: true,
      });
      setNewName('');
      setNewPrimary('');
      setCreateOpen(false);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  };

  const onBindBoard = async () => {
    const ref = activeProject?.slug || activeProject?.id || activeSlug;
    if (!ref) {
      setActionError('Select a project first');
      return;
    }
    setBusy('bind-board');
    setActionError(null);
    try {
      const res = await bindMutation.mutateAsync({
        project: ref,
        board: boardSlug.trim() || undefined,
      });
      const updated = (res.projects || []).find((p) => p.slug === ref || p.id === ref);
      setBoardSlug(updated?.board_slug ?? boardSlug.trim());
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  };

  if (projectsQuery.isPending) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/40 bg-background/40 px-2.5 py-2 text-[11px] text-muted-foreground/60">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading projects…
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border/40 bg-background/40">
      <div className="flex items-center justify-between gap-2 p-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/45">
            <FolderKanban className="h-3 w-3 shrink-0" />
            Projects
          </div>
          <p className="mt-1 truncate text-[11px] text-muted-foreground/70">
            {activeSlug ? `Active: ${activeSlug}` : 'No active project'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          title="Create project"
        >
          <Plus className="h-3 w-3" />
          New
        </button>
      </div>

      <HermesErrorState
        error={error}
        onRetry={() => { setActionError(null); void projectsQuery.refetch(); }}
        fallbackMessage="Failed to load projects"
        variant="inline"
        className="mx-2.5 mb-2"
      />

      {createOpen && (
        <div className="space-y-1.5 border-t border-border/30 px-2.5 py-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Project name"
            className="w-full rounded-md border border-border/40 bg-background/60 px-2 py-1.5 text-[11px] outline-none focus:border-primary/30"
          />
          <input
            value={newPrimary}
            onChange={(e) => setNewPrimary(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onCreate();
            }}
            placeholder="Primary folder (absolute path)"
            className="w-full rounded-md border border-border/40 bg-background/60 px-2 py-1.5 font-mono text-[10px] outline-none focus:border-primary/30"
          />
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={busy === 'create' || !newName.trim()}
            className="rounded-md border border-border/40 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {busy === 'create' ? 'Creating…' : 'Create & use'}
          </button>
        </div>
      )}

      {activeSlug && (
        <div className="space-y-1 border-t border-border/30 px-2.5 py-2">
          <div className="flex items-center gap-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/45">
            <Link2 className="h-3 w-3 shrink-0" />
            Kanban board
          </div>
          <div className="flex gap-1">
            <input
              value={boardSlug}
              onChange={(e) => setBoardSlug(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onBindBoard();
              }}
              placeholder="board slug (empty = unbind)"
              className="min-w-0 flex-1 rounded-md border border-border/40 bg-background/60 px-2 py-1 font-mono text-[10px] outline-none focus:border-primary/30"
            />
            <button
              type="button"
              onClick={() => void onBindBoard()}
              disabled={busy === 'bind-board'}
              className="shrink-0 rounded-md border border-border/40 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {busy === 'bind-board' ? '…' : 'Bind'}
            </button>
          </div>
          <p className="text-[9px] text-muted-foreground/50">
            Active project <span className="font-mono">{activeSlug}</span>
            {activeProject?.board_slug ? (
              <> · bound to <span className="font-mono">{activeProject.board_slug}</span></>
            ) : (
              <> · no board bound</>
            )}
          </p>
        </div>
      )}

      {projects.length > 0 ? (
        <ul className="max-h-40 space-y-0.5 overflow-auto border-t border-border/30 px-1.5 py-1.5">
          {projects.map((p) => {
            const ref = p.slug || p.id || p.name;
            const isActive = p.active || p.slug === activeSlug;
            const primary =
              p.primary_path ||
              p.folders?.find((f) => f.is_primary)?.path ||
              p.folders?.[0]?.path;
            return (
              <li key={ref}>
                <button
                  type="button"
                  onClick={() => void onUse(p)}
                  disabled={busy === ref || isActive}
                  className={cn(
                    'flex w-full items-start justify-between gap-2 rounded px-1.5 py-1 text-left transition-colors',
                    isActive
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground/80 hover:bg-background/60 hover:text-foreground',
                    (busy === ref || isActive) && 'disabled:opacity-70',
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-medium">
                      {isActive ? '● ' : ''}
                      {p.name}
                      {p.archived ? (
                        <span className="text-muted-foreground/50"> · archived</span>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-[9px] text-muted-foreground/50">
                      {p.slug}
                      {p.board_slug ? ` · board:${p.board_slug}` : ''}
                      {primary ? ` · ${shortenPath(primary)}` : ''}
                    </div>
                  </div>
                  {!isActive && (
                    <span className="shrink-0 text-[9px] text-muted-foreground/45">
                      {busy === ref ? '…' : 'use'}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="border-t border-border/30 px-2.5 py-2 text-[10px] text-muted-foreground/55">
          No projects yet — create one to group multi-folder workspaces.
        </p>
      )}
    </div>
  );
}
