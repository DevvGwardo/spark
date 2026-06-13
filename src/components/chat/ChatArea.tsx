import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown, ArrowRight, MessageSquare, Settings, Wrench, ClipboardList } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { ContextualSuggestions } from './ContextualSuggestions';
import { ActivityIndicator } from './ActivityIndicator';
import { AgentTaskPanel } from './AgentTaskPanel';
import { VerificationGhostOverlay } from './VerificationGhostOverlay';
import type { AgentStatusEvent } from '@/hooks/useChat';
import { WelcomeScreen } from './WelcomeScreen';
import { ApiKeyModal } from './ApiKeyModal';
import { ChangeApprovalModal } from './ChangeApprovalModal';
import { ChatErrorBanner } from './ChatErrorBanner';
import { ChatSurfaceBackground } from './ChatSurfaceBackground';
import { BuddyComparisonPanel, type BuddyResponse } from './BuddyComparisonPanel';
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
  type PendingProposal,
  type ProposalToolInvocationLike,
} from '@/lib/proposed-changes';
import { getContextUsage } from '@/lib/tokens';
import type { QueuedMessage } from '@/lib/chat-queue';
import type { ToolActivityEvent } from './AgentActivity';
import { useActivityStore } from '@/stores/activity-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useChatStore } from '@/stores/chat-store';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { useUIStore } from '@/stores/ui-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { useHermesStore } from '@/stores/hermes-store';
import { useChatScopeId, usePanelId } from '@/contexts/PanelContext';
import {
  getProposalApprovalKey,
  matchApprovalPolicy,
} from '@/lib/approval-policy';

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

  if (invocation.toolName && (path || filename || batchPaths)) {
    return `${invocation.toolName}:${path}:${filename}:${batchPaths}`;
  }

  if (invocation.toolCallId) {
    return `${invocation.toolName ?? ''}:${invocation.toolCallId}`;
  }

  return `${invocation.toolName}:${JSON.stringify(invocation.args ?? {}) || fallbackIndex}`;
}

function getMessageToolInvocations(message?: ChatMessageLike | null): ProposalToolInvocationLike[] {
  const merged: ProposalToolInvocationLike[] = [];
  const seen = new Set<string>();

  const appendInvocation = (invocation: ProposalToolInvocationLike | undefined | null) => {
    if (!invocation) {
      return;
    }

    const key = getToolInvocationKey(invocation, merged.length);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push(invocation);
  };

  getAssistantParts(message)
    .filter((part): part is ChatPartLike & { toolInvocation: ProposalToolInvocationLike } =>
      part.type === 'tool-invocation' && !!part.toolInvocation,
    )
    .forEach((part) => appendInvocation(part.toolInvocation));

  if (Array.isArray(message?.toolInvocations)) {
    message.toolInvocations.forEach((invocation) => appendInvocation(invocation));
  }

  return merged;
}

