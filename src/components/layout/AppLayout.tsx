import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ChatSidebar } from '@/components/sidebar/ChatSidebar';
import { ChatPanelContainer } from '@/components/chat/ChatPanelContainer';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { SetupWizard } from '@/components/settings/SetupWizard';
import { GitHubPanel, GitHubAnalyzer } from '@/components/github';
import { KnowledgePanel } from '@/components/settings/KnowledgePanel';
import { CreatePRModal } from '@/components/github/CreatePRModal';
import { useUIStore } from '@/stores/ui-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { PreviewSidebar } from '@/components/preview/PreviewSidebar';
import { usePreviewStore } from '@/stores/preview-store';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { useTheme } from '@/hooks/useTheme';
import { useGlobalStyles } from '@/hooks/useGlobalStyles';
import { PROVIDERS } from '@/lib/providers';
import { formatTokenCount } from '@/lib/tokens';
import { PanelLeft, GitPullRequest, MoreHorizontal, GitBranch, Shield, Circle, Pin, Pencil, Archive, Copy, PanelRight, Plus, FileCode2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export const AppLayout: React.FC = () => {
  useTheme();
  useGlobalStyles();
  const { sidebarOpen, setSidebarOpen, toggleSidebar, sidebarWidth, setSidebarWidth, activeTab } = useUIStore();
  const { isSetupComplete, activeProvider, providers } = useSettingsStore();
  const { getChangeset, getChangeCount, getLineTotals, clearChanges, getStagedCount, getStagedChanges } = useChangesetStore();
  const { conversations, deleteConversation, renameConversation, pinConversation } = useChatStore();
  const { panels, focusedPanelId, openPanel, setConversationForPanel, focusPanel } = usePanelStore();
  const footerUsage = useContextUsageStore((state) => state.panelUsage[focusedPanelId]);
  const preview = usePreviewStore((s) => s.getPreview(focusedPanelId));
  const setPreviewOpen = usePreviewStore((s) => s.setOpen);
  const setPreviewView = usePreviewStore((s) => s.setView);
  const isMultiPanel = panels.length > 1;
  const [prModalOpen, setPrModalOpen] = useState(false);
  const [prPanelId, setPrPanelId] = useState<string | null>(null); // which panel triggered the PR modal
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  // Get changeset for the focused panel (used in global header for single-panel mode)
  const focusedChangeset = getChangeset(focusedPanelId);
  const activeRepo = focusedChangeset.activeRepo;
  const changeCount = getChangeCount(focusedPanelId);
  const lineTotals = getLineTotals(focusedPanelId, 'all');
  const stagedCount = getStagedCount(focusedPanelId);

  // For the PR modal, use the panel that triggered it (or focused panel in single-panel mode)
  const prTargetPanelId = prPanelId || focusedPanelId;
  const prChangeset = getChangeset(prTargetPanelId);
  const prActiveRepo = prChangeset.activeRepo;
  const pendingFiles = getStagedChanges(prTargetPanelId).map(c => ({ path: c.path, content: c.content, action: c.action }));

  // Get active conversation title
  const focusedPanel = panels.find((p) => p.id === focusedPanelId);
  const activeConv = focusedPanel?.conversationId
    ? conversations.find((c) => c.id === focusedPanel.conversationId)
    : null;

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

  const config = providers[activeProvider];
  const footerProvider = activeTab === 'chat' ? footerUsage?.provider ?? activeProvider : activeProvider;
  const footerModel = activeTab === 'chat' ? footerUsage?.model ?? config.model : config.model;
  const footerProviderInfo = PROVIDERS[footerProvider as keyof typeof PROVIDERS];
  const footerDisplayModel = footerModel.split('/').pop() || footerModel;
  const footerContextLabel = activeTab === 'chat' && footerUsage
    ? `${formatTokenCount(footerUsage.used)} / ${formatTokenCount(footerUsage.total)} context`
    : null;
  const headerSecondaryLabel = activeTab === 'chat'
    ? activeRepo?.name ?? null
    : activeTab === 'github'
      ? 'Repository tools'
      : activeTab === 'analyzer'
        ? 'Diagnostics'
        : 'Workspace memory';
  const chromeIconButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded-xl border border-border/60 bg-background/60 text-muted-foreground transition-colors duration-100 hover:bg-background/85 hover:text-foreground';
  const chromeActionButtonClass = 'inline-flex h-8 items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3 text-[12px] font-medium text-muted-foreground transition-colors duration-100 hover:bg-background/85 hover:text-foreground';

  // Header title based on active tab
  const headerTitle = activeTab === 'chat'
    ? (activeConv?.title || 'New thread')
    : activeTab === 'github'
      ? 'GitHub'
      : activeTab === 'analyzer'
        ? 'Analyzer'
        : 'Knowledge';

  const handlePrSuccess = useCallback(() => {
    clearChanges(prTargetPanelId);
    // Don't close the modal — let the user see the success screen with the GitHub link
  }, [clearChanges, prTargetPanelId]);

  // Callback for per-panel commit buttons
  const handleOpenPRForPanel = useCallback((targetPanelId: string) => {
    setPrPanelId(targetPanelId);
    focusPanel(targetPanelId);
    setPrModalOpen(true);
  }, [focusPanel]);

  const handleOpenChangesSidebar = useCallback((panelId: string) => {
    setPreviewView(panelId, 'changes');
    setPreviewOpen(panelId, true);
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
      {prActiveRepo && (
        <CreatePRModal
          isOpen={prModalOpen}
          onClose={() => { setPrModalOpen(false); setPrPanelId(null); }}
          owner={prActiveRepo.owner}
          repo={prActiveRepo.name}
          baseBranch={prActiveRepo.defaultBranch}
          files={pendingFiles}
          onSuccess={handlePrSuccess}
        />
      )}

      <div className="h-[100dvh] flex flex-col bg-[hsl(var(--sidebar-bg))] p-3 gap-3">
        <div className="flex-1 flex min-h-0 gap-3">
          {/* Sidebar + resize handle wrapper */}
          <div className="flex-shrink-0 relative" style={sidebarOpen ? { width: sidebarWidth } : { width: 0 }}>
            <div
              className={cn(
                'h-full overflow-hidden rounded-[22px] border border-border/60 bg-background/88',
                !sidebarOpen && 'w-0'
              )}
              style={sidebarOpen ? { width: sidebarWidth, transition: isResizing.current ? 'none' : 'width 200ms' } : { transition: 'width 200ms' }}
            >
              <div className="h-full" style={{ width: sidebarWidth }}>
                <ChatSidebar />
              </div>
            </div>
            {/* Resize handle — positioned to straddle the sidebar edge and the gap */}
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
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden rounded-[22px] border border-border/60 bg-background/92">
            {/* Header */}
            <header className="flex items-center h-[58px] px-4 flex-shrink-0 border-b border-border/60 bg-background/88" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
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
                  {activeTab === 'chat' && (
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
                  <div className="min-w-0">
                    <h1 className="truncate text-[13px] font-semibold tracking-[-0.015em] text-foreground">
                      {headerTitle}
                    </h1>
                    {headerSecondaryLabel && (
                      <p className="truncate text-[11px] text-muted-foreground">
                        {headerSecondaryLabel}
                      </p>
                    )}
                  </div>
                  {activeTab === 'chat' && (
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

              <div className="flex-1" />

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
                    <span className="text-emerald-500">+{lineTotals.added}</span>
                    <span className="text-muted-foreground/40">/</span>
                    <span className="text-red-400">-{lineTotals.removed}</span>
                  </button>
                  <button
                    onClick={() => { setPrPanelId(null); setPrModalOpen(true); }}
                    disabled={stagedCount === 0}
                    className="inline-flex h-8 items-center gap-2 rounded-xl border border-border/60 bg-background/65 px-3 text-[12px] font-semibold text-foreground transition-colors duration-100 hover:bg-background/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <GitPullRequest className="h-3.5 w-3.5" />
                    Commit
                  </button>
                </div>
              )}
            </header>

            {/* Content — switches based on active tab */}
            <main className="flex-1 overflow-hidden flex">
              <div className="flex-1 overflow-hidden">
                <div
                  className={cn('h-full overflow-hidden', activeTab !== 'chat' && 'hidden')}
                  aria-hidden={activeTab !== 'chat'}
                >
                  <ChatPanelContainer onOpenPR={handleOpenPRForPanel} />
                </div>
                {activeTab === 'github' && <GitHubPanel />}
                {activeTab === 'analyzer' && (
                  <div className="h-full overflow-y-auto p-6">
                    <GitHubAnalyzer />
                  </div>
                )}
                {activeTab === 'knowledge' && (
                  <div className="h-full overflow-y-auto p-6">
                    <KnowledgePanel />
                  </div>
                )}
              </div>
              <div className={cn(activeTab !== 'chat' && 'hidden')} aria-hidden={activeTab !== 'chat'}>
                <PreviewSidebar />
              </div>
            </main>
          </div>
        </div>

        {/* Bottom status bar — Codex style */}
        <footer className="flex items-center h-7 px-4 text-[11px] leading-7 text-muted-foreground gap-4 flex-shrink-0 border-t border-border">
          <div className="flex items-center gap-1.5">
            <Shield className="h-3 w-3" />
            <span>Default permissions</span>
          </div>
          {activeRepo && (
            <div className="flex items-center gap-1.5">
              <Circle className="h-2 w-2 fill-emerald-500 text-emerald-500" />
              <span>Editing</span>
              <GitBranch className="h-3 w-3 ml-1" />
              <span className="font-mono">{activeRepo.fullName}</span>
            </div>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono truncate">
              {footerProviderInfo?.label ?? footerProvider} · {footerDisplayModel}
            </span>
            {footerContextLabel && (
              <>
                <span className="text-muted-foreground/35">·</span>
                <span className="font-mono tabular-nums text-foreground/80">
                  {footerContextLabel}
                </span>
              </>
            )}
          </div>
        </footer>
      </div>
    </>
  );
};
