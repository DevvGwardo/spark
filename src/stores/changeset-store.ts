import { create } from 'zustand';
import { getChangeLineDelta } from '@/lib/change-diff';
import type { PullRequestRecord } from '@/lib/pull-request';

export interface ActiveRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  fullName: string;
  permissions?: {
    pull?: boolean;
    push?: boolean;
    admin?: boolean;
  };
  baseOwner?: string;
  baseName?: string;
  baseFullName?: string;
  localPath?: string | null;
  issue?: {
    number: number;
    title: string;
    body?: string | null;
    url: string;
    state: string;
    labels: string[];
    updatedAt: string;
  } | null;
}

export type RepoFileTreeStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface FileChange {
  path: string;
  action: 'create' | 'edit' | 'delete';
  content: string;
  originalContent?: string;
  staged?: boolean;
}

export interface PanelChangeset {
  activeRepo: ActiveRepo | null;
  isRepoMode: boolean;
  pullRequest: PullRequestRecord | null;
  changes: Record<string, FileChange>;
  repoFileTree: string[];
  repoFileCache: Record<string, string>;
  selectedRepoFilePath: string | null;
  repoFileTreeStatus: RepoFileTreeStatus;
  repoFileTreeError: string | null;
}

const EMPTY_CHANGESET: PanelChangeset = {
  activeRepo: null,
  isRepoMode: false,
  pullRequest: null,
  changes: {},
  repoFileTree: [],
  repoFileCache: {},
  selectedRepoFilePath: null,
  repoFileTreeStatus: 'idle',
  repoFileTreeError: null,
};

interface ChangesetState {
  /** Per-panel changesets keyed by panel ID */
  panelChangesets: Record<string, PanelChangeset>;

  // Per-panel scoped actions
  replaceChangeset: (panelId: string, changeset: PanelChangeset) => void;
  setActiveRepo: (panelId: string, repo: ActiveRepo) => void;
  switchActiveRepo: (panelId: string, repo: ActiveRepo) => void;
  clearActiveRepo: (panelId: string) => void;
  addChange: (panelId: string, change: FileChange) => void;
  batchAddChanges: (panelId: string, changes: FileChange[]) => void;
  removeChange: (panelId: string, path: string) => void;
  clearChanges: (panelId: string) => void;
  setPullRequest: (panelId: string, pullRequest: PullRequestRecord | null) => void;
  setChangeStaged: (panelId: string, path: string, staged: boolean) => void;
  stageAllChanges: (panelId: string, staged: boolean) => void;
  getChangeset: (panelId: string) => PanelChangeset;
  getChangeCount: (panelId: string) => number;
  getStagedCount: (panelId: string) => number;
  getLineTotals: (panelId: string, filter?: 'all' | 'staged' | 'unstaged') => { added: number; removed: number };
  getStagedChanges: (panelId: string) => FileChange[];
  setRepoFileTree: (panelId: string, tree: string[]) => void;
  setRepoFileTreeStatus: (panelId: string, status: RepoFileTreeStatus, error?: string | null) => void;
  cacheRepoFile: (panelId: string, path: string, content: string) => void;
  setSelectedRepoFilePath: (panelId: string, path: string | null) => void;
  cleanupPanel: (panelId: string) => void;

  // Legacy global accessors (for components that operate on the focused panel)
  // These read/write the "default" panel for backward compat
  activeRepo: ActiveRepo | null;
  isRepoMode: boolean;
  pullRequest: PullRequestRecord | null;
  changes: Record<string, FileChange>;
  repoFileTree: string[];
  repoFileCache: Record<string, string>;
  selectedRepoFilePath: string | null;
  repoFileTreeStatus: RepoFileTreeStatus;
  repoFileTreeError: string | null;
}

function getOrDefault(state: ChangesetState, panelId: string): PanelChangeset {
  const existing = state.panelChangesets[panelId];
  if (!existing) {
    return EMPTY_CHANGESET;
  }

  if (
    existing.repoFileCache !== undefined &&
    existing.selectedRepoFilePath !== undefined &&
    existing.repoFileTreeStatus !== undefined &&
    existing.repoFileTreeError !== undefined
  ) {
    return existing;
  }

  return { ...EMPTY_CHANGESET, ...existing };
}

function cloneChangeset(changeset: PanelChangeset): PanelChangeset {
  return {
    ...EMPTY_CHANGESET,
    ...changeset,
    activeRepo: changeset.activeRepo ? { ...changeset.activeRepo } : null,
    pullRequest: changeset.pullRequest ? { ...changeset.pullRequest } : null,
    changes: Object.fromEntries(
      Object.entries(changeset.changes).map(([path, change]) => [path, { ...change }])
    ),
    repoFileTree: [...changeset.repoFileTree],
    repoFileCache: { ...changeset.repoFileCache },
  };
}

