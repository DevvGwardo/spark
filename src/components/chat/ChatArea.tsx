import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { ActivityIndicator } from './ActivityIndicator';
import { WelcomeScreen } from './WelcomeScreen';
import { ApiKeyModal } from './ApiKeyModal';
import { ChangeApprovalModal } from './ChangeApprovalModal';
import { ChatErrorBanner } from './ChatErrorBanner';
import { getProviderLabel } from '@/lib/providers';
import { getErrorMessage } from '@/lib/errors';
import {
  extractPseudoToolInvocations,
  extractTextFileEdits,
  getPseudoToolSourceText,
} from '@/lib/pseudo-tool-calls';
import {
  findPendingProposal,
  getProposalDigest,
  hasRepoContinuationAfterProposal,
  type ProposalToolInvocationLike,
} from '@/lib/proposed-changes';
import { getContextUsage } from '@/lib/tokens';
import type { QueuedMessage } from '@/lib/chat-queue';
import type { ToolActivityEvent } from './AgentActivity';
import { useSettingsStore } from '@/stores/settings-store';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { useUIStore } from '@/stores/ui-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePanelId } from '@/contexts/PanelContext';

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

function getMessageScrollDigest(message?: ChatMessageLike | null) {
  if (!message) return '';

  const partsDigest = getAssistantParts(message)
    .map((part) => {
      if (part?.type === 'text') return `text:${part.text ?? ''}`;
      if (part?.type === 'reasoning') return `reasoning:${part.reasoning ?? ''}`;
      if (part?.type === 'tool-invocation') return `tool:${part.toolInvocation?.toolName ?? ''}`;
      return part?.type ?? '';
    })
    .join('|');

  return `${message.id}:${message.content}:${partsDigest}:${message.toolInvocations?.length ?? 0}`;
}

function getToolActivityDigest(toolActivity: ToolActivityEvent[] = []) {
  return toolActivity
    .map((event) => `${event.tool}:${event.status}:${event.input}:${event.output ?? ''}`)
    .join('|');
}

function getToolInvocationKey(invocation: ProposalToolInvocationLike, fallbackIndex: number): string {
  if (invocation.toolCallId) {
    return invocation.toolCallId;
  }

  const path = typeof invocation.args?.path === 'string' ? invocation.args.path : '';
  const filename = typeof invocation.args?.filename === 'string' ? invocation.args.filename : '';
  const batchPaths = Array.isArray(invocation.args?.changes)
    ? invocation.args.changes
        .map((change) =>
          change && typeof change === 'object'
            ? `${typeof change.action === 'string' ? change.action : ''}:${typeof change.path === 'string' ? change.path : ''}`
            : '',
        )
        .join('|')
    : '';

  return `${invocation.toolName}:${path}:${filename}:${batchPaths || fallbackIndex}`;
}

function countUniqueToolInvocations(invocations: ProposalToolInvocationLike[] = []) {
  const keys = new Set<string>();

  invocations.forEach((invocation, index) => {
    keys.add(getToolInvocationKey(invocation, index));
  });

  return keys.size;
}

function getVisibleAssistantToolCount(message?: ChatMessageLike | null, toolActivity: ToolActivityEvent[] = []) {
  if (!message || message.role !== 'assistant') {
    return 0;
  }

  const parts = getAssistantParts(message);
  const structuredParts = parts
    .filter((part): part is ChatPartLike & { toolInvocation: ProposalToolInvocationLike } =>
      part.type === 'tool-invocation' && !!part.toolInvocation,
    )
    .map((part) => part.toolInvocation);
  const directInvocations = Array.isArray(message.toolInvocations) ? message.toolInvocations : [];

  const structuredCount = countUniqueToolInvocations(
    structuredParts.length > 0 ? structuredParts : directInvocations,
  );
  if (structuredCount > 0) {
    return structuredCount;
  }

  const pseudoSource = getPseudoToolSourceText({
    content: message.content,
    parts: parts.map((part) => ({ type: part.type, text: part.text })),
  });
  const pseudoCount = extractPseudoToolInvocations(pseudoSource).length;
  if (pseudoCount > 0) {
    return pseudoCount;
  }

  const textEditCount = extractTextFileEdits(pseudoSource).length;
  if (textEditCount > 0) {
    return textEditCount;
  }

  return toolActivity.length;
}

