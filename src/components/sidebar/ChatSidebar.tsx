import React, { useEffect, useState, useMemo } from 'react';
import { Plus, Trash2, Settings, Columns2, Pin, MessageSquare, Bug } from 'lucide-react';
import { GhostIcon } from '@/components/chat/GhostIcon';
import { useChatStore } from '@/stores/chat-store';
import { useUIStore } from '@/stores/ui-store';
import { usePanelStore } from '@/stores/panel-store';
import { useActivityStore } from '@/stores/activity-store';
import { cn } from '@/lib/utils';
import type { Conversation } from '@/lib/db';

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

interface ConversationGroup {
  label: string;
  conversations: Conversation[];
}

function groupConversationsByDate(conversations: Conversation[]): ConversationGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOf7DaysAgo = startOfToday - 7 * 86400000;

  const pinned: Conversation[] = [];
  const today: Conversation[] = [];
  const yesterday: Conversation[] = [];
  const previous7: Conversation[] = [];
  const older: Conversation[] = [];

  for (const conv of conversations) {
    if (conv.pinned) {
      pinned.push(conv);
      continue;
    }
    const ts = new Date(conv.updatedAt || conv.createdAt).getTime();
    if (ts >= startOfToday) {
      today.push(conv);
    } else if (ts >= startOfYesterday) {
      yesterday.push(conv);
    } else if (ts >= startOf7DaysAgo) {
      previous7.push(conv);
    } else {
      older.push(conv);
    }
  }

  const groups: ConversationGroup[] = [];
  if (pinned.length > 0) groups.push({ label: 'Pinned', conversations: pinned });
  if (today.length > 0) groups.push({ label: 'Today', conversations: today });
  if (yesterday.length > 0) groups.push({ label: 'Yesterday', conversations: yesterday });
  if (previous7.length > 0) groups.push({ label: 'Previous 7 days', conversations: previous7 });
  if (older.length > 0) groups.push({ label: 'Older', conversations: older });
  return groups;
}

