import { create } from 'zustand';

export type ProjectType = 'html' | 'react' | 'nextjs';
export type FileType = 'html' | 'css' | 'js' | 'jsx' | 'tsx' | 'ts' | 'md';
export type PreviewSidebarView = 'preview' | 'changes';

export interface PreviewFile {
  id: string;
  filename: string;
  content: string;
  type: FileType;
  timestamp: string;
}

export interface PanelPreviewState {
  isOpen: boolean;
  files: PreviewFile[];
  activeFileId: string | null;
  projectType: ProjectType;
  activeView: PreviewSidebarView;
}

const EMPTY_PREVIEW: PanelPreviewState = {
  isOpen: false,
  files: [],
  activeFileId: null,
  projectType: 'html',
  activeView: 'preview',
};

interface PreviewState {
  panelPreviews: Record<string, PanelPreviewState>;

  setOpen: (panelId: string, open: boolean) => void;
  togglePreview: (panelId: string) => void;
  setView: (panelId: string, view: PreviewSidebarView) => void;
  addFile: (panelId: string, file: Omit<PreviewFile, 'id' | 'timestamp'>) => void;
  updateFile: (panelId: string, id: string, content: string) => void;
  removeFile: (panelId: string, id: string) => void;
  setActiveFile: (panelId: string, id: string | null) => void;
  clearFiles: (panelId: string) => void;
  resetPreview: (panelId: string) => void;
  replacePreview: (panelId: string, preview: PanelPreviewState) => void;
  getActiveFile: (panelId: string) => PreviewFile | null;
  setProjectType: (panelId: string, type: ProjectType) => void;
  getPreview: (panelId: string) => PanelPreviewState;
}

function inferProjectType(files: PreviewFile[], newFile?: Omit<PreviewFile, 'id' | 'timestamp'>): ProjectType {
  const allFiles = newFile ? [...files, newFile as PreviewFile] : files;
  
  // Check for Next.js patterns
  const hasNextPatterns = allFiles.some(f => 
    f.filename.includes('pages/') || 
    f.filename.includes('app/') || 
    f.filename === 'next.config.js' ||
    f.filename === '_app.jsx' ||
    f.filename === '_app.tsx'
  );
  
  // Check for React patterns
  const hasReactFiles = allFiles.some(f => 
    f.type === 'jsx' || f.type === 'tsx'
  );
  
  if (hasNextPatterns) return 'nextjs';
  if (hasReactFiles) return 'react';
  return 'html';
}

function getOrDefault(state: PreviewState, panelId: string): PanelPreviewState {
  return state.panelPreviews[panelId] || EMPTY_PREVIEW;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  panelPreviews: {},

  setOpen: (panelId, open) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelPreviews: {
          ...state.panelPreviews,
          [panelId]: { ...existing, isOpen: open },
        },
      };
    }),

  togglePreview: (panelId) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelPreviews: {
          ...state.panelPreviews,
          [panelId]: { ...existing, isOpen: !existing.isOpen },
        },
      };
    }),

  setView: (panelId, view) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelPreviews: {
          ...state.panelPreviews,
          [panelId]: { ...existing, activeView: view, isOpen: true },
        },
      };
    }),

  addFile: (panelId, file) => {
    const id = crypto.randomUUID();
    const newFile: PreviewFile = {
      ...file,
      id,
      timestamp: new Date().toISOString(),
    };

    set((state) => {
      const existing = getOrDefault(state, panelId);
      const updatedFiles = [...existing.files, newFile];
      const newProjectType = inferProjectType(updatedFiles);

      return {
        panelPreviews: {
          ...state.panelPreviews,
          [panelId]: {
            ...existing,
            isOpen: true,
            files: updatedFiles,
            activeFileId: id,
            projectType: newProjectType,
            activeView: 'preview',
          },
        },
      };
    });
  },

  updateFile: (panelId, id, content) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelPreviews: {
          ...state.panelPreviews,
          [panelId]: {
            ...existing,
            files: existing.files.map((file) =>
              file.id === id ? { ...file, content, timestamp: new Date().toISOString() } : file
            ),
          },
        },
      };
    }),

  removeFile: (panelId, id) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      const files = existing.files.filter((file) => file.id !== id);
      return {
        panelPreviews: {
          ...state.panelPreviews,
          [panelId]: {
            ...existing,
            files,
            activeFileId: existing.activeFileId === id ? files[0]?.id ?? null : existing.activeFileId,
            projectType: inferProjectType(files),
            isOpen: files.length > 0 ? existing.isOpen : false,
          },
        },
      };
    }),

  setActiveFile: (panelId, id) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelPreviews: {
          ...state.panelPreviews,
          [panelId]: { ...existing, activeFileId: id },
        },
      };
    }),

  clearFiles: (panelId) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelPreviews: {
          ...state.panelPreviews,
          [panelId]: {
            ...existing,
            files: [],
            activeFileId: null,
            projectType: 'html',
            isOpen: false,
            activeView: 'preview',
          },
        },
      };
    }),

  resetPreview: (panelId) =>
    set((state) => ({
      panelPreviews: {
        ...state.panelPreviews,
        [panelId]: { ...EMPTY_PREVIEW },
      },
    })),

  replacePreview: (panelId, preview) =>
    set((state) => ({
      panelPreviews: {
        ...state.panelPreviews,
        [panelId]: { ...preview },
      },
    })),

  getActiveFile: (panelId) => {
    const preview = getOrDefault(get(), panelId);
    return preview.files.find((file) => file.id === preview.activeFileId) || null;
  },

  setProjectType: (panelId, type) =>
    set((state) => {
      const existing = getOrDefault(state, panelId);
      return {
        panelPreviews: {
          ...state.panelPreviews,
          [panelId]: { ...existing, projectType: type },
        },
      };
    }),

  getPreview: (panelId) => getOrDefault(get(), panelId),
}));