export const useChangesetStore = create<ChangesetState>()((set, get) => ({
  panelChangesets: {},

  // Legacy global fields — derived from 'default' panel for backward compat
  get activeRepo() { return get().panelChangesets['default']?.activeRepo ?? null; },
  get isRepoMode() { return get().panelChangesets['default']?.isRepoMode ?? false; },
  get pullRequest() { return get().panelChangesets['default']?.pullRequest ?? null; },
  get changes() { return get().panelChangesets['default']?.changes ?? {}; },
  get repoFileTree() { return get().panelChangesets['default']?.repoFileTree ?? []; },
  get repoFileCache() { return get().panelChangesets['default']?.repoFileCache ?? {}; },
  get selectedRepoFilePath() { return get().panelChangesets['default']?.selectedRepoFilePath ?? null; },
  get repoFileTreeStatus() { return get().panelChangesets['default']?.repoFileTreeStatus ?? 'idle'; },
  get repoFileTreeError() { return get().panelChangesets['default']?.repoFileTreeError ?? null; },

  replaceChangeset: (panelId, changeset) =>
    set((state) => ({
      panelChangesets: {
        ...state.panelChangesets,
        [panelId]: cloneChangeset(changeset),
      },
    })),

  setActiveRepo: (panelId, repo) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      const switchingRepos = !!existing.activeRepo && existing.activeRepo.fullName !== repo.fullName;
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: {
            ...existing,
            activeRepo: repo,
            isRepoMode: true,
            ...(switchingRepos
              ? {
                  pullRequest: null,
                  changes: {},
                  repoFileTree: [],
                  repoFileCache: {},
                  selectedRepoFilePath: null,
                  repoFileTreeStatus: 'idle',
                  repoFileTreeError: null,
                }
              : {}),
          },
        },
      };
    }),

  switchActiveRepo: (panelId, repo) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: {
            ...existing,
            activeRepo: repo,
            isRepoMode: true,
            pullRequest: null,
            changes: {},
            repoFileTree: [],
            repoFileCache: {},
            selectedRepoFilePath: null,
            repoFileTreeStatus: 'idle',
            repoFileTreeError: null,
          },
        },
      };
    }),

  clearActiveRepo: (panelId) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: {
            ...existing,
            activeRepo: null,
            isRepoMode: false,
            pullRequest: null,
            changes: {},
            repoFileTree: [],
            repoFileCache: {},
            selectedRepoFilePath: null,
            repoFileTreeStatus: 'idle',
            repoFileTreeError: null,
          },
        },
      };
    }),

  addChange: (panelId, change) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      const prevChange = existing.changes[change.path];
      // If deleting a file created in this session, remove entirely
      if (change.action === 'delete' && prevChange?.action === 'create') {
        const { [change.path]: _, ...rest } = existing.changes;
        return {
          panelChangesets: {
            ...state.panelChangesets,
            [panelId]: { ...existing, changes: rest },
          },
        };
      }
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: {
            ...existing,
            changes: {
              ...existing.changes,
              [change.path]: {
                ...prevChange,
                ...change,
                staged: change.staged ?? prevChange?.staged ?? false,
                originalContent: change.originalContent ?? prevChange?.originalContent,
              },
            },
          },
        },
      };
    }),

  batchAddChanges: (panelId, changes: FileChange[]) =>
    set((state) => {
      const changeset = getOrDefault(state, panelId);
      let updatedChanges = { ...changeset.changes };
      for (const change of changes) {
        const prev = updatedChanges[change.path];
        if (change.action === 'delete' && prev?.action === 'create') {
          const { [change.path]: _, ...rest } = updatedChanges;
          updatedChanges = rest;
        } else {
          updatedChanges[change.path] = {
            ...prev,
            ...change,
            staged: change.staged ?? prev?.staged ?? false,
            originalContent: change.originalContent ?? prev?.originalContent,
          };
        }
      }
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: { ...changeset, changes: updatedChanges },
        },
      };
    }),

  removeChange: (panelId, path) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      const { [path]: _, ...rest } = existing.changes;
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: { ...existing, changes: rest },
        },
      };
    }),

  clearChanges: (panelId) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: { ...existing, changes: {} },
        },
      };
    }),

  setPullRequest: (panelId, pullRequest) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: { ...existing, pullRequest },
        },
      };
    }),

  setChangeStaged: (panelId, path, staged) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      const change = existing.changes[path];
      if (!change) return state;
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: {
            ...existing,
            changes: {
              ...existing.changes,
              [path]: { ...change, staged },
            },
          },
        },
      };
    }),

  stageAllChanges: (panelId, staged) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      const changes = Object.fromEntries(
        Object.entries(existing.changes).map(([path, change]) => [path, { ...change, staged }])
      );
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: { ...existing, changes },
        },
      };
    }),

  getChangeset: (panelId) => getOrDefault(get(), panelId),

  getChangeCount: (panelId) => Object.keys(getOrDefault(get(), panelId).changes).length,

  getStagedCount: (panelId) =>
    Object.values(getOrDefault(get(), panelId).changes).filter((change) => change.staged).length,

  getLineTotals: (panelId, filter = 'all') => {
    const changes = Object.values(getOrDefault(get(), panelId).changes).filter((change) => {
      if (filter === 'staged') return !!change.staged;
      if (filter === 'unstaged') return !change.staged;
      return true;
    });
    let added = 0;
    let removed = 0;
    for (const change of changes) {
      const lineDelta = getChangeLineDelta(change);
      added += lineDelta.added;
      removed += lineDelta.removed;
    }
    return { added, removed };
  },

  getStagedChanges: (panelId) =>
    Object.values(getOrDefault(get(), panelId).changes).filter((change) => change.staged),

  setRepoFileTree: (panelId, tree) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: {
            ...existing,
            repoFileTree: tree,
            repoFileTreeStatus: 'ready',
            repoFileTreeError: null,
          },
        },
      };
    }),

  setRepoFileTreeStatus: (panelId, status, error = null) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: {
            ...existing,
            repoFileTreeStatus: status,
            repoFileTreeError: status === 'error' ? (error ?? 'Failed to index repository tree.') : null,
          },
        },
      };
    }),

  cacheRepoFile: (panelId, path, content) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: {
            ...existing,
            repoFileCache: {
              ...existing.repoFileCache,
              [path]: content,
            },
          },
        },
      };
    }),

  setSelectedRepoFilePath: (panelId, path) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: { ...existing, selectedRepoFilePath: path },
        },
      };
    }),

  cleanupPanel: (panelId) =>
    set((state) => {
      const { [panelId]: _, ...rest } = state.panelChangesets;
      return { panelChangesets: rest };
    }),
}));
