import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown, ArrowRight, MessageSquare, Settings, Wrench, ClipboardList } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { ContextualSuggestions } from './ContextualSuggestions';
import { ActivityIndicator } from './ActivityIndicator';
import { VerificationGhostOverlay } from './VerificationGhostOverlay';
import type { AgentStatusEvent } from '@/hooks/useChat';
import { WelcomeScreen } from './WelcomeScreen';
import { ApiKeyModal } from './ApiKeyModal';
import { ChangeApprovalModal } from './ChangeApprovalModal';
import { ChatErrorBanner } from './ChatErrorBanner';
import { getProviderLabel } from '@/lib/providers';
import type { Provider } from '@/stores/settings-store';
import { getErrorMessage } from '@/lib/errors';
import {
  buildIssueFixFollowUpPrompt,
  buildIssueUpdateFollowUpPrompt,
  isIssueExplainPrompt,
} from '@/lib/issue-chat-prompts';
import {
  extractPseudoToolInvocations,
  extractTextFileEdits,
  getPseudoToolSourceText,
} from '@/lib/pseudo-tool-calls';
import { isRepoWriteMessage } from '@/lib/repo-intent';
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
import { useChatStore } from '@/stores/chat-store';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { useUIStore } from '@/stores/ui-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { useChatScopeId, usePanelId } from '@/contexts/PanelContext';

interface ChatPartLike {
  type?: 'text' | 'reasoning' | 'tool-invocation' | 'step-start' | 'source' | 'file';
  text?: string;
  reasoning?: string;
  toolInvocation?: ProposalToolInvocationLike;
}

interface ChatMessageLike {
  id: string;
  role: string;
  content: string;
  timestamp?: string;
  parts?: ChatPartLike[];
  toolInvocations?: ProposalToolInvocationLike[];
}

const REPO_WRITE_TOOL_NAMES = new Set([
  'edit_repo_file',
  'create_repo_file',
  'delete_repo_file',
  'batch_edit_repo_files',
]);

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
      if (part?.type === 'tool-invocation') {
        const inv = part.toolInvocation;
        return `tool:${inv?.toolName ?? ''}:${inv?.state ?? ''}`;
      }
      return part?.type ?? '';
    })
    .join('|');

  const invocationsDigest = Array.isArray(message.toolInvocations)
    ? message.toolInvocations.map((t) => `${t.toolName}:${t.state ?? ''}`).join(',')
    : '0';

  return `${message.id}:${message.content}:${partsDigest}:${invocationsDigest}`;
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

function countUniqueToolActivity(toolActivity: ToolActivityEvent[] = []) {
  const keys = new Set<string>();

  toolActivity.forEach((event, index) => {
    keys.add(`${event.tool}:${event.input}:${index}`);
  });

  return keys.size;
}

