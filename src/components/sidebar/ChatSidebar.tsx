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
    <div className="flex h-full flex-col bg-transparent text-foreground">
      {/* New thread button + thread menu */}
      <div className="flex items-center gap-2 border-b border-border/40 px-3 pb-3 pt-6">
        <button
          onClick={handleNew}
          className="flex h-10 flex-1 items-center gap-2 rounded-xl border border-border/50 bg-background/55 px-3 text-sm font-medium text-foreground transition-colors duration-100 hover:bg-background/75"
        >
          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          New thread
        </button>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setThreadMenuOpen((v) => !v)}
            className={cn(
              'inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/50 bg-background/50 transition-colors duration-100',
              threadMenuOpen
                ? 'bg-background/70 text-foreground'
                : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
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
      <div className="px-3 py-3">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              'mb-1 flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[13px] transition-colors duration-100',
              activeTab === id
                ? 'bg-background/80 text-foreground'
                : 'text-muted-foreground hover:bg-background/55 hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4 text-muted-foreground" />
            {label}
          </button>
        ))}
      </div>

      {/* Threads section header */}
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">Threads</span>
        <span className="text-[11px] font-mono text-muted-foreground/55">{conversations.length}</span>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {visibleConversations.map((conv) => {
          const isFocused = activeTab === 'chat' && focusedConvId === conv.id;
          const isInAnotherPanel = !isFocused && panels.some((p) => p.conversationId === conv.id);
          const activity = activities[conv.id];
          const isProcessing = activity?.streaming;
          const hasLineStats = (activity?.linesAdded ?? 0) > 0 || (activity?.linesRemoved ?? 0) > 0;
          const showPinned = !!conv.pinned;

          return (
            <div
              key={conv.id}
              onClick={() => handleSelectConversation(conv.id)}
              className={cn(
                'group mb-1 flex cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2.5 text-[13px] transition-colors duration-100',
                isFocused
                  ? 'border border-border/60 bg-background/82 text-foreground'
                  : isInAnotherPanel
                    ? 'bg-background/55 text-foreground/85'
                    : 'text-foreground/75 hover:bg-background/50 hover:text-foreground'
              )}
            >
              {/* Top row: title + time + actions */}
              <div className="flex items-center gap-2">
                {editingId === conv.id ? (
                  <>
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
                  </>
                ) : (
                  <>
                    {isProcessing && (
                      <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
                        <Loader2 className="h-3 w-3 animate-spin text-primary" />
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void pinConversation(conv.id, !conv.pinned);
                      }}
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm transition-all duration-200 ease-out',
                        showPinned
                          ? 'text-foreground/75'
                          : 'text-muted-foreground/50 opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100 hover:text-foreground'
                      )}
                      title={conv.pinned ? 'Unpin thread' : 'Pin thread'}
                      aria-label={conv.pinned ? 'Unpin thread' : 'Pin thread'}
                    >
                      <Pin className={cn('h-3 w-3 transition-transform duration-200', showPinned ? 'fill-current' : 'group-hover:rotate-6')} />
                    </button>
                    <span
                      className="flex-1 truncate font-medium transition-transform duration-200 ease-out"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(conv.id);
                        setEditTitle(conv.title);
                      }}
                    >
                      {conv.title}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
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
                  <div className="flex shrink-0 gap-0.5 opacity-0 transition-all duration-100 group-hover:opacity-100">
                    {panels.length < 4 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openPanel(conv.id); }}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                        title="Open in new panel"
                      >
                        <Columns2 className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm(conv.id); }}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-destructive"
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
            className="mt-2 w-full rounded-lg py-2 text-[12px] text-muted-foreground transition-colors duration-100 hover:bg-background/40 hover:text-foreground"
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
      <div className="border-t border-border/40 px-3 py-3">
        <button
          onClick={() => setSettingsOpen(true)}
          className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-sm text-muted-foreground transition-colors duration-100 hover:bg-background/50 hover:text-foreground"
        >
          <Settings className="h-4 w-4 text-muted-foreground" />
          Settings
        </button>
      </div>
    </div>
  );
};
