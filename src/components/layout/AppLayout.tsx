import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ChatSidebar } from '@/components/sidebar/ChatSidebar';
import { ChatPanelContainer } from '@/components/chat/ChatPanelContainer';
import { CronHistoryChat } from '@/components/chat/CronHistoryChat';
import { SessionHistoryChat } from '@/components/chat/SessionHistoryChat';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { SetupWizard } from '@/components/settings/SetupWizard';
import { CreatePRModal } from '@/components/github/CreatePRModal';
import { RepoIssueBrowser } from '@/components/github/RepoIssueBrowser';
import { useUIStore } from '@/stores/ui-store';
import { useShallow } from 'zustand/shallow';
import { useSettingsStore } from '@/stores/settings-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { PreviewSidebar } from '@/components/preview/PreviewSidebar';
import { usePreviewStore } from '@/stores/preview-store';
import { useChatStore } from '@/stores/chat-store';
import { useCronStore } from '@/stores/cron-store';
import { usePanelStore } from '@/stores/panel-store';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { useTheme } from '@/hooks/useTheme';
import { useGlobalStyles } from '@/hooks/useGlobalStyles';
import { PROVIDERS } from '@/lib/providers';
import { getChatScopeId } from '@/lib/chat-scope';
import { PanelLeft, GitPullRequest, MoreHorizontal, Circle, Pin, Pencil, Archive, Copy, PanelRight, Plus, FileCode2, MessageSquare, TerminalSquare, Globe } from 'lucide-react';
import { TerminalPanel } from '@/components/terminal/TerminalPanel';
import { MiniBrowser, MiniBrowserToggle, DockedMiniBrowser } from '@/components/browser/MiniBrowser';
import { SlotNumber } from '@/components/ui/SlotNumber';
import { cn } from '@/lib/utils';

export const AppLayout: React.FC = () => {
  useTheme();
  useGlobalStyles();
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
    selectedCronJobId,
    selectedSessionId,
    miniBrowserDocked,
    rightSidebarHidden,
    setRightSidebarHidden,
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
  const [prModalOpen, setPrModalOpen] = useState(false);
  const [prPanelId, setPrPanelId] = useState<string | null>(null); // which panel triggered the PR modal
  const [prModalMode, setPrModalMode] = useState<'create' | 'review'>('create');
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const focusedPanel = panels.find((p) => p.id === focusedPanelId);
  const focusedScopeId = getChatScopeId(focusedPanelId, focusedPanel?.conversationId ?? null);
  const preview = usePreviewStore((s) => s.getPreview(focusedScopeId));

  // Get changeset for the focused panel (used in global header for single-panel mode)
  const focusedChangeset = getChangeset(focusedScopeId);
  const activeRepo = focusedChangeset.activeRepo;
  const focusedPullRequest = focusedChangeset.pullRequest;
  const changeCount = getChangeCount(focusedScopeId);
  const stagedCount = getStagedCount(focusedScopeId);
  const focusedConvId = focusedPanel?.conversationId ?? null;
  const focusedConv = useChatStore((s) => s.conversations.find((c) => c.id === focusedConvId));
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

  // Keyboard shortcut: Ctrl+` to toggle terminal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault();
        toggleTerminal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleTerminal]);

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

  // Sidebar resize handling
  const isResizing = useRef(false);
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onMouseMove = (ev: MouseEvent) => {
        if (!isResizing.current) return;
        const newWidth = startWidth + (ev.clientX - startX);
        setSidebarWidth(newWidth);
      };

      const onMouseUp = () => {
        isResizing.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
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

  return (
    <>
      {!isSetupComplete && <SetupWizard />}
      <SettingsModal />
      <RepoIssueBrowser isOpen={repoBrowserOpen} onClose={() => setRepoBrowserOpen(false)} />
      {prActiveRepo && (
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
      )}

      <div className="h-[100dvh] flex flex-col bg-[hsl(var(--frame-bg))] p-0 gap-0">
        <div className="flex-1 flex min-h-0 gap-0">
          {/* Sidebar + resize handle wrapper */}
          <div className="flex-shrink-0 relative" style={sidebarOpen ? { width: sidebarWidth } : { width: 0 }}>
            <div
              className={cn(
                'h-full overflow-hidden bg-[hsl(var(--sidebar-bg))] border-r border-[hsl(var(--sidebar-border))]',
                !sidebarOpen && 'w-0 border-r-0'
              )}
              style={sidebarOpen ? { width: sidebarWidth, transition: isResizing.current ? 'none' : 'width 200ms' } : { transition: 'width 200ms' }}
            >
              <div className="h-full" style={{ width: sidebarWidth }}>
                <ChatSidebar />
              </div>
            </div>
            {/* Resize handle — positioned to straddle the sidebar edge */}
            {sidebarOpen && (
              <div
                onMouseDown={handleResizeStart}
                className="absolute top-0 -right-1.5 w-3 h-full cursor-col-resize z-10 group"
              >
                <div className="absolute inset-y-6 bottom-6 left-1/2 -translate-x-1/2 w-px rounded-full bg-border/20 group-hover:bg-primary/30 group-active:bg-primary/50 transition-colors" />
              </div>
            )}
          </div>

          {/* Mobile overlay */}
          {sidebarOpen && (
            <div
              className="md:hidden fixed inset-0 z-40 bg-foreground/10"
              onClick={() => setSidebarOpen(false)}
            />
          )}

          {/* Main */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background">
            {/* Header */}
            <header className="flex items-center h-[48px] px-5 flex-shrink-0 border-b border-border/60 bg-background" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
              {/* Collapsed sidebar controls — sits in the traffic light area */}
              {!sidebarOpen && (
                <div className="flex items-center gap-2 mr-3 pl-[60px]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
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
                      className={chromeActionButtonClass}
                      title="New thread"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>New thread</span>
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
                <div className="flex items-center gap-2.5 ml-3 min-w-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <div className="flex h-5 w-5 items-center justify-center rounded-[4px] bg-[#2a2a2a]"><MessageSquare className="h-2.5 w-2.5 text-[hsl(var(--text-muted))]" /></div>
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

                              {panels.length < 4 && (
                                <>
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

              {/* Terminal toggle */}
              <div className="flex items-center mr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
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
            <main className="flex-1 overflow-hidden flex flex-col">
              <div className="flex-1 overflow-hidden flex min-h-0">
                <div className="flex-1 overflow-hidden">
                  <div
                    className={cn('h-full overflow-hidden', activeTab !== 'chat' && 'hidden')}
                    aria-hidden={activeTab !== 'chat'}
                  >
                    {selectedCronJobId ? (
                      <CronHistoryChat />
                    ) : selectedSessionId ? (
                      <SessionHistoryChat />
                    ) : (
                      <ChatPanelContainer onOpenPR={handleOpenPRForPanel} />
                    )}
                  </div>
                </div>
                <div className={cn(activeTab !== 'chat' && 'hidden')} aria-hidden={activeTab !== 'chat'}>
                  <PreviewSidebar />
                </div>
                <DockedMiniBrowser />
              </div>
              <TerminalPanel cwd={activeRepo?.name ? undefined : undefined} />
            </main>
          </div>
        </div>

        {/* Chat area status bar */}
        {activeTab === 'chat' && (
          <div className="flex items-center justify-end h-8 px-5 border-t border-[hsl(var(--border))] flex-shrink-0">
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
