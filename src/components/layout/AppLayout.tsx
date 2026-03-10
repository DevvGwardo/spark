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
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { useTheme } from '@/hooks/useTheme';
import { useGlobalStyles } from '@/hooks/useGlobalStyles';
import { PROVIDERS } from '@/lib/providers';
import { PanelLeft, GitPullRequest, MoreHorizontal, GitBranch, Shield, Circle, Pin, Pencil, Archive, Copy, PanelRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

export const AppLayout: React.FC = () => {
  useTheme();
  useGlobalStyles();
  const { sidebarOpen, setSidebarOpen, toggleSidebar, sidebarWidth, setSidebarWidth, activeTab } = useUIStore();
  const { isSetupComplete, activeProvider, providers } = useSettingsStore();
  const { getChangeset, getChangeCount, getLineTotals, clearChanges } = useChangesetStore();
  const { conversations, deleteConversation, renameConversation, pinConversation } = useChatStore();
  const { panels, focusedPanelId, openPanel, setConversationForPanel, focusPanel } = usePanelStore();
  const isMultiPanel = panels.length > 1;
  const [prModalOpen, setPrModalOpen] = useState(false);
  const [prPanelId, setPrPanelId] = useState<string | null>(null); // which panel triggered the PR modal
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  // Get changeset for the focused panel (used in global header for single-panel mode)
  const focusedChangeset = getChangeset(focusedPanelId);
  const activeRepo = focusedChangeset.activeRepo;
  const changeCount = getChangeCount(focusedPanelId);
  const lineTotals = getLineTotals(focusedPanelId);

  // For the PR modal, use the panel that triggered it (or focused panel in single-panel mode)
  const prTargetPanelId = prPanelId || focusedPanelId;
  const prChangeset = getChangeset(prTargetPanelId);
  const prActiveRepo = prChangeset.activeRepo;
  const pendingFiles = Object.values(prChangeset.changes).map(c => ({ path: c.path, content: c.content, action: c.action }));

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

  const providerInfo = PROVIDERS[activeProvider];
  const config = providers[activeProvider];
  const displayModel = config.model.split('/').pop() || config.model;

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

      <div className="h-[100dvh] flex flex-col bg-[hsl(var(--sidebar-bg))] p-2 gap-2">
        <div className="flex-1 flex min-h-0 gap-2">
          {/* Sidebar + resize handle wrapper */}
          <div className="flex-shrink-0 relative" style={sidebarOpen ? { width: sidebarWidth } : { width: 0 }}>
            <div
              className={cn(
                'bg-[hsl(var(--sidebar-bg))] rounded-xl overflow-hidden h-full',
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
                <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 group-hover:bg-primary/30 group-active:bg-primary/50 transition-colors rounded-full" />
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
          <div className={cn("flex-1 flex flex-col min-w-0 bg-[hsl(var(--sidebar-bg))] overflow-hidden", sidebarOpen && "border-l border-border")}>
            {/* Header */}
            <header className={cn("flex items-center h-[52px] px-4 flex-shrink-0 bg-background/50")} style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
              {/* Collapsed sidebar controls — sits in the traffic light area */}
              {!sidebarOpen && (
                <div className="flex items-center gap-1 mr-3 pl-[60px]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <button
                    onClick={toggleSidebar}
                    className="p-2 rounded-lg hover:bg-muted transition-colors duration-100 text-muted-foreground hover:text-foreground"
                    title="Open sidebar"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </button>
                  {activeTab === 'chat' && (
                    <button
                      onClick={() => setConversationForPanel(focusedPanelId, null)}
                      className="p-2 rounded-lg hover:bg-muted transition-colors duration-100 text-muted-foreground hover:text-foreground"
                      title="New thread"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}

              {/* Sidebar toggle when sidebar is open */}
              {sidebarOpen && (
                <button
                  onClick={toggleSidebar}
                  className="p-2 rounded-lg hover:bg-muted transition-colors duration-100 text-muted-foreground hover:text-foreground"
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  title="Close sidebar"
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
              )}

              {/* Thread/page title — only show in single-panel or non-chat tabs */}
              {(!isMultiPanel || activeTab !== 'chat') && (
                <div className="flex items-center gap-2 ml-3 min-w-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <h1 className="text-[13px] font-semibold tracking-[-0.01em] truncate max-w-[400px]">
                    {headerTitle}
                  </h1>
                  {activeTab === 'chat' && (
                    <div className="relative" ref={headerMenuRef}>
                      <button
                        onClick={() => setHeaderMenuOpen((v) => !v)}
                        className={cn(
                          'p-1 rounded-lg transition-colors duration-100',
                          headerMenuOpen
                            ? 'bg-muted text-foreground'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                        )}
                        title="Thread options"
                      >
                        <MoreHorizontal className="h-4 w-4" />
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
                <div className="flex items-center gap-2 ml-3 min-w-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <h1 className="text-[13px] font-semibold tracking-[-0.01em] text-muted-foreground">
                    {panels.length} panels
                  </h1>
                </div>
              )}

              <div className="flex-1" />

              {/* Commit button — only in single-panel mode (multi-panel has per-panel commit) */}
              {!isMultiPanel && activeRepo && changeCount > 0 && (
                <div className="flex items-center gap-2.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <button
                    onClick={() => { setPrPanelId(null); setPrModalOpen(true); }}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-foreground text-background hover:opacity-90 transition-opacity duration-100 shadow-sm"
                  >
                    <GitPullRequest className="h-3.5 w-3.5" />
                    Commit
                  </button>
                  <span className="text-[11px] font-mono font-medium tabular-nums flex items-center gap-1">
                    <span className="text-emerald-500">+{lineTotals.added}</span>
                    <span className="text-muted-foreground/40">/</span>
                    <span className="text-red-400">-{lineTotals.removed}</span>
                  </span>
                </div>
              )}
            </header>

            {/* Content — switches based on active tab */}
            <main className="flex-1 overflow-hidden flex">
              <div className="flex-1 overflow-hidden">
                {activeTab === 'chat' && <ChatPanelContainer onOpenPR={handleOpenPRForPanel} />}
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
              {activeTab === 'chat' && <PreviewSidebar />}
            </main>
          </div>
        </div>

        {/* Bottom status bar — Codex style */}
        <footer className="flex items-center h-7 px-4 text-[11px] text-muted-foreground gap-4 flex-shrink-0 border-t border-border">
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
          <span className="font-mono">
            {providerInfo?.label} · {displayModel}
          </span>
        </footer>
      </div>
    </>
  );
};
