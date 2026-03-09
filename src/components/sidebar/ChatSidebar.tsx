import React, { useEffect, useState } from 'react';
import { Plus, Search, Trash2, Settings, Moon, Sun, Monitor } from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';
import { getProviderLabel } from '@/lib/providers';
import { cn } from '@/lib/utils';

export const ChatSidebar: React.FC = () => {
  const {
    conversations,
    activeConversationId,
    loadConversations,
    selectConversation,
    deleteConversation,
    renameConversation,
    clearActiveConversation,
    searchQuery,
    setSearchQuery,
  } = useChatStore();

  const { activeProvider, theme, setTheme } = useSettingsStore();
  const { setSettingsOpen } = useUIStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const filtered = conversations.filter((c) =>
    !searchQuery || c.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleNew = () => clearActiveConversation();

  const handleRename = async (id: string) => {
    if (editTitle.trim()) await renameConversation(id, editTitle.trim());
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    await deleteConversation(id);
    setDeleteConfirm(null);
  };

  const themeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const ThemeIcon = themeIcon;
  const nextTheme = () => {
    const order: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
    const idx = order.indexOf(theme);
    setTheme(order[(idx + 1) % 3]);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-[hsl(var(--sidebar-border))]">
        <button
          onClick={handleNew}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium hover:bg-[hsl(var(--sidebar-hover))] transition-colors duration-100"
        >
          <Plus className="h-4 w-4" />
          New conversation
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
            className="w-full pl-9 pr-3 py-2 text-xs rounded-md bg-background border border-input focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {filtered.map((conv) => (
          <div
            key={conv.id}
            onClick={() => selectConversation(conv.id)}
            className={cn(
              'group flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer mb-0.5 transition-colors duration-100',
              activeConversationId === conv.id
                ? 'bg-[hsl(var(--sidebar-active))] text-foreground'
                : 'hover:bg-[hsl(var(--sidebar-hover))] text-muted-foreground'
            )}
          >
            {editingId === conv.id ? (
              <input
                autoFocus
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={() => handleRename(conv.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename(conv.id);
                  if (e.key === 'Escape') setEditingId(null);
                }}
                className="flex-1 bg-transparent text-sm focus:outline-none"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="flex-1 truncate"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingId(conv.id);
                  setEditTitle(conv.title);
                }}
              >
                {conv.title}
              </span>
            )}

            {deleteConfirm === conv.id ? (
              <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => handleDelete(conv.id)} className="text-xs text-destructive font-medium">
                  Delete
                </button>
                <button onClick={() => setDeleteConfirm(null)} className="text-xs text-muted-foreground">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setDeleteConfirm(conv.id); }}
                className="p-1 opacity-0 group-hover:opacity-100 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-all duration-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}

        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">
            {searchQuery ? 'No conversations found' : 'No conversations yet'}
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-[hsl(var(--sidebar-border))] flex items-center gap-2">
        <button
          onClick={nextTheme}
          className="p-2 rounded-md hover:bg-[hsl(var(--sidebar-hover))] transition-colors duration-100 text-muted-foreground hover:text-foreground"
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="h-4 w-4" />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="p-2 rounded-md hover:bg-[hsl(var(--sidebar-hover))] transition-colors duration-100 text-muted-foreground hover:text-foreground"
          title="Settings"
        >
          <Settings className="h-4 w-4" />
        </button>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground font-mono">
          {getProviderLabel(activeProvider)}
        </span>
      </div>
    </div>
  );
};