function mergeAssistantPartsWithToolInvocations(
  parts: ChatPartLike[],
  toolInvocations: ProposalToolInvocationLike[],
): ChatPartLike[] {
  const merged = [...parts];
  const seen = new Set(
    parts
      .filter((part): part is ChatPartLike & { toolInvocation: ProposalToolInvocationLike } =>
        part.type === 'tool-invocation' && !!part.toolInvocation,
      )
      .map((part, index) => getToolInvocationKey(part.toolInvocation, index)),
  );

  toolInvocations.forEach((invocation, index) => {
    const key = getToolInvocationKey(invocation, parts.length + index);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push({ type: 'tool-invocation', toolInvocation: invocation });
  });

  return merged;
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
  const structuredCount = countUniqueToolInvocations(getMessageToolInvocations(message));
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

interface ChatVirtuosoFooterState {
  showInlineApprovalBanner: boolean;
  approvalModalOpen: boolean;
  onApprovalModalOpenChange: (open: boolean) => void;
  pendingProposal: PendingProposal | null;
  onApproveOnce: () => void | Promise<void>;
  onApproveSession: () => void | Promise<void>;
  onApproveAlways: () => void | Promise<void>;
  handleQuickSend?: (content: string) => Promise<void> | void;
  isStreaming: boolean;
  acceptingProposalId: string | null;
  showIssueNextStepCallout: boolean;
  issueContext: { number: number; title: string } | null;
  onIssueUpdate: () => void;
  onIssueFix: () => void;
  repoComposerLocked: boolean;
  buddyResponse?: BuddyResponse | null;
  lastAssistantMessage?: ChatMessageLike | null;
  activeModel: string;
  onUseBuddyResponse?: (content: string) => void;
  showFooterActivity: boolean;
  messages: ChatMessageLike[];
  toolActivity?: ToolActivityEvent[];
  agentStatusLabel?: string;
}

interface ChatVirtuosoContext {
  footer: ChatVirtuosoFooterState;
}

const ChatVirtuosoFooter = React.memo(function ChatVirtuosoFooter({
  context,
}: {
  context?: ChatVirtuosoContext;
}) {
  const footer = context?.footer;
  if (!footer) return null;

  const {
    showInlineApprovalBanner,
    approvalModalOpen,
    onApprovalModalOpenChange,
    pendingProposal,
    onApproveOnce,
    onApproveSession,
    onApproveAlways,
    handleQuickSend,
    isStreaming,
    acceptingProposalId,
    showIssueNextStepCallout,
    issueContext,
    onIssueUpdate,
    onIssueFix,
    repoComposerLocked,
    buddyResponse,
    lastAssistantMessage,
    activeModel,
    onUseBuddyResponse,
    showFooterActivity,
    messages,
    toolActivity,
    agentStatusLabel,
  } = footer;

  return (
    <>
      {showInlineApprovalBanner && pendingProposal && (
        <div className="mx-auto max-w-[720px] px-4 md:px-20">
          <ChangeApprovalModal
            open={approvalModalOpen}
            onOpenChange={onApprovalModalOpenChange}
            proposal={pendingProposal}
            onApproveOnce={onApproveOnce}
            onApproveSession={onApproveSession}
            onApproveAlways={onApproveAlways}
            disabled={!handleQuickSend || isStreaming || acceptingProposalId === pendingProposal.messageId}
          />
        </div>
      )}
      {showIssueNextStepCallout && issueContext && (
        <div className="mx-auto max-w-[720px] px-4 md:px-20 pb-6">
          <IssueNextStepCallout
            issueNumber={issueContext.number}
            issueTitle={issueContext.title}
            onUpdateIssue={onIssueUpdate}
            onFix={onIssueFix}
            disabled={repoComposerLocked}
          />
        </div>
      )}
      {buddyResponse && (
        <div className="mx-auto max-w-[720px] px-4 md:px-20 pb-4">
          <BuddyComparisonPanel
            buddyResponse={buddyResponse}
            primaryResponse={lastAssistantMessage ? {
              content: lastAssistantMessage.content,
              modelName: activeModel,
            } : undefined}
            autoExpandOnArrival={true}
            onUseBuddyResponse={onUseBuddyResponse}
          />
        </div>
      )}
      {showFooterActivity && (
        <ActivityIndicator
          isStreaming={isStreaming}
          messages={messages}
          toolActivity={toolActivity}
          statusLabel={agentStatusLabel}
        />
      )}
    </>
  );
});

const CHAT_VIRTUOSO_COMPONENTS = { Footer: ChatVirtuosoFooter };

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
  isAnotherPanelStreamingSameProfile?: boolean;
  error?: Error | null;
  apiKeyModalOpen: boolean;
  setApiKeyModalOpen: (v: boolean) => void;
  activeProvider: Provider;
  activeModel: string;
  toolActivityMap?: Record<string, ToolActivityEvent[]>;
  agentStatus?: AgentStatusEvent | null;
  conversationAutoApproveEnabled?: boolean;
  setConversationAutoApprove?: (value: boolean) => void;
  /** Buddy/secondary model response for comparison after Hermes completes */
  buddyResponse?: BuddyResponse | null;
  /** Callback when user wants to use the buddy response */
  onUseBuddyResponse?: (content: string) => void;
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
  isAnotherPanelStreamingSameProfile = false,
  error,
  apiKeyModalOpen,
  setApiKeyModalOpen,
  activeProvider,
  activeModel,
  toolActivityMap,
  agentStatus,
  conversationAutoApproveEnabled = false,
  setConversationAutoApprove,
  buddyResponse,
  onUseBuddyResponse,
}) => {
  const panelId = usePanelId();
  const scopeId = useChatScopeId();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const isAutoScroll = useRef(true);
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;
  // True briefly while the user is actively wheel/touch scrolling, so we can
  // tell a real scroll-away from streamed content pushing the bottom down.
  const userScrollingRef = useRef(false);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const pendingProposalCacheRef = useRef<{ digest: string; proposal: ReturnType<typeof findPendingProposal> }>({
    digest: '',
    proposal: null,
  });
  const messageTimestampCacheRef = useRef<Record<string, string>>({});
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const toolActivityMapRef = useRef(toolActivityMap);
  toolActivityMapRef.current = toolActivityMap;
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [acceptingProposalId, setAcceptingProposalId] = useState<string | null>(null);
  const [approvalModalOpen, setApprovalModalOpen] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const notifiedProposalKeyRef = useRef<string | null>(null);
  const autoApprovedProposalIdRef = useRef<string | null>(null);

  const updateProviderConfig = useSettingsStore((state) => state.updateProviderConfig);
  const setPanelUsage = useContextUsageStore((state) => state.setPanelUsage);
  const clearPanelUsage = useContextUsageStore((state) => state.clearPanelUsage);
  const setSettingsOpen = useUIStore((state) => state.setSettingsOpen);
  const queuePanelPrompt = useUIStore((state) => state.queuePanelPrompt);
  const changeset = useChangesetStore((state) => state.getChangeset(scopeId));
  const planMode = useChatStore((state) => state.planMode);
  const alwaysApprovalPolicies = useSettingsStore((state) => state.approvalPolicies);
  const addAlwaysApprovalPolicy = useSettingsStore((state) => state.addApprovalPolicy);
  const sessionApprovalPolicies = useHermesStore((state) => state.sessionApprovalPolicies);
  const addSessionApprovalPolicy = useHermesStore((state) => state.addSessionApprovalPolicy);
  const clearSessionApprovalPolicies = useHermesStore((state) => state.clearSessionApprovalPolicies);
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

  // Conversation-ordered tool activity for the composer task panel: per-message
  // activity in message order, then the in-flight 'current' stream.
  const panelToolActivity = useMemo(() => {
    if (!toolActivityMap) return [];
    const ordered: ToolActivityEvent[] = [];
    for (const message of messages) {
      const activity = toolActivityMap[message.id];
      if (activity) ordered.push(...activity);
    }
    if (toolActivityMap.current) ordered.push(...toolActivityMap.current);
    return ordered;
  }, [toolActivityMap, messages]);

  // Start time of this conversation's active run. Prefers the server's start
  // time (background runs poll); falls back to the locally persisted stream
  // anchor for runs the server doesn't report (loop/swarm) and the poll-race
  // window. Anchors the elapsed timer so closing/reopening the panel doesn't
  // restart it from 0.
  const streamStartedAt = useActivityStore((s) =>
    conversationId
      ? s.backgroundRuns[conversationId] ?? s.streamAnchors[conversationId]
      : undefined,
  );

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    // During streaming, Virtuoso fires atBottom=false when in-place content
    // growth (tool calls, streaming parts) pushes the bottom below the
    // viewport.  Don't disable auto-scroll for that — only honour an
    // explicit user-scroll-away when NOT streaming.
    if (atBottom) {
      isAutoScroll.current = true;
    } else if (!isStreamingRef.current || userScrollingRef.current) {
      // A genuine user scroll-away disables auto-scroll even mid-stream. Pure
      // content-growth atBottom=false (no wheel/touch) is ignored so streaming
      // keeps following the output.
      isAutoScroll.current = false;
    }
    setShowScrollButton((prev) => {
      const next = !atBottom;
      return prev === next ? prev : next;
    });
  }, []);

  // Grab the Virtuoso scroller element so we can watch for real user scrolling.
  const handleScrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    setScrollerEl(ref instanceof HTMLElement ? ref : null);
  }, []);

  useEffect(() => {
    if (!scrollerEl) return;
    let release: ReturnType<typeof setTimeout> | null = null;
    const markScrolling = () => {
      userScrollingRef.current = true;
      if (release) clearTimeout(release);
      release = setTimeout(() => {
        userScrollingRef.current = false;
      }, 250);
    };
    // Upward wheel or any touch drag = the user taking over scrolling.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) markScrolling();
    };
    const onTouchMove = () => markScrolling();
    scrollerEl.addEventListener('wheel', onWheel, { passive: true });
    scrollerEl.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      scrollerEl.removeEventListener('wheel', onWheel);
      scrollerEl.removeEventListener('touchmove', onTouchMove);
      if (release) clearTimeout(release);
    };
  }, [scrollerEl]);

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
    // Use instant ('auto') scrolling here, NOT smooth: this fires on every
    // streamed chunk, and a smooth animation toward an ever-growing target
    // restarts each token and makes the text visibly bounce/jitter.
    virtuosoRef.current?.scrollToIndex({
      index: messages.length - 1,
      align: 'end',
      behavior: 'auto',
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
      title: 'Spark approval needed',
      body,
    });
  }, [canShowProposalApproval, conversationId, pendingProposal]);

  const handleApproveOnce = useCallback(async () => {
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

  const handleApproveSession = useCallback(async () => {
    if (!pendingProposal) return;
    addSessionApprovalPolicy({
      key: getProposalApprovalKey(pendingProposal),
      scope: 'session',
      createdAt: Date.now(),
    });
    await handleApproveOnce();
  }, [pendingProposal, addSessionApprovalPolicy, handleApproveOnce]);

  const handleApproveAlways = useCallback(async () => {
    if (pendingProposal) {
      addAlwaysApprovalPolicy({
        key: getProposalApprovalKey(pendingProposal),
        scope: 'always',
        createdAt: Date.now(),
      });
    }
    setConversationAutoApprove?.(true);
    await handleApproveOnce();
  }, [pendingProposal, addAlwaysApprovalPolicy, handleApproveOnce, setConversationAutoApprove]);

  // Auto-accept if a saved session or always policy matches this proposal.
  useEffect(() => {
    if (!canShowProposalApproval || !pendingProposal) return;
    if (autoApprovedProposalIdRef.current === pendingProposal.messageId) return;
    const key = getProposalApprovalKey(pendingProposal);
    const matched = matchApprovalPolicy(key, sessionApprovalPolicies, alwaysApprovalPolicies);
    if (!matched) return;
    autoApprovedProposalIdRef.current = pendingProposal.messageId;
    void handleApproveOnce();
  }, [
    canShowProposalApproval,
    pendingProposal,
    sessionApprovalPolicies,
    alwaysApprovalPolicies,
    handleApproveOnce,
  ]);

  // Clear session-scope approval policies when the chat panel unmounts.
  useEffect(() => () => {
    clearSessionApprovalPolicies();
  }, [clearSessionApprovalPolicies]);

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

  const itemContent = useCallback((index: number, msg: ChatMessageLike) => {
    const messages = messagesRef.current;
    const isStreaming = isStreamingRef.current;
    const conversationId = conversationIdRef.current;
    const toolActivityMap = toolActivityMapRef.current;
    const isLastAssistantStreaming =
      isStreaming && msg.role === 'assistant' && index === messages.length - 1;
    const allowPseudoRepoWrites = msg.role === 'assistant'
      ? allowPseudoRepoWritesForAssistant(messages, index)
      : false;
    const parts = getAssistantParts(msg);
    const toolInvocations = msg.role === 'assistant'
      ? getMessageToolInvocations(msg)
      : [];
    const displayParts = msg.role === 'assistant'
      ? mergeAssistantPartsWithToolInvocations(parts, toolInvocations)
      : parts;

    const reasoning = msg.role === 'assistant'
      ? displayParts
          .filter((p) => p.type === 'reasoning')
          .map((p: ChatPartLike) => p.reasoning)
          .join('\n') || undefined
      : undefined;

    const isReasoningStreaming = isLastAssistantStreaming && !!reasoning && !msg.content;

    const messageToolActivity = toolActivityMap?.[msg.id]
      || (isLastAssistantStreaming ? toolActivityMap?.['current'] : undefined);

    return (
      <div className="max-w-[720px] mx-auto px-4 md:px-20 py-3">
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
          parts={displayParts as React.ComponentProps<typeof MessageBubble>['parts']}
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
  }, [handleRegenerate, handleRewind]);

  const virtuosoContext = useMemo<ChatVirtuosoContext>(() => ({
    footer: {
      showInlineApprovalBanner,
      approvalModalOpen,
      onApprovalModalOpenChange: setApprovalModalOpen,
      pendingProposal,
      onApproveOnce: handleApproveOnce,
      onApproveSession: handleApproveSession,
      onApproveAlways: handleApproveAlways,
      handleQuickSend,
      isStreaming,
      acceptingProposalId,
      showIssueNextStepCallout,
      issueContext,
      onIssueUpdate: handleIssueUpdate,
      onIssueFix: handleIssueFix,
      repoComposerLocked,
      buddyResponse,
      lastAssistantMessage,
      activeModel,
      onUseBuddyResponse,
      showFooterActivity,
      messages,
      toolActivity: toolActivityMap?.current,
      agentStatusLabel: agentStatus?.label,
    },
  }), [
    acceptingProposalId,
    activeModel,
    agentStatus?.label,
    approvalModalOpen,
    buddyResponse,
    handleApproveAlways,
    handleApproveOnce,
    handleApproveSession,
    handleIssueFix,
    handleIssueUpdate,
    handleQuickSend,
    isStreaming,
    issueContext,
    lastAssistantMessage,
    messages,
    onUseBuddyResponse,
    pendingProposal,
    repoComposerLocked,
    showFooterActivity,
    showInlineApprovalBanner,
    showIssueNextStepCallout,
    toolActivityMap,
  ]);

  const hasMessages = messages.length > 0;

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
      <div className="relative flex h-full flex-col overflow-hidden px-4">
        <ChatSurfaceBackground testId="chat-surface-background" />
        <div className="relative z-10 flex h-full min-h-0 flex-col">
          {planMode && (
            <div className="mx-auto mt-2 flex items-center gap-2 rounded-md bg-purple-500/10 px-3 py-1.5 text-xs text-purple-400 ring-1 ring-purple-500/20">
              <ClipboardList className="h-3.5 w-3.5" />
              <span>Plan Mode — read-only exploration, no file edits</span>
            </div>
          )}
          {/* The hero scrolls; the composer is pinned below it so it stays
              reachable in short panels (e.g. multi-panel grid rows). */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex min-h-full flex-col">
              <div className="flex-1" />
              <WelcomeScreen onSendMessage={(message) => {
                if (handleQuickSend) {
                  handleQuickSend(message);
                } else {
                  setInput(message);
                }
              }} disableRepoActions={repoComposerLocked} />
              <div className="flex-[2]" />
            </div>
          </div>
          <div className="mx-auto mt-2 w-full max-w-[720px] pb-3">
            {errorBanner}
            <VerificationGhostOverlay />
            <ActivityIndicator
              isStreaming={isStreaming}
              messages={messages}
              toolActivity={toolActivityMap?.current}
              statusLabel={agentStatus?.label}
            />
            <div className="mx-auto w-full max-w-[720px] px-3 md:px-20">
              <AgentTaskPanel events={panelToolActivity} />
            </div>
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              onStop={handleStop}
              isStreaming={isStreaming}
              isAnotherPanelStreamingSameProfile={isAnotherPanelStreamingSameProfile}
              toolCallCount={toolCallCount}
              disabled={repoComposerLocked}
              disabledPlaceholder={disabledPlaceholder}
              hasMessages={hasMessages}
              activeProvider={activeProvider}
              activeModel={activeModel}
              agentStatusLabel={agentStatus?.label}
              streamStartedAt={streamStartedAt}
              queuedMessages={queuedMessages}
              onRemoveQueuedMessage={handleRemoveQueuedMessage}
              onSteerQueuedMessage={handleSteerQueuedMessage}
              onSendContent={handleQuickSend}
            />
          </div>
        </div>
        {modal}
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <ChatSurfaceBackground testId="chat-surface-background" />
      <div className="relative z-10 flex h-full min-h-0 flex-col">
        {planMode && (
          <div className="mx-4 md:mx-20 mt-2 flex items-center gap-2 rounded-md bg-purple-500/10 px-3 py-1.5 text-xs text-purple-400 ring-1 ring-purple-500/20">
            <ClipboardList className="h-3.5 w-3.5" />
            <span>Plan Mode — read-only exploration, no file edits</span>
          </div>
        )}
        <Virtuoso
          ref={virtuosoRef}
          scrollerRef={handleScrollerRef}
          data={messages}
          followOutput={() => isAutoScroll.current ? (isStreamingRef.current ? 'auto' : 'smooth') : false}
          atBottomStateChange={handleAtBottomChange}
          className="min-h-0 flex-1"
          data-testid="virtuoso-scroller"
          context={virtuosoContext}
          itemContent={itemContent}
          components={CHAT_VIRTUOSO_COMPONENTS}
        />
        {showScrollButton && (
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
        <div className="mx-auto w-full max-w-[720px] px-3 md:px-20">
          <AgentTaskPanel events={panelToolActivity} />
        </div>
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={handleSendWithScroll}
          onStop={handleStop}
          isStreaming={isStreaming}
          isAnotherPanelStreamingSameProfile={isAnotherPanelStreamingSameProfile}
          toolCallCount={toolCallCount}
          disabled={repoComposerLocked}
          disabledPlaceholder={disabledPlaceholder}
          hasMessages={hasMessages}
          activeProvider={activeProvider}
          activeModel={activeModel}
          agentStatusLabel={agentStatus?.label}
          streamStartedAt={streamStartedAt}
          queuedMessages={queuedMessages}
          onRemoveQueuedMessage={handleRemoveQueuedMessage}
          onSteerQueuedMessage={handleSteerQueuedMessage}
          onSendContent={handleQuickSend}
        />
      </div>
      {modal}
    </div>
  );
};
