import React, { useCallback, useRef, useState, useEffect } from 'react';
import { X, MoreHorizontal, Pin, Pencil, Archive, Copy, PanelRight, GitPullRequest } from 'lucide-react';
import { useShallow } from 'zustand/shallow';
import { ChatArea } from './ChatArea';
import { useChat } from '@/hooks/useChat';
import { usePanelStore } from '@/stores/panel-store';
import { useChatStore } from '@/stores/chat-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore } from '@/stores/preview-store';
import { useActivityStore } from '@/stores/activity-store';
import { PanelProvider } from '@/contexts/PanelContext';
import { CommandCallbacksProvider } from '@/contexts/CommandCallbacksContext';
import { cn } from '@/lib/utils';
import { SlotNumber } from '@/components/ui/SlotNumber';
import { getChatScopeId } from '@/lib/chat-scope';

interface ChatPanelProps {
  panelId: string;
  conversationId: string | null;
  isFocused: boolean;
  onFocus: () => void;
  onClose?: () => void;  // undefined for the last remaining panel (can't close)
  onOpenPR?: (panelId: string, mode?: 'create' | 'review') => void;
}

type ChatRuntime = ReturnType<typeof useChat>;

function ChatRuntimeArea({
  conversationId,
  chat,
}: {
  conversationId: string | null;
  chat: ChatRuntime;
}) {
  return (
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
      toolActivityMap={'toolActivityMap' in chat ? chat.toolActivityMap : undefined}
      agentStatus={'agentStatus' in chat ? chat.agentStatus : undefined}
      conversationAutoApproveEnabled={'conversationAutoApproveEnabled' in chat ? (chat.conversationAutoApproveEnabled as boolean) : false}
      setConversationAutoApprove={'setConversationAutoApprove' in chat ? (chat.setConversationAutoApprove as (value: boolean) => void) : undefined}
    />
  );
}

function StandardChatRuntime({
  panelId,
  conversationId,
  onConversationCreated,
  onOpenPR,
}: {
  panelId: string;
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
  onOpenPR?: (panelId: string, mode?: 'create' | 'review') => void;
}) {
  const scopeId = getChatScopeId(panelId, conversationId);
  const chat = useChat(conversationId, onConversationCreated, undefined, panelId, onOpenPR, scopeId);
  const setConversationForPanel = usePanelStore((s) => s.setConversationForPanel);
  const renameConversation = useChatStore((s) => s.renameConversation);

  const commandCallbacks = {
    stopAgent: chat.handleStop,
    retryMessage: chat.handleRegenerate,
    newConversation: conversationId
      ? () => setConversationForPanel(panelId, null)
      : undefined,
    renameConversation: conversationId
      ? (title: string) => renameConversation(conversationId, title)
      : undefined,
  };

  return (
    <CommandCallbacksProvider callbacks={commandCallbacks}>
      <ChatRuntimeArea conversationId={conversationId} chat={chat} />
    </CommandCallbacksProvider>
  );
}