function getVisibleAssistantToolCount(
  message?: ChatMessageLike | null,
  toolActivity: ToolActivityEvent[] = [],
  pseudoWritesAllowed = true,
) {
  const activityCount = countUniqueToolActivity(toolActivity);
  if (activityCount > 0) {
    return activityCount;
  }

  if (!message || message.role !== 'assistant') {
    return activityCount;
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
  const pseudoCount = extractPseudoToolInvocations(pseudoSource)
    .filter((invocation) => pseudoWritesAllowed || !REPO_WRITE_TOOL_NAMES.has(invocation.toolName))
    .length;
  if (pseudoCount > 0) {
    return pseudoCount;
  }

  const textEditCount = pseudoWritesAllowed ? extractTextFileEdits(pseudoSource).length : 0;
  if (textEditCount > 0) {
    return textEditCount;
  }

  return activityCount;
}

function allowPseudoRepoWritesForAssistant(messages: ChatMessageLike[], assistantIndex: number): boolean {
  if (assistantIndex <= 0) {
    return false;
  }

  const previousUserMessage = messages.slice(0, assistantIndex).findLast((message) =>
    message.role === 'user' && typeof message.content === 'string' && message.content.trim().length > 0,
  );

  return previousUserMessage ? isRepoWriteMessage(previousUserMessage.content) : false;
}

function IssueNextStepCallout({
  issueNumber,
  issueTitle,
  onUpdateIssue,
  onFix,
  disabled,
}: {
  issueNumber: number;
  issueTitle: string;
  onUpdateIssue: () => void;
  onFix: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-4 rounded-xl border border-primary/20 bg-background p-6 shadow-[0_18px_60px_-28px_hsl(var(--foreground)/0.25)]">
      {/* Header row: icon + label on left, buttons on right */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary">
            <Settings className="h-5 w-5" />
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary">Issue</span>
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary">Analysis</span>
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary">Complete</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onUpdateIssue}
            disabled={disabled}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-primary/30 bg-transparent px-4 py-2 text-[13px] font-medium text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>Draft issue update</span>
          </button>
          <button
            type="button"
            onClick={onFix}
            disabled={disabled}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Wrench className="h-3.5 w-3.5" />
            <span>Fix issue in chat</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {/* Issue details below header */}
      <div className="mt-4">
        <p className="text-[15px] font-bold text-foreground">
          {`Issue #${issueNumber}`}
        </p>
        <p className="mt-2 text-sm leading-6 text-foreground/90">
          {issueTitle}
        </p>
        <p className="mt-3 text-[13px] leading-6 text-muted-foreground">
          Choose the next step in this same repo context: draft a GitHub issue update or move straight into the fix.
        </p>
      </div>
    </div>
  );
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
  activeProvider: Provider;
  activeModel: string;
  toolActivityMap?: Record<string, ToolActivityEvent[]>;
  agentStatus?: AgentStatusEvent | null;
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
  agentStatus,
  conversationAutoApproveEnabled = false,
  setConversationAutoApprove,
}) => {
  const panelId = usePanelId();
  const scopeId = useChatScopeId();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const isAutoScroll = useRef(true);
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;
  const pendingProposalCacheRef = useRef<{ digest: string; proposal: ReturnType<typeof findPendingProposal> }>({
    digest: '',
    proposal: null,
  });
  const messageTimestampCacheRef = useRef<Record<string, string>>({});
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [acceptingProposalId, setAcceptingProposalId] = useState<string | null>(null);
  const [approvalModalOpen, setApprovalModalOpen] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const notifiedProposalKeyRef = useRef<string | null>(null);

  const updateProviderConfig = useSettingsStore((state) => state.updateProviderConfig);
  const setPanelUsage = useContextUsageStore((state) => state.setPanelUsage);
  const clearPanelUsage = useContextUsageStore((state) => state.clearPanelUsage);
  const setSettingsOpen = useUIStore((state) => state.setSettingsOpen);
  const queuePanelPrompt = useUIStore((state) => state.queuePanelPrompt);
  const changeset = useChangesetStore((state) => state.getChangeset(scopeId));
  const planMode = useChatStore((state) => state.planMode);
  const repoComposerLocked = changeset.isRepoMode && changeset.repoFileTreeStatus === 'loading';
  const disabledPlaceholder = repoComposerLocked
    ? `Loading ${changeset.activeRepo?.fullName || 'repository'} files...`
    : undefined;

  // Reset dismissed error when a new error comes in
  const errorMessage = error ? getErrorMessage(error) : null;
  const showError = errorMessage && errorMessage !== dismissedError;
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastAssistantMessage = messages.findLast((msg) => msg.role === 'assistant');
  const lastUserMessage = messages.findLast((msg) => msg.role === 'user') ?? null;
  const lastUserMessageId = lastUserMessage?.id ?? null;
  const issueContext = changeset.activeRepo?.issue ?? null;
  const lastMessageIsAssistant = lastMessage?.role === 'assistant';
  const showIssueNextStepCallout = Boolean(
    issueContext &&
    lastMessageIsAssistant &&
    !isStreaming &&
    Object.keys(changeset.changes).length === 0 &&
    lastUserMessage &&
    isIssueExplainPrompt(lastUserMessage.content),
  );
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
    !isStreaming &&
    !conversationAutoApproveEnabled,
  );
  const showInlineApprovalBanner = canShowProposalApproval && approvalModalOpen && !!pendingProposal;
  const activeToolActivity = (() => {
    if (!toolActivityMap) return [];
    if (lastMessage && toolActivityMap[lastMessage.id]) {
      return toolActivityMap[lastMessage.id] || [];
    }
    return toolActivityMap.current || [];
  })();
  const lastMessageDigest = getMessageScrollDigest(lastMessage);
  const toolActivityDigest = getToolActivityDigest(activeToolActivity);
  const lastAssistantIndex = lastAssistantMessage
    ? messages.findIndex((message) => message.id === lastAssistantMessage.id)
    : -1;
  const lastAssistantAllowsPseudoRepoWrites = lastAssistantIndex >= 0
    ? allowPseudoRepoWritesForAssistant(messages, lastAssistantIndex)
    : false;

  const toolCallCount = useMemo(
    () => getVisibleAssistantToolCount(
      lastAssistantMessage,
      activeToolActivity,
      lastAssistantAllowsPseudoRepoWrites,
    ),
    [activeToolActivity, lastAssistantAllowsPseudoRepoWrites, lastAssistantMessage],
  );

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    // During streaming, Virtuoso fires atBottom=false when in-place content
    // growth (tool calls, streaming parts) pushes the bottom below the
    // viewport.  Don't disable auto-scroll for that — only honour an
    // explicit user-scroll-away when NOT streaming.
    if (atBottom) {
      isAutoScroll.current = true;
    } else if (!isStreamingRef.current) {
      isAutoScroll.current = false;
    }
    setShowScrollButton((prev) => {
      const next = !atBottom;
      return prev === next ? prev : next;
    });
  }, []);

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

  const scrollToBottom = useCallback(() => {
    if (messages.length === 0) return;
    virtuosoRef.current?.scrollToIndex({
      index: messages.length - 1,
      align: 'end',
      behavior: 'smooth',
    });
    isAutoScroll.current = true;
    setShowScrollButton(false);
  }, [messages.length]);

  const handleSendWithScroll = useCallback(() => {
    isAutoScroll.current = true;
    setShowScrollButton(false);
    handleSend();
  }, [handleSend]);

  // When streaming content grows in-place (tool calls injected into the last
  // message, text appended to parts), the Virtuoso data array length doesn't
  // change so followOutput won't fire.  Nudge the scroll position ourselves.
  useEffect(() => {
    if (!isStreaming || !isAutoScroll.current || messages.length === 0) return;
    virtuosoRef.current?.scrollToIndex({
      index: messages.length - 1,
      align: 'end',
      behavior: 'smooth',
    });
  }, [isStreaming, lastMessageDigest, toolActivityDigest, messages.length]);

  useEffect(() => {
    if (
      acceptingProposalId !== null &&
      (!pendingProposalId || pendingProposalId !== acceptingProposalId || isStreaming)
    ) {
      setAcceptingProposalId(null);
    }
  }, [acceptingProposalId, isStreaming, pendingProposalId]);

  useEffect(() => {
    const shouldOpen = canShowProposalApproval;
    setApprovalModalOpen((prev) => prev === shouldOpen ? prev : shouldOpen);
  }, [canShowProposalApproval]);

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

  const handleRewind = useCallback(async (messageId: string) => {
    if (!conversationId) return;
    const rewindConversation = useChatStore.getState().rewindConversation;
    const forkId = await rewindConversation(conversationId, messageId);
    if (forkId) {
      const selectConversation = useChatStore.getState().selectConversation;
      selectConversation(forkId);
    }
  }, [conversationId]);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, [setSettingsOpen]);

  const handleSwitchHermesModel = useCallback((model: string) => {
    if (activeProvider !== 'hermes') return;
    updateProviderConfig('hermes', { model });
    setDismissedError(errorMessage);
  }, [activeProvider, errorMessage, updateProviderConfig]);

  const handleIssueFix = useCallback(() => {
    const activeRepo = useChangesetStore.getState().getChangeset(scopeId).activeRepo;
    if (!activeRepo?.issue) {
      return;
    }

    isAutoScroll.current = true;
    setShowScrollButton(false);
    queuePanelPrompt(panelId, {
      content: buildIssueFixFollowUpPrompt({
        fullName: activeRepo.fullName,
        baseFullName: activeRepo.baseFullName,
        issue: activeRepo.issue,
      }),
      autoSend: true,
      repoEditIntentOverride: true,
    });
  }, [panelId, queuePanelPrompt, scopeId]);

  const handleIssueUpdate = useCallback(() => {
    const activeRepo = useChangesetStore.getState().getChangeset(scopeId).activeRepo;
    if (!activeRepo?.issue) {
      return;
    }

    isAutoScroll.current = true;
    setShowScrollButton(false);
    queuePanelPrompt(panelId, {
      content: buildIssueUpdateFollowUpPrompt({
        fullName: activeRepo.fullName,
        baseFullName: activeRepo.baseFullName,
        issue: activeRepo.issue,
      }),
      autoSend: true,
      repoEditIntentOverride: false,
    });
  }, [panelId, queuePanelPrompt, scopeId]);

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
        {planMode && (
          <div className="flex items-center gap-2 rounded-md bg-purple-500/10 px-3 py-1.5 text-xs text-purple-400 ring-1 ring-purple-500/20 mx-auto mt-2">
            <ClipboardList className="h-3.5 w-3.5" />
            <span>Plan Mode — read-only exploration, no file edits</span>
          </div>
        )}
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
          <VerificationGhostOverlay />
          <ActivityIndicator
            isStreaming={isStreaming}
            messages={messages}
            toolActivity={toolActivityMap?.current}
            statusLabel={agentStatus?.label}
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
            agentStatusLabel={agentStatus?.label}
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
      {planMode && (
        <div className="flex items-center gap-2 rounded-md bg-purple-500/10 px-3 py-1.5 text-xs text-purple-400 ring-1 ring-purple-500/20 mx-20 mt-2">
          <ClipboardList className="h-3.5 w-3.5" />
          <span>Plan Mode — read-only exploration, no file edits</span>
        </div>
      )}
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        followOutput={() => isAutoScroll.current ? 'smooth' : false}
        atBottomStateChange={handleAtBottomChange}
        className="min-h-0 flex-1"
        data-testid="virtuoso-scroller"
        itemContent={(index, msg) => {
          const isLastAssistantStreaming =
            isStreaming && msg.role === 'assistant' && index === messages.length - 1;
          const allowPseudoRepoWrites = msg.role === 'assistant'
            ? allowPseudoRepoWritesForAssistant(messages, index)
            : false;
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

          // Only the currently-streaming assistant message should receive
          // 'current' tool activity. Other messages use their migrated
          // message-specific activity (keyed by msg.id) or nothing.
          const messageToolActivity = toolActivityMap?.[msg.id]
            || (isLastAssistantStreaming ? toolActivityMap?.['current'] : undefined);

          return (
            <div className="max-w-[720px] mx-auto px-20 py-6">
              <MessageBubble
                key={msg.id}
                message={{
                  id: msg.id,
                  conversationId: conversationId || '',
                  role: msg.role as 'user' | 'assistant',
                  content: msg.content,
                  timestamp: msg.timestamp || (messageTimestampCacheRef.current[msg.id] ??= new Date().toISOString()),
                }}
                isStreaming={isLastAssistantStreaming}
                streamingContent={isLastAssistantStreaming ? msg.content : undefined}
                parts={parts as React.ComponentProps<typeof MessageBubble>['parts']}
                reasoning={reasoning}
                isReasoningStreaming={isReasoningStreaming}
                toolInvocations={toolInvocations as React.ComponentProps<typeof MessageBubble>['toolInvocations']}
                toolActivity={messageToolActivity}
                allowPseudoRepoWrites={allowPseudoRepoWrites}
                onRegenerate={
                  msg.role === 'assistant' && index === messages.length - 1 && !isStreaming
                    ? handleRegenerate
                    : undefined
                }
                onRewind={
                  msg.role === 'assistant' && !isLastAssistantStreaming && msg.id
                    ? () => handleRewind(msg.id)
                    : undefined
                }
              />
            </div>
          );
        }}
        components={{
          Footer: React.memo(() => (
            <>
              {showInlineApprovalBanner && (
                <div className="max-w-[720px] mx-auto px-20">
                  <ChangeApprovalModal
                    open={approvalModalOpen}
                    onOpenChange={setApprovalModalOpen}
                    proposal={pendingProposal}
                    onAccept={handleAcceptProposal}
                    onAcceptAlways={handleAcceptAlways}
                    disabled={!handleQuickSend || isStreaming || acceptingProposalId === pendingProposal.messageId}
                  />
                </div>
              )}
              {showIssueNextStepCallout && issueContext && (
                <div className="max-w-[720px] mx-auto px-20 pb-6">
                  <IssueNextStepCallout
                    issueNumber={issueContext.number}
                    issueTitle={issueContext.title}
                    onUpdateIssue={handleIssueUpdate}
                    onFix={handleIssueFix}
                    disabled={repoComposerLocked}
                  />
                </div>
              )}
              {showFooterActivity && (
                <ActivityIndicator
                  isStreaming={isStreaming}
                  messages={messages}
                  toolActivity={toolActivityMap?.current}
                  statusLabel={agentStatus?.label}
                />
              )}
            </>
          )),
        }}
      />
      {showScrollButton && isStreaming && (
        <div className="flex justify-center py-1">
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground shadow-md backdrop-blur-sm transition-opacity hover:text-foreground"
            aria-label="Scroll to bottom"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="px-4">
        {errorBanner}
      </div>
      <ContextualSuggestions
        messages={messages}
        isStreaming={isStreaming}
        onSend={(prompt) => {
          if (handleQuickSend) {
            handleQuickSend(prompt);
          } else {
            setInput(prompt);
          }
        }}
      />
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={handleSendWithScroll}
        onStop={handleStop}
        isStreaming={isStreaming}
        toolCallCount={toolCallCount}
        disabled={repoComposerLocked}
        disabledPlaceholder={disabledPlaceholder}
        messages={messages}
        activeProvider={activeProvider}
        activeModel={activeModel}
        agentStatusLabel={agentStatus?.label}
        queuedMessages={queuedMessages}
        onRemoveQueuedMessage={handleRemoveQueuedMessage}
        onSteerQueuedMessage={handleSteerQueuedMessage}
      />
      {modal}
    </div>
  );
};
