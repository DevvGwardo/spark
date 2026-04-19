import React, { useEffect, useState, useMemo } from 'react';
import { Plus, Trash2, Settings, Columns2, Pin, MessageSquare, Lock, Circle, GitFork, Search, ChevronRight, Zap, Clock, House, BookOpen, Sparkles, BarChart3, User } from 'lucide-react';
import { Github } from 'lucide-react';
import { GhostIcon } from '@/components/chat/GhostIcon';
import { useChatStore } from '@/stores/chat-store';
import { useUIStore } from '@/stores/ui-store';
import { usePanelStore } from '@/stores/panel-store';
import { useActivityStore } from '@/stores/activity-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { useSettingsStore } from '@/stores/settings-store';
import { getChatScopeId } from '@/lib/chat-scope';
import { getRepoAccessLabel } from '@/lib/repo-access';
import { cn } from '@/lib/utils';
import { SlotNumber } from '@/components/ui/SlotNumber';
import { CronJobsPanel } from '@/components/sidebar/CronJobsPanel';
import { HermesChatsPanel } from '@/components/sidebar/HermesChatsPanel';
import { HermesOverviewPanel } from '@/components/sidebar/HermesOverviewPanel';
import { HermesMemoriesPanel } from '@/components/sidebar/HermesMemoriesPanel';
import { ProfilesPanel } from '@/components/sidebar/ProfilesPanel';
import { HermesSkillsPanel } from '@/components/sidebar/HermesSkillsPanel';
import { HermesUsagePanel } from '@/components/sidebar/HermesUsagePanel';
import type { Conversation } from '@/lib/db';

import type { SubTab } from '@/stores/ui-store';
import { relativeTime } from '@/lib/relative-time';

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

const HERMES_SUB_TABS: Array<{ key: SubTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: 'Overview', icon: House },
  { key: 'threads', label: 'Threads', icon: MessageSquare },
  { key: 'chats', label: 'Sessions', icon: Zap },
  { key: 'profiles', label: 'Profiles', icon: User },
  { key: 'cron', label: 'Cron', icon: Clock },
  { key: 'memories', label: 'Memories', icon: BookOpen },
  { key: 'skills', label: 'Skills', icon: Sparkles },
  { key: 'usage', label: 'Usage', icon: BarChart3 },
];