export const ChatSidebar: React.FC = () => {
  const {
    conversations,
    loadConversations,
    deleteConversation,
    renameConversation,
    pinConversation,
  } = useChatStore();

  const { panels, focusedPanelId, setConversationForPanel, openPanel } = usePanelStore();
  const { activeTab, setActiveTab, setSettingsOpen, setRepoBrowserOpen } = useUIStore();
  const activities = useActivityStore((s) => s.activities);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const focusedConvId = panels.find((p) => p.id === focusedPanelId)?.conversationId;

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
  const groups = useMemo(() => groupConversationsByDate(visibleConversations), [visibleConversations]);

  return (
    <div className="flex h-full flex-col bg-transparent text-foreground">
      {/* New thread button + settings shortcut */}
      <div className="flex items-center gap-2 border-b border-border/40 px-3 pb-3 pt-6">
        <button
          onClick={handleNew}
          className="group flex h-10 flex-1 items-center rounded-xl border border-border/50 bg-background/55 px-3 text-sm font-medium text-foreground transition-colors duration-200 hover:border-primary/30 hover:bg-primary/5"
        >
          <span className="overflow-hidden transition-[width,opacity,transform,margin] duration-200 ease-out w-0 -translate-x-1 opacity-0 group-hover:mr-2 group-hover:w-3.5 group-hover:translate-x-0 group-hover:opacity-100">
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
          <span className="min-w-0">
            New thread
          </span>
        </button>
        <button
          onClick={() => setRepoBrowserOpen(true)}
          className="group inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/50 bg-background/50 text-muted-foreground transition-colors duration-200 hover:bg-background/60 hover:text-foreground"
          title="Browse repo issues"
          aria-label="Browse repo issues"
        >
          <Bug className="h-4 w-4 transition-[transform,opacity] duration-300 ease-out group-hover:-rotate-6 group-hover:scale-105 opacity-80" />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="group inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/50 bg-background/50 text-muted-foreground transition-colors duration-200 hover:bg-background/60 hover:text-foreground"
          title="Settings"
          aria-label="Open settings"
        >
          <Settings className="h-4 w-4 transition-[transform,opacity] duration-500 ease-out group-hover:rotate-[360deg] group-hover:opacity-100 opacity-80" />
        </button>
      </div>

      {/* Threads section header */}
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">Threads</span>
        <span className="text-[11px] font-mono text-muted-foreground/55">{conversations.length}</span>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-background/60 mb-4">
              <MessageSquare className="h-6 w-6 text-muted-foreground/40" />
            </div>
            <p className="text-[13px] font-medium text-muted-foreground/70 mb-1">No conversations yet</p>
            <p className="text-[11px] text-muted-foreground/50 text-center">Start a new conversation using the button above</p>
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.label}>
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 px-3 pt-4 pb-1">
                  {group.label}
                </div>
                {group.conversations.map((conv) => {
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
                          ? 'border-l-2 border-l-primary/60 border border-border/60 bg-background/82 text-foreground'
                          : isInAnotherPanel
                            ? 'border-l-2 border-l-transparent bg-background/55 text-foreground/85'
                            : 'border-l-2 border-l-transparent text-foreground/75 hover:bg-background/50 hover:text-foreground'
                      )}
                    >
                      {/* Top row: title + time + actions */}
                      <div className="flex min-w-0 items-center gap-2">
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
                              <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                                <GhostIcon size={10} />
                              </span>
                            )}
                            <div
                              className={cn(
                                'shrink-0 overflow-hidden transition-[width,opacity,transform] duration-200 ease-out',
                                showPinned
                                  ? 'w-4 opacity-100'
                                  : 'w-0 translate-x-1 opacity-0 group-hover:w-4 group-hover:translate-x-0 group-hover:opacity-100'
                              )}
                            >
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void pinConversation(conv.id, !conv.pinned);
                                }}
                                className={cn(
                                  'flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors duration-200 ease-out hover:text-foreground',
                                  showPinned && 'text-foreground/75'
                                )}
                                title={conv.pinned ? 'Unpin thread' : 'Pin thread'}
                                aria-label={conv.pinned ? 'Unpin thread' : 'Pin thread'}
                              >
                                <Pin className={cn('h-3 w-3 transition-transform duration-200', showPinned ? 'fill-current' : 'group-hover:rotate-6')} />
                              </button>
                            </div>
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span
                                className="min-w-0 flex-1 truncate font-medium transition-[max-width,color] duration-200 ease-out"
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  setEditingId(conv.id);
                                  setEditTitle(conv.title);
                                }}
                              >
                                {conv.title}
                              </span>
                              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60 transition-opacity duration-200 ease-out group-hover:opacity-70">
                                {relativeTime(conv.updatedAt || conv.createdAt)}
                              </span>
                            </div>
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
                          <div className="shrink-0 overflow-hidden">
                            <div className="flex max-w-0 translate-x-2 gap-0.5 opacity-0 transition-[max-width,opacity,transform] duration-200 ease-out group-hover:max-w-20 group-hover:translate-x-0 group-hover:opacity-100">
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
                          </div>
                        )}
                      </div>

                      {/* Preview line */}
                      <div className="truncate pl-6 text-[11px] text-muted-foreground/50 leading-relaxed">
                        {conv.title}
                      </div>

                      {/* Bottom row: line stats */}
                      {hasLineStats && (
                        <div className="flex items-center gap-1 pl-6">
                          <span className="text-[10px] font-mono text-emerald-500">+{activity!.linesAdded}</span>
                          <span className="text-[10px] text-muted-foreground/40">/</span>
                          <span className="text-[10px] font-mono text-red-400">-{activity!.linesRemoved}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            {hasMore && (
              <button
                onClick={() => setShowAll(true)}
                className="mt-2 w-full rounded-lg py-2 text-[12px] text-muted-foreground transition-colors duration-100 hover:bg-background/40 hover:text-foreground"
              >
                Show more
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
