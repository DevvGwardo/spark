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

interface ChangesetState {
  activeRepo: ActiveRepo | null;
  isRepoMode: boolean;
  changes: Record<string, FileChange>;

  setActiveRepo: (repo: ActiveRepo) => void;
  clearActiveRepo: () => void;
  addChange: (change: FileChange) => void;
  removeChange: (path: string) => void;
  clearChanges: () => void;
  getChangeCount: () => number;
}

export const useChangesetStore = create<ChangesetState>()((set, get) => ({
  activeRepo: null,
  isRepoMode: false,
  changes: {},

  setActiveRepo: (repo) => set({ activeRepo: repo, isRepoMode: true }),
  clearActiveRepo: () => set({ activeRepo: null, isRepoMode: false }),
  addChange: (change) =>
    set((state) => ({
      changes: { ...state.changes, [change.path]: change },
    })),
  removeChange: (path) =>
    set((state) => {
      const { [path]: _, ...rest } = state.changes;
      return { changes: rest };
    }),
  clearChanges: () => set({ changes: {} }),
  getChangeCount: () => Object.keys(get().changes).length,
}));