function BackgroundStandardChatRuntime({
  panelId,
  conversationId,
}: {
  panelId: string;
  conversationId: string;
}) {
  useChat(conversationId, undefined, undefined, panelId, undefined, conversationId);
  return null;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  panelId,
  conversationId,
  isFocused,
  onFocus,
  onClose,
  onOpenPR,
}) => {
  const { setConversationForPanel, panels, openPanel, dockPanel } = usePanelStore();
  const activities = useActivityStore((s) => s.activities);
  const conversations = useChatStore((s) => s.conversations);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const pinConversation = useChatStore((s) => s.pinConversation);
  const getChangeCount = useChangesetStore((s) => s.getChangeCount);
  const getChangeset = useChangesetStore((s) => s.getChangeset);
  const getStagedCount = useChangesetStore((s) => s.getStagedCount);
  const getLineTotals = useChangesetStore((s) => s.getLineTotals);
  const scopeId = getChatScopeId(panelId, conversationId);
  const preview = usePreviewStore(useShallow((s) => s.getPreview(scopeId)));
  const setPreviewOpen = usePreviewStore((s) => s.setOpen);
  const setPreviewView = usePreviewStore((s) => s.setView);
  const [menuOpen, setMenuOpen] = useState(false);
  const [backgroundConversationIds, setBackgroundConversationIds] = useState<string[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const previousConversationIdRef = useRef<string | null>(conversationId);

  const isMultiPanel = onClose !== undefined;
  const changeCount = getChangeCount(scopeId);
  const stagedCount = getStagedCount(scopeId);
  const { activeRepo, pullRequest } = getChangeset(scopeId);
  const currentConv = conversations.find((c) => c.id === conversationId);
  const lineTotals = getLineTotals(scopeId);

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

  useEffect(() => {
    const previousConversationId = previousConversationIdRef.current;
    previousConversationIdRef.current = conversationId;

    setBackgroundConversationIds((current) => {
      let next = current;

      // If switching away from a streaming conversation, track it in background
      if (
        previousConversationId &&
        previousConversationId !== conversationId &&
        activities[previousConversationId]?.streaming &&
        !current.includes(previousConversationId)
      ) {
        next = [...next, previousConversationId];
      }

      // Filter out conversations that are no longer streaming or are now active
      next = next.filter((id) => id !== conversationId && activities[id]?.streaming);

      return next;
    });
  }, [activities, conversationId]);

  const handleConversationCreated = useCallback((newId: string) => {
    const nextScopeId = getChatScopeId(panelId, newId);
    if (nextScopeId !== panelId) {
      const changesetStore = useChangesetStore.getState();
      const previewStore = usePreviewStore.getState();
      changesetStore.replaceChangeset(nextScopeId, changesetStore.getChangeset(panelId));
      previewStore.replacePreview(nextScopeId, previewStore.getPreview(panelId));
    }
    setConversationForPanel(panelId, newId);
  }, [panelId, setConversationForPanel]);

  // Get conversation for the panel header
  const activeConv = conversationId
    ? conversations.find((c) => c.id === conversationId)
    : null;
  const convTitle = activeConv?.title || (conversationId ? 'Chat' : 'New conversation');

  return (
    <PanelProvider value={{ panelId, scopeId }}>
      <div
        className={cn(
          'flex flex-col h-full',
          isMultiPanel && isFocused ? 'ring-1 ring-primary/40 ring-inset' : ''
        )}
        onClick={onFocus}
      >
        {backgroundConversationIds.map((backgroundConversationId) => (
          <BackgroundStandardChatRuntime
            key={`background:${backgroundConversationId}`}
            panelId={panelId}
            conversationId={backgroundConversationId}
          />
        ))}
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
                    setPreviewView(scopeId, 'changes');
                    setPreviewOpen(scopeId, true);
                  }}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-mono font-medium tabular-nums transition-colors',
                    preview.isOpen && preview.activeView === 'changes'
                      ? 'border-primary/30 bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <PanelRight className="h-3 w-3" />
                  <SlotNumber value={lineTotals.added} prefix="+" className="text-emerald-500" />
                  <span className="text-muted-foreground/40">/</span>
                  <SlotNumber value={lineTotals.removed} prefix="-" className="text-red-400" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPR?.(panelId, 'create');
                  }}
                  disabled={stagedCount === 0}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-foreground text-background hover:opacity-90 transition-opacity duration-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <GitPullRequest className="h-3 w-3" />
                  Commit
                </button>
              </div>
            )}
            {activeRepo && pullRequest && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenPR?.(panelId, 'review');
                }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold border border-border/60 bg-background/65 text-foreground hover:bg-background/90 transition-colors duration-100"
              >
                <GitPullRequest className="h-3 w-3" />
                {`PR #${pullRequest.number}`}
              </button>
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
                      <div className="my-1 border-t border-border" />
                      <button
                        onClick={() => {
                          dockPanel(panelId, activeConv.id);
                          setMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted transition-colors duration-100"
                      >
                        <PanelRight className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 text-left">Pop out to sidebar</span>
                      </button>
                    </>
                  ) : (
                    <div className="px-3 py-2 text-muted-foreground text-center text-[11px]">
                      No active thread
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Pop out to sidebar button */}
            {conversationId && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dockPanel(panelId, conversationId);
                }}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors duration-100 shrink-0"
                title="Pop out to sidebar"
              >
                <PanelRight className="h-3 w-3" />
              </button>
            )}

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
          <StandardChatRuntime
            panelId={panelId}
            conversationId={conversationId}
            onConversationCreated={handleConversationCreated}
            onOpenPR={onOpenPR}
          />
        </div>
      </div>
    </PanelProvider>
  );
};
