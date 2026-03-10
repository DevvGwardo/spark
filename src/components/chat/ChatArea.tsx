import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { ActivityIndicator } from './ActivityIndicator';
import { WelcomeScreen } from './WelcomeScreen';
import { ApiKeyModal } from './ApiKeyModal';
import { ChangeApprovalModal } from './ChangeApprovalModal';
import { getProviderLabel } from '@/lib/providers';
import { findPendingProposal, type ProposalToolInvocationLike } from '@/lib/proposed-changes';
import type { QueuedMessage } from '@/lib/chat-queue';
import { useSettingsStore } from '@/stores/settings-store';
import { AlertCircle, X } from 'lucide-react';

interface ChatPartLike {
  type?: string;
  text?: string;
  reasoning?: string;
  toolInvocation?: ProposalToolInvocationLike;
}

interface ChatMessageLike {
  id: string;
  role: string;
  content: string;
  parts?: ChatPartLike[];
  toolInvocations?: ProposalToolInvocationLike[];
}

function getAssistantParts(message?: ChatMessageLike | null) {
  return Array.isArray(message?.parts) ? message.parts : [];
}

function hasInlineAssistantActivity(message?: ChatMessageLike | null) {
  return getAssistantParts(message).some((part) => {
    if (part?.type === 'tool-invocation') return true;
    if (part?.type === 'reasoning') return !!part.reasoning?.trim();
    if (part?.type === 'text') return !!part.text?.trim();
    return false;
  });
}

interface ChatAreaProps {
  conversationId: string | null;
  messages: ChatMessageLike[];
  input: string;
  setInput: (v: string) => void;
  handleSend: () => void;
  handleQuickSend?: (content: string) => Promise<void> | void;
  queuedMessages?: QueuedMessage[];
  handleRemoveQueuedMessage?: (messageId: string) => void;
  handleSteerQueuedMessage?: (messageId: string) => void;
  handleStop: () => void;
  handleRegenerate: () => void;
  isStreaming: boolean;
  error?: Error | null;
  apiKeyModalOpen: boolean;
  setApiKeyModalOpen: (v: boolean) => void;
  activeProvider: string;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  conversationId,
  messages,
  input,
  setInput,
  handleSend,
  handleQuickSend,
  queuedMessages = [],
  handleRemoveQueuedMessage,
  handleSteerQueuedMessage,
  handleStop,
  handleRegenerate,
  isStreaming,
  error,
  apiKeyModalOpen,
  setApiKeyModalOpen,
  activeProvider,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScroll = useRef(true);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [acceptingProposalId, setAcceptingProposalId] = useState<string | null>(null);
  const autoApproveRepoChanges = useSettingsStore((state) => state.autoApproveRepoChanges);
  const setAutoApproveRepoChanges = useSettingsStore((state) => state.setAutoApproveRepoChanges);

  // Reset dismissed error when a new error comes in
  const errorMessage = error?.message || null;
  const showError = errorMessage && errorMessage !== dismissedError;
  const lastAssistantMessage = [...messages].reverse().find((msg) => msg.role === 'assistant');
  const showFooterActivity = isStreaming && !hasInlineAssistantActivity(lastAssistantMessage);
  const pendingProposal = useMemo(() => findPendingProposal(messages), [messages]);

