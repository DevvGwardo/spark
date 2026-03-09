import React, { useRef, useEffect, useCallback, useState } from 'react';
import { GitPullRequest } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { WelcomeScreen } from './WelcomeScreen';
import { ApiKeyModal } from './ApiKeyModal';
import { CreatePRModal } from '@/components/github/CreatePRModal';
import { useChat } from '@/hooks/useChat';
import { useChatStore } from '@/stores/chat-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { getProviderLabel } from '@/lib/providers';

export const ChatArea: React.FC = () => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScroll = useRef(true);
  const { activeConversationId } = useChatStore();
  const { activeRepo, changes, getChangeCount, clearChanges } = useChangesetStore();
  const [prModalOpen, setPrModalOpen] = useState(false);

  const {
    messages,
    input,
    setInput,
    handleSend,
    handleStop,
    handleRegenerate,
    isStreaming,
    apiKeyModalOpen,
    setApiKeyModalOpen,
    activeProvider,
  } = useChat();

  const changeCount = getChangeCount();
  const pendingFiles = Object.values(changes).map(c => ({ path: c.path, content: c.content }));

  useEffect(() => {
    if (isAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 100;
    isAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  const handlePrSuccess = useCallback(() => {
    clearChanges();
    setPrModalOpen(false);
  }, [clearChanges]);

  const modal = (
    <ApiKeyModal
      open={apiKeyModalOpen}
      onOpenChange={setApiKeyModalOpen}
      provider={activeProvider}
      providerLabel={getProviderLabel(activeProvider)}
    />
  );

  const prModal = activeRepo && (
    <CreatePRModal
      isOpen={prModalOpen}
      onClose={() => setPrModalOpen(false)}
      owner={activeRepo.owner}
      repo={activeRepo.name}
      baseBranch={activeRepo.defaultBranch}
      files={pendingFiles}
      onSuccess={handlePrSuccess}
    />
  );

  const createPRButton = activeRepo && changeCount > 0 && (
    <button
      onClick={() => setPrModalOpen(true)}
      className="fixed bottom-24 right-6 z-40 flex items-center gap-2 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium shadow-lg hover:bg-primary/90 transition-colors"
    >
      <GitPullRequest className="h-4 w-4" />
      Create PR ({changeCount} change{changeCount > 1 ? 's' : ''})
    </button>
  );

  if (!activeConversationId && messages.length === 0) {
    return (
      <div className="flex flex-col items-center h-full px-4">
        <div className="flex-1" />
        <WelcomeScreen />
        <div className="w-full max-w-[720px] mt-8">
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            messages={messages}
          />
        </div>
        <div className="flex-1" />
        {modal}
        {createPRButton}
        {prModal}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-[720px] mx-auto px-4 py-6">
          {messages.map((msg, i) => {
            const isLastAssistantStreaming =
              isStreaming && msg.role === 'assistant' && i === messages.length - 1;

            return (
              <MessageBubble
                key={msg.id}
                message={{
                  id: msg.id,
                  conversationId: activeConversationId || '',
                  role: msg.role as 'user' | 'assistant',
                  content: msg.content,
                  timestamp: new Date().toISOString(),
                }}
                isStreaming={isLastAssistantStreaming}
                streamingContent={isLastAssistantStreaming ? msg.content : undefined}
                onRegenerate={
                  msg.role === 'assistant' && i === messages.length - 1 && !isStreaming
                    ? handleRegenerate
                    : undefined
                }
              />
            );
          })}
        </div>
      </div>
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        onStop={handleStop}
        isStreaming={isStreaming}
        messages={messages}
      />
      {modal}
      {createPRButton}
      {prModal}
    </div>
  );
};
