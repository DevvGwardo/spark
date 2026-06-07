import React, { useState, useCallback, useRef, useEffect, Suspense } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ChatSidebar } from '@/components/sidebar/ChatSidebar';
import { ChatPanelContainer } from '@/components/chat/ChatPanelContainer';
import { CronHistoryChat } from '@/components/chat/CronHistoryChat';
import { SessionHistoryChat } from '@/components/chat/SessionHistoryChat';
import { KanbanBoard } from '@/components/kanban/KanbanBoard';
import { McpStoreView } from '@/components/mcp/McpStoreView';
import { useHermesModelSync } from '@/hooks/useHermesModelSync';
import { useUIStore } from '@/stores/ui-store';
import { useShallow } from 'zustand/shallow';
import { useSettingsStore } from '@/stores/settings-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { PreviewSidebar } from '@/components/preview/PreviewSidebar';
import { usePreviewStore } from '@/stores/preview-store';
import { useChatStore } from '@/stores/chat-store';
import { useCronStore } from '@/stores/cron-store';
import { usePanelStore } from '@/stores/panel-store';
import { useRoomStore } from '@/stores/room-store';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { useTheme } from '@/hooks/useTheme';
import { useGlobalStyles } from '@/hooks/useGlobalStyles';
import { useIsMobile } from '@/hooks/use-mobile';
import { PROVIDERS } from '@/lib/providers';
import { detectHermesBridge } from '@/lib/detect-hermes';
import { getChatScopeId } from '@/lib/chat-scope';
import { PanelLeft, GitPullRequest, MoreHorizontal, Circle, Pin, Pencil, Archive, Copy, PanelRight, Plus, FileCode2, MessageSquare, TerminalSquare, Globe, Sparkles, Smartphone } from 'lucide-react';
import { MiniBrowser, MiniBrowserToggle, DockedMiniBrowser, HermesPTYPanel, type HermesPTYPanelHandle } from '@/components/browser/MiniBrowser';
import { DockedChatSidebar } from '@/components/chat/DockedChatSidebar';
import { SlotNumber } from '@/components/ui/SlotNumber';
import { HermesUpdateButton } from '@/components/chat/HermesUpdateButton';
import { FeedbackButton } from '@/components/feedback/FeedbackButton';
import { BridgeSetupModal } from '@/components/setup/BridgeSetupModal';
import { HermesStatusPill } from '@/components/layout/HermesStatusPill';
import { CommandPalette } from '@/components/overlay/CommandPalette';
import { RemoteAccessModal } from '@/components/remote/RemoteAccessModal';
import { cn } from '@/lib/utils';
import { rafThrottle } from '@/lib/raf';

const SettingsModal = React.lazy(() => import('@/components/settings/SettingsModal').then(m => ({ default: m.SettingsModal })));
const SetupWizard = React.lazy(() => import('@/components/settings/SetupWizard').then(m => ({ default: m.SetupWizard })));
const CreatePRModal = React.lazy(() => import('@/components/github/CreatePRModal').then(m => ({ default: m.CreatePRModal })));
const RepoIssueBrowser = React.lazy(() => import('@/components/github/RepoIssueBrowser').then(m => ({ default: m.RepoIssueBrowser })));
const TerminalPanel = React.lazy(() => import('@/components/terminal/TerminalPanel').then(m => ({ default: m.TerminalPanel })));

const LazyFallback = () => (
  <div className="flex items-center justify-center p-8">
    <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
  </div>
);

