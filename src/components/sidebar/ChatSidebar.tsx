import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Plus, Trash2, Settings, Columns2, Pin, MessageSquare, Lock, Circle, GitFork, Search, ChevronRight, Zap, Clock, House, BookOpen, Sparkles, BarChart3, User, Network, Image, Download, Upload, Archive, ArchiveRestore, ChevronDown, Tag, X, Kanban, CornerDownLeft, ListChecks, Users } from 'lucide-react';
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
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { SlotNumber } from '@/components/ui/SlotNumber';
import { CronJobsPanel } from '@/components/sidebar/CronJobsPanel';
import { HermesChatsPanel } from '@/components/sidebar/HermesChatsPanel';
import { HermesOverviewPanel } from '@/components/sidebar/HermesOverviewPanel';
import { HermesMemoriesPanel } from '@/components/sidebar/HermesMemoriesPanel';
import { ProfilesPanel } from '@/components/sidebar/ProfilesPanel';
import { HermesSkillsPanel } from '@/components/sidebar/HermesSkillsPanel';
import { HermesUsagePanel } from '@/components/sidebar/HermesUsagePanel';
import { ImagesPanel } from '@/components/sidebar/ImagesPanel';
import { KanbanPanel } from '@/components/sidebar/KanbanPanel';
import { TaskQueuePanel } from '@/components/sidebar/TaskQueuePanel';
import { TeamPanel } from '@/components/sidebar/TeamPanel';
import { HermesQueuePanel } from '@/components/sidebar/HermesQueuePanel';
import { HermesMCPPanel } from '@/components/sidebar/HermesMCPPanel';
import { ConversationTreeOverlay } from '@/components/workflow/ConversationTreeOverlay';
import type { Conversation } from '@/lib/db';
import { exportConversationJson, exportConversationMarkdown, importConversationJson } from '@/lib/db';
import { toast } from '@/lib/toast';
import { tagColor } from '@/lib/tag-color';

import type { SubTab } from '@/stores/ui-store';
import { relativeTime } from '@/lib/relative-time';
import { useChatQueueStore } from '@/stores/chat-queue-store';
import { useRoomStore } from '@/stores/room-store';
import { SwarmRoomPanel } from '@/components/chat/SwarmRoomPanel';
import { CreateRoomDialog } from '@/components/rooms/CreateRoomDialog';
import { RoomSettingsPanel } from '@/components/rooms/RoomSettingsPanel';
import { useProfilesStore } from '@/stores/profiles-store';

interface ConversationGroup {
  label: string;
  /** Full label for the title attribute (e.g. owner/repo when the visible label is just the repo name). */
  title?: string;
  conversations: Conversation[];
}

const recencyOf = (c: Conversation) => new Date(c.updatedAt || c.createdAt).getTime();
const byRecencyDesc = (a: Conversation, b: Conversation) => recencyOf(b) - recencyOf(a);

// Group threads by attached project (GitHub repo). Pinned threads float to the top
// across all projects; threads with no repo land in a trailing "No project" section.
// Project sections are ordered by their most-recent thread.
function groupConversationsByProject(conversations: Conversation[]): ConversationGroup[] {
  const pinned: Conversation[] = [];
  const byProject = new Map<string, Conversation[]>();
  const noProject: Conversation[] = [];

  for (const conv of conversations) {
    if (conv.pinned) {
      pinned.push(conv);
      continue;
    }
    const repo = conv.repoFullName;
    if (repo) {
      const list = byProject.get(repo);
      if (list) list.push(conv);
      else byProject.set(repo, [conv]);
    } else {
      noProject.push(conv);
    }
  }

  const projectGroups = Array.from(byProject.entries())
    .map(([repo, convs]) => ({
      label: repo.includes('/') ? repo.slice(repo.lastIndexOf('/') + 1) : repo,
      title: repo,
      conversations: convs.sort(byRecencyDesc),
      mostRecent: Math.max(...convs.map(recencyOf)),
    }))
    .sort((a, b) => b.mostRecent - a.mostRecent);

  const groups: ConversationGroup[] = [];
  if (pinned.length > 0) groups.push({ label: 'Pinned', conversations: pinned.sort(byRecencyDesc) });
  for (const g of projectGroups) groups.push({ label: g.label, title: g.title, conversations: g.conversations });
  if (noProject.length > 0) groups.push({ label: 'No project', conversations: noProject.sort(byRecencyDesc) });
  return groups;
}

