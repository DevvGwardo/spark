import React, { useEffect, useState, useRef } from 'react';
import { Plus, Trash2, Settings, Columns2, Github, Bug, BookOpen, Loader2, MoreHorizontal, Pin, Pencil, Archive, Copy, PanelRight } from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore, type AppTab } from '@/stores/ui-store';
import { usePanelStore } from '@/stores/panel-store';
import { useActivityStore } from '@/stores/activity-store';
import { cn } from '@/lib/utils';

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

const NAV_ITEMS: { id: AppTab; label: string; icon: React.ElementType }[] = [
  { id: 'github', label: 'GitHub', icon: Github },
  { id: 'analyzer', label: 'Analyzer', icon: Bug },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
];

export const ChatSidebar: React.FC = () => {
  const {
    conversations,
    loadConversations,
    deleteConversation,
    renameConversation,
    pinConversation,
  } = useChatStore();

  const { panels, focusedPanelId, setConversationForPanel, openPanel } = usePanelStore();
  const { activeTab, setActiveTab, setSettingsOpen } = useUIStore();
  const activities = useActivityStore((s) => s.activities);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Close menu on outside click
  useEffect(() => {
    if (!threadMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setThreadMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [threadMenuOpen]);

  const focusedConvId = panels.find((p) => p.id === focusedPanelId)?.conversationId;
  const focusedConv = focusedConvId ? conversations.find((c) => c.id === focusedConvId) : null;

  const handleNew = () => {
    setActiveTab('chat');
    setConversationForPanel(focusedPanelId, null);
  };

  const handleRename = async (id: string) => {
    if (editTitle.trim()) await renameConversation(id, editTitle.trim());
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    await deleteConversation(id);
    setDeleteConfirm(null);
  };

  const handleSelectConversation = (convId: string) => {
    setActiveTab('chat');
    setConversationForPanel(focusedPanelId, convId);
  };

  const displayLimit = showAll ? conversations.length : 15;
  const visibleConversations = conversations.slice(0, displayLimit);
  const hasMore = conversations.length > 15 && !showAll;

  return (
    <div className="flex flex-col h-full">
      {/* New thread button + thread menu */}
      <div className="p-3 pt-8 flex items-center gap-1">
        <button
          onClick={handleNew}
          className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium border border-border/40 hover:border-border/60 hover:bg-[hsl(var(--sidebar-hover))] transition-colors duration-100"
        >
          <Plus className="h-4 w-4" />
          New thread
        </button>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setThreadMenuOpen((v) => !v)}
            className={cn(
              'p-2 rounded-lg border transition-colors duration-100',
              threadMenuOpen
                ? 'bg-[hsl(var(--sidebar-active))] text-foreground border-border/50'
                : 'text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--sidebar-hover))] border-border/40 hover:border-border/60'
            )}
            title="Thread options"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>

          {threadMenuOpen && (
            <div className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-border bg-popover shadow-lg z-50 py-1 text-[13px]">
              {focusedConv ? (
                <>
                  {/* Pin / Unpin */}
                  <button
                    onClick={() => {
                      pinConversation(focusedConv.id, !focusedConv.pinned);
                      setThreadMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[hsl(var(--sidebar-hover))] transition-colors duration-100"
                  >
                    <Pin className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-left">{focusedConv.pinned ? 'Unpin thread' : 'Pin thread'}</span>
                  </button>

                  {/* Rename */}
                  <button
                    onClick={() => {
                      setEditingId(focusedConv.id);
                      setEditTitle(focusedConv.title);
                      setThreadMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[hsl(var(--sidebar-hover))] transition-colors duration-100"
                  >
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-left">Rename thread</span>
                  </button>

                  {/* Archive (Delete) */}
                  <button
                    onClick={() => {
                      handleDelete(focusedConv.id);
                      setThreadMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[hsl(var(--sidebar-hover))] transition-colors duration-100"
                  >
                    <Archive className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-left">Archive thread</span>
                  </button>

                  <div className="my-1 border-t border-border" />

                  {/* Copy conversation ID */}
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(focusedConv.id);
                      setThreadMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[hsl(var(--sidebar-hover))] transition-colors duration-100"
                  >
                    <Copy className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-left">Copy conversation ID</span>
                  </button>

                  {/* Open in new panel */}
                  {panels.length < 4 && (
                    <>
                      <div className="my-1 border-t border-border" />
                      <button
                        onClick={() => {
                          openPanel(focusedConv.id);
                          setThreadMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[hsl(var(--sidebar-hover))] transition-colors duration-100"
                      >
                        <PanelRight className="h-4 w-4 text-muted-foreground" />
                        <span className="flex-1 text-left">Open in new panel</span>
                      </button>
                    </>
                  )}
                </>
              ) : (
                <div className="px-3 py-2 text-muted-foreground text-center">
                  No active thread
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Nav items — GitHub, Analyzer, Knowledge */}
      <div className="px-2 pb-2">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] transition-colors duration-100 mb-1 border',
              activeTab === id
                ? 'bg-[hsl(var(--sidebar-active))] text-foreground font-medium border-border/50'
                : 'text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--sidebar-hover))] border-border/30 hover:border-border/50'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Threads section header */}
      <div className="flex items-center justify-between px-5 py-2 border-t border-[hsl(var(--sidebar-border))]">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Threads</span>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {visibleConversations.map((conv) => {
          const isFocused = activeTab === 'chat' && focusedConvId === conv.id;
          const isInAnotherPanel = !isFocused && panels.some((p) => p.conversationId === conv.id);
          const activity = activities[conv.id];
          const isProcessing = activity?.streaming;
          const hasLineStats = (activity?.linesAdded ?? 0) > 0 || (activity?.linesRemoved ?? 0) > 0;

          return (
            <div
              key={conv.id}
              onClick={() => handleSelectConversation(conv.id)}
              className={cn(
                'group flex flex-col gap-0.5 px-3 py-2 rounded-lg text-[13px] cursor-pointer mb-0.5 transition-colors duration-100',
                isFocused
                  ? 'bg-[hsl(var(--sidebar-active))] text-foreground'
                  : isInAnotherPanel
                    ? 'bg-[hsl(var(--sidebar-active))]/50 text-foreground/80'
                    : 'hover:bg-[hsl(var(--sidebar-hover))] text-foreground/70 hover:text-foreground'
              )}
            >
              {/* Top row: title + time + actions */}
              <div className="flex items-center gap-2">
                {isProcessing && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                )}
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
                    className="flex-1 bg-transparent text-[13px] focus:outline-none"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    {conv.pinned && (
                      <Pin className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                    )}
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
                    <span className="text-[11px] text-muted-foreground/60 shrink-0 tabular-nums">
                      {relativeTime(conv.updatedAt || conv.createdAt)}
                    </span>
                  </>
                )}

                {deleteConfirm === conv.id ? (
                  <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => handleDelete(conv.id)} className="text-[11px] text-destructive font-medium">
                      Delete
                    </button>
                    <button onClick={() => setDeleteConfirm(null)} className="text-[11px] text-muted-foreground">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-all duration-100 shrink-0">
                    {panels.length < 4 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openPanel(conv.id); }}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        title="Open in new panel"
                      >
                        <Columns2 className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm(conv.id); }}
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>

              {/* Bottom row: line stats */}
              {hasLineStats && (
                <div className="flex items-center gap-1 pl-0.5">
                  <span className="text-[10px] font-mono text-emerald-500">+{activity!.linesAdded}</span>
                  <span className="text-[10px] text-muted-foreground/40">/</span>
                  <span className="text-[10px] font-mono text-red-400">-{activity!.linesRemoved}</span>
                </div>
              )}
            </div>
          );
        })}

        {hasMore && (
          <button
            onClick={() => setShowAll(true)}
            className="w-full text-[12px] text-muted-foreground hover:text-foreground py-2 transition-colors duration-100"
          >
            Show more
          </button>
        )}

        {conversations.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">
            No threads yet
          </p>
        )}
      </div>

      {/* Footer — Settings only */}
      <div className="p-3 border-t border-[hsl(var(--sidebar-border))]">
        <button
          onClick={() => setSettingsOpen(true)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground border border-border/30 hover:border-border/50 hover:bg-[hsl(var(--sidebar-hover))] transition-colors duration-100"
        >
          <Settings className="h-4 w-4" />
          Settings
        </button>
      </div>
    </div>
  );
};