export const AppLayout: React.FC = () => {
  useTheme();
  useGlobalStyles();
  const isMobile = useIsMobile();
  const {
    sidebarOpen,
    setSidebarOpen,
    toggleSidebar,
    sidebarWidth,
    setSidebarWidth,
    activeTab,
    setActiveTab,
    repoBrowserOpen,
    setRepoBrowserOpen,
    terminalOpen,
    toggleTerminal,
    hermesTerminalOpen,
    toggleHermesTerminal,
    selectedCronJobId,
    selectedSessionId,
    miniBrowserDocked,
    rightSidebarHidden,
    setRightSidebarHidden,
    kanbanFullscreen,
    setKanbanFullscreen,
    mcpStoreFullscreen,
    setMcpStoreFullscreen,
    setBridgeSetupOpen,
  } = useUIStore();
  const { isSetupComplete, activeProvider, providers } = useSettingsStore(
    useShallow((s) => ({ isSetupComplete: s.isSetupComplete, activeProvider: s.activeProvider, providers: s.providers })),
  );
  const { getChangeset, getChangeCount, clearChanges, getStagedCount, getStagedChanges, setPullRequest, getLineTotals } = useChangesetStore();
  const { conversations, deleteConversation, renameConversation, pinConversation } = useChatStore();
  const { panels, focusedPanelId, openPanel, setConversationForPanel, focusPanel } = usePanelStore();
  const footerUsage = useContextUsageStore((state) => state.panelUsage[focusedPanelId]);
  const setPreviewOpen = usePreviewStore((s) => s.setOpen);
  const setPreviewView = usePreviewStore((s) => s.setView);
  const isMultiPanel = panels.length > 1;
  // Keep Spark's hermes model in sync with the agent's CLI-configured default.
  useHermesModelSync();
  const [prModalOpen, setPrModalOpen] = useState(false);
  const [prPanelId, setPrPanelId] = useState<string | null>(null); // which panel triggered the PR modal
  const [prModalMode, setPrModalMode] = useState<'create' | 'review'>('create');
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [remoteAccessOpen, setRemoteAccessOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const hermesTerminalRef = useRef<HermesPTYPanelHandle>(null);
  const focusedPanel = panels.find((p) => p.id === focusedPanelId);
  const focusedScopeId = getChatScopeId(focusedPanelId, focusedPanel?.conversationId ?? null);
  const preview = usePreviewStore((s) => s.getPreview(focusedScopeId));

  // Resolve room name if the focused panel is a room
  const focusedRoom = focusedPanel?.roomId
    ? useRoomStore.getState().rooms.find((r) => r.id === focusedPanel.roomId)
    : null;

  // Get changeset for the focused panel (used in global header for single-panel mode)
  const focusedChangeset = getChangeset(focusedScopeId);
  const activeRepo = focusedChangeset.activeRepo;
  const focusedPullRequest = focusedChangeset.pullRequest;
  const changeCount = getChangeCount(focusedScopeId);
  const stagedCount = getStagedCount(focusedScopeId);
  // focusedConvId removed - unused
  const lineTotals = getLineTotals(focusedScopeId);

  // For the PR modal, use the panel that triggered it (or focused panel in single-panel mode)
  const prTargetPanelId = prPanelId || focusedPanelId;
  const prPanel = panels.find((p) => p.id === prTargetPanelId);
  const prScopeId = getChatScopeId(prTargetPanelId, prPanel?.conversationId ?? null);
  const prChangeset = getChangeset(prScopeId);
  const prActiveRepo = prChangeset.activeRepo;
  const prPullRequest = prChangeset.pullRequest;
  const pendingFiles = getStagedChanges(prScopeId).map((change) => ({
    path: change.path,
    content: change.content,
    action: change.action,
    originalContent: change.originalContent,
  }));

  // Get active conversation title
  const activeConv = focusedPanel?.conversationId
    ? conversations.find((c) => c.id === focusedPanel.conversationId)
    : null;

  // Keyboard shortcut: Ctrl+` to toggle terminal, Ctrl/Cmd+K to open command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault();
        toggleTerminal();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleTerminal]);

  // Sync Hermes model from ~/.hermes/config.yaml.
  // CLI config is the source of truth — overwrites any previous UI selection.
  // Runs on mount, on window focus, and on a light interval while the document
  // is visible. The interval covers the case where `hermes model …` is run in
  // the embedded HermesPTYPanel — no window focus change fires there, so an
  // interval is the only way to notice the config change.
  useEffect(() => {
    let cancelled = false;

    const syncHermesModel = () => {
      detectHermesBridge().then((status) => {
        if (cancelled || !status?.hermesDefaultModel) return;
        const store = useSettingsStore.getState();
        const currentHermesModel = store.providers?.hermes?.model;
        if (currentHermesModel === status.hermesDefaultModel) return;
        store.updateProviderConfig('hermes', { model: status.hermesDefaultModel });
        console.info(
          `[hermes-sync] model synced from ~/.hermes/config.yaml: ${currentHermesModel ?? '(none)'} → ${status.hermesDefaultModel}`,
        );
      }).catch(() => {
        // Bridge unreachable — keep existing stored model.
      });
    };

    syncHermesModel();
    window.addEventListener('focus', syncHermesModel);

    // 15s poll — only while the tab is visible, so we don't spam /health in
    // a hidden background window.
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') syncHermesModel();
    }, 15000);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', syncHermesModel);
      window.clearInterval(interval);
    };
  }, []);

  // Auto-skip onboarding when a local Hermes provider is already credentialed.
  // The bridge reports per-provider credential state (provider_credentials); if any
  // provider is usable, the user is effectively set up, so complete setup instead of
  // forcing the wizard (which otherwise gates on OpenRouter specifically). Only runs
  // while setup is incomplete — e.g. a fresh dev build with an empty persisted store.
  // The bridge can come up a few seconds after the renderer on a cold start, so retry
  // a bounded number of times rather than checking only once at mount.
  useEffect(() => {
    if (isSetupComplete) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;
    const check = () => {
      detectHermesBridge().then((status) => {
        if (cancelled) return;
        if (status?.hasAnyCreds) {
          const store = useSettingsStore.getState();
          if (store.activeProvider !== 'hermes') store.setActiveProvider('hermes');
          store.completeSetup();
          console.info('[setup] auto-completed — local Hermes bridge has a credentialed provider');
          return;
        }
        if (++attempts < 20) timer = window.setTimeout(check, 1500);
      }).catch(() => {
        if (!cancelled && ++attempts < 20) timer = window.setTimeout(check, 1500);
      });
    };
    check();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [isSetupComplete]);

  // Close header menu on outside click
  useEffect(() => {
    if (!headerMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setHeaderMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [headerMenuOpen]);

  useEffect(() => {
    if (activeTab !== 'chat') {
      setActiveTab('chat');
    }
  }, [activeTab, setActiveTab]);

  const config = providers[activeProvider];
  const footerProvider = activeTab === 'chat' ? footerUsage?.provider ?? activeProvider : activeProvider;
  const footerModel = activeTab === 'chat' ? footerUsage?.model ?? config.model : config.model;
  const footerProviderInfo = PROVIDERS[footerProvider as keyof typeof PROVIDERS];
  const footerDisplayModel = footerModel.split('/').pop() || footerModel;
  const cronJob = useCronStore((s) => selectedCronJobId ? s.jobs.find((j) => j.id === selectedCronJobId) : undefined);
const headerSecondaryLabel = selectedCronJobId
    ? (cronJob?.schedule_display ?? cronJob?.schedule ?? null)
    : activeTab === 'chat'
      ? activeRepo?.name ?? null
      : activeTab === 'github'
        ? 'Repository tools'
        : activeTab === 'analyzer'
          ? 'Diagnostics'
          : 'Prompts';
  const chromeIconButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded-xl border border-border/60 bg-background/60 text-muted-foreground transition-colors duration-100 hover:bg-background/85 hover:text-foreground';
  const chromeActionButtonClass = 'inline-flex h-8 items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3 text-[12px] font-medium text-muted-foreground transition-colors duration-100 hover:bg-background/85 hover:text-foreground';

  // Header title based on active tab
  const headerTitle = selectedCronJobId
    ? (cronJob?.name || 'Cron Job')
    : focusedRoom
      ? focusedRoom.name
      : activeTab === 'chat'
        ? (activeConv?.title || 'New thread')
        : activeTab === 'github'
          ? 'GitHub'
          : activeTab === 'analyzer'
            ? 'Analyzer'
            : 'Knowledge';

  const handlePrSuccess = useCallback(() => {
    clearChanges(prScopeId);
    // Don't close the modal — let the user see the success screen with the GitHub link
  }, [clearChanges, prScopeId]);

  const handlePullRequestCreated = useCallback((pullRequest: NonNullable<typeof prPullRequest>) => {
    setPullRequest(prScopeId, pullRequest);
  }, [prScopeId, setPullRequest]);

  // Callback for per-panel commit buttons
  const handleOpenPRForPanel = useCallback((targetPanelId: string, mode: 'create' | 'review' = 'create') => {
    setPrPanelId(targetPanelId);
    setPrModalMode(mode);
    focusPanel(targetPanelId);
    setPrModalOpen(true);
  }, [focusPanel]);

  const handleOpenChangesSidebar = useCallback((panelId: string) => {
    const panel = usePanelStore.getState().panels.find((entry) => entry.id === panelId);
    const scopeId = getChatScopeId(panelId, panel?.conversationId ?? null);
    setPreviewView(scopeId, 'changes');
    setPreviewOpen(scopeId, true);
  }, [setPreviewOpen, setPreviewView]);

  // First-run bridge setup modal: shown when running inside Electron AND the
  // bridge is not reachable AND the user hasn't manually dismissed it.
  // Polls `bridge:status` on mount; auto-hides when the bridge comes up.
  const [bridgeSetupVisible, setBridgeSetupVisible] = useState(false);
  const [bridgeSetupDismissed, setBridgeSetupDismissed] = useState(false);
  // Publish the bridge-setup modal visibility so the product tour waits for it to clear.
  useEffect(() => {
    setBridgeSetupOpen(bridgeSetupVisible);
  }, [bridgeSetupVisible, setBridgeSetupOpen]);
  useEffect(() => {
    if (!isSetupComplete) {
      setBridgeSetupVisible(false);
      return;
    }
    const bridge = window.electronAPI?.bridge;
    if (!bridge) return; // browser/dev mode without Electron — N/A
    let cancelled = false;
    let poller: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      try {
        const s = await bridge.status();
        if (cancelled) return;
        const needsSetup = !s.bridgeReachable && (
          !s.pythonPath ||
          (!s.hermesAgentPresent && !s.gitPath) ||
          !s.bridgeDepsInstalled ||
          !s.hermesAgentPresent ||
          Boolean(s.lastStartError)
        );
        // If the bridge is reachable, no setup needed.
        if (s.bridgeReachable) {
          setBridgeSetupVisible(false);
          return;
        }
        // If something's missing AND user hasn't dismissed, show modal.
        if (needsSetup && !bridgeSetupDismissed) {
          setBridgeSetupVisible(true);
          return;
        }
        // Bridge isn't up yet but everything looks installable — wait & retry.
        poller = setTimeout(check, 2000);
      } catch {
        // ignore IPC errors and retry
        poller = setTimeout(check, 4000);
      }
    };

    // Slight delay so the bridge has a chance to come up on its own first
    poller = setTimeout(check, 1500);
    return () => {
      cancelled = true;
      if (poller) clearTimeout(poller);
    };
  }, [bridgeSetupDismissed, isSetupComplete]);

  // Sidebar resize handling
  const isResizing = useRef(false);
  const sidebarResizeFrame = useRef<ReturnType<typeof rafThrottle<[number]>> | null>(null);
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      document.body.classList.add('resize-performance-lock');
      sidebarResizeFrame.current?.cancel();
      sidebarResizeFrame.current = rafThrottle((nextWidth: number) => {
        setSidebarWidth(nextWidth);
      });
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onMouseMove = (ev: MouseEvent) => {
        if (!isResizing.current) return;
        const newWidth = startWidth + (ev.clientX - startX);
        sidebarResizeFrame.current?.(newWidth);
      };

      const onMouseUp = () => {
        isResizing.current = false;
        sidebarResizeFrame.current?.flush();
        sidebarResizeFrame.current = null;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.classList.remove('resize-performance-lock');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [sidebarWidth, setSidebarWidth]
  );

  // Propagate the resize-performance-lock to OS window resizing. Codex's lock
  // only covered the sidebar/terminal drags, so dragging the window edge left
  // every card's transitions + animate-pulse churning each frame. We add the
  // lock on the first resize event and lift it shortly after resizing settles.
  useEffect(() => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const onWindowResize = () => {
      document.body.classList.add('resize-performance-lock');
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        document.body.classList.remove('resize-performance-lock');
        settleTimer = null;
      }, 200);
    };
    window.addEventListener('resize', onWindowResize, { passive: true });
    return () => {
      window.removeEventListener('resize', onWindowResize);
      if (settleTimer) clearTimeout(settleTimer);
      document.body.classList.remove('resize-performance-lock');
    };
  }, []);

  return (
    <>
      {isSetupComplete && bridgeSetupVisible && (
        <BridgeSetupModal
          onComplete={() => {
            setBridgeSetupVisible(false);
            setBridgeSetupDismissed(true);
          }}
        />
      )}
      {!isSetupComplete && <Suspense fallback={<LazyFallback />}><ErrorBoundary><SetupWizard /></ErrorBoundary></Suspense>}
      <Suspense fallback={<LazyFallback />}><ErrorBoundary><SettingsModal /></ErrorBoundary></Suspense>
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      <RemoteAccessModal open={remoteAccessOpen} onOpenChange={setRemoteAccessOpen} />
      <Suspense fallback={<LazyFallback />}><ErrorBoundary><RepoIssueBrowser isOpen={repoBrowserOpen} onClose={() => setRepoBrowserOpen(false)} /></ErrorBoundary></Suspense>
      {prActiveRepo && (
        <Suspense fallback={<LazyFallback />}>
        <CreatePRModal
          isOpen={prModalOpen}
          onClose={() => { setPrModalOpen(false); setPrPanelId(null); setPrModalMode('create'); }}
          owner={prActiveRepo.owner}
          repo={prActiveRepo.name}
          baseOwner={prActiveRepo.baseOwner}
          baseRepo={prActiveRepo.baseName}
          baseBranch={prActiveRepo.defaultBranch}
          files={pendingFiles}
          initialPullRequest={prModalMode === 'review' ? prPullRequest : null}
          onPullRequestCreated={handlePullRequestCreated}
          onSuccess={handlePrSuccess}
        />
        </Suspense>
      )}

      <div className="app-shell h-screen flex flex-col bg-[hsl(var(--frame-bg))] p-0 gap-0">
        <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-1.5 focus:bg-primary focus:text-primary-foreground focus:rounded-md focus:text-sm">
          Skip to main content
        </a>
        <div className="flex-1 flex min-h-0 gap-0 overflow-hidden" id="main-content">
          {/* Sidebar — slide-over drawer on mobile, in-flow resizable panel on desktop */}
          {isMobile ? (
            <div
              className={cn(
                'fixed inset-y-0 left-0 z-50 flex flex-col bg-[hsl(var(--sidebar-bg))] border-r border-[hsl(var(--sidebar-border))] shadow-2xl transition-transform duration-200 ease-out',
                sidebarOpen ? 'translate-x-0' : '-translate-x-full pointer-events-none'
              )}
              style={{ width: 'min(86vw, 360px)' }}
            >
              <nav className="h-full w-full" aria-label="Main navigation" aria-hidden={!sidebarOpen}>
                <ChatSidebar />
              </nav>
            </div>
          ) : (
            <div className="app-independent-pane flex-shrink-0 relative" style={sidebarOpen ? { width: sidebarWidth } : { width: 0 }}>
              <div
                className={cn(
                  'h-full overflow-hidden bg-[hsl(var(--sidebar-bg))] border-r border-[hsl(var(--sidebar-border))]',
                  !sidebarOpen && 'w-0 border-r-0'
                )}
                style={sidebarOpen ? { width: sidebarWidth, transition: isResizing.current ? 'none' : 'width 200ms' } : { transition: 'width 200ms' }}
              >
                <nav className="h-full" style={{ width: sidebarWidth }} aria-label="Main navigation">
                  <ChatSidebar />
                </nav>
              </div>
              {/* Resize handle — positioned to straddle the sidebar edge */}
              {sidebarOpen && (
                <div
                  role="separator"
                  aria-valuenow={sidebarWidth}
                  aria-valuemin={200}
                  aria-valuemax={600}
                  aria-label="Resize sidebar"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') setSidebarWidth(Math.max(200, sidebarWidth - 20));
                    if (e.key === 'ArrowRight') setSidebarWidth(Math.min(600, sidebarWidth + 20));
                  }}
                  onMouseDown={handleResizeStart}
                  className="absolute top-0 -right-1.5 w-3 h-full cursor-col-resize z-10 group"
                >
                  <div className="absolute inset-y-6 bottom-6 left-1/2 -translate-x-1/2 w-px rounded-full bg-border/20 group-hover:bg-primary/30 group-active:bg-primary/50 transition-colors" />
                </div>
              )}
            </div>
          )}

          {/* Mobile overlay */}
          {sidebarOpen && (
            <div
              className="md:hidden fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[1px]"
              onClick={() => setSidebarOpen(false)}
              aria-hidden="true"
            />
          )}

          {/* Main */}
          <div className="app-main-pane flex-1 flex flex-col min-w-0 overflow-hidden bg-background">
            {/* Header */}
            <header className="flex items-center h-[48px] px-3 md:px-5 flex-shrink-0 border-b border-border/60 bg-background" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
              {/* Collapsed sidebar controls — sits in the traffic light area */}
              {!sidebarOpen && (
                <div className="flex items-center gap-2 mr-2 md:mr-3 md:pl-[60px]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <button
                    onClick={toggleSidebar}
                    className={chromeIconButtonClass}
                    title="Open sidebar"
                  >
                    <PanelLeft className="h-3.5 w-3.5" />
                  </button>
                  {activeTab === 'chat' && !selectedCronJobId && (
                    <button
                      onClick={() => setConversationForPanel(focusedPanelId, null)}
                      className={cn(chromeActionButtonClass, 'whitespace-nowrap')}
                      title="New thread"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span className="hidden md:inline">New thread</span>
                    </button>
                  )}
                </div>
              )}

              {/* Sidebar toggle when sidebar is open */}
              {sidebarOpen && (
                <button
                  onClick={toggleSidebar}
                  className={chromeIconButtonClass}
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  title="Close sidebar"
                >
                  <PanelLeft className="h-3.5 w-3.5" />
                </button>
              )}

              {/* Thread/page title — only show in single-panel or non-chat tabs */}
              {(!isMultiPanel || activeTab !== 'chat') && (
                <div className="flex items-center gap-2.5 ml-2 md:ml-3 min-w-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <div className="hidden md:flex h-5 w-5 items-center justify-center rounded-[4px] bg-[#2a2a2a]"><MessageSquare className="h-2.5 w-2.5 text-[hsl(var(--text-muted))]" /></div>
                  <div className="min-w-0">
                    <h1 className="truncate text-[13px] font-normal tracking-[-0.015em] text-[hsl(var(--text-secondary))]">
                      {headerTitle}
                    </h1>
                    {headerSecondaryLabel && (
                      <p className="truncate text-[11px] text-muted-foreground">
                        {headerSecondaryLabel}
                      </p>
                    )}
                  </div>
                  {activeTab === 'chat' && !selectedCronJobId && (
                    <div className="relative" ref={headerMenuRef}>
                      <button
                        onClick={() => setHeaderMenuOpen((v) => !v)}
                        className={cn(
                          chromeIconButtonClass,
                          headerMenuOpen
                            ? 'bg-background/80 text-foreground'
                            : ''
                        )}
                        title="Thread options"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>

                      {headerMenuOpen && (
                        <div className="absolute left-0 top-full mt-1 w-56 rounded-lg border border-border bg-popover shadow-lg z-50 py-1 text-[13px]">
                          {activeConv ? (
                            <>
                              <button
                                onClick={() => {
                                  pinConversation(activeConv.id, !activeConv.pinned);
                                  setHeaderMenuOpen(false);
                                }}
                                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-muted transition-colors duration-100"
                              >
                                <Pin className="h-4 w-4 text-muted-foreground" />
                                <span className="flex-1 text-left">{activeConv.pinned ? 'Unpin thread' : 'Pin thread'}</span>
                              </button>

                              <button
                                onClick={() => {
                                  const newTitle = prompt('Rename thread:', activeConv.title);
                                  if (newTitle?.trim()) renameConversation(activeConv.id, newTitle.trim());
                                  setHeaderMenuOpen(false);
                                }}
                                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-muted transition-colors duration-100"
                              >
                                <Pencil className="h-4 w-4 text-muted-foreground" />
                                <span className="flex-1 text-left">Rename thread</span>
                              </button>

                              <button
                                onClick={() => {
                                  deleteConversation(activeConv.id);
                                  setConversationForPanel(focusedPanelId, null);
                                  setHeaderMenuOpen(false);
                                }}
                                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-muted transition-colors duration-100"
                              >
                                <Archive className="h-4 w-4 text-muted-foreground" />
                                <span className="flex-1 text-left">Archive thread</span>
                              </button>

                              <div className="my-1 border-t border-border" />

                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(activeConv.id);
                                  setHeaderMenuOpen(false);
                                }}
                                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-muted transition-colors duration-100"
                              >
                                <Copy className="h-4 w-4 text-muted-foreground" />
                                <span className="flex-1 text-left">Copy conversation ID</span>
                              </button>

                              <div className="my-1 border-t border-border" />
                              <button
                                onClick={() => {
                                  openPanel(activeConv.id);
                                  setHeaderMenuOpen(false);
                                }}
                                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-muted transition-colors duration-100"
                              >
                                <PanelRight className="h-4 w-4 text-muted-foreground" />
                                <span className="flex-1 text-left">Open in new panel</span>
                              </button>
                            </>
                          ) : (
                            <div className="px-3 py-2 text-muted-foreground text-center">
                              No active thread
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Multi-panel indicator in header */}
              {isMultiPanel && activeTab === 'chat' && (
                <div className="ml-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <div className="inline-flex items-center rounded-full border border-border/50 bg-background/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                    {panels.length} panels
                  </div>
                </div>
              )}

              {/* Repo attachment status removed — shown in sidebar footer instead */}

              <div className="flex-1" />

              {/* Hermes bridge status — click when offline to open bridge setup */}
              <div className="flex items-center mr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <HermesStatusPill
                  onClick={() => {
                    setBridgeSetupDismissed(false);
                    setBridgeSetupVisible(true);
                  }}
                />
              </div>

              {/* Remote access QR button */}
              <div className="flex items-center mr-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <button
                  onClick={() => setRemoteAccessOpen(true)}
                  className={cn(
                    chromeIconButtonClass,
                    remoteAccessOpen && 'border-primary/30 bg-primary/10 text-foreground'
                  )}
                  title="Remote access (QR code)"
                >
                  <Smartphone className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Terminal toggle — desktop-only chrome, hidden at phone width */}
              <div className="hidden md:flex items-center mr-2 gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <button
                  onClick={toggleHermesTerminal}
                  className={cn(
                    chromeIconButtonClass,
                    hermesTerminalOpen && 'border-primary/30 bg-primary/10 text-foreground'
                  )}
                  title="Toggle Hermes terminal"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={toggleTerminal}
                  className={cn(
                    chromeIconButtonClass,
                    terminalOpen && 'border-primary/30 bg-primary/10 text-foreground'
                  )}
                  title="Toggle terminal (Ctrl+`)"
                >
                  <TerminalSquare className="h-3.5 w-3.5" />
                </button>
                {miniBrowserDocked && rightSidebarHidden ? (
                  <button
                    onClick={() => setRightSidebarHidden(false)}
                    className={cn(
                      chromeIconButtonClass,
                      'border-primary/30 bg-primary/10 text-primary'
                    )}
                    title="Show browser"
                  >
                    <Globe className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <MiniBrowserToggle className={chromeIconButtonClass} />
                )}
              </div>

              {/* Commit button — only in single-panel mode (multi-panel has per-panel commit) */}
              {!isMultiPanel && activeRepo && changeCount > 0 && (
                <div className="flex items-center gap-2.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <button
                    onClick={() => handleOpenChangesSidebar(focusedPanelId)}
                    className={cn(
                      chromeActionButtonClass,
                      'font-mono tabular-nums',
                      preview.isOpen && preview.activeView === 'changes'
                        ? 'border-primary/30 bg-primary/10 text-foreground'
                        : ''
                    )}
                  >
                    <FileCode2 className="h-3.5 w-3.5" />
                    <SlotNumber value={lineTotals.added} prefix="+" className="text-emerald-500" />
                    <span className="text-muted-foreground/40">/</span>
                    <SlotNumber value={lineTotals.removed} prefix="-" className="text-red-400" />
                  </button>
                  <button
                    onClick={() => { setPrPanelId(null); setPrModalMode('create'); setPrModalOpen(true); }}
                    disabled={stagedCount === 0}
                    className="inline-flex h-8 items-center gap-2 rounded-xl border border-border/60 bg-background/65 px-3 text-[12px] font-semibold text-foreground transition-colors duration-100 hover:bg-background/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <GitPullRequest className="h-3.5 w-3.5" />
                    Commit
                  </button>
                </div>
              )}
              {!isMultiPanel && activeRepo && focusedPullRequest && (
                <div className="flex items-center gap-2.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <button
                    onClick={() => { setPrPanelId(null); setPrModalMode('review'); setPrModalOpen(true); }}
                    className="inline-flex h-8 items-center gap-2 rounded-xl border border-border/60 bg-background/65 px-3 text-[12px] font-semibold text-foreground transition-colors duration-100 hover:bg-background/90"
                  >
                    <GitPullRequest className="h-3.5 w-3.5" />
                    {`PR #${focusedPullRequest.number}`}
                  </button>
                </div>
              )}
            </header>

            {/* Content — switches based on active tab */}
            <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
              {kanbanFullscreen ? (
                <div className="flex-1 min-h-0 overflow-hidden">
                  <ErrorBoundary>
                    <KanbanBoard onExitFullscreen={() => setKanbanFullscreen(false)} />
                  </ErrorBoundary>
                </div>
              ) : mcpStoreFullscreen ? (
                <div className="flex-1 min-h-0 overflow-hidden">
                  <ErrorBoundary>
                    <McpStoreView onExitFullscreen={() => setMcpStoreFullscreen(false)} />
                  </ErrorBoundary>
                </div>
              ) : (
              <div className="flex-1 overflow-hidden flex min-h-0">
                <div className="app-independent-pane flex-1 overflow-hidden">
                  <div
                    className={cn('h-full overflow-hidden', activeTab !== 'chat' && 'hidden')}
                    aria-hidden={activeTab !== 'chat'}
                  >
                    {selectedCronJobId ? (
                      <ErrorBoundary><CronHistoryChat /></ErrorBoundary>
                    ) : selectedSessionId ? (
                      <ErrorBoundary><SessionHistoryChat /></ErrorBoundary>
                    ) : (
                      <ErrorBoundary><ChatPanelContainer onOpenPR={handleOpenPRForPanel} /></ErrorBoundary>
                    )}
                  </div>
                </div>
                <div className={cn('app-independent-pane', activeTab !== 'chat' && 'hidden')} aria-hidden={activeTab !== 'chat'}>
                  <PreviewSidebar />
                </div>
                <DockedMiniBrowser />
                <DockedChatSidebar />
              </div>
              )}
              {hermesTerminalOpen && (
                <div className="flex-shrink-0 border-t border-border/60 flex flex-col" style={{ height: 300 }}>
                  <HermesPTYPanel ref={hermesTerminalRef} />
                </div>
              )}
              <Suspense fallback={<LazyFallback />}><TerminalPanel cwd={activeRepo?.name ? undefined : undefined} /></Suspense>
            </main>
          </div>
        </div>

        {/* Chat area status bar */}
        {activeTab === 'chat' && (
          <div className="flex items-center justify-between h-8 px-5 border-t border-[hsl(var(--border))] flex-shrink-0">
            <div className="flex items-center gap-2">
              {activeProvider === 'hermes' && <HermesUpdateButton />}
              <FeedbackButton />
            </div>
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="text-[11px] text-[hsl(var(--text-faint))] truncate">
                {footerProviderInfo?.label ?? footerProvider} · {footerDisplayModel}
              </span>
              {footerUsage && (
                <>
                  <Circle className={cn(
                    'h-1.5 w-1.5 shrink-0',
                    footerUsage.percentage > 90
                      ? 'fill-red-400 text-red-400'
                      : footerUsage.percentage > 70
                        ? 'fill-amber-400 text-amber-400'
                        : 'fill-[#FF8800] text-[#FF8800]'
                  )} />
                  <span className={cn(
                    'font-mono tabular-nums text-[11px]',
                    footerUsage.percentage > 90
                      ? 'text-red-400'
                      : footerUsage.percentage > 70
                        ? 'text-amber-400'
                        : 'text-[hsl(var(--text-faint))]'
                  )}>
                    {Math.round(footerUsage.percentage)}%
                  </span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <MiniBrowser />
    </>
  );
};
