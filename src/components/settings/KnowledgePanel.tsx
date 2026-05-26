import React, { useState, useRef } from 'react';
import { Trash2, FileText, StickyNote, Upload, X } from 'lucide-react';
import { useKnowledgeStore, type KnowledgeEntry } from '@/stores/knowledge-store';
import { cn } from '@/lib/utils';

export const KnowledgePanel: React.FC = () => {
  const { entries, addEntry, removeEntry, toggleEntry, updateEntry, getTotalSize } = useKnowledgeStore();
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const totalMB = (getTotalSize() / 1024 / 1024).toFixed(2);
  const maxMB = 4;

  const handleAddNote = () => {
    if (!newTitle.trim() || !newContent.trim()) return;
    try {
      addEntry({ title: newTitle.trim(), content: newContent.trim(), type: 'note', enabled: true });
      setNewTitle('');
      setNewContent('');
      setIsAdding(false);
      setError('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const maxFileSize = 2 * 1024 * 1024; // 2MB per file
    if (file.size > maxFileSize) {
      setError('File too large (max 2MB per file).');
      return;
    }

    try {
      const text = await file.text();
      addEntry({
        title: file.name,
        content: text,
        type: 'file',
        enabled: true,
      });
      setError('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }

    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h3 className="text-sm font-semibold">Knowledge Base</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Add context that gets included with every message. Stored locally on your device.
        </p>
      </div>

      {/* Storage indicator */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>Local storage used</span>
          <span className="font-mono">{totalMB} / {maxMB} MB</span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              parseFloat(totalMB) / maxMB > 0.9 ? 'bg-destructive' :
              parseFloat(totalMB) / maxMB > 0.7 ? 'bg-amber-500' :
              'bg-foreground/30'
            )}
            style={{ width: `${Math.min((parseFloat(totalMB) / maxMB) * 100, 100)}%` }}
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Entry list */}
      <div className="space-y-2">
        {entries.length === 0 && !isAdding && (
          <div className="text-center py-8 text-muted-foreground">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No knowledge entries yet</p>
            <p className="text-xs mt-1">Add notes or upload text files to give the AI more context.</p>
          </div>
        )}

        {entries.map((entry) => (
          <KnowledgeEntryCard
            key={entry.id}
            entry={entry}
            onToggle={() => toggleEntry(entry.id)}
            onRemove={() => removeEntry(entry.id)}
            onUpdate={(fields) => updateEntry(entry.id, fields)}
          />
        ))}
      </div>

      {/* Add form */}
      {isAdding && (
        <div className="space-y-2 border border-border rounded-xl p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">New Note</span>
            <button onClick={() => { setIsAdding(false); setNewTitle(''); setNewContent(''); }} className="p-1 rounded hover:bg-secondary text-muted-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Title (e.g. 'My coding preferences')"
            className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="Add your context here... (e.g. 'I prefer TypeScript with functional components')"
            rows={4}
            className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={handleAddNote}
            disabled={!newTitle.trim() || !newContent.trim()}
            className={cn(
              "w-full py-2 rounded-lg text-sm font-medium transition-colors duration-100",
              newTitle.trim() && newContent.trim()
                ? "bg-foreground text-background hover:opacity-90"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            )}
          >
            Save Note
          </button>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={() => setIsAdding(true)}
          className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors duration-100"
        >
          <StickyNote className="h-3.5 w-3.5" />
          Add Note
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors duration-100"
        >
          <Upload className="h-3.5 w-3.5" />
          Upload File
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.csv,.json,.xml,.yaml,.yml,.log,.py,.js,.ts,.tsx,.jsx,.html,.css"
          onChange={handleFileUpload}
          className="hidden"
        />
      </div>

      <p className="text-[11px] text-muted-foreground">
        Accepts text-based files (.txt, .md, .json, .csv, code files). Max 2MB per file.
      </p>
    </div>
  );
};

const KnowledgeEntryCard: React.FC<{
  entry: KnowledgeEntry;
  onToggle: () => void;
  onRemove: () => void;
  onUpdate: (fields: Partial<KnowledgeEntry>) => void;
}> = ({ entry, onToggle, onRemove }) => {
  const sizeKB = (new Blob([entry.content]).size / 1024).toFixed(1);

  return (
    <div className={cn(
      "flex items-start gap-3 border border-border rounded-xl px-3 py-2.5 transition-opacity duration-200",
      !entry.enabled && "opacity-50"
    )}>
      <button
        onClick={onToggle}
        className={cn(
          "mt-0.5 h-4 w-4 rounded border shrink-0 flex items-center justify-center transition-colors duration-100",
          entry.enabled
            ? "bg-foreground border-foreground text-background"
            : "border-input bg-background"
        )}
      >
        {entry.enabled && (
          <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {entry.type === 'file' ? (
            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <StickyNote className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-medium truncate">{entry.title}</span>
          <span className="text-[10px] font-mono text-muted-foreground shrink-0">{sizeKB}KB</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{entry.content}</p>
      </div>

      <button
        onClick={onRemove}
        className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors duration-100 shrink-0"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