export const ChatSidebar: React.FC = () => {
  const {
    conversations,
    loadConversations,
    deleteConversation,
    deleteOldConversations,
    renameConversation,
    pinConversation,
  } = useChatStore();

  const { panels, focusedPanelId, setConversationForPanel, openPanel } = usePanelStore();
  const { activeTab, setActiveTab, setSettingsOpen, setRepoBrowserOpen, sidebarWidth, activeSubTab, setActiveSubTab } = useUIStore();
  const { activeProvider } = useSettingsStore();
  const activities = useActivityStore((s) => s.activities);
  const getLineTotals = useChangesetStore((s) => s.getLineTotals);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupDays, setCleanupDays] = useState<number | null>(null);
  const [cleanupCount, setCleanupCount] = useState(0);
  const isHermes = activeProvider === 'hermes';

  // Get active repo from focused panel's changeset
  const focusedPanel = panels.find((p) => p.id === focusedPanelId);
  const focusedScopeId = getChatScopeId(focusedPanelId, focusedPanel?.conversationId ?? null);
  const focusedChangeset = useChangesetStore((s) => s.getChangeset(focusedScopeId));
  const activeRepo = focusedChangeset.activeRepo;
  const focusedConversation = conversations.find((conversation) => conversation.id === focusedPanel?.conversationId);
  const isCompactHeader = sidebarWidth <= 280;
  const isCompactFooter = sidebarWidth <= 320;
  const isUltraCompactFooter = sidebarWidth <= 280;
  const accessStatusLabel = getRepoAccessLabel(activeRepo);
  const permissionsLabel = isUltraCompactFooter ? null : isCompactFooter ? accessStatusLabel : accessStatusLabel;
  const repoDisplayName = activeRepo
    ? isCompactFooter
      ? activeRepo.name
      : activeRepo.fullName
    : isCompactFooter
      ? 'No repo'
      : 'No repo attached';

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const focusedConvId = focusedPanel?.conversationId;

  const handleNew = () => {
    setActiveTab('chat');
    setConversationForPanel(focusedPanelId, null);
  };

  // Listen for "New Chat" from Electron tray/dock menu
  useEffect(() => {
    const cleanup = window.electronAPI?.onNewChat?.(() => {
      setActiveTab('chat');
      setConversationForPanel(focusedPanelId, null);
    });
    return () => { cleanup?.(); };
  }, [focusedPanelId, setActiveTab, setConversationForPanel]);

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

  const handleCleanupSelect = (days: number) => {
    const cutoff = Date.now() - days * 86400000;
    const count = conversations.filter((c) => {
      if (c.pinned) return false;
      const ts = new Date(c.updatedAt || c.createdAt).getTime();
      return ts < cutoff;
    }).length;
    setCleanupDays(days);
    setCleanupCount(count);
  };

  const handleCleanupConfirm = async () => {
    if (cleanupDays !== null) {
      await deleteOldConversations(cleanupDays);
    }
    setCleanupDays(null);
    setCleanupOpen(false);
  };

  const handleCleanupCancel = () => {
    setCleanupDays(null);
    setCleanupOpen(false);
  };

  const displayLimit = showAll ? conversations.length : 15;
  const visibleConversations = conversations.slice(0, displayLimit);
  const hasMore = conversations.length > 15 && !showAll;
  const groups = useMemo(() => groupConversationsByDate(visibleConversations), [visibleConversations]);

  return (
    <div className="flex h-full flex-col bg-transparent text-foreground">
      {/* macOS traffic light spacer — clears hiddenInset titlebar buttons */}
      <div className="h-[38px] shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
      {/* Top action bar */}
      <div
        className={cn(
          'flex h-11 items-center',
          isCompactHeader ? 'gap-1.5 px-3' : 'gap-2 px-4'
        )}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Shared SVG defs for animated rainbow gradient */}
        <svg className="absolute h-0 w-0" aria-hidden="true">
          <defs>
            <linearGradient id="sidebar-rainbow" x1="0%" y1="0%" x2="100%" y2="100%" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#ff6b6b">
                <animate attributeName="stop-color" values="#ff6b6b;#ffd43b;#51cf66;#339af0;#cc5de8;#ff6b6b" dur="3s" repeatCount="indefinite" />
              </stop>
              <stop offset="25%" stopColor="#ffd43b">
                <animate attributeName="stop-color" values="#ffd43b;#51cf66;#339af0;#cc5de8;#ff6b6b;#ffd43b" dur="3s" repeatCount="indefinite" />
              </stop>
              <stop offset="50%" stopColor="#51cf66">
                <animate attributeName="stop-color" values="#51cf66;#339af0;#cc5de8;#ff6b6b;#ffd43b;#51cf66" dur="3s" repeatCount="indefinite" />
              </stop>
              <stop offset="75%" stopColor="#339af0">
                <animate attributeName="stop-color" values="#339af0;#cc5de8;#ff6b6b;#ffd43b;#51cf66;#339af0" dur="3s" repeatCount="indefinite" />
              </stop>
              <stop offset="100%" stopColor="#cc5de8">
                <animate attributeName="stop-color" values="#cc5de8;#ff6b6b;#ffd43b;#51cf66;#339af0;#cc5de8" dur="3s" repeatCount="indefinite" />
              </stop>
            </linearGradient>
          </defs>
        </svg>

        {/* New thread button — primary action */}
        <button
          onClick={handleNew}
          className={cn(
            'group/new relative flex h-9 items-center overflow-hidden rounded-[8px] border border-[#2F2F2F] bg-[hsl(var(--card))] text-[13px] font-normal text-[#e0e0e0] transition-colors duration-100 hover:bg-[hsl(var(--card))]/80',
            isCompactHeader ? 'w-9 justify-center px-0' : 'flex-1 px-3.5'
          )}
          title="New thread"
          aria-label="New thread"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Plus className={cn(
            'h-3.5 w-3.5 text-[#888888] group-hover/new:[stroke:url(#sidebar-rainbow)]',
            !isCompactHeader && 'mr-2 w-0 -ml-0.5 opacity-0 group-hover/new:w-3.5 group-hover/new:ml-0 group-hover/new:opacity-100 transition-all duration-200 ease-out'
          )} />
          {!isCompactHeader && 'New thread'}
          <span className="pointer-events-none absolute inset-0 z-0 translate-x-[-120%] bg-[linear-gradient(115deg,transparent_0%,transparent_30%,hsl(var(--foreground)/0.12)_48%,transparent_62%,transparent_100%)] opacity-0 group-hover/new:animate-[sidebar-btn-glimmer_4s_ease-in-out_infinite] group-hover/new:opacity-100" />
        </button>

        {/* Secondary actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRepoBrowserOpen(true)}
            className="group/gh relative inline-flex h-9 w-9 items-center justify-center overflow-hidden rounded-[8px] border border-[#2F2F2F] bg-[hsl(var(--card))] text-[#888888] transition-colors duration-100 hover:text-[hsl(var(--text-secondary))]"
            title="Browse repo issues"
            aria-label="Browse repo issues"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Github className="relative z-[1] h-4 w-4 group-hover/gh:[stroke:url(#sidebar-rainbow)] group-hover/gh:drop-shadow-[0_0_4px_rgba(200,100,255,0.4)]" />
            <span className="pointer-events-none absolute inset-0 z-0 translate-x-[-120%] bg-[linear-gradient(115deg,transparent_0%,transparent_30%,hsl(var(--foreground)/0.12)_48%,transparent_62%,transparent_100%)] opacity-0 group-hover/gh:animate-[sidebar-btn-glimmer_4s_ease-in-out_infinite] group-hover/gh:opacity-100" />
          </button>

          <button
            onClick={() => setSettingsOpen(true)}
            className="group/cog relative inline-flex h-9 w-9 items-center justify-center overflow-hidden rounded-[8px] border border-[#2F2F2F] bg-[hsl(var(--card))] text-[#888888] transition-colors duration-100 hover:text-[hsl(var(--text-secondary))]"
            title="Settings"
            aria-label="Open settings"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Settings className="relative z-[1] h-4 w-4 group-hover/cog:animate-[cog-spin_3s_cubic-bezier(0.16,1,0.3,1)_infinite] group-hover/cog:[stroke:url(#sidebar-rainbow)]" />
            <span className="pointer-events-none absolute inset-0 z-0 translate-x-[-120%] bg-[linear-gradient(115deg,transparent_0%,transparent_30%,hsl(var(--foreground)/0.12)_48%,transparent_62%,transparent_100%)] opacity-0 group-hover/cog:animate-[sidebar-btn-glimmer_4s_ease-in-out_infinite] group-hover/cog:opacity-100" />
          </button>
        </div>
      </div>

      {/* Sub-tab navigation (hermes only) */}
      {isHermes && (
        <div className="px-3 pb-3 pt-1">
          <div className={cn(
            'grid gap-1',
            sidebarWidth <= 260 ? 'grid-cols-3' : 'grid-cols-4'
          )}>
            {HERMES_SUB_TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveSubTab(key)}
                className={cn(
                  'flex flex-col items-center justify-center gap-1 rounded-lg px-1 py-2.5 text-[10px] font-medium transition-all duration-150',
                  activeSubTab === key
                    ? 'bg-[hsl(var(--muted))]/80 text-foreground shadow-sm'
                    : 'text-muted-foreground/60 hover:bg-[hsl(var(--muted))]/40 hover:text-muted-foreground'
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
                <span className="leading-none">{label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Conditional content based on active sub-tab */}
      {!isHermes || activeSubTab === 'threads' ? (
        <>
          {/* Threads section header */}
          <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[1px] text-[#666666]">Threads</span>
          <SlotNumber value={conversations.length} className="text-[11px] font-mono text-[#555555]" />
        </div>
        <div className="relative flex items-center gap-1.5">
          <button
            onClick={() => { setCleanupOpen(!cleanupOpen); setCleanupDays(null); }}
            className="rounded-md p-0.5 text-[#666666] transition-colors duration-100 hover:text-[hsl(var(--text-secondary))]"
            title="Clean up old threads"
            aria-label="Clean up old threads"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <Search className="h-3.5 w-3.5 text-[#666666]" />
          {cleanupOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-lg border border-[#2F2F2F] bg-[hsl(var(--card))] py-1 shadow-lg">
              {cleanupDays === null ? (
                <>
                  <button
                    onClick={() => handleCleanupSelect(1)}
                    className="flex w-full items-center px-3 py-1.5 text-[11px] text-[hsl(var(--text-secondary))] transition-colors hover:bg-[hsl(var(--sidebar-active))]/40"
                  >
                    Older than 1 day
                  </button>
                  <button
                    onClick={() => handleCleanupSelect(7)}
                    className="flex w-full items-center px-3 py-1.5 text-[11px] text-[hsl(var(--text-secondary))] transition-colors hover:bg-[hsl(var(--sidebar-active))]/40"
                  >
                    Older than 7 days
                  </button>
                </>
              ) : (
                <div className="px-3 py-1.5">
                  <p className="text-[11px] text-[hsl(var(--text-secondary))]">
                    Delete {cleanupCount} thread{cleanupCount !== 1 ? 's' : ''}?
                  </p>
                  <div className="mt-1.5 flex gap-2">
                    <button
                      onClick={handleCleanupConfirm}
                      className="text-[11px] font-medium text-destructive"
                      disabled={cleanupCount === 0}
                    >
                      Delete
                    </button>
                    <button
                      onClick={handleCleanupCancel}
                      className="text-[11px] text-muted-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
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
                <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-[#666666] px-4 pt-4 pb-1">
                  {group.label}
                </div>
                {group.conversations.map((conv) => {
                  const isFocused = activeTab === 'chat' && focusedConvId === conv.id;
                  const isInAnotherPanel = !isFocused && panels.some((p) => p.conversationId === conv.id);
                  const activity = activities[conv.id];
                  const isProcessing = activity?.streaming;
                  const convLineTotals = getLineTotals(conv.id);
                  const totalAdded = convLineTotals.added;
                  const totalRemoved = convLineTotals.removed;
                  const hasLineStats = totalAdded > 0 || totalRemoved > 0;
                  const showPinned = !!conv.pinned;

                  return (
                    <div
                      key={conv.id}
                      onClick={() => handleSelectConversation(conv.id)}
                      className={cn(
                        'group mb-1 flex cursor-pointer flex-col gap-0.5 rounded-[10px] px-4 py-2.5 text-[13px] transition-colors duration-100',
                        isFocused
                          ? 'bg-[#FF840010] border-l-2 border-l-[#FF840020]'
                          : isInAnotherPanel
                            ? 'bg-[hsl(var(--sidebar-active))]/50'
                            : 'hover:bg-[hsl(var(--sidebar-active))]/40'
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
                                className={cn(
                                  'min-w-0 flex-1 truncate font-medium transition-[max-width,color] duration-200 ease-out',
                                  isFocused
                                    ? 'text-[hsl(var(--text-primary))]'
                                    : 'text-[hsl(var(--text-tertiary))]'
                                )}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  setEditingId(conv.id);
                                  setEditTitle(conv.title);
                                }}
                              >
                                {conv.title}
                                {conv.parentConversationId && (
                                  <GitFork className="inline-block ml-1 h-3 w-3 text-muted-foreground opacity-60" />
                                )}
                              </span>
                              <span className="shrink-0 text-[11px] tabular-nums text-[hsl(var(--text-dim))] transition-opacity duration-200 ease-out group-hover:opacity-70">
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
                              <button
                                onClick={(e) => { e.stopPropagation(); openPanel(conv.id); }}
                                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                                title="Open in new panel"
                              >
                                <Columns2 className="h-3 w-3" />
                              </button>
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
                      <div className={cn(
                        'truncate pl-6 text-[12px] leading-relaxed',
                        isFocused ? 'text-[hsl(var(--text-dim))]' : 'text-[hsl(var(--text-faint))]'
                      )}>
                        {conv.title}
                      </div>

                      {/* Bottom row: line stats */}
                      {hasLineStats && (
                        <div className="flex items-center gap-1 pl-6">
                          <SlotNumber value={totalAdded} prefix="+" className="text-[10px] font-mono text-emerald-500" />
                          <span className="text-[10px] text-muted-foreground/40">/</span>
                          <SlotNumber value={totalRemoved} prefix="-" className="text-[10px] font-mono text-red-400" />
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

        </>
      ) : activeSubTab === 'overview' ? (
        <HermesOverviewPanel />
      ) : activeSubTab === 'chats' ? (
        <HermesChatsPanel />
      ) : activeSubTab === 'profiles' ? (
        <ProfilesPanel />
      ) : activeSubTab === 'memories' ? (
        <HermesMemoriesPanel />
      ) : activeSubTab === 'skills' ? (
        <HermesSkillsPanel />
      ) : activeSubTab === 'usage' ? (
        <HermesUsagePanel />
      ) : (
        <CronJobsPanel
          conversationId={focusedConversation?.id ?? null}
          conversationTitle={focusedConversation?.title ?? null}
        />
      )}

      {/* Footer — permissions + repo status */}
      <div className={cn(
        'flex shrink-0 items-center border-t border-[#2F2F2F] px-3 py-2',
        isCompactFooter ? 'gap-1.5' : 'gap-2'
      )}>
        <div
          className={cn(
            'inline-flex shrink-0 items-center rounded-full border border-[#2F2F2F] bg-[hsl(var(--card))]/70 py-1 text-[11px] text-[#666666]',
            isUltraCompactFooter ? 'px-2' : 'gap-1.5 px-2.5'
          )}
          title={accessStatusLabel}
          aria-label={accessStatusLabel}
        >
          <Lock className="h-3 w-3 text-[#555555]" />
          {permissionsLabel && <span className="truncate">{permissionsLabel}</span>}
          {!isUltraCompactFooter && <ChevronRight className="h-2.5 w-2.5 text-[#444444]" />}
        </div>
        <div
          className={cn(
            'min-w-0 flex-1 rounded-full border px-2.5 py-1',
            activeRepo
              ? 'border-emerald-500/15 bg-emerald-500/[0.06]'
              : 'border-[#2F2F2F] bg-[hsl(var(--card))]/50'
          )}
          title={activeRepo ? activeRepo.fullName : 'No repo attached'}
        >
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-none">
            <Circle
              className={cn(
                'h-1.5 w-1.5 shrink-0',
                activeRepo ? 'fill-emerald-500 text-emerald-500' : 'fill-[#4A4A4A] text-[#4A4A4A]'
              )}
            />
            {activeRepo && <GitFork className="h-3 w-3 shrink-0 text-[hsl(var(--text-dim))]" />}
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                activeRepo ? 'font-medium text-[hsl(var(--text-secondary))]' : 'text-[#666666]'
              )}
            >
              {repoDisplayName}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
