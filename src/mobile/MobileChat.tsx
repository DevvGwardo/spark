import { useCallback, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Sparkles } from 'lucide-react';
import { useChat } from '@/hooks/useChat';
import { ChatArea } from '@/components/chat/ChatArea';
import { useChatStore } from '@/stores/chat-store';

const MOBILE_PANEL_ID = 'mobile-chat';

function truncateTitle(title: string, maxLen = 40): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen - 1) + '…';
}

/**
 * Mobile-optimized chat view for the /m/chat route.
 *
 * Reuses the standard useChat hook and ChatArea component from the desktop
 * experience, wrapped in a mobile viewport (max-w-[390px]) with navigation
 * back to the mobile shell and a "New Chat" button for fresh conversations.
 */
const MobileChat = () => {
  const navigate = useNavigate();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const [chatTitle, setChatTitle] = useState('Chat');

  // Create a new conversation on mount if none selected
  const startNewChat = useCallback(() => {
    setIsCreatingChat(true);
    // The ChatArea + useChat will create a new conversation when
    // conversationId is null and the user sends a message. Force
    // a fresh state by cycling through null.
    setConversationId(null);
    setChatTitle('Chat');
    // Note: we intentionally do NOT setIsCreatingChat(false) here.
    // React 18 batches all setState calls within the same synchronous callback,
    // so the true/false updates would collapse and the loading state would
    // never render. handleConversationCreated already resets this to false
    // when the conversation actually resolves.
  }, []);

  // Start with a fresh chat on mount
  useEffect(() => {
    startNewChat();
  }, [startNewChat]);

  const handleConversationCreated = useCallback((id: string) => {
    setConversationId(id);
    setIsCreatingChat(false);

    // Try to get the title from the store
    try {
      const store = useChatStore.getState();
      const conv = store.conversations.find((c: { id: string }) => c.id === id);
      if (conv && 'title' in conv && typeof conv.title === 'string') {
        setChatTitle(truncateTitle(conv.title || 'Chat'));
      }
    } catch {
      // Store may not be ready yet
    }
  }, []);

  const chat = useChat(
    conversationId,
    handleConversationCreated,
    undefined,
    MOBILE_PANEL_ID,
    undefined,
    conversationId ?? undefined,
  );

  // Update title when conversation changes
  useEffect(() => {
    if (!conversationId) return;
    try {
      const store = useChatStore.getState();
      const conv = store.conversations.find((c: { id: string }) => c.id === conversationId);
      if (conv && 'title' in conv && typeof conv.title === 'string' && conv.title) {
        setChatTitle(truncateTitle(conv.title));
      }
    } catch {
      // ignore
    }
  }, [conversationId, chat.messages]);

  return (
    <div className="mx-auto flex min-h-screen max-w-[390px] flex-col overflow-x-hidden bg-background">
      {/* Top bar */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2.5">
        <button
          type="button"
          onClick={() => navigate('/m')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back to dashboard"
          style={{ minHeight: 44, minWidth: 44 }}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate font-sans text-[13px] font-medium text-foreground">
            {chatTitle}
          </h1>
          {chat.isStreaming && (
            <p className="font-sans text-[10px] text-muted-foreground/60">
              Streaming…
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={startNewChat}
          disabled={isCreatingChat}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          aria-label="New chat"
          style={{ minHeight: 44, minWidth: 44 }}
        >
          <Plus className="h-4 w-4" />
        </button>
      </header>

      {/* Chat area */}
      <div className="flex-1 min-h-0">
        {isCreatingChat ? (
          <div className="flex flex-col items-center justify-center py-20 px-4">
            <Sparkles className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="font-sans text-[13px] text-muted-foreground/60">
              Starting a new chat…
            </p>
          </div>
        ) : (
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
            isAnotherPanelStreamingSameProfile={chat.isAnotherPanelStreamingSameProfile}
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
        )}
      </div>
    </div>
  );
};

export default MobileChat;
