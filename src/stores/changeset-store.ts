import { create } from 'zustand';

export interface ActiveRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  fullName: string;
}

export interface FileChange {
  path: string;
  action: 'create' | 'edit' | 'delete';
  content: string;
  originalContent?: string;
}

export interface PanelChangeset {
  activeRepo: ActiveRepo | null;
  isRepoMode: boolean;
  changes: Record<string, FileChange>;
  repoFileTree: string[];
}

const EMPTY_CHANGESET: PanelChangeset = {
  activeRepo: null,
  isRepoMode: false,
  changes: {},
  repoFileTree: [],
};

interface ChangesetState {
  /** Per-panel changesets keyed by panel ID */
  panelChangesets: Record<string, PanelChangeset>;

  // Per-panel scoped actions
  setActiveRepo: (panelId: string, repo: ActiveRepo) => void;
  clearActiveRepo: (panelId: string) => void;
  addChange: (panelId: string, change: FileChange) => void;
  removeChange: (panelId: string, path: string) => void;
  clearChanges: (panelId: string) => void;
  getChangeset: (panelId: string) => PanelChangeset;
  getChangeCount: (panelId: string) => number;
  getLineTotals: (panelId: string) => { added: number; removed: number };
  setRepoFileTree: (panelId: string, tree: string[]) => void;
  cleanupPanel: (panelId: string) => void;

  // Legacy global accessors (for components that operate on the focused panel)
  // These read/write the "default" panel for backward compat
  activeRepo: ActiveRepo | null;
  isRepoMode: boolean;
  changes: Record<string, FileChange>;
  repoFileTree: string[];
}

function getOrDefault(state: ChangesetState, panelId: string): PanelChangeset {
  return state.panelChangesets[panelId] || EMPTY_CHANGESET;
}

export const useChangesetStore = create<ChangesetState>()((set, get) => ({
  panelChangesets: {},

  // Legacy global fields — derived from 'default' panel for backward compat
  get activeRepo() { return get().panelChangesets['default']?.activeRepo ?? null; },
  get isRepoMode() { return get().panelChangesets['default']?.isRepoMode ?? false; },
  get changes() { return get().panelChangesets['default']?.changes ?? {}; },
  get repoFileTree() { return get().panelChangesets['default']?.repoFileTree ?? []; },

  setActiveRepo: (panelId, repo) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: { ...existing, activeRepo: repo, isRepoMode: true },
        },
      };
    }),

  clearActiveRepo: (panelId) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: { ...existing, activeRepo: null, isRepoMode: false, repoFileTree: [] },
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
            changes: { ...existing.changes, [change.path]: change },
          },
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

  getChangeset: (panelId) => getOrDefault(get(), panelId),

  getChangeCount: (panelId) => Object.keys(getOrDefault(get(), panelId).changes).length,

  getLineTotals: (panelId) => {
    const changes = Object.values(getOrDefault(get(), panelId).changes);
    let added = 0;
    let removed = 0;
    for (const change of changes) {
      const newLines = (change.content || '').split('\n').length;
      const oldLines = (change.originalContent || '').split('\n').length;
      if (change.action === 'create') {
        added += newLines;
      } else if (change.action === 'delete') {
        removed += oldLines;
      } else {
        added += Math.max(0, newLines - oldLines);
        removed += Math.max(0, oldLines - newLines);
      }
    }
    return { added, removed };
  },

  setRepoFileTree: (panelId, tree) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelChangesets: {
          ...state.panelChangesets,
          [panelId]: { ...existing, repoFileTree: tree },
        },
      };
    }),

  cleanupPanel: (panelId) =>
    set((state) => {
      const { [panelId]: _, ...rest } = state.panelChangesets;
      return { panelChangesets: rest };
    }),
}));