const HERMES_SUB_TABS: Array<{ key: SubTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: 'Overview', icon: House },
  { key: 'threads', label: 'Threads', icon: MessageSquare },
  { key: 'queue', label: 'Queue', icon: CornerDownLeft },
  { key: 'chats', label: 'Sessions', icon: Zap },
  { key: 'profiles', label: 'Profiles', icon: User },
  { key: 'cron', label: 'Cron', icon: Clock },
  { key: 'memories', label: 'Memories', icon: BookOpen },
  { key: 'skills', label: 'Skills', icon: Sparkles },
  { key: 'usage', label: 'Usage', icon: BarChart3 },
  { key: 'images', label: 'Images', icon: Image },
  { key: 'mcp', label: 'MCP', icon: Network },
  { key: 'kanban', label: 'Board', icon: Kanban },
  { key: 'tasks', label: 'Tasks', icon: ListChecks },
  { key: 'rooms', label: 'Rooms', icon: Users },
  { key: 'teams', label: 'Teams', icon: Users },
];

export const ChatSidebar: React.FC = () => {
  const {
    conversations,
    archivedConversations,
    loadConversations,
    deleteConversation,
    deleteOldConversations,
    renameConversation,
    pinConversation,
    archiveConversation,
    unarchiveConversation,
    addTagToConversation,
    removeTagFromConversation,
  } = useChatStore();

  const { panels, focusedPanelId, setConversationForPanel, openPanel, openRoomPanel } = usePanelStore();
  const { activeTab, setActiveTab, setSettingsOpen, setRepoBrowserOpen, sidebarWidth, activeSubTab, setActiveSubTab, setSidebarOpen } = useUIStore();
  const { activeProvider, githubPAT } = useSettingsStore();
  const isMobile = useIsMobile();
  // On mobile the sidebar is a slide-over drawer — dismiss it after navigating
  // to content so the user lands on the chat instead of staying behind the panel.
  const closeOnMobile = () => { if (isMobile) setSidebarOpen(false); };
  const activities = useActivityStore((s) => s.activities);
  const getLineTotals = useChangesetStore((s) => s.getLineTotals);
  const panelQueues = useChatQueueStore((s) => s.panelQueues);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupDays, setCleanupDays] = useState<number | null>(null);
  const [cleanupCount, setCleanupCount] = useState(0);
  const [showTreeOverlay, setShowTreeOverlay] = useState(false);
  const [showAllTabs, setShowAllTabs] = useState(false);
  const [exportMenuId, setExportMenuId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (label: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagEditorId, setTagEditorId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [activeRoomSettingsId, setActiveRoomSettingsId] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const isHermes = activeProvider === 'hermes';
  const totalQueuedMessages = useMemo(
    () => Object.values(panelQueues).reduce((sum, queue) => sum + queue.messages.length, 0),
    [panelQueues],
  );

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

  // Room store
  const { rooms, fetchRooms, settingsRoomId, closeRoomSettings } = useRoomStore();
  const profiles = useProfilesStore((s) => s.profiles);
  const profilesLoading = useProfilesStore((s) => s.loading);
  const fetchProfiles = useProfilesStore((s) => s.fetchProfiles);
  const getProfilesForRoomSelection = useProfilesStore((s) => s.getProfilesForRoomSelection);
  const roomProfiles = getProfilesForRoomSelection ? getProfilesForRoomSelection() : profiles;

  useEffect(() => {
    void fetchRooms();
    void fetchProfiles();
  }, [fetchRooms, fetchProfiles]);

  const handleNew = () => {
    setActiveTab('chat');
    setConversationForPanel(focusedPanelId, null);
    closeOnMobile();
  };

  // Close tree overlay on Esc
  useEffect(() => {
    if (!showTreeOverlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowTreeOverlay(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showTreeOverlay]);

  // Press "E" on a focused sidebar row to archive / unarchive.
  // Scoped to avoid hijacking typing: only fires when focus is on a sidebar
  // row (tracked via focusedRowId) and no text input / textarea / contentEditable
  // element is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'e' && e.key !== 'E') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!focusedRowId) return;
      const target = document.activeElement as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }
      const archived = archivedConversations.some((c) => c.id === focusedRowId);
      e.preventDefault();
      if (archived) {
        void unarchiveConversation(focusedRowId);
      } else {
        void archiveConversation(focusedRowId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedRowId, archivedConversations, archiveConversation, unarchiveConversation]);

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

  const handleExport = async (conv: Conversation, format: 'md' | 'json') => {
    try {
      const blob = format === 'md' ? await exportConversationMarkdown(conv.id) : await exportConversationJson(conv.id);
      const slug = (conv.title || 'conversation')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'conversation';
      const idPrefix = conv.id.slice(0, 8);
      const filename = `${slug}-${idPrefix}.${format}`;

      if (window.electronAPI?.saveFile) {
        const content = await blob.text();
        const result = await window.electronAPI.saveFile(filename, content);
        if (result.saved) {
          toast.success(`Exported to ${result.path}`);
        } else if (result.error) {
          toast.error(`Export failed: ${result.error}`);
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } finally {
      setExportMenuId(null);
    }
  };

  const handleImportFile = async (file: File) => {
    try {
      const imported = await importConversationJson(file);
      await loadConversations();
      setActiveTab('chat');
      setConversationForPanel(focusedPanelId, imported.id);
      toast.success(`Imported "${imported.title}"`);
    } catch (error) {
      toast.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleSelectConversation = (convId: string) => {
    setActiveTab('chat');
    setConversationForPanel(focusedPanelId, convId);
    closeOnMobile();
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

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const conv of conversations) {
      for (const tag of conv.tags ?? []) {
        if (tag) set.add(tag);
      }
    }
    return Array.from(set).sort();
  }, [conversations]);

  // Prune selected tags that no longer exist so the filter bar stays accurate.
  useEffect(() => {
    setSelectedTags((prev) => prev.filter((t) => allTags.includes(t)));
  }, [allTags]);

  const filteredConversations = useMemo(() => {
    if (selectedTags.length === 0) return conversations;
    return conversations.filter((conv) => {
      const tags = conv.tags ?? [];
      return selectedTags.every((t) => tags.includes(t));
    });
  }, [conversations, selectedTags]);

  const displayLimit = showAll ? filteredConversations.length : 15;
  const visibleConversations = filteredConversations.slice(0, displayLimit);
  const hasMore = filteredConversations.length > 15 && !showAll;
  const groups = useMemo(() => groupConversationsByProject(visibleConversations), [visibleConversations]);

  const handleTagClick = (tag: string, shift: boolean) => {
    setSelectedTags((prev) => {
      if (shift) {
        return prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag];
      }
      if (prev.length === 1 && prev[0] === tag) return [];
      return [tag];
    });
  };

  const commitTag = async (conversationId: string) => {
    const value = tagInput.trim().toLowerCase();
    if (!value) {
      setTagEditorId(null);
      setTagInput('');
      return;
    }
    try {
      await addTagToConversation(conversationId, value);
    } catch (error) {
      toast.error(`Failed to add tag: ${error instanceof Error ? error.message : String(error)}`);
    }
    setTagInput('');
    setTagEditorId(null);
  };

  return (
    <div className="flex h-full flex-col bg-transparent text-foreground">
      {/* macOS traffic light spacer (desktop) / close affordance (mobile drawer) */}
      {isMobile ? (
        <div className="flex h-11 shrink-0 items-center justify-end px-3">
          <button
            onClick={() => setSidebarOpen(false)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[hsl(var(--muted))] hover:text-foreground"
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="h-[38px] shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
      )}
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
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            className="group/imp relative inline-flex h-9 w-9 items-center justify-center overflow-hidden rounded-[8px] border border-[#2F2F2F] bg-[hsl(var(--card))] text-[#888888] transition-colors duration-100 hover:text-[hsl(var(--text-secondary))]"
            title="Import conversation"
            aria-label="Import conversation"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Upload className="relative z-[1] h-4 w-4 group-hover/imp:[stroke:url(#sidebar-rainbow)]" />
            <span className="pointer-events-none absolute inset-0 z-0 translate-x-[-120%] bg-[linear-gradient(115deg,transparent_0%,transparent_30%,hsl(var(--foreground)/0.12)_48%,transparent_62%,transparent_100%)] opacity-0 group-hover/imp:animate-[sidebar-btn-glimmer_4s_ease-in-out_infinite] group-hover/imp:opacity-100" />
          </button>
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
      {isHermes && (() => {
        const PRIMARY_TAB_COUNT = 7;
        const overflowKeys = HERMES_SUB_TABS.slice(PRIMARY_TAB_COUNT).map((t) => t.key);
        // Keep the active tab reachable: auto-expand if it lives in the overflow.
        const expanded = showAllTabs || overflowKeys.includes(activeSubTab);
        const visibleTabs = expanded ? HERMES_SUB_TABS : HERMES_SUB_TABS.slice(0, PRIMARY_TAB_COUNT);
        return (
        <div className="px-3 pb-3 pt-1" data-tour="subtab-nav">
          <div className={cn(
            'grid gap-1',
            sidebarWidth <= 260 ? 'grid-cols-3' : 'grid-cols-4'
          )}>
            {visibleTabs.map(({ key, label, icon: Icon }) => (
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
                <span className="relative">
                  <Icon className="h-[18px] w-[18px]" />
                  {key === 'queue' && totalQueuedMessages > 0 && (
                    <span className="absolute -right-2.5 -top-2 inline-flex min-w-[18px] items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
                      {Math.min(totalQueuedMessages, 99)}
                    </span>
                  )}
                </span>
                <span className="leading-none">{label}</span>
              </button>
            ))}
            <button
              onClick={() => setShowAllTabs((v) => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? 'Show fewer sections' : 'Show more sections'}
              className="flex flex-col items-center justify-center gap-1 rounded-lg px-1 py-2.5 text-[10px] font-medium text-muted-foreground/60 transition-all duration-150 hover:bg-[hsl(var(--muted))]/40 hover:text-muted-foreground"
            >
              <ChevronDown className={cn('h-[18px] w-[18px] transition-transform duration-200', expanded && 'rotate-180')} />
              <span className="leading-none">{expanded ? 'Less' : 'More'}</span>
            </button>
          </div>
        </div>
        );
      })()}

      {/* Conditional content based on active sub-tab */}
      {!isHermes || activeSubTab === 'threads' ? (
        <>
          {/* Threads section header */}
          <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[1px] text-[#666666]">Threads</span>
          <SlotNumber value={conversations.length} className="text-[11px] font-mono text-[#555555]" />
          {panels.length > 1 && (
            <span
              className="ml-1 inline-flex items-center gap-1 rounded-full border border-[#2F2F2F] bg-[hsl(var(--card))]/70 px-1.5 py-0.5 text-[10px] font-mono text-[#888888]"
              title={`${panels.length} panels open`}
            >
              <Columns2 className="h-3 w-3" />
              {panels.length}
            </span>
          )}
        </div>
        <div className="relative flex items-center gap-1.5">
          <button
            onClick={() => setShowTreeOverlay(true)}
            className="rounded-md p-0.5 text-[#666666] transition-colors duration-100 hover:text-[hsl(var(--text-secondary))]"
            title="Conversation tree"
            aria-label="Open conversation tree"
            disabled={conversations.length === 0}
          >
            <Network className="h-3.5 w-3.5" />
          </button>
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

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div
          className="flex flex-wrap gap-1 px-4 pb-2"
          aria-label="Filter by tag"
        >
          <button
            type="button"
            onClick={() => setSelectedTags([])}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
              selectedTags.length === 0
                ? 'border-[hsl(var(--ring))] bg-[hsl(var(--muted))]/60 text-foreground'
                : 'border-[#2F2F2F] text-muted-foreground hover:text-foreground'
            )}
          >
            All
          </button>
          {allTags.map((tag) => {
            const color = tagColor(tag);
            const selected = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={(e) => handleTagClick(tag, e.shiftKey)}
                title={selected ? 'Click to deselect (shift-click to combine)' : 'Click to filter (shift-click to combine)'}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
                  color.bg,
                  color.fg,
                  selected ? `ring-1 ${color.ring}` : 'opacity-70 hover:opacity-100'
                )}
              >
                #{tag}
              </button>
            );
          })}
        </div>
      )}

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto px-3 pb-3" data-tour="threads-list">
        {conversations.length === 0 && archivedConversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-background/60 mb-4">
              <MessageSquare className="h-6 w-6 text-muted-foreground/40" />
            </div>
            <p className="text-[13px] font-medium text-muted-foreground/70 mb-1">No conversations yet</p>
            <p className="text-[11px] text-muted-foreground/50 text-center">Start a new conversation using the button above</p>
          </div>
        ) : (
          <>
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.label);
              return (
              <div key={group.label}>
                <button
                  onClick={() => toggleGroup(group.label)}
                  className="flex w-full items-center gap-1.5 px-4 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-[1.2px] text-[#666666] transition-colors hover:text-[hsl(var(--text-secondary))]"
                  aria-expanded={!collapsed}
                >
                  {collapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                  <span className="min-w-0 truncate" title={group.title ?? group.label}>{group.label}</span>
                  <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground/40">{group.conversations.length}</span>
                </button>
                {!collapsed && group.conversations.map((conv) => {
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
                      tabIndex={0}
                      onClick={() => handleSelectConversation(conv.id)}
                      onFocus={() => setFocusedRowId(conv.id)}
                      onBlur={() => setFocusedRowId((current) => (current === conv.id ? null : current))}
                      className={cn(
                        'group mb-1 flex cursor-pointer flex-col gap-0.5 rounded-[10px] px-4 py-2.5 text-[13px] transition-colors duration-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))]',
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
                              {conv.tags && conv.tags.length > 0 && (
                                <div className="flex shrink-0 items-center gap-0.5" aria-label="Tags">
                                  {conv.tags.slice(0, 2).map((tag) => {
                                    const color = tagColor(tag);
                                    return (
                                      <span
                                        key={tag}
                                        className={cn(
                                          'group/chip inline-flex items-center gap-0.5 rounded-full px-1.5 py-0 text-[9px] font-medium leading-[14px]',
                                          color.bg,
                                          color.fg,
                                        )}
                                        title={`#${tag}`}
                                      >
                                        {tag}
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void removeTagFromConversation(conv.id, tag);
                                          }}
                                          className="hidden opacity-0 group-hover/chip:inline-flex group-hover/chip:opacity-70 hover:opacity-100"
                                          aria-label={`Remove tag ${tag}`}
                                        >
                                          <X className="h-2 w-2" />
                                        </button>
                                      </span>
                                    );
                                  })}
                                  {conv.tags.length > 2 && (
                                    <span
                                      className="rounded-full bg-[hsl(var(--muted))]/60 px-1.5 py-0 text-[9px] font-medium leading-[14px] text-muted-foreground"
                                      title={conv.tags.slice(2).map((t) => `#${t}`).join(' ')}
                                    >
                                      +{conv.tags.length - 2}
                                    </span>
                                  )}
                                </div>
                              )}
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
                            <div className={cn(
                              'flex translate-x-2 gap-0.5 opacity-0 transition-[max-width,opacity,transform] duration-200 ease-out group-hover:translate-x-0 group-hover:opacity-100',
                              exportMenuId === conv.id
                                ? 'max-w-28 translate-x-0 opacity-100'
                                : 'max-w-0 group-hover:max-w-28'
                            )}>
                              <button
                                onClick={(e) => { e.stopPropagation(); openPanel(conv.id); }}
                                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                                title="Open in new panel"
                              >
                                <Columns2 className="h-3 w-3" />
                              </button>
                              <div className="relative">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExportMenuId(exportMenuId === conv.id ? null : conv.id);
                                  }}
                                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                                  title="Export conversation"
                                  aria-label="Export conversation"
                                >
                                  <Download className="h-3 w-3" />
                                </button>
                                {exportMenuId === conv.id && (
                                  <div
                                    className="absolute right-0 top-full z-50 mt-1 min-w-[140px] rounded-lg border border-[#2F2F2F] bg-[hsl(var(--card))] py-1 shadow-lg"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[1px] text-[#666666]">
                                      Export as
                                    </div>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); void handleExport(conv, 'md'); }}
                                      className="flex w-full items-center px-3 py-1.5 text-[11px] text-[hsl(var(--text-secondary))] transition-colors hover:bg-[hsl(var(--sidebar-active))]/40"
                                    >
                                      Markdown
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); void handleExport(conv, 'json'); }}
                                      className="flex w-full items-center px-3 py-1.5 text-[11px] text-[hsl(var(--text-secondary))] transition-colors hover:bg-[hsl(var(--sidebar-active))]/40"
                                    >
                                      JSON
                                    </button>
                                  </div>
                                )}
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTagEditorId(tagEditorId === conv.id ? null : conv.id);
                                  setTagInput('');
                                }}
                                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                                title="Add tag"
                                aria-label="Add tag"
                              >
                                <Tag className="h-3 w-3" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); void archiveConversation(conv.id); }}
                                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                                title="Archive (E)"
                                aria-label="Archive conversation"
                              >
                                <Archive className="h-3 w-3" />
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

                      {/* Bottom row: line stats */}
                      {hasLineStats && (
                        <div className="flex items-center gap-1 pl-6">
                          <SlotNumber value={totalAdded} prefix="+" className="text-[10px] font-mono text-emerald-500" />
                          <span className="text-[10px] text-muted-foreground/40">/</span>
                          <SlotNumber value={totalRemoved} prefix="-" className="text-[10px] font-mono text-red-400" />
                        </div>
                      )}

                      {tagEditorId === conv.id && (
                        <div className="pl-6 pt-1" onClick={(e) => e.stopPropagation()}>
                          <input
                            autoFocus
                            list={`tag-suggestions-${conv.id}`}
                            value={tagInput}
                            onChange={(e) => setTagInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void commitTag(conv.id);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setTagEditorId(null);
                                setTagInput('');
                              }
                            }}
                            onBlur={() => {
                              setTagEditorId(null);
                              setTagInput('');
                            }}
                            placeholder="Add tag…"
                            className="w-full rounded-md border border-[#2F2F2F] bg-background/60 px-2 py-1 text-[11px] focus:border-[hsl(var(--ring))] focus:outline-none"
                            aria-label="Add tag"
                          />
                          <datalist id={`tag-suggestions-${conv.id}`}>
                            {allTags
                              .filter((t) => !(conv.tags ?? []).includes(t))
                              .map((t) => (
                                <option key={t} value={t} />
                              ))}
                          </datalist>
                        </div>
                      )}
                    </div>
                  );
                })}
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

            {archivedConversations.length > 0 && (
              <div className="mt-3">
                <button
                  onClick={() => setArchivedOpen((v) => !v)}
                  className="flex w-full items-center gap-1.5 px-4 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-[1.2px] text-[#666666] transition-colors hover:text-[hsl(var(--text-secondary))]"
                  aria-expanded={archivedOpen}
                  aria-label={`Archived (${archivedConversations.length})`}
                >
                  {archivedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  <span>Archived ({archivedConversations.length})</span>
                </button>
                {archivedOpen && archivedConversations.map((conv) => (
                  <div
                    key={conv.id}
                    tabIndex={0}
                    onClick={() => handleSelectConversation(conv.id)}
                    onFocus={() => setFocusedRowId(conv.id)}
                    onBlur={() => setFocusedRowId((current) => (current === conv.id ? null : current))}
                    className="group mb-1 flex cursor-pointer items-center gap-2 rounded-[10px] px-4 py-2 text-[13px] text-[hsl(var(--text-tertiary))] transition-colors duration-100 hover:bg-[hsl(var(--sidebar-active))]/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))]"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium opacity-70">{conv.title}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-[hsl(var(--text-dim))]">
                      {relativeTime(conv.archivedAt || conv.updatedAt || conv.createdAt)}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); void unarchiveConversation(conv.id); }}
                      className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background/80 hover:text-foreground group-hover:opacity-100"
                      title="Unarchive (E)"
                      aria-label="Unarchive conversation"
                    >
                      <ArchiveRestore className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

        </>
      ) : activeSubTab === 'overview' ? (
        <HermesOverviewPanel />
      ) : activeSubTab === 'queue' ? (
        <HermesQueuePanel />
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
      ) : activeSubTab === 'images' ? (
        <ImagesPanel />
      ) : activeSubTab === 'mcp' ? (
        <HermesMCPPanel />
      ) : activeSubTab === 'kanban' ? (
        <KanbanPanel />
      ) : activeSubTab === 'tasks' ? (
        <TaskQueuePanel />
      ) : activeSubTab === 'teams' ? (
        <TeamPanel />
      ) : activeSubTab === 'rooms' && (settingsRoomId || activeRoomSettingsId) ? (
        <RoomSettingsPanel
          roomId={settingsRoomId || activeRoomSettingsId!}
          onClose={() => {
            closeRoomSettings();
            setActiveRoomSettingsId(null);
          }}
        />
      ) : activeSubTab === 'rooms' && activeRoomId ? (
        <SwarmRoomPanel
          roomId={activeRoomId}
          onBack={() => setActiveRoomId(null)}
          onSettings={() => {
            setActiveRoomSettingsId(activeRoomId);
            setActiveRoomId(null);
          }}
        />
      ) : activeSubTab === 'rooms' ? (
        <div className="flex h-full flex-col">
          {/* Rooms list header */}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[1px] text-[#666666]">Rooms</span>
              <span className="text-[11px] font-mono text-[#555555]">{rooms.length}</span>
            </div>
            <button
              onClick={() => setShowCreateDialog(true)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--muted))] transition-colors"
            >
              <Plus className="h-3 w-3" />
              New Room
            </button>
          </div>

          {/* Room list */}
          <div className="flex-1 overflow-y-auto px-3 pb-3">
            {rooms.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 px-4">
                <Users className="h-8 w-8 text-muted-foreground/30 mb-3" />
                <p className="text-[13px] font-medium text-muted-foreground/70 mb-1">No rooms yet</p>
                <p className="text-[11px] text-muted-foreground/50 text-center">Create a swarm room to collaborate with agents</p>
              </div>
            ) : (
              <div className="space-y-1">
                {rooms.map((room) => (
                  <button
                    key={room.id}
                    onClick={() => {
                      openRoomPanel(room.id);
                      setActiveTab('chat');
                      closeOnMobile();
                    }}
                    className="flex w-full items-center gap-3 rounded-[10px] px-4 py-3 text-left transition-colors hover:bg-[hsl(var(--sidebar-active))]/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))]"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--muted))]">
                      <Users className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] font-medium text-[hsl(var(--text-primary))]">
                        {room.name}
                      </span>
                      <span className="text-[11px] text-muted-foreground/60">
                        Created {new Date(room.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Create room dialog */}
          <CreateRoomDialog
            open={showCreateDialog}
            profiles={roomProfiles}
            profilesLoading={profilesLoading}
            onClose={() => setShowCreateDialog(false)}
            onCreated={(room) => {
              setShowCreateDialog(false);
              openRoomPanel(room.id);
              setActiveTab('chat');
              closeOnMobile();
            }}
          />
        </div>
      ) : (
        <CronJobsPanel
          conversationId={focusedConversation?.id ?? null}
          conversationTitle={focusedConversation?.title ?? null}
        />
      )}

      {/* Footer — repo status + GitHub connect */}
      <div
        data-tour="repo-footer"
        className={cn(
          'flex shrink-0 items-center border-t border-[#2F2F2F] px-3 py-2',
          isCompactFooter ? 'gap-1.5' : 'gap-2'
        )}
      >
        {activeRepo ? (
          <>
            <div
              className={cn(
                'inline-flex h-7 shrink-0 items-center rounded-full border border-[#2F2F2F] bg-[hsl(var(--card))]/70 text-[11px] text-[#666666]',
                isUltraCompactFooter ? 'px-2' : 'gap-1.5 px-2.5'
              )}
              title={accessStatusLabel}
              aria-label={accessStatusLabel}
            >
              <Lock className="h-3 w-3 text-[#555555]" />
              {permissionsLabel && <span className="truncate">{permissionsLabel}</span>}
            </div>
            <button
              onClick={() => setRepoBrowserOpen(true)}
              className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border border-emerald-500/15 bg-emerald-500/[0.06] px-2.5 text-[11px] leading-none transition-colors hover:border-emerald-500/30 hover:bg-emerald-500/[0.1]"
              title={`${activeRepo.fullName} — change repository`}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <Circle className="h-1.5 w-1.5 shrink-0 fill-emerald-500 text-emerald-500" />
              <GitFork className="h-3 w-3 shrink-0 text-[hsl(var(--text-dim))]" />
              <span className="min-w-0 flex-1 truncate text-left font-medium text-[hsl(var(--text-secondary))]">
                {repoDisplayName}
              </span>
            </button>
          </>
        ) : (
          <button
            onClick={() => (githubPAT ? setRepoBrowserOpen(true) : setSettingsOpen(true, 'github'))}
            className="flex h-7 w-full items-center justify-center gap-2 rounded-full border border-[#2F2F2F] bg-[hsl(var(--card))]/60 px-3 text-[11px] font-medium text-[#888888] transition-colors hover:border-primary/30 hover:bg-primary/[0.06] hover:text-[hsl(var(--text-secondary))]"
            title={githubPAT ? 'Attach a repository to this thread' : 'Connect your GitHub account'}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Github className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{githubPAT ? 'Attach repository' : 'Connect GitHub'}</span>
          </button>
        )}
      </div>

      {showTreeOverlay && (
        <ConversationTreeOverlay onClose={() => setShowTreeOverlay(false)} />
      )}
    </div>
  );
};
