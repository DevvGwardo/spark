import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  type: 'note' | 'file';
  enabled: boolean;
  createdAt: string;
}

interface KnowledgeState {
  entries: KnowledgeEntry[];
  addEntry: (entry: Omit<KnowledgeEntry, 'id' | 'createdAt'>) => void;
  removeEntry: (id: string) => void;
  toggleEntry: (id: string) => void;
  updateEntry: (id: string, fields: Partial<KnowledgeEntry>) => void;
  getActiveContext: () => string;
  getTotalSize: () => number;
}

const MAX_STORAGE_BYTES = 4 * 1024 * 1024; // 4MB safe limit for localStorage

export const useKnowledgeStore = create<KnowledgeState>()(
  persist(
    (set, get) => ({
      entries: [],

      addEntry: (entry) => {
        const newEntry: KnowledgeEntry = {
          ...entry,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        // Check size limit
        const current = get().getTotalSize();
        const newSize = new Blob([newEntry.content]).size;
        if (current + newSize > MAX_STORAGE_BYTES) {
          throw new Error(`Storage limit reached (${(MAX_STORAGE_BYTES / 1024 / 1024).toFixed(0)}MB). Remove some entries first.`);
        }
        set((state) => ({ entries: [...state.entries, newEntry] }));
      },

      removeEntry: (id) =>
        set((state) => ({ entries: state.entries.filter((e) => e.id !== id) })),

      toggleEntry: (id) =>
        set((state) => ({
          entries: state.entries.map((e) =>
            e.id === id ? { ...e, enabled: !e.enabled } : e
          ),
        })),

      updateEntry: (id, fields) =>
        set((state) => ({
          entries: state.entries.map((e) =>
            e.id === id ? { ...e, ...fields } : e
          ),
        })),

      getActiveContext: () => {
        const entries = get().entries.filter((e) => e.enabled);
        if (entries.length === 0) return '';
        return entries
          .map((e) => `[${e.title}]\n${e.content}`)
          .join('\n\n---\n\n');
      },

      getTotalSize: () => {
        const entries = get().entries;
        return new Blob(entries.map((e) => e.content)).size;
      },
    }),
    {
      name: 'cloudchat-knowledge',
      version: 1,
    }
  )
);
