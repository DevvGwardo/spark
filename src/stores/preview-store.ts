import { create } from 'zustand';

export type ProjectType = 'html' | 'react' | 'nextjs';
export type FileType = 'html' | 'css' | 'js' | 'jsx' | 'tsx' | 'ts';

export interface PreviewFile {
  id: string;
  filename: string;
  content: string;
  type: FileType;
  timestamp: string;
}

interface PreviewState {
  isOpen: boolean;
  files: PreviewFile[];
  activeFileId: string | null;
  projectType: ProjectType;
  
  // Actions
  setOpen: (open: boolean) => void;
  togglePreview: () => void;
  addFile: (file: Omit<PreviewFile, 'id' | 'timestamp'>) => void;
  updateFile: (id: string, content: string) => void;
  removeFile: (id: string) => void;
  setActiveFile: (id: string | null) => void;
  clearFiles: () => void;
  getActiveFile: () => PreviewFile | null;
  setProjectType: (type: ProjectType) => void;
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

export const usePreviewStore = create<PreviewState>((set, get) => ({
  isOpen: false,
  files: [],
  activeFileId: null,
  projectType: 'html',
  
  setOpen: (open) => set({ isOpen: open }),
  
  togglePreview: () => set((state) => ({ isOpen: !state.isOpen })),
  
  addFile: (file) => {
    const id = crypto.randomUUID();
    const newFile: PreviewFile = {
      ...file,
      id,
      timestamp: new Date().toISOString(),
    };
    
    set((state) => {
      const updatedFiles = [...state.files, newFile];
      const newProjectType = inferProjectType(updatedFiles);
      
      return {
        files: updatedFiles,
        activeFileId: id,
        projectType: newProjectType,
      };
    });
  },
  
  updateFile: (id, content) => set((state) => ({
    files: state.files.map((file) =>
      file.id === id ? { ...file, content, timestamp: new Date().toISOString() } : file
    ),
  })),
  
  removeFile: (id) => set((state) => ({
    files: state.files.filter((file) => file.id !== id),
    activeFileId: state.activeFileId === id ? null : state.activeFileId,
  })),
  
  setActiveFile: (id) => set({ activeFileId: id }),
  
  clearFiles: () => set({ files: [], activeFileId: null }),
  
  getActiveFile: () => {
    const { files, activeFileId } = get();
    return files.find((file) => file.id === activeFileId) || null;
  },

  setProjectType: (type) => set({ projectType: type }),
}));