  const toolCallCount = useMemo(() => {
    let count = 0;
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const parts = Array.isArray(msg.parts) ? msg.parts : [];
      count += parts.filter((p) => p.type === 'tool-invocation').length;
      if (msg.toolInvocations) count += msg.toolInvocations.length;
    }
    return count;
  }, [messages]);

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

  useEffect(() => {
    if (!pendingProposal || pendingProposal.messageId !== acceptingProposalId || isStreaming) {
      setAcceptingProposalId(null);
    }
  }, [acceptingProposalId, isStreaming, pendingProposal]);

  const handleAcceptProposal = useCallback(async () => {
    if (!pendingProposal || !handleQuickSend || isStreaming) return;
    setAcceptingProposalId(pendingProposal.messageId);
    try {
      await handleQuickSend('go ahead');
    } catch {
      setAcceptingProposalId(null);
    }
  }, [pendingProposal, handleQuickSend, isStreaming]);

  const handleAcceptAlways = useCallback(async () => {
    setAutoApproveRepoChanges(true);
    await handleAcceptProposal();
  }, [handleAcceptProposal, setAutoApproveRepoChanges]);


  const modal = (
    <ApiKeyModal
      open={apiKeyModalOpen}
      onOpenChange={setApiKeyModalOpen}
      provider={activeProvider}
      providerLabel={getProviderLabel(activeProvider)}
    />
  );

  const errorBanner = showError ? (
    <div className="max-w-[720px] mx-auto w-full mb-2">
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
        <span className="flex-1 break-words">{errorMessage}</span>
        <button
          onClick={() => setDismissedError(errorMessage)}
          className="p-0.5 rounded hover:bg-destructive/10 shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  ) : null;

  if (!conversationId && messages.length === 0) {
    return (
      <div className="flex flex-col h-full px-4">
        <div className="flex-1" />
        <WelcomeScreen />
        <div className="w-full max-w-[720px] mx-auto mt-6">
          {errorBanner}
          <ActivityIndicator isStreaming={isStreaming} messages={messages} />
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            toolCallCount={toolCallCount}
            messages={messages}
            queuedMessages={queuedMessages}
            onRemoveQueuedMessage={handleRemoveQueuedMessage}
            onSteerQueuedMessage={handleSteerQueuedMessage}
          />
        </div>
        <div className="flex-[2]" />
        {modal}
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
            const parts = getAssistantParts(msg);

            // Extract reasoning from message parts
            const reasoning = msg.role === 'assistant'
              ? parts
                  .filter((p) => p.type === 'reasoning')
                  .map((p: ChatPartLike) => p.reasoning)
                  .join('\n') || undefined
              : undefined;

            // Extract tool invocations from message parts and/or toolInvocations field
            const partsToolInvocations = msg.role === 'assistant'
              ? parts
                  .filter((p: ChatPartLike) => p.type === 'tool-invocation')
                  .map((p: ChatPartLike) => p.toolInvocation) || []
              : [];
            const directToolInvocations = msg.toolInvocations || [];
            const toolInvocations = partsToolInvocations.length > 0 ? partsToolInvocations : directToolInvocations;

            // Reasoning is streaming if we're streaming, have reasoning content, but no text content yet (or still accumulating)
            const isReasoningStreaming = isLastAssistantStreaming && !!reasoning && !msg.content;

            return (
              <MessageBubble
                key={`${msg.id}-${i}`}
                message={{
                  id: msg.id,
                  conversationId: conversationId || '',
                  role: msg.role as 'user' | 'assistant',
                  content: msg.content,
                  timestamp: new Date().toISOString(),
                }}
                isStreaming={isLastAssistantStreaming}
                streamingContent={isLastAssistantStreaming ? msg.content : undefined}
                parts={parts}
                reasoning={reasoning}
                isReasoningStreaming={isReasoningStreaming}
                toolInvocations={toolInvocations}
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
      <div className="px-4">
        {errorBanner}
      </div>
      {showFooterActivity && <ActivityIndicator isStreaming={isStreaming} messages={messages} />}
      {pendingProposal && !autoApproveRepoChanges && (
        <ChangeApprovalModal
          proposal={pendingProposal}
          onAccept={handleAcceptProposal}
          onAcceptAlways={handleAcceptAlways}
          disabled={!handleQuickSend || isStreaming || acceptingProposalId === pendingProposal.messageId}
        />
      )}
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        onStop={handleStop}
        isStreaming={isStreaming}
        toolCallCount={toolCallCount}
        messages={messages}
        queuedMessages={queuedMessages}
        onRemoveQueuedMessage={handleRemoveQueuedMessage}
        onSteerQueuedMessage={handleSteerQueuedMessage}
      />
      {modal}
    </div>
  );
};