function isNearBottom(element: HTMLDivElement, threshold = 100) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
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
  activeModel: string;
  toolActivityMap?: Record<string, ToolActivityEvent[]>;
  conversationAutoApproveEnabled?: boolean;
  setConversationAutoApprove?: (value: boolean) => void;
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
  activeModel,
  toolActivityMap,
  conversationAutoApproveEnabled = false,
  setConversationAutoApprove,
}) => {
  const panelId = usePanelId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScroll = useRef(true);
  const touchStartYRef = useRef<number | null>(null);
  const pendingProposalCacheRef = useRef<{ digest: string; proposal: ReturnType<typeof findPendingProposal> }>({
    digest: '',
    proposal: null,
  });
  const messageTimestampCacheRef = useRef<Record<string, string>>({});
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [acceptingProposalId, setAcceptingProposalId] = useState<string | null>(null);
  const [approvalModalOpen, setApprovalModalOpen] = useState(false);
  const notifiedProposalKeyRef = useRef<string | null>(null);

  const updateProviderConfig = useSettingsStore((state) => state.updateProviderConfig);
  const setPanelUsage = useContextUsageStore((state) => state.setPanelUsage);
  const clearPanelUsage = useContextUsageStore((state) => state.clearPanelUsage);
  const setSettingsOpen = useUIStore((state) => state.setSettingsOpen);
  const changeset = useChangesetStore((state) => state.getChangeset(panelId));
  const repoComposerLocked = changeset.isRepoMode && changeset.repoFileTreeStatus === 'loading';
  const disabledPlaceholder = repoComposerLocked
    ? `Loading ${changeset.activeRepo?.fullName || 'repository'} files...`
    : undefined;

  // Reset dismissed error when a new error comes in
  const errorMessage = error ? getErrorMessage(error) : null;
  const showError = errorMessage && errorMessage !== dismissedError;
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastAssistantMessage = [...messages].reverse().find((msg) => msg.role === 'assistant');
  const lastUserMessageId = [...messages].reverse().find((msg) => msg.role === 'user')?.id ?? null;
  const showFooterActivity = isStreaming && !hasInlineAssistantActivity(lastAssistantMessage);
  const proposalDigest = getProposalDigest(messages);
  if (pendingProposalCacheRef.current.digest !== proposalDigest) {
    pendingProposalCacheRef.current = {
      digest: proposalDigest,
      proposal: findPendingProposal(messages),
    };
  }
  const pendingProposal = pendingProposalCacheRef.current.proposal;
  const pendingProposalId = pendingProposal?.messageId ?? null;
  const proposalHasContinuation = pendingProposal
    ? hasRepoContinuationAfterProposal(messages, pendingProposal.messageId)
    : false;
  const canShowProposalApproval = Boolean(
    conversationId &&
    pendingProposal &&
    !proposalHasContinuation &&
    !conversationAutoApproveEnabled,
  );
  const showInlineApprovalBanner = canShowProposalApproval && approvalModalOpen && !!pendingProposal;
  const activeToolActivity = (() => {
    if (!lastMessage || !toolActivityMap) return [];
    return toolActivityMap[lastMessage.id] || toolActivityMap.current || [];
  })();
  const lastMessageDigest = getMessageScrollDigest(lastMessage);
  const toolActivityDigest = getToolActivityDigest(activeToolActivity);

  const toolCallCount = useMemo(
    () => getVisibleAssistantToolCount(lastAssistantMessage, activeToolActivity),
    [activeToolActivity, lastAssistantMessage],
  );

  useEffect(() => {
    if (!isAutoScroll.current || !scrollRef.current) return;

    const frame = window.requestAnimationFrame(() => {
      if (!isAutoScroll.current || !scrollRef.current) return;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    conversationId,
    isStreaming,
    lastMessageDigest,
    toolActivityDigest,
    messages.length,
    showInlineApprovalBanner,
  ]);

  useEffect(() => {
    const hasMessageHistory = messages.some((message) => message.content.trim().length > 0);
    if (!hasMessageHistory) {
      clearPanelUsage(panelId);
      return;
    }

    // Debounce during streaming to avoid excessive re-renders
    if (isStreaming) {
      const timer = setTimeout(() => {
        setPanelUsage(panelId, {
          provider: activeProvider,
          model: activeModel,
          ...getContextUsage(messages, activeModel),
        });
      }, 500);
      return () => clearTimeout(timer);
    }

    setPanelUsage(panelId, {
      provider: activeProvider,
      model: activeModel,
      ...getContextUsage(messages, activeModel),
    });
  }, [activeModel, activeProvider, clearPanelUsage, isStreaming, messages, panelId, setPanelUsage]);

  useEffect(() => () => clearPanelUsage(panelId), [clearPanelUsage, panelId]);

  useEffect(() => {
    setDismissedError(null);
  }, [lastUserMessageId]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAutoScroll.current = isNearBottom(el);
  }, []);

  const handleWheelCapture = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      isAutoScroll.current = false;
    }
  }, []);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    touchStartYRef.current = touch.clientY;
  }, []);

  const handleTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;

    if (touchStartYRef.current !== null && touch.clientY > touchStartYRef.current) {
      isAutoScroll.current = false;
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    touchStartYRef.current = null;
  }, []);

  useEffect(() => {
    if (
      acceptingProposalId !== null &&
      (!pendingProposalId || pendingProposalId !== acceptingProposalId || isStreaming)
    ) {
      setAcceptingProposalId(null);
    }
  }, [acceptingProposalId, isStreaming, pendingProposalId]);

  useEffect(() => {
    const shouldOpen = Boolean(conversationId && pendingProposalId && !proposalHasContinuation);
    setApprovalModalOpen((prev) => prev === shouldOpen ? prev : shouldOpen);
  }, [conversationId, pendingProposalId, proposalHasContinuation]);

  useEffect(() => {
    if (!canShowProposalApproval || !pendingProposal || !conversationId) {
      notifiedProposalKeyRef.current = null;
      void window.electronAPI?.clearAttentionRequest?.();
      return;
    }

    const proposalKey = `${conversationId}:${pendingProposal.messageId}`;
    if (notifiedProposalKeyRef.current === proposalKey) {
      return;
    }

    notifiedProposalKeyRef.current = proposalKey;
    const summary = pendingProposal.summary || pendingProposal.excerpt || 'Hermes is waiting for your approval before editing repo files.';
    const body = summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;

    void window.electronAPI?.notifyAttentionRequest?.({
      title: 'CloudChat approval needed',
      body,
    });
  }, [canShowProposalApproval, conversationId, pendingProposal]);

  const handleAcceptProposal = useCallback(async () => {
    if (!conversationId || !pendingProposal || !handleQuickSend || isStreaming) return;
    setApprovalModalOpen(false);
    setAcceptingProposalId(pendingProposal.messageId);
    try {
      await handleQuickSend('go ahead');
    } catch {
      setApprovalModalOpen(true);
      setAcceptingProposalId(null);
    }
  }, [conversationId, pendingProposal, handleQuickSend, isStreaming]);

  const handleAcceptAlways = useCallback(async () => {
    setConversationAutoApprove?.(true);
    await handleAcceptProposal();
  }, [handleAcceptProposal, setConversationAutoApprove]);

  const handleDismissError = useCallback(() => {
    setDismissedError(errorMessage);
  }, [errorMessage]);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, [setSettingsOpen]);

  const handleSwitchHermesModel = useCallback((model: string) => {
    if (activeProvider !== 'hermes') return;
    updateProviderConfig('hermes', { model });
    setDismissedError(errorMessage);
  }, [activeProvider, errorMessage, updateProviderConfig]);

  const modal = (
    <ApiKeyModal
      open={apiKeyModalOpen}
      onOpenChange={setApiKeyModalOpen}
      provider={activeProvider}
      providerLabel={getProviderLabel(activeProvider)}
    />
  );

  const errorBanner = showError ? (
    <ChatErrorBanner
      message={errorMessage}
      activeProvider={activeProvider}
      activeModel={activeModel}
      onDismiss={handleDismissError}
      onOpenSettings={handleOpenSettings}
      onSwitchModel={handleSwitchHermesModel}
    />
  ) : null;

  if (!conversationId && messages.length === 0) {
    return (
      <div className="flex flex-col h-full px-4">
        <div className="flex-1" />
        <WelcomeScreen onSendMessage={(message) => {
          if (handleQuickSend) {
            handleQuickSend(message);
          } else {
            setInput(message);
          }
        }} disableRepoActions={repoComposerLocked} />
        <div className="w-full max-w-[720px] mx-auto mt-6">
          {errorBanner}
          <ActivityIndicator
            isStreaming={isStreaming}
            messages={messages}
            toolActivity={toolActivityMap?.current}
          />
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            toolCallCount={toolCallCount}
            disabled={repoComposerLocked}
            disabledPlaceholder={disabledPlaceholder}
            messages={messages}
            activeProvider={activeProvider}
            activeModel={activeModel}
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
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheelCapture={handleWheelCapture}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
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
                  timestamp: (messageTimestampCacheRef.current[msg.id] ??= new Date().toISOString()),
                }}
                isStreaming={isLastAssistantStreaming}
                streamingContent={isLastAssistantStreaming ? msg.content : undefined}
                parts={parts}
                reasoning={reasoning}
                isReasoningStreaming={isReasoningStreaming}
                toolInvocations={toolInvocations}
                toolActivity={toolActivityMap?.[msg.id] || toolActivityMap?.['current']}
                onRegenerate={
                  msg.role === 'assistant' && i === messages.length - 1 && !isStreaming
                    ? handleRegenerate
                    : undefined
                }
              />
            );
          })}
          {showInlineApprovalBanner && (
            <ChangeApprovalModal
              open={approvalModalOpen}
              onOpenChange={setApprovalModalOpen}
              proposal={pendingProposal}
              onAccept={handleAcceptProposal}
              onAcceptAlways={handleAcceptAlways}
              disabled={!handleQuickSend || isStreaming || acceptingProposalId === pendingProposal.messageId}
            />
          )}
        </div>
      </div>
      <div className="px-4">
        {errorBanner}
      </div>
      {showFooterActivity && (
        <ActivityIndicator
          isStreaming={isStreaming}
          messages={messages}
          toolActivity={toolActivityMap?.current}
        />
      )}
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        onStop={handleStop}
        isStreaming={isStreaming}
        toolCallCount={toolCallCount}
        disabled={repoComposerLocked}
        disabledPlaceholder={disabledPlaceholder}
        messages={messages}
        activeProvider={activeProvider}
        activeModel={activeModel}
        queuedMessages={queuedMessages}
        onRemoveQueuedMessage={handleRemoveQueuedMessage}
        onSteerQueuedMessage={handleSteerQueuedMessage}
      />
      {modal}
    </div>
  );
};
