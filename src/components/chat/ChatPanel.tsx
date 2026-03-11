import React, { useCallback, useRef, useState, useEffect } from 'react';
import { X, MoreHorizontal, Pin, Pencil, Archive, Copy, PanelRight, GitPullRequest } from 'lucide-react';
import { ChatArea } from './ChatArea';
import { useChat } from '@/hooks/useChat';
import { useOrchestrator } from '@/hooks/useOrchestrator';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { usePanelStore } from '@/stores/panel-store';
import { useChatStore } from '@/stores/chat-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore } from '@/stores/preview-store';
import { PanelProvider } from '@/contexts/PanelContext';
import { cn } from '@/lib/utils';

interface ChatPanelProps {
  panelId: string;
  conversationId: string | null;
  isFocused: boolean;
  onFocus: () => void;
  onClose?: () => void;  // undefined for the last remaining panel (can't close)
  onOpenPR?: (panelId: string) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  panelId,
  conversationId,
  isFocused,
  onFocus,
  onClose,
  onOpenPR,
}) => {
  const { setConversationForPanel, panels, openPanel } = usePanelStore();
  const { conversations, deleteConversation, renameConversation, pinConversation } = useChatStore();
  const { getChangeCount, getLineTotals, getChangeset, getStagedCount } = useChangesetStore();
  const preview = usePreviewStore((s) => s.getPreview(panelId));
  const setPreviewOpen = usePreviewStore((s) => s.setOpen);
  const setPreviewView = usePreviewStore((s) => s.setView);
  const orchestratorEnabled = useOrchestratorStore((s) => s.enabled);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isMultiPanel = onClose !== undefined;
  const changeCount = getChangeCount(panelId);
  const lineTotals = getLineTotals(panelId, 'all');
  const stagedCount = getStagedCount(panelId);
  const { activeRepo } = getChangeset(panelId);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const handleConversationCreated = useCallback((newId: string) => {
    setConversationForPanel(panelId, newId);
  }, [panelId, setConversationForPanel]);

  // Use the orchestrator hook when enabled, otherwise the regular chat hook
  const regularChat = useChat(
    orchestratorEnabled ? null : conversationId,
    orchestratorEnabled ? undefined : handleConversationCreated,
    undefined,
    panelId,
  );

  const orchestratorChat = useOrchestrator(
    orchestratorEnabled ? conversationId : null,
    orchestratorEnabled ? handleConversationCreated : undefined,
  );

  const chat = orchestratorEnabled ? orchestratorChat : regularChat;

  // Get conversation for the panel header
  const activeConv = conversationId
    ? conversations.find((c) => c.id === conversationId)
    : null;
  const convTitle = activeConv?.title || (conversationId ? 'Chat' : 'New conversation');

  return (
    <PanelProvider value={panelId}>
      <div
        className={cn(
          'flex flex-col h-full',
          isMultiPanel && isFocused ? 'ring-1 ring-primary/40 ring-inset' : ''
        )}
        onClick={onFocus}
      >
        {/* Panel header - only show when multiple panels exist */}
        {isMultiPanel && (
          <div className="flex items-center h-9 px-3 border-b border-border bg-muted/20 shrink-0 gap-2">
            <span className="text-xs font-medium text-muted-foreground truncate flex-1 min-w-0">
              {convTitle}
            </span>

            {/* Commit button for this panel */}
            {activeRepo && changeCount > 0 && (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewView(panelId, 'changes');
                    setPreviewOpen(panelId, true);
                  }}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-mono font-medium tabular-nums transition-colors',
                    preview.isOpen && preview.activeView === 'changes'
                      ? 'border-primary/30 bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <PanelRight className="h-3 w-3" />
                  <span className="text-emerald-500">+{lineTotals.added}</span>
                  <span className="text-muted-foreground/40">/</span>
                  <span className="text-red-400">-{lineTotals.removed}</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPR?.(panelId);
                  }}
                  disabled={stagedCount === 0}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-foreground text-background hover:opacity-90 transition-opacity duration-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <GitPullRequest className="h-3 w-3" />
                  Commit
                </button>
              </div>
            )}

            {/* Thread menu */}
            <div className="relative shrink-0" ref={menuRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                }}
                className={cn(
                  'p-1 rounded transition-colors duration-100',
                  menuOpen
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
                title="Thread options"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>

              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 w-52 rounded-lg border border-border bg-popover shadow-lg z-50 py-1 text-[12px]">
                  {activeConv ? (
                    <>
                      <button
                        onClick={() => {
                          pinConversation(activeConv.id, !activeConv.pinned);
                          setMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted transition-colors duration-100"
                      >
                        <Pin className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 text-left">{activeConv.pinned ? 'Unpin thread' : 'Pin thread'}</span>
                      </button>
                      <button
                        onClick={() => {
                          const newTitle = prompt('Rename thread:', activeConv.title);
                          if (newTitle?.trim()) renameConversation(activeConv.id, newTitle.trim());
                          setMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted transition-colors duration-100"
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 text-left">Rename thread</span>
                      </button>
                      <button
                        onClick={() => {
                          deleteConversation(activeConv.id);
                          setConversationForPanel(panelId, null);
                          setMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted transition-colors duration-100"
                      >
                        <Archive className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 text-left">Archive thread</span>
                      </button>
                      <div className="my-1 border-t border-border" />
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(activeConv.id);
                          setMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted transition-colors duration-100"
                      >
                        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 text-left">Copy conversation ID</span>
                      </button>
                      {panels.length < 4 && (
                        <>
                          <div className="my-1 border-t border-border" />
                          <button
                            onClick={() => {
                              openPanel(activeConv.id);
                              setMenuOpen(false);
                            }}
                            className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted transition-colors duration-100"
                          >
                            <PanelRight className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="flex-1 text-left">Open in new panel</span>
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    <div className="px-3 py-2 text-muted-foreground text-center text-[11px]">
                      No active thread
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Close panel button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors duration-100 shrink-0"
              title="Close panel"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <ChatArea
            conversationId={conversationId}
            messages={chat.messages}
            input={chat.input}
            setInput={chat.setInput}
            handleSend={chat.handleSend}
            handleQuickSend={chat.handleQuickSend}
            queuedMessages={chat.queuedMessages}
            handleRemoveQueuedMessage={chat.handleRemoveQueuedMessage}
            handleSteerQueuedMessage={chat.handleSteerQueuedMessage}
            handleStop={chat.handleStop}
            handleRegenerate={chat.handleRegenerate}
            isStreaming={chat.isStreaming}
            error={chat.error}
            apiKeyModalOpen={chat.apiKeyModalOpen}
            setApiKeyModalOpen={chat.setApiKeyModalOpen}
            activeProvider={chat.activeProvider}
            activeModel={chat.activeModel}
            toolActivityMap={chat.toolActivityMap}
          />
        </div>
      </div>
    </PanelProvider>
  );
};
