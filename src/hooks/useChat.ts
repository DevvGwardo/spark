import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { useChat as useAIChat, type Message as AIMessage } from '@ai-sdk/react';
import { parseDataStreamPart } from 'ai';
import { useShallow } from 'zustand/shallow';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore, type FileType, type PreviewFile, type ProjectType } from '@/stores/preview-store';
import { useActivityStore } from '@/stores/activity-store';
import { useUIStore } from '@/stores/ui-store';
import { db } from '@/lib/db';
import { fetchRepoFileTreeResult, getApiBaseUrl } from '@/lib/api';
import { createQueuedMessage, moveQueuedMessageToFront, removeQueuedMessage, type QueuedMessage } from '@/lib/chat-queue';
import { PROVIDERS, supportsReasoningEffort } from '@/lib/providers';
import { useHermesStore } from '@/stores/hermes-store';
import { getActiveProfile, useProfilesStore } from '@/stores/profiles-store';
import { useStreamLockStore } from '@/stores/stream-lock-store';

import { findPendingProposal, type PendingProposal, type ProposalToolInvocationLike } from '@/lib/proposed-changes';
import {
  getRepoTurnIntentInstruction,
  isRepoApprovalFollowUpMessage,
  isRepoEditIntentMessage,
  isRepoWriteMessage,
} from '@/lib/repo-intent';
import type { ToolActivityEvent } from '@/components/chat/AgentActivity';
import { getErrorMessage } from '@/lib/errors';
import { handleServerToolEvent, SERVER_EXECUTED_REPO_TOOLS, type ServerToolEvent } from '@/lib/server-tool-events';
import { getChatScopeId } from '@/lib/chat-scope';
import { extractPseudoToolInvocations, extractTextFileEdits, getPseudoToolSourceText } from '@/lib/pseudo-tool-calls';
import {
  normalizeBatchEditRepoFilesArgs,
  normalizeCreateRepoFileArgs,
  normalizeDeleteRepoFileArgs,
  normalizeEditRepoFileArgs,
  normalizeProposeChangesArgs,
} from '@/lib/repo-tool-args';
import {
  AUTO_CONTINUE_DELAY_MS,
  AUTO_SAVE_DEBOUNCE_MS,
  CONVERSATION_TITLE_MAX_LENGTH,
  REPO_EDIT_TOOL_NAMES,
  REPO_MODE_DISABLED_HERMES_TOOLSETS,
  REPO_PATH_SAMPLE_LIMIT,
  allowPseudoRepoWritesForAssistantMessage,
  collectRepoWorkflowToolNames,
  describedEditButDidNotExecute,
  formatMissingRepoFileError,
  formatRepoTreeUnavailableError,
  getPendingProposalKey,
  getRepoPathSuggestions,
  getRepoToolExistingPaths,
  getServerToolEventKey,
  hasRecoverablePseudoRepoWrites,
  isAgentStatusData,
  isHermesToolActivityData,
  isInvalidRepoReadPath,
  isServerExecutedRepoToolName,
  isServerToolEvent,
  normalizeRepoPath,
  resolveRepoWriteAction,
  sanitizePartialToolCalls,
  synthesizeToolInvocationsForPersistence,
  stalledOnRepoRead,
  summarizeContentForLog,
  toStoredAIMessages,
  upsertStoredMessage,
  type AgentStatusEvent,
  type AutoContinueRequest,
  type ProviderOverride,
  type SendMessageOptions,
} from './chat-utils';
export type { AgentStatusEvent } from './chat-utils';

const TOOL_INVOCATION_STATE_PRIORITY: Record<string, number> = {
  'partial-call': 0,
  call: 1,
  result: 2,
};

function asUnknownArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value as unknown[] : undefined;
}

function getPersistedToolInvocationKey(invocation: Record<string, unknown>, fallbackIndex: number): string {
  const toolName = typeof invocation.toolName === 'string' ? invocation.toolName : '';
  const args = invocation.args && typeof invocation.args === 'object'
    ? invocation.args as Record<string, unknown>
    : {};
  const path = typeof args.path === 'string' ? args.path : '';
  const filename = typeof args.filename === 'string' ? args.filename : '';
  const batchPaths = Array.isArray(args.changes)
    ? args.changes
        .map((change) =>
          change && typeof change === 'object'
            ? `${typeof (change as { action?: unknown }).action === 'string' ? (change as { action: string }).action : ''}:${typeof (change as { path?: unknown }).path === 'string' ? (change as { path: string }).path : ''}`
            : '',
        )
        .join('|')
    : '';

  if (toolName && (path || filename || batchPaths)) {
    return `${toolName}:${path}:${filename}:${batchPaths}`;
  }

  const toolCallId = typeof invocation.toolCallId === 'string' ? invocation.toolCallId : '';
  if (toolCallId) {
    return `${toolName}:${toolCallId}`;
  }

  const argsDigest = Object.keys(args).length > 0 ? JSON.stringify(args) : '';
  return `${toolName}:${argsDigest || fallbackIndex}`;
}

function mergePersistedToolInvocation(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const currentPriority = TOOL_INVOCATION_STATE_PRIORITY[
    typeof current.state === 'string' ? current.state : ''
  ] ?? 0;
  const incomingPriority = TOOL_INVOCATION_STATE_PRIORITY[
    typeof incoming.state === 'string' ? incoming.state : ''
  ] ?? 0;
  const preferred = incomingPriority >= currentPriority ? incoming : current;
  const fallback = preferred === incoming ? current : incoming;

  return {
    ...fallback,
    ...preferred,
    args: preferred.args ?? fallback.args,
    result: preferred.result ?? fallback.result,
  };
}

function mergePersistedToolInvocations(
  ...groups: Array<unknown[] | undefined>
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const indexByKey = new Map<string, number>();

  for (const group of groups) {
    for (const invocation of group ?? []) {
      if (!invocation || typeof invocation !== 'object') {
        continue;
      }

      const record = invocation as Record<string, unknown>;
      const key = getPersistedToolInvocationKey(record, merged.length);
      const existingIndex = indexByKey.get(key);

      if (existingIndex === undefined) {
        indexByKey.set(key, merged.length);
        merged.push(record);
        continue;
      }

      merged[existingIndex] = mergePersistedToolInvocation(merged[existingIndex], record);
    }
  }

  return merged;
}

function pickPreferredArray(primary?: unknown[], secondary?: unknown[]): unknown[] | undefined {
  if ((secondary?.length ?? 0) > (primary?.length ?? 0)) {
    return secondary;
  }

  return primary ?? secondary;
}

function buildAssistantSnapshotForPersistence(params: {
  message?: Record<string, unknown>;
  streamedMessage?: Record<string, unknown>;
  toolActivity?: ToolActivityEvent[];
  serverToolEvents?: ServerToolEvent[];
  fallbackId?: string;
  fallbackTimestamp?: string;
}): Record<string, unknown> | undefined {
  const source = params.message ?? {};
  const streamed = params.streamedMessage ?? {};
  const parts = pickPreferredArray(asUnknownArray(source.parts), asUnknownArray(streamed.parts));
  const sourceContent = typeof source.content === 'string' ? source.content : undefined;
  const streamedContent = typeof streamed.content === 'string' ? streamed.content : undefined;
  const toolInvocations = mergePersistedToolInvocations(
    asUnknownArray(source.toolInvocations),
    asUnknownArray(streamed.toolInvocations),
    synthesizeToolInvocationsForPersistence(
      params.toolActivity ?? [],
      params.serverToolEvents ?? [],
    ),
  );
  const id = typeof source.id === 'string' && source.id
    ? source.id
    : typeof streamed.id === 'string' && streamed.id
      ? streamed.id
      : params.fallbackId;

  if (!id) {
    return undefined;
  }

  const timestamp = typeof source.timestamp === 'string' && source.timestamp
    ? source.timestamp
    : typeof streamed.timestamp === 'string' && streamed.timestamp
      ? streamed.timestamp
      : params.fallbackTimestamp ?? new Date().toISOString();

  return {
    id,
    role: typeof source.role === 'string'
      ? source.role
      : typeof streamed.role === 'string'
        ? streamed.role
        : 'assistant',
    content: sourceContent && sourceContent.length > 0
      ? sourceContent
      : (streamedContent ?? sourceContent ?? ''),
    timestamp,
    ...(parts ? { parts } : {}),
    ...(toolInvocations.length > 0 ? { toolInvocations } : {}),
  };
}

export function useChat(
  conversationId: string | null,
  onConversationCreated?: (id: string) => void,
  providerOverride?: ProviderOverride,
  panelId: string = 'default',
  onReadyForPR?: (panelId: string, mode?: 'create' | 'review') => void,
  stateScopeId?: string,
) {
  const sanitizeRetryMessages = useCallback((msgs: AIMessage[]): AIMessage[] => (
    sanitizePartialToolCalls(
      msgs as unknown as Array<{
        id: string;
        role: AIMessage['role'];
        content: string;
        parts?: Array<Record<string, unknown>>;
        toolInvocations?: Array<Record<string, unknown>>;
      }>,
    ) as unknown as AIMessage[]
  ), []);

  const scopeId = stateScopeId ?? panelId;
  const createConversation = useChatStore((s) => s.createConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const loadConversations = useChatStore((s) => s.loadConversations);

  const { activeProvider, providers, defaultSystemPrompt, githubPAT, autoApproveRepoChanges } = useSettingsStore(
    useShallow((s) => ({
      activeProvider: s.activeProvider,
      providers: s.providers,
      defaultSystemPrompt: s.defaultSystemPrompt,
      githubPAT: s.githubPAT,
      autoApproveRepoChanges: s.autoApproveRepoChanges,
    })),
  );
  const knowledgeContext = useKnowledgeStore((s) => s.getActiveContext());
  const changeset = useChangesetStore(useShallow((s) => s.getChangeset(scopeId)));
  const addChangeForPanel = useChangesetStore((s) => s.addChange);
  const preview = usePreviewStore(useShallow((s) => s.getPreview(scopeId)));
  const pendingPanelPrompt = useUIStore((s) => s.pendingPanelPrompts[panelId] ?? null);
  const clearPanelPrompt = useUIStore((s) => s.clearPanelPrompt);
  const { activeRepo, isRepoMode, repoFileTree } = changeset;
  const hermesToolsetConfig = useHermesStore((s) => s.toolsets);
  const hermesMcpServers = useHermesStore((s) => s.mcpServers);
  const hermesSwarmEnabled = useHermesStore((s) => s.swarm.enabled);
  const hermesCustomToolDefs = useMemo(() => {
    const servers = hermesMcpServers.filter((s) => s.enabled && s.tools.length > 0);
    return servers.flatMap((server) =>
      server.tools.map((tool) => ({
        type: 'function' as const,
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        mcp_server_id: server.id,
        mcp_server_url: server.url,
        mcp_server_api_key: server.apiKey,
      }))
    );
  }, [hermesMcpServers]);
  const hermesToolsets = useMemo(
    () =>
      Object.entries(hermesToolsetConfig)
        .filter(([, enabled]) => enabled)
        .map(([toolset]) => toolset),
    [hermesToolsetConfig],
  );
  // Local execution toolsets (terminal, files, code_execution) sent to all non-Hermes providers
  const agentToolsets = useMemo(
    () =>
      Object.entries(hermesToolsetConfig)
        .filter(([key, enabled]) => enabled && (key === 'terminal' || key === 'files' || key === 'code_execution'))
        .map(([key]) => key)
        .join(','),
    [hermesToolsetConfig],
  );
  const addChange = useCallback((change: Parameters<typeof addChangeForPanel>[1]) => addChangeForPanel(scopeId, change), [addChangeForPanel, scopeId]);

  // Determine effective provider/model (supports overrides)
  const effectiveProvider = providerOverride?.provider ?? activeProvider;
  const config = providers[effectiveProvider];
  const effectiveModel = providerOverride?.model ?? config.model;
  const reasoningEffort = supportsReasoningEffort(effectiveProvider, effectiveModel)
    ? config.reasoningEffort
    : undefined;

  const baseSystemPrompt = knowledgeContext
    ? `${defaultSystemPrompt}\n\n--- Knowledge Base ---\n${knowledgeContext}`
    : defaultSystemPrompt;

  const buildRepoSystemPrompt = useCallback((
    repo: typeof activeRepo,
    repoMode: boolean,
    repoEditIntent: boolean,
    hasRepoAccess: boolean,
  ) => {
    let prompt = baseSystemPrompt;

    if (repoMode && repo) {
      let repoContext = `\n\n--- GitHub Repository ---\nYou are working on the GitHub repository ${repo.fullName} (default branch: ${repo.defaultBranch}).

IMPORTANT: First determine whether the current user turn is asking for read-only repository help or for actual code changes.
- If the user is asking what the repo is, how it works, where something lives, for an overview, or for analysis/review, stay read-only: inspect files as needed and answer directly.
- Only begin editing when the user explicitly asks you to modify the repository.
- Never treat repo selection by itself as permission to edit.

When the user asks you to make changes:
1. Use read_repo_file to read the files you need to understand and modify.
2. Then use batch_edit_repo_files to apply ALL changes at once (preferred), or edit_repo_file / create_repo_file individually.
3. Do NOT ask the user to specify file paths or share files — explore the repo yourself using the repository context provided with the request.
4. Do NOT ask clarifying questions. Use your judgment, explore the repo to understand the codebase, and make the changes directly. If the request is ambiguous, make reasonable assumptions and explain them.
5. When the user asks you to update multiple things, make sure you address ALL of them, not just one.
6. All changes are staged for a pull request (not applied directly).
7. Never print pseudo-tool syntax like batch_edit_repo_files(...) in visible text. Use the actual tool calls instead.
8. IMPORTANT: If you need to edit many large files, split batch_edit_repo_files into multiple calls (max 3-4 files per batch) to avoid output truncation. For very large files, use individual edit_repo_file calls instead.
9. Never conclude that the repository is empty or inaccessible just because a guessed file path failed to read. If a read fails, choose another path from the loaded repo tree and continue exploring.
10. Do not guess generic placeholder paths like \`.\`, \`/\`, \`src/main\`, \`server\`, \`client\`, or \`package.json\` unless that exact path is present in the loaded repo tree.
11. Only use exact file paths that appear in the repo tree or that are returned by a read_repo_file error as a possible match. Do not infer unlisted sibling paths or directory names.`;

      if (!hasRepoAccess) {
        repoContext += `\n11. GitHub file access is unavailable for this request because no GitHub token is configured. Do not call repo tools and do not search the web just to compensate for missing repo access.
12. If the user asked for explanation or analysis, work only from the issue text and any already provided context. Mention the access limitation once, then provide the best concise analysis you can without repeating the issue description verbatim.
13. If the user asked for code changes, explain briefly that repository access is unavailable and that you cannot inspect or modify files until GitHub access is configured.`;
      }

      prompt += repoContext;
      prompt = `${prompt}\n\n${getRepoTurnIntentInstruction(repoEditIntent)}`;
    }

    return prompt;
  }, [baseSystemPrompt]);

  const apiBaseUrl = getApiBaseUrl();

  // Use a ref so callbacks always have current conversation ID.
  // We update it lazily in the conversation-switch effect (not eagerly on every render)
  // so that onFinish for a streaming response can still persist to the correct conversation.
  const convIdRef = useRef(conversationId);

  // Skip the next IndexedDB reload when we just created a conversation and are about to append
  const skipNextLoadRef = useRef(false);
  // Keep a just-created conversation local until the first send settles.
  // Switching the panel immediately remounts the chat tree and drops the in-flight transcript.
  const pendingConversationIdRef = useRef<string | null>(null);
  // Captures the conversationId at stream start so we can distinguish the
  // draft→new-conv promotion (keep session) from a user navigating to a
  // different thread mid-stream (advance session so the UI reflects the
  // new thread). Set when isStreaming goes false→true; cleared on end.
  const streamConvIdRef = useRef<string | null>(null);
  const repoEditIntentRef = useRef(false);
  const pendingProposalRef = useRef<PendingProposal | null>(null);
  const explicitProposalKeyRef = useRef<string | null>(null);
  const approvedProposalContinuationRef = useRef<{
    conversationId: string | null;
    proposalKey: string | null;
  } | null>(null);
  const pausedProposalKeyRef = useRef<string | null>(null);
  const contentProposalStabilityRef = useRef<{ key: string | null; cycles: number }>({
    key: null,
    cycles: 0,
  });
  const appliedPseudoRepoMessageIdsRef = useRef(new Set<string>());
  // Track scopes that have been hydrated from DB this session.
  // Once a scope is hydrated (or populated by the user), we use in-memory state
  // on subsequent visits and skip the async DB read entirely.
  const hydratedScopesRef = useRef(new Set<string>());

  const resetPanelFileState = useCallback(() => {
    const csStore = useChangesetStore.getState();
    const psStore = usePreviewStore.getState();
    csStore.clearActiveRepo(scopeId);
    psStore.resetPreview(scopeId);
  }, [scopeId]);

  const saveConversationFiles = useCallback((convId: string, sourceScopeId: string = scopeId) => {
    const cs = useChangesetStore.getState().getChangeset(sourceScopeId);
    const ps = usePreviewStore.getState().getPreview(sourceScopeId);
    const hasChanges = Object.keys(cs.changes).length > 0 || cs.activeRepo !== null;
    const hasFiles = ps.files.length > 0;

    if (!hasChanges && !hasFiles) {
      return db.conversationFiles.delete(convId);
    }

    return db.conversationFiles.save({
      conversationId: convId,
      changeset: {
        activeRepo: cs.activeRepo,
        isRepoMode: cs.isRepoMode,
        pullRequest: cs.pullRequest,
        changes: cs.changes,
        repoFileTree: cs.repoFileTree,
        repoFileCache: cs.repoFileCache,
        selectedRepoFilePath: cs.selectedRepoFilePath,
      },
      preview: {
        files: ps.files,
        activeFileId: ps.activeFileId,
        projectType: ps.projectType,
        isOpen: ps.isOpen,
        activeView: ps.activeView,
      },
      repoFileCache: Object.keys(cs.repoFileCache).length > 0
        ? cs.repoFileCache
        : undefined,
    });
  }, [scopeId]);

  const activeRepoKey = activeRepo ? `${activeRepo.owner}/${activeRepo.name}` : null;
  const previousActiveRepoKeyRef = useRef<string | null>(activeRepoKey);

  useEffect(() => {
    const previousRepoKey = previousActiveRepoKeyRef.current;
    previousActiveRepoKeyRef.current = activeRepoKey;

    if (previousRepoKey === activeRepoKey) {
      return;
    }


  }, [activeRepoKey]);

  const [draftInput, setDraftInput] = useState('');
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [providerUnavailableOpen, setProviderUnavailableOpen] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [toolActivityMap, setToolActivityMap] = useState<Record<string, ToolActivityEvent[]>>({});
  const [agentStatus, setAgentStatus] = useState<AgentStatusEvent | null>(null);
  const [conversationAutoApproveEnabled, setConversationAutoApproveEnabled] = useState(false);
  const requestConversationIdRef = useRef<string | null>(conversationId);
  const activeRequestBodyRef = useRef<Record<string, unknown> | null>(null);
  const toolActivityRef = useRef<Record<string, ToolActivityEvent[]>>({});
  const serverToolEventsRef = useRef<Record<string, ServerToolEvent[]>>({});
  const serverToolEventKeysRef = useRef<Record<string, Set<string>>>({});
  const serverSideToolsDetectedRef = useRef(false);
  // Use only the prop-level conversationId for the AI SDK session key.
  // pendingConversationIdRef must NOT influence the session ID because it gets
  // set inside sendMessage *before* append() runs. If the session switches early,
  // append targets the old draft session while the UI shows the new (empty) one,
  // causing messages to vanish.
  // A unique draft epoch ensures each "New thread" gets a fresh AI SDK session
  // so stale messages/status from a previous draft don't bleed through.
  const draftEpochRef = useRef(0);
  const prevConversationIdForSessionRef = useRef(conversationId);
  if (prevConversationIdForSessionRef.current !== null && conversationId === null) {
    draftEpochRef.current += 1;
  }
  prevConversationIdForSessionRef.current = conversationId;
  const chatSessionId = `${conversationId ?? `draft-${draftEpochRef.current}`}:${panelId}`;
  // Use useMemo so aiChatSessionId tracks conversationId synchronously.
  // The previous useState + useLayoutEffect pattern caused a race condition:
  // when the user switched conversations mid-stream, aiChatSessionId stayed stale
  // (blocked by isStreaming guard in useLayoutEffect), which also blocked the
  // conversation-switch effect (guarded on aiChatSessionId !== chatSessionId).
  // This meant hydrateConversationMessages was never called and the UI kept
  // showing the old conversation's messages.
  const aiChatSessionId = useMemo(() => chatSessionId, [chatSessionId]);
  const isStreamingRef = useRef(false);
  const shouldRetainRequestConversationId =
    conversationId === null && (isStreamingRef.current || pendingConversationIdRef.current !== null);
  // Keep the request conversation aligned with the visible conversation unless we are
  // intentionally holding on to the previous conversation during an in-flight handoff.
  requestConversationIdRef.current = shouldRetainRequestConversationId
    ? requestConversationIdRef.current
    : conversationId;
  const abortControllerRef = useRef<AbortController | null>(null);
  const isSendingRef = useRef(false);
  const autoSendingQueuedRef = useRef<string | null>(null);
  // Track consecutive 'unknown' finish reasons during active repo work to auto-continue
  // when the model is interrupted (e.g. token limit, dropped stream). Cap retries to
  // prevent infinite loops.
  const unknownFinishRetryRef = useRef(0);
  const MAX_UNKNOWN_FINISH_RETRIES = 6;
  const repoStopRetryRef = useRef(0);
  const MAX_REPO_STOP_RETRIES = 5;
  const autoContinueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when the user explicitly clicks stop — prevents onFinish from auto-continuing
  const userStoppedRef = useRef(false);
  const messagesRef = useRef<AIMessage[]>([]);

  const persistAssistantSnapshot = useCallback(async (
    message: Record<string, unknown>,
    convId: string,
    fallback?: {
      toolActivity?: ToolActivityEvent[];
      serverToolEvents?: ServerToolEvent[];
    },
  ) => {
    const messageId = typeof message.id === 'string' && message.id ? message.id : crypto.randomUUID();
    const timestamp = typeof message.timestamp === 'string' && message.timestamp
      ? message.timestamp
      : new Date().toISOString();
    const streamedMessage = messagesRef.current.find((entry) => entry.id === messageId) as
      | (AIMessage & { timestamp?: string })
      | undefined;
    const snapshot = buildAssistantSnapshotForPersistence({
      message: {
        ...message,
        id: messageId,
        timestamp,
      },
      streamedMessage: streamedMessage as unknown as Record<string, unknown> | undefined,
      toolActivity: fallback?.toolActivity,
      serverToolEvents: fallback?.serverToolEvents,
      fallbackId: messageId,
      fallbackTimestamp: timestamp,
    });

    if (!snapshot) {
      return;
    }

    const parts = asUnknownArray(snapshot.parts);
    const toolInvocations = asUnknownArray(snapshot.toolInvocations);

    await upsertStoredMessage({
      id: messageId,
      conversationId: convId,
      role: 'assistant',
      content: typeof snapshot.content === 'string' ? snapshot.content : '',
      timestamp: typeof snapshot.timestamp === 'string' ? snapshot.timestamp : timestamp,
      parts,
      toolInvocations: toolInvocations && toolInvocations.length > 0
        ? toolInvocations
        : undefined,
    });
    await db.conversations.update(convId, { updatedAt: new Date().toISOString() });
    await loadConversations();
  }, [loadConversations]);

  const chatStreamFetch = useCallback(async (url: string, init?: RequestInit) => {
    // Cancel any previous streaming request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const response = await fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        'X-Hermes-Profile': getActiveProfile(),
      },
      signal: abortControllerRef.current.signal,
    });
    if (!response.ok) {
      const text = await response.clone().text().catch(() => '');
      console.error(`[useChat:fetch] Error response body:`, text.slice(0, 500));
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === 'string' && parsed.error.trim()) {
            throw new Error(parsed.error);
          }
        } catch (parseError) {
          if (parseError instanceof Error && parseError.message !== text) {
            throw parseError;
          }
        }
        throw new Error(text);
      }
      throw new Error(`Request failed with status ${response.status}`);
    }
    if (!response.body) return response;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const applyServerToolEvent = (event: ServerToolEvent) => {
      const msgId = 'current';
      const eventKey = getServerToolEventKey(event);
      const seenEventKeys = serverToolEventKeysRef.current[msgId] ?? new Set<string>();

      if (seenEventKeys.has(eventKey)) {
        return;
      }

      seenEventKeys.add(eventKey);
      serverToolEventKeysRef.current[msgId] = seenEventKeys;
      serverSideToolsDetectedRef.current = true;
      const currentEvents = serverToolEventsRef.current[msgId] || [];
      serverToolEventsRef.current = {
        ...serverToolEventsRef.current,
        [msgId]: [...currentEvents, event],
      };
      if (event.type === 'repo_proposal') {
        const plan = Array.isArray(event.plan)
          ? event.plan
              .filter((item): item is { path: string; action: string; description: string } =>
                !!item &&
                typeof item === 'object' &&
                typeof (item as { path?: unknown }).path === 'string' &&
                typeof (item as { action?: unknown }).action === 'string' &&
                typeof (item as { description?: unknown }).description === 'string',
              )
              .map((item) => ({
                path: item.path,
                action: item.action,
                description: item.description,
              }))
          : [];
        pendingProposalRef.current = {
          messageId: '',
          summary: typeof event.summary === 'string' ? event.summary : null,
          excerpt: null,
          plan,
        };
        explicitProposalKeyRef.current = getPendingProposalKey(pendingProposalRef.current);
      }
      const addChangeFn = (change: { path: string; action: 'create' | 'edit' | 'delete'; content: string; originalContent?: string; staged: boolean }) => {
        const changesetStore = useChangesetStore.getState();
        const existing = changesetStore.getChangeset(scopeId).changes[change.path];
        const originalContent = change.originalContent ?? existing?.originalContent ?? '';
        changesetStore.addChange(scopeId, {
          path: change.path,
          action: change.action,
          content: change.content,
          originalContent,
          staged: change.staged,
        });
      };
      const batchAddChangesFn = (changes: Array<{ path: string; action: 'create' | 'edit' | 'delete'; content: string; originalContent?: string; staged: boolean }>) => {
        const changesetStore = useChangesetStore.getState();
        // Resolve originalContent for each change before the batch update
        const resolved = changes.map((change) => {
          const existing = changesetStore.getChangeset(scopeId).changes[change.path];
          return {
            ...change,
            originalContent: change.originalContent ?? existing?.originalContent ?? '',
          };
        });
        changesetStore.batchAddChanges(scopeId, resolved);
        // Verify
      };
      handleServerToolEvent(
        event,
        scopeId,
        {
          conversationId: convIdRef.current,
          addChange: addChangeFn,
          batchAddChanges: batchAddChangesFn,
        },
      );
    };

    const updateToolActivity = (activity: ToolActivityEvent) => {
      const msgId = 'current';
      const prev = [...(toolActivityRef.current[msgId] || [])];

      const existingIdx = activity.status === 'completed'
        ? prev.findLastIndex(
            (e) =>
              e.tool === activity.tool &&
              e.status === 'running' &&
              (!activity.input || e.input === activity.input),
          )
        : prev.findIndex(
            (e) => e.tool === activity.tool && e.input === activity.input && e.status === 'running',
          );

      if (existingIdx >= 0 && activity.status === 'completed') {
        // Preserve the running event's input (which has the full args)
        const fullInput = prev[existingIdx].input || activity.input;
        prev[existingIdx] = {
          ...prev[existingIdx],
          ...activity,
          input: fullInput,
          output: activity.output ?? prev[existingIdx].output,
        };
      } else if (existingIdx < 0) {
        prev.push(activity);
      }

      toolActivityRef.current = { ...toolActivityRef.current, [msgId]: prev };
      setToolActivityMap({ ...toolActivityRef.current });
    };

    const updateAgentStatus = (nextStatus: AgentStatusEvent) => {
      setAgentStatus((current) => {
        if (
          current?.label === nextStatus.label &&
          current?.phase === nextStatus.phase &&
          current?.iteration === nextStatus.iteration &&
          current?.elapsed_ms === nextStatus.elapsed_ms
        ) {
          return current;
        }
        return nextStatus;
      });
    };

    const stream = new ReadableStream({
      async pull(controller) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            controller.close();
            return;
          }
          throw e;
        }
        const { done, value } = readResult;
        if (done) {
          controller.close();
          return;
        }

        const text = decoder.decode(value, { stream: true });
        buffer += text;

        // Safety: if buffer grows beyond 1MB without newlines, flush it
        // to prevent memory issues from malformed streams
        if (buffer.length > 1_048_576 && !buffer.includes('\n')) {
          buffer = '';
        }

        // Extract tool_activity from SSE data lines before SDK processes them
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              const delta = parsed?.choices?.[0]?.delta;
              if (delta?.tool_activity) {
                updateToolActivity(delta.tool_activity as ToolActivityEvent);
              }
              if (delta?.agent_status && typeof delta.agent_status === 'object') {
                updateAgentStatus(delta.agent_status as AgentStatusEvent);
              }
              if (delta?.server_tool_event && isServerToolEvent(delta.server_tool_event)) {
                applyServerToolEvent(delta.server_tool_event as ServerToolEvent);
              }
              if (isServerToolEvent(parsed)) {
                applyServerToolEvent(parsed);
              }
            } catch {
              // Not valid JSON, skip
            }
            continue;
          }

          try {
            const parsedPart = parseDataStreamPart(line);

            if (
              (parsedPart.type === 'tool_call' || parsedPart.type === 'tool_call_streaming_start') &&
              isServerExecutedRepoToolName(parsedPart.value.toolName)
            ) {
              serverSideToolsDetectedRef.current = true;
            }

            if (parsedPart.type === 'data' && Array.isArray(parsedPart.value)) {
              for (const item of parsedPart.value) {
                if (isHermesToolActivityData(item)) {
                  updateToolActivity(item.activity);
                  continue;
                }
                if (isAgentStatusData(item)) {
                  updateAgentStatus(item.status);
                  continue;
                }
                if (isServerToolEvent(item)) {
                  applyServerToolEvent(item);
                }
              }
            }
          } catch {
            // Not an AI SDK data-stream line, skip.
          }
        }

        // Pass raw bytes through unmodified for the SDK to process
        controller.enqueue(value);
      },
    });

    return new Response(stream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }, [scopeId]);

  const ensureRepoFileTreeLoaded = useCallback(async (): Promise<string[]> => {
    const currentChangeset = useChangesetStore.getState().getChangeset(scopeId);
    if (!currentChangeset.isRepoMode || !currentChangeset.activeRepo) {
      return [];
    }

    if (currentChangeset.repoFileTree.length > 0) {
      return currentChangeset.repoFileTree;
    }

    if (!githubPAT) {
      return [];
    }

    useChangesetStore.getState().setRepoFileTreeStatus(scopeId, 'loading');

    const result = await fetchRepoFileTreeResult(
      githubPAT,
      currentChangeset.activeRepo.owner,
      currentChangeset.activeRepo.name,
      currentChangeset.activeRepo.defaultBranch,
    );

    if (result.error) {
      useChangesetStore.getState().setRepoFileTreeStatus(scopeId, 'error', result.error);
      return [];
    }

    useChangesetStore.getState().setRepoFileTree(scopeId, result.paths);
    return result.paths;
  }, [githubPAT, scopeId]);

  const buildRequestBody = useCallback((overrides?: {
    conversationId?: string | null;
    repoFileTree?: string[];
    repoFileCache?: Record<string, string>;
    continuingApprovedProposal?: boolean;
    repoEditIntent?: boolean;
  }) => {
    const currentChangeset = useChangesetStore.getState().getChangeset(scopeId);
    const currentGithubPAT = useSettingsStore.getState().githubPAT;
    const currentActiveRepo = currentChangeset.activeRepo;
    const currentIsRepoMode = currentChangeset.isRepoMode && !!currentActiveRepo;
    const conversationIdForRequest = overrides?.conversationId ?? requestConversationIdRef.current;
    const repoFileTreeForRequest = overrides?.repoFileTree ?? currentChangeset.repoFileTree;
    const repoFileCacheForRequest = overrides?.repoFileCache ?? currentChangeset.repoFileCache;
    const repoEditIntentForRequest = typeof overrides?.repoEditIntent === 'boolean'
      ? overrides.repoEditIntent
      : repoEditIntentRef.current;
    const continuingApprovedProposal = overrides?.continuingApprovedProposal === true;

    // Compute effective hermes toolsets from fresh store state to avoid stale memo values mid-stream
    const currentHermesUsesLocalCloneFallback = currentIsRepoMode && !!currentActiveRepo?.localPath && !currentGithubPAT;
    const currentEffectiveHermesToolsets = currentIsRepoMode && !currentHermesUsesLocalCloneFallback
      ? hermesToolsets.filter((toolset) => !REPO_MODE_DISABLED_HERMES_TOOLSETS.has(toolset))
      : hermesToolsets;

    return {
      provider: effectiveProvider,
      model: effectiveModel,
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      api_key: config.apiKey,
      system_prompt: buildRepoSystemPrompt(
        currentActiveRepo,
        currentIsRepoMode,
        repoEditIntentForRequest,
        !!(currentIsRepoMode && currentActiveRepo && (currentGithubPAT || currentActiveRepo.localPath)),
      ),
      ...(currentIsRepoMode && currentActiveRepo
        ? {
            activeRepo: {
              ...currentActiveRepo,
              default_branch: currentActiveRepo.defaultBranch,
            },
          }
        : {}),
      ...(currentIsRepoMode && currentActiveRepo ? { repo_edit_intent: repoEditIntentForRequest } : {}),
      ...(effectiveProvider === 'hermes' ? { hermes_toolsets: currentEffectiveHermesToolsets.join(',') } : {}),
      ...(effectiveProvider === 'hermes' && hermesSwarmEnabled ? { hermes_swarm_mode: true } : {}),
      ...(effectiveProvider === 'hermes' && hermesCustomToolDefs.length > 0 ? { custom_tools: hermesCustomToolDefs } : {}),
      ...(effectiveProvider !== 'hermes' && effectiveProvider !== 'openclaw' && agentToolsets ? { agent_toolsets: agentToolsets } : {}),
      ...(effectiveProvider === 'hermes' && effectiveModel.startsWith('MiniMax-')
        ? { hermes_minimax_key: useSettingsStore.getState().providers.minimax?.apiKey || useSettingsStore.getState().providers['minimax-payg']?.apiKey || '' }
        : {}),
      ...(currentIsRepoMode && currentActiveRepo && currentGithubPAT ? { github_pat: currentGithubPAT } : {}),
      ...(currentIsRepoMode && repoFileTreeForRequest.length > 0 ? { repo_file_tree: repoFileTreeForRequest } : {}),
      ...(currentIsRepoMode && Object.keys(repoFileCacheForRequest).length > 0
        ? { repo_file_cache: repoFileCacheForRequest }
        : {}),
      ...(conversationIdForRequest ? { conversation_id: conversationIdForRequest } : {}),
      ...(continuingApprovedProposal ? { continuing_approved_proposal: true } : {}),
      // STEP 7: Pass planMode in the request body
      ...(useChatStore.getState().planMode ? { planMode: true } : {}),
    };
  }, [
    agentToolsets,
    buildRepoSystemPrompt,
    config.apiKey,
    config.maxTokens,
    config.temperature,
    config.topP,
    hermesCustomToolDefs,
    hermesSwarmEnabled,
    hermesToolsets,
    effectiveModel,
    effectiveProvider,
    reasoningEffort,
    scopeId,
  ]);

  const requestBody = (() => {
    const nextBody = activeRequestBodyRef.current ?? buildRequestBody();
    if (!('continuing_approved_proposal' in nextBody)) {
      return nextBody;
    }
    const { continuing_approved_proposal: _ignoredContinuation, ...rest } = nextBody;
    return rest;
  })();

  const {
    messages,
    append,
    status,
    stop: sdkStop,
    reload,
    setMessages,
    error,
  } = useAIChat({
    api: `${apiBaseUrl}/functions/v1/chat`,
    fetch: chatStreamFetch,
    body: requestBody,
    experimental_prepareRequestBody: ({ id, messages: requestMessages, requestData, requestBody: perRequestBody }) => ({
      id,
      messages: requestMessages,
      data: requestData,
      ...(activeRequestBodyRef.current ?? buildRequestBody()),
      ...(perRequestBody ?? {}),
    }),
    id: aiChatSessionId,
    streamProtocol: 'data',
    experimental_throttle: 32,
    maxSteps: Infinity,
    onFinish: async (message, options) => {
      // Use streamConvIdRef (captured at stream start) so mid-stream
      // conversation navigation doesn't redirect persistence to the wrong thread.
      const convId = streamConvIdRef.current ?? convIdRef.current;
      if (!convId) return;
      setAgentStatus(null);

      const currentToolActivity = toolActivityRef.current.current || [];
      const currentServerToolEvents = serverToolEventsRef.current.current || [];
      const hasCurrentFallbackData = currentToolActivity.length > 0 || currentServerToolEvents.length > 0;
      const incomingParts = Array.isArray(message?.parts) ? message.parts as unknown[] : undefined;
      const incomingToolInvocations = Array.isArray(message?.toolInvocations)
        ? message.toolInvocations as unknown[]
        : undefined;
      const synthesizedCurrentToolInvocations = hasCurrentFallbackData
        ? synthesizeToolInvocationsForPersistence(currentToolActivity, currentServerToolEvents)
        : [];
      let finishedMessage = message as unknown as Record<string, unknown> | undefined;
      let finishedMessageId = typeof message?.id === 'string' && message.id ? message.id : null;
      const messageWithTimestamp = message as (AIMessage & { timestamp?: string }) | undefined;
      const finishedTimestamp = typeof messageWithTimestamp?.timestamp === 'string' && messageWithTimestamp.timestamp
        ? messageWithTimestamp.timestamp
        : new Date().toISOString();

      if (
        !finishedMessageId &&
        (
          hasCurrentFallbackData ||
          (typeof message?.content === 'string' && message.content.length > 0) ||
          (incomingParts?.length ?? 0) > 0 ||
          (incomingToolInvocations?.length ?? 0) > 0
        )
      ) {
        finishedMessageId = crypto.randomUUID();
        finishedMessage = {
          id: finishedMessageId,
          role: 'assistant',
          content: typeof message?.content === 'string' ? message.content : '',
          timestamp: finishedTimestamp,
          ...(incomingParts ? { parts: incomingParts } : {}),
          ...(
            incomingToolInvocations && incomingToolInvocations.length > 0
              ? { toolInvocations: incomingToolInvocations }
              : (synthesizedCurrentToolInvocations.length > 0
                  ? { toolInvocations: synthesizedCurrentToolInvocations }
                  : {})
          ),
        };
      }

      // Remap tool activity from 'current' to the actual message ID
      if (finishedMessageId && toolActivityRef.current['current']) {
        const currentActivity = toolActivityRef.current['current'];
        delete toolActivityRef.current['current'];
        toolActivityRef.current[finishedMessageId] = currentActivity;
        setToolActivityMap({ ...toolActivityRef.current });
      }
      if (finishedMessageId && serverToolEventsRef.current['current']) {
        const currentEvents = serverToolEventsRef.current['current'];
        delete serverToolEventsRef.current['current'];
        serverToolEventsRef.current[finishedMessageId] = currentEvents;
      }
      if (finishedMessageId && serverToolEventKeysRef.current.current) {
        const currentEventKeys = serverToolEventKeysRef.current.current;
        delete serverToolEventKeysRef.current.current;
        serverToolEventKeysRef.current[finishedMessageId] = currentEventKeys;
      }

      const messageToolActivity = finishedMessageId
        ? toolActivityRef.current[finishedMessageId] || []
        : currentToolActivity;
      const messageServerToolEvents = finishedMessageId
        ? serverToolEventsRef.current[finishedMessageId] || []
        : currentServerToolEvents;
      const persistedFinishedMessage = finishedMessage
        ? buildAssistantSnapshotForPersistence({
            message: finishedMessage,
            streamedMessage: finishedMessageId
              ? messagesRef.current.find((entry) => entry.id === finishedMessageId) as unknown as Record<string, unknown> | undefined
              : undefined,
            toolActivity: messageToolActivity,
            serverToolEvents: messageServerToolEvents,
            fallbackId: finishedMessageId ?? undefined,
            fallbackTimestamp: finishedTimestamp,
          })
        : undefined;
      const finishedMessageParts = Array.isArray(finishedMessage?.parts) ? finishedMessage.parts as unknown[] : undefined;
      const finishedMessageToolInvocations = Array.isArray(finishedMessage?.toolInvocations)
        ? finishedMessage.toolInvocations as unknown[]
        : undefined;
      const shouldInjectFinishedMessage =
        !!finishedMessageId &&
        !messagesRef.current.some((entry) => entry.id === finishedMessageId) &&
        (
          (typeof finishedMessage?.content === 'string' && finishedMessage.content.length > 0) ||
          (finishedMessageParts?.length ?? 0) > 0 ||
          (finishedMessageToolInvocations?.length ?? 0) > 0 ||
          messageToolActivity.length > 0 ||
          messageServerToolEvents.length > 0
        );

      if (shouldInjectFinishedMessage && (persistedFinishedMessage || finishedMessage)) {
        const injectedMessage = (persistedFinishedMessage ?? finishedMessage) as Record<string, unknown>;
        const injectedParts = Array.isArray(injectedMessage.parts) ? injectedMessage.parts as unknown[] : undefined;
        const injectedToolInvocations = Array.isArray(injectedMessage.toolInvocations)
          ? injectedMessage.toolInvocations as unknown[]
          : undefined;
        const nextMessages = [
          ...messagesRef.current,
          {
            id: finishedMessageId,
            role: (typeof injectedMessage.role === 'string' ? injectedMessage.role : 'assistant') as AIMessage['role'],
            content: typeof injectedMessage.content === 'string' ? injectedMessage.content : '',
            ...(typeof injectedMessage.timestamp === 'string' ? { timestamp: injectedMessage.timestamp } : {}),
            ...(injectedParts ? { parts: injectedParts } : {}),
            ...(injectedToolInvocations ? { toolInvocations: injectedToolInvocations } : {}),
          } as AIMessage,
        ];
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
      }

      // Persist assistant message (including parts and tool invocations)
      if (!finishedMessage && !persistedFinishedMessage) return;
      await persistAssistantSnapshot((persistedFinishedMessage ?? finishedMessage) as Record<string, unknown>, convId, {
        toolActivity: messageToolActivity,
        serverToolEvents: messageServerToolEvents,
      });

      // If the user explicitly clicked stop, skip all auto-continue logic.
      // Reset counters so the next user-initiated send starts fresh.
      if (userStoppedRef.current) {
        userStoppedRef.current = false;
        unknownFinishRetryRef.current = 0;
        repoStopRetryRef.current = 0;
        activeRequestBodyRef.current = null;
        approvedProposalContinuationRef.current = null;
        return;
      }

      const finishReason = options?.finishReason;
      const repoWorkflowNames = collectRepoWorkflowToolNames(
        finishedMessage as {
          content?: string;
          parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
          toolInvocations?: Array<{ toolName?: string }>;
        },
        messageToolActivity,
        messageServerToolEvents,
      );
      const latestUserApproval = isRepoApprovalFollowUpMessage(
        messagesRef.current.findLast((entry) => entry.role === 'user')?.content ?? '',
      );
      const approvedPlanMentioned = /\b(?:approved|accepted)\s+plan\b/i.test(
        typeof finishedMessage.content === 'string' ? finishedMessage.content : '',
      );
      const inferredApprovedContinuation =
        pendingProposalRef.current !== null &&
        (
          latestUserApproval ||
          repoWorkflowNames.some((toolName) => REPO_EDIT_TOOL_NAMES.has(toolName)) ||
          approvedPlanMentioned
        );
      const continuingApprovedProposal =
        approvedProposalContinuationRef.current !== null || inferredApprovedContinuation;
      if (continuingApprovedProposal && approvedProposalContinuationRef.current === null) {
        approvedProposalContinuationRef.current = {
          conversationId: convId,
          proposalKey: getPendingProposalKey(pendingProposalRef.current),
        };
      }
      // Detect partial/incomplete tool calls left by a dropped stream (common
      // with Minimax and other providers that may terminate mid-tool-call).
      const hasPartialToolCalls = (finishedMessage.parts as Array<{ type?: string; toolInvocation?: { state?: string } }> | undefined)?.some(
        (p) => p.type === 'tool-invocation' && (p.toolInvocation?.state === 'partial-call' || p.toolInvocation?.state === 'call'),
      ) || (finishedMessage.toolInvocations as Array<{ state?: string }> | undefined)?.some(
        (inv) => inv.state === 'partial-call' || inv.state === 'call',
      );

      if (finishReason !== 'tool-calls') {
        if (
          // Auto-continue when tool calls were interrupted mid-stream. The
          // sanitizePartialToolCalls helper will patch them with error results
          // before re-sending, so the model sees the failure and can retry.
          hasPartialToolCalls &&
          activeRepo &&
          unknownFinishRetryRef.current < MAX_UNKNOWN_FINISH_RETRIES
        ) {
          unknownFinishRetryRef.current += 1;
          scheduleAutoContinue({
            conversationId: convId,
            content: continuingApprovedProposal
              ? 'Your tool call was interrupted mid-execution. Continue the accepted plan — retry the tool call and complete the remaining work.'
              : repoEditIntentRef.current
                ? 'Your tool call was interrupted mid-execution. Retry the tool call and continue where you left off.'
                : 'Your tool call was interrupted mid-execution. Retry the tool call and continue your analysis.',
            continuingApprovedProposal,
            forceRepoEditIntent: continuingApprovedProposal || repoEditIntentRef.current,
          });
        } else if (
          // Auto-continue when the model is interrupted mid-work with an unknown
          // finish reason (common with OpenRouter/Gemini hitting token limits or
          // returning non-standard finish reasons). Recover when the turn was
          // actively doing repo work, including read-only analysis with
          // server-side repo reads, and cap retries to avoid loops.
          (finishReason === 'unknown' || finishReason === 'length') &&
          activeRepo &&
          (
            repoEditIntentRef.current ||
            continuingApprovedProposal ||
            repoWorkflowNames.length > 0 ||
            stalledOnRepoRead(
              finishedMessage as {
                content?: string;
                parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
                toolInvocations?: Array<{ toolName?: string }>;
              },
              messageToolActivity,
              messageServerToolEvents,
            )
          ) &&
          unknownFinishRetryRef.current < MAX_UNKNOWN_FINISH_RETRIES
        ) {
          unknownFinishRetryRef.current += 1;
          scheduleAutoContinue({
            conversationId: convId,
            content: continuingApprovedProposal
              ? 'You were interrupted in the middle of the accepted repo plan. Continue the accepted plan now and complete the remaining file changes.'
              : repoEditIntentRef.current
                ? 'You were interrupted mid-work. Continue where you left off — complete the remaining file changes.'
                : "You were interrupted in the middle of a read-only repo analysis. Continue inspecting the repo as needed and answer the user's question directly.",
            continuingApprovedProposal,
            forceRepoEditIntent: continuingApprovedProposal || repoEditIntentRef.current,
          });
        } else if (
          finishReason === 'stop' &&
          activeRepo &&
          repoStopRetryRef.current < MAX_REPO_STOP_RETRIES &&
          stalledOnRepoRead(
            finishedMessage as {
              content?: string;
              parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
              toolInvocations?: Array<{ toolName?: string }>;
            },
            messageToolActivity,
            messageServerToolEvents,
          )
        ) {
          repoStopRetryRef.current += 1;
          scheduleAutoContinue({
            conversationId: convId,
            content: continuingApprovedProposal
              ? 'Continue the accepted plan now. You stopped after reading a file but the approved repo work is not finished yet. Keep using repo tools until the accepted changes are complete.'
              : repoEditIntentRef.current
                ? 'You stopped in the middle of repo work after reading a file. Continue making the requested changes. Do not stop after a single read_repo_file result.'
                : "You stopped in the middle of a read-only repo analysis after reading a file. Continue inspecting the repo as needed and answer the user's question directly.",
            continuingApprovedProposal,
            forceRepoEditIntent: continuingApprovedProposal || repoEditIntentRef.current,
          });
        } else if (
          finishReason === 'stop' &&
          activeRepo &&
          repoStopRetryRef.current < MAX_REPO_STOP_RETRIES &&
          describedEditButDidNotExecute(
            message as {
              content?: string;
              parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
              toolInvocations?: Array<{ toolName?: string }>;
            },
            messageToolActivity,
            messageServerToolEvents,
            repoEditIntentRef.current,
          )
        ) {
          repoStopRetryRef.current += 1;
          scheduleAutoContinue({
            conversationId: convId,
            content: continuingApprovedProposal
              ? 'Continue the accepted plan now. You described the approved changes but did not execute any repo tools. Do not narrate the plan again. Call read_repo_file or the repo edit tools directly.'
              : 'You described changes but did not apply them. Do not describe what you will do — actually call the edit tools now. Use batch_edit_repo_files or edit_repo_file to make the changes directly.',
            continuingApprovedProposal,
            forceRepoEditIntent: continuingApprovedProposal || repoEditIntentRef.current,
          });
        } else if (
          finishReason === 'stop' &&
          continuingApprovedProposal &&
          activeRepo &&
          repoStopRetryRef.current < MAX_REPO_STOP_RETRIES &&
          repoWorkflowNames.length === 0
        ) {
          repoStopRetryRef.current += 1;
          scheduleAutoContinue({
            conversationId: convId,
            content: 'Continue the accepted plan now. You did not execute any repo tools in the last step. Use read_repo_file for more context or call the repo edit tools directly.',
            continuingApprovedProposal: true,
            forceRepoEditIntent: true,
          });
        } else {
          // Natural finish — reset retry counters
          unknownFinishRetryRef.current = 0;
          repoStopRetryRef.current = 0;
          activeRequestBodyRef.current = null;
          approvedProposalContinuationRef.current = null;
          pendingProposalRef.current = null;
          explicitProposalKeyRef.current = null;
          // PR readiness is handled by the auto-PR useEffect that watches
          // the isStreaming transition — don't signal here since the stream
          // may not be fully consumed yet.
        }
      } else {
        // Tool-calls finish — let the AI SDK continue the conversation
        activeRequestBodyRef.current = null;
      }
    },
    onToolCall: async ({ toolCall }) => {
      // When server-side tool execution is active, repo tools are handled
      // server-side — return a no-op result to avoid duplicate execution.
      if (serverSideToolsDetectedRef.current && SERVER_EXECUTED_REPO_TOOLS.has(toolCall.toolName)) {
        return `Handled server-side`;
      }

      if (toolCall.toolName === 'propose_changes') {
        if (approvedProposalContinuationRef.current) {
          return 'This proposal was already approved. Continue directly with read_repo_file or the repo edit tools now.';
        }
        const normalizedArgs = normalizeProposeChangesArgs(toolCall.args, {
          existingPaths: getRepoToolExistingPaths(scopeId),
        }) as { summary?: unknown; plan?: unknown };
        pendingProposalRef.current = {
          messageId: '',
          summary: typeof normalizedArgs.summary === 'string' ? normalizedArgs.summary : null,
          excerpt: null,
          plan: Array.isArray(normalizedArgs.plan)
            ? normalizedArgs.plan
                .filter((item): item is { path: string; action: string; description: string } =>
                  !!item &&
                  typeof item === 'object' &&
                  typeof (item as { path?: unknown }).path === 'string' &&
                  typeof (item as { action?: unknown }).action === 'string' &&
                  typeof (item as { description?: unknown }).description === 'string',
                )
                .map((item) => ({
                  path: item.path,
                  action: item.action,
                  description: item.description,
                }))
            : [],
        };
        explicitProposalKeyRef.current = getPendingProposalKey(pendingProposalRef.current);
        return 'Proposal ready for review. Pause for approval before editing repo files.';
      }

      // Handle file creation tools (artifacts/preview)
      const FILE_TYPE_MAP: Record<string, FileType> = {
        create_html_file: 'html',
        create_css_file: 'css',
        create_js_file: 'js',
        create_react_component: 'jsx',
        create_markdown_file: 'md',
      };

      const fileType = FILE_TYPE_MAP[toolCall.toolName];
      if (fileType) {
        const { filename, content } = toolCall.args as { filename: string; content: string };
        const previewStore = usePreviewStore.getState();
        const previewState = previewStore.getPreview(scopeId);
        // Check if file already exists (update it) or add new
        const existing = previewState.files.find((f) => f.filename === filename);
        if (existing) {
          previewStore.updateFile(scopeId, existing.id, content);
        } else {
          previewStore.addFile(scopeId, { filename, content, type: fileType });
        }
        return JSON.stringify({ success: true, filename, message: `Created ${filename}` });
      }

      // Handle repo tool calls
      if (toolCall.toolName === 'read_repo_file') {
        const { path } = toolCall.args as { path: string };
        const normalizedPath = normalizeRepoPath(path);
        const currentRepo = useChangesetStore.getState().getChangeset(scopeId).activeRepo;
        if (!currentRepo || !githubPAT) {
          return 'Error: No active repository or GitHub token not configured.';
        }

        if (isInvalidRepoReadPath(normalizedPath)) {
          return 'Error: Choose a concrete file path from the loaded repository tree, not `.` , `/`, or a directory path.';
        }

        const currentChangeset = useChangesetStore.getState().getChangeset(scopeId);
        const repoTree = currentChangeset.repoFileTree.length > 0
          ? currentChangeset.repoFileTree
          : await ensureRepoFileTreeLoaded();

        const repoTreeStatus = useChangesetStore.getState().getChangeset(scopeId).repoFileTreeStatus;
        const repoTreeError = useChangesetStore.getState().getChangeset(scopeId).repoFileTreeError;

        if (repoTree.length === 0) {
          return formatRepoTreeUnavailableError(repoTreeStatus, repoTreeError);
        }

        if (!repoTree.includes(normalizedPath)) {
          return formatMissingRepoFileError(normalizedPath, repoTree);
        }

        // Return cached content if available (avoids redundant GitHub API calls)
        const cached = useChangesetStore.getState().getChangeset(scopeId).repoFileCache[normalizedPath];
        if (cached !== undefined) {
          return cached;
        }

        try {
          const response = await fetch(
            `${getApiBaseUrl()}/functions/v1/github-integration`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'read-file',
                pat: githubPAT,
                owner: currentRepo.owner,
                repo: currentRepo.name,
                path: normalizedPath,
                ref: currentRepo.defaultBranch,
              }),
            }
          );
          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            return `Error reading file: server returned ${response.status}${errText ? ` — ${errText.slice(0, 200)}` : ''}`;
          }
          const data = await response.json();
          if (data.error) return `Error reading file: ${data.error}`;
          useChangesetStore.getState().cacheRepoFile(scopeId, normalizedPath, data.content || '');
          return data.content || '';
        } catch {
          return 'Error: Failed to read file from GitHub.';
        }
      }

      if (toolCall.toolName === 'edit_repo_file') {
        const normalizedArgs = normalizeEditRepoFileArgs(toolCall.args) as {
          path?: unknown;
          content?: unknown;
        };
        const path = typeof normalizedArgs.path === 'string' ? normalizedArgs.path : '';
        const content = typeof normalizedArgs.content === 'string' ? normalizedArgs.content : '';
        if (!path) {
          return 'Error: edit_repo_file is missing a valid path.';
        }
        const existingPaths = getRepoToolExistingPaths(scopeId);
        const approvedPlanAllowsEdit =
          approvedProposalContinuationRef.current !== null &&
          (pendingProposalRef.current?.plan ?? []).some((item) => item.action === 'edit' && item.path === path);
        if (!existingPaths.has(path) && !approvedPlanAllowsEdit) {
          return `Error: edit_repo_file can only modify existing repo files. \`${path}\` is not in the indexed repo tree or staged changes. Use create_repo_file only for genuinely new paths.`;
        }
        const existing = useChangesetStore.getState().getChangeset(scopeId).changes[path];
        const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[path] ?? '';
        addChange({ path, action: 'edit', content, originalContent, staged: true });
        return `Staged edit to ${path}`;
      }

      if (toolCall.toolName === 'create_repo_file') {
        const normalizedArgs = normalizeCreateRepoFileArgs(toolCall.args) as {
          path?: unknown;
          content?: unknown;
        };
        const path = typeof normalizedArgs.path === 'string' ? normalizedArgs.path : '';
        const content = typeof normalizedArgs.content === 'string' ? normalizedArgs.content : '';
        if (!path) {
          return 'Error: create_repo_file is missing a valid path.';
        }
        const existingPaths = getRepoToolExistingPaths(scopeId);
        const action = resolveRepoWriteAction('create', path, existingPaths);
        const existing = useChangesetStore.getState().getChangeset(scopeId).changes[path];
        const originalContent = action === 'edit'
          ? existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[path] ?? ''
          : '';
        addChange({ path, action, content, originalContent, staged: true });
        return action === 'edit' ? `Staged edit to ${path}` : `Staged new file ${path}`;
      }

      if (toolCall.toolName === 'delete_repo_file') {
        const normalizedArgs = normalizeDeleteRepoFileArgs(toolCall.args) as { path?: unknown };
        const path = typeof normalizedArgs.path === 'string' ? normalizedArgs.path : '';
        if (!path) {
          return 'Error: delete_repo_file is missing a valid path.';
        }
        const existingPaths = getRepoToolExistingPaths(scopeId);
        if (!existingPaths.has(path)) {
          return `Error: delete_repo_file can only delete existing repo files. \`${path}\` is not in the indexed repo tree or staged changes.`;
        }
        const existing = useChangesetStore.getState().getChangeset(scopeId).changes[path];
        const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[path] ?? '';
        addChange({ path, action: 'delete', content: '', originalContent, staged: true });
        return `Staged deletion of ${path}`;
      }

      if (toolCall.toolName === 'batch_edit_repo_files') {
        const normalizedArgs = normalizeBatchEditRepoFilesArgs(toolCall.args, {
          existingPaths: getRepoToolExistingPaths(scopeId),
        }) as { changes?: unknown };
        const fileChanges = Array.isArray(normalizedArgs.changes)
          ? normalizedArgs.changes as Array<{ path: string; action: 'create' | 'edit' | 'delete'; content: string; description: string }>
          : [];
        const knownPaths = getRepoToolExistingPaths(scopeId);
        const approvedPlanEditPaths = new Set(
          approvedProposalContinuationRef.current !== null
            ? (pendingProposalRef.current?.plan ?? [])
                .filter((item) => item.action === 'edit')
                .map((item) => item.path)
            : [],
        );
        const results: string[] = [];
        for (const change of fileChanges) {
          if (!change?.path || (change.action !== 'create' && change.action !== 'edit' && change.action !== 'delete')) {
            continue;
          }
          const action = resolveRepoWriteAction(change.action, change.path, knownPaths);
          if (action === 'edit' && !knownPaths.has(change.path) && !approvedPlanEditPaths.has(change.path)) {
            return `Error: batch_edit_repo_files cannot edit missing file \`${change.path}\`. Use create only for genuinely new files and edit only for paths already in the repo.`;
          }
          if (action === 'delete' && !knownPaths.has(change.path)) {
            return `Error: batch_edit_repo_files cannot delete missing file \`${change.path}\`. Use delete only for paths already present in the repo or staged changes.`;
          }
          const existing = useChangesetStore.getState().getChangeset(scopeId).changes[change.path];
          const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[change.path] ?? '';
          addChange({
            path: change.path,
            action,
            content: change.content || '',
            originalContent,
            staged: true,
          });
          if (action === 'delete') {
            knownPaths.delete(change.path);
          } else {
            knownPaths.add(change.path);
          }
          results.push(`Staged ${action} on ${change.path}`);
        }
        return results.join('\n');
      }
    },
    onError: (err) => {
      activeRequestBodyRef.current = null;
      pendingProposalRef.current = null;
      explicitProposalKeyRef.current = null;
      approvedProposalContinuationRef.current = null;
      delete toolActivityRef.current.current;
      delete serverToolEventsRef.current.current;
      delete serverToolEventKeysRef.current.current;
      setAgentStatus(null);
      const errorMessage = getErrorMessage(err);
      console.error('[useChat:onError] Chat error:', errorMessage, 'provider:', effectiveProvider, 'model:', effectiveModel);
      if (errorMessage.includes('not configured')) {
        setProviderUnavailableOpen(true);
      }
      // Handle truncated tool call JSON (model output exceeded token limit)
      if (errorMessage.includes('JSON parsing failed') || errorMessage.includes('Unexpected end of JSON')) {
        console.warn('Tool call was truncated — the model likely exceeded its output token limit. The response will be retried with a prompt to use smaller changes.');
      }
    },
  });

  // Wrap SDK stop to also abort the in-flight fetch
  const stop = useCallback(() => {
    userStoppedRef.current = true;
    // Cancel any pending auto-continue so it doesn't fire after stop
    if (autoContinueTimerRef.current) {
      clearTimeout(autoContinueTimerRef.current);
      autoContinueTimerRef.current = null;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    sdkStop();
  }, [sdkStop]);

  // Keep messagesRef in sync for use in callbacks without adding messages to deps
  messagesRef.current = messages;

  // Wrapper that prevents overwriting the AI SDK streaming buffer unless forced
  const safeSetMessages = useCallback((msgs: AIMessage[], force = false) => {
    if (!force && isStreamingRef.current) return;
    setMessages(msgs);
  }, [setMessages]);

  const scheduleAutoContinue = useCallback((request: AutoContinueRequest) => {
    const currentMessages = messagesRef.current;
    const sanitized = sanitizeRetryMessages(currentMessages);
    if (sanitized !== currentMessages) {
      safeSetMessages(sanitized, true);
    }

    if (autoContinueTimerRef.current) {
      clearTimeout(autoContinueTimerRef.current);
    }

    autoContinueTimerRef.current = setTimeout(() => {
      autoContinueTimerRef.current = null;
      serverSideToolsDetectedRef.current = false;
      activeRequestBodyRef.current = buildRequestBody({
        conversationId: request.conversationId,
        continuingApprovedProposal: request.continuingApprovedProposal,
        repoEditIntent: request.forceRepoEditIntent,
      });
      append(
        {
          role: 'system',
          content: request.content,
        },
        {
          body: {
            conversation_id: request.conversationId,
            ...(isRepoMode && activeRepo ? {
              repo_edit_intent: typeof request.forceRepoEditIntent === 'boolean'
                ? request.forceRepoEditIntent
                : repoEditIntentRef.current,
            } : {}),
            ...(request.continuingApprovedProposal ? { continuing_approved_proposal: true } : {}),
          },
        },
      ).catch((err) => {
        console.error('[useChat:autoContinue] Failed to auto-continue:', err);
        activeRequestBodyRef.current = null;
      });
    }, AUTO_CONTINUE_DELAY_MS);
  }, [activeRepo, append, buildRequestBody, isRepoMode, safeSetMessages, sanitizeRetryMessages]);

  // Track streaming state in global activity store
  const isStreaming = status === 'streaming' || status === 'submitted';
  isStreamingRef.current = isStreaming;

  // Serialize Hermes streams per-profile across panels. Two panels sharing the
  // active profile would otherwise both hit the same hermes_home/state.db/skills
  // directory concurrently, which corrupts tool results (skills_list, skill_view)
  // and traps the agent in a retry loop.
  const activeProfile = useProfilesStore((s) => s.activeProfile) || 'default';
  const profileLockHolder = useStreamLockStore((s) => s.locks[activeProfile]);
  const isAnotherPanelStreamingSameProfile =
    effectiveProvider === 'hermes' && !!profileLockHolder && profileLockHolder !== panelId;
  const effectiveBusy = isStreaming || isAnotherPanelStreamingSameProfile;

  useEffect(() => {
    if (effectiveProvider !== 'hermes') return;
    if (!isStreaming) return;
    // Capture the profile at stream start. If the user switches the active
    // profile mid-stream, the backend keeps streaming against the original
    // profile — so acquire and release must use the same value. Closure
    // capture here; `activeProfile` is intentionally not in the dep list.
    const profile = activeProfile;
    useStreamLockStore.getState().acquire(profile, panelId);
    return () => {
      useStreamLockStore.getState().release(profile, panelId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lock stays bound to profile captured at stream start
  }, [effectiveProvider, isStreaming, panelId]);

  useLayoutEffect(() => {
    // Track which conversation owns the active stream. Set on false→true and
    // cleared when streaming ends; intentionally not updated on mid-stream
    // navigation so it still identifies the stream's original conversation.
    if (!isStreaming) {
      streamConvIdRef.current = null;
    } else if (streamConvIdRef.current === null) {
      // Use convIdRef (already set by sendMessage before append()) or
      // pendingConversationIdRef, because the conversationId prop lags
      // behind for new conversations (onConversationCreated fires after
      // the stream resolves).
      streamConvIdRef.current = convIdRef.current ?? pendingConversationIdRef.current ?? conversationId;
    }
    // Session ID sync removed: aiChatSessionId is now derived via useMemo from
    // chatSessionId, so it's always in sync. No async state lag possible.
  }, [isStreaming, conversationId]);
  useEffect(() => {
    const pendingProposal = findPendingProposal(messages as Array<{
      id: string;
      role: string;
      content?: string;
      parts?: Array<{ type?: string; text?: string; reasoning?: string; toolInvocation?: { toolName?: string; state?: string; args?: Record<string, unknown>; result?: unknown } }>;
      toolInvocations?: Array<{ toolName?: string; state?: string; args?: Record<string, unknown>; result?: unknown }>;
    }>);
    const proposalKey = getPendingProposalKey(pendingProposal);
    const isExplicitProposal = !!proposalKey && explicitProposalKeyRef.current === proposalKey;

    pendingProposalRef.current = pendingProposal ?? pendingProposalRef.current;

    if (!isStreaming || !pendingProposal || autoApproveRepoChanges || conversationAutoApproveEnabled || approvedProposalContinuationRef.current) {
      if (!pendingProposal) {
        pausedProposalKeyRef.current = null;
        contentProposalStabilityRef.current = { key: null, cycles: 0 };
      }
      return;
    }

    if (!isExplicitProposal) {
      const stability = contentProposalStabilityRef.current;
      if (stability.key === proposalKey) {
        stability.cycles += 1;
      } else {
        contentProposalStabilityRef.current = { key: proposalKey, cycles: 1 };
      }

      if (contentProposalStabilityRef.current.cycles < 3) {
        return;
      }
    } else {
      contentProposalStabilityRef.current = { key: proposalKey, cycles: 0 };
    }

    if (!proposalKey || pausedProposalKeyRef.current === proposalKey) {
      return;
    }

    pausedProposalKeyRef.current = proposalKey;
    stop();

    const proposalMessage = messages.find((message) => message.id === pendingProposal.messageId);
    const persistedConversationId = convIdRef.current ?? pendingConversationIdRef.current;
    if (proposalMessage && persistedConversationId) {
      void persistAssistantSnapshot(proposalMessage as unknown as Record<string, unknown>, persistedConversationId, {
        toolActivity: proposalMessage.id ? toolActivityRef.current[proposalMessage.id] || [] : [],
        serverToolEvents: proposalMessage.id ? serverToolEventsRef.current[proposalMessage.id] || [] : [],
      });
    }

    if (!conversationId && pendingConversationIdRef.current) {
      skipNextLoadRef.current = true;
      onConversationCreated?.(pendingConversationIdRef.current);
    }
  }, [
    autoApproveRepoChanges,
    conversationAutoApproveEnabled,
    conversationId,
    isStreaming,
    messages,
    onConversationCreated,
    persistAssistantSnapshot,
    stop,
  ]);
  useEffect(() => {
    if (isStreaming || !activeRepo) return;

    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      if (appliedPseudoRepoMessageIdsRef.current.has(message.id)) continue;

      const messageToolActivity = message.id ? toolActivityRef.current[message.id] || [] : [];
      const messageServerToolEvents = message.id ? serverToolEventsRef.current[message.id] || [] : [];
      const executedRepoWrites = collectRepoWorkflowToolNames(
        message as {
          content?: string;
          parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
          toolInvocations?: Array<{ toolName?: string }>;
        },
        messageToolActivity,
        messageServerToolEvents,
      ).some((toolName) => REPO_EDIT_TOOL_NAMES.has(toolName));

      if (executedRepoWrites) continue;

      const sourceText = getPseudoToolSourceText(message as {
        content?: string;
        parts?: Array<{ type?: string; text?: string }>;
      });
      const messageIndex = messages.findIndex((entry) => entry.id === message.id);
      const previousUserMessage = messageIndex > 0
        ? messages.slice(0, messageIndex).findLast((entry) =>
            entry.role === 'user' && typeof entry.content === 'string' && entry.content.trim().length > 0,
          )
        : undefined;
      const allowPseudoRepoWrites = (previousUserMessage
        ? isRepoWriteMessage(previousUserMessage.content)
        : false) || repoEditIntentRef.current;
      const pseudoInvocations = extractPseudoToolInvocations(sourceText);
      const repoEditInvocation = allowPseudoRepoWrites
        ? pseudoInvocations.find((invocation) =>
            ['batch_edit_repo_files', 'edit_repo_file', 'create_repo_file', 'delete_repo_file'].includes(invocation.toolName),
          )
        : undefined;
      const textFileEdits = repoEditInvocation || !allowPseudoRepoWrites ? [] : extractTextFileEdits(sourceText);

      if (!repoEditInvocation && textFileEdits.length === 0) continue;

      if (repoEditInvocation?.toolName === 'batch_edit_repo_files') {
        const normalizedArgs = normalizeBatchEditRepoFilesArgs(repoEditInvocation.args, {
          existingPaths: getRepoToolExistingPaths(scopeId),
        }) as { changes?: unknown };
        const fileChanges = Array.isArray(normalizedArgs.changes)
          ? normalizedArgs.changes as Array<{ path?: string; action?: 'create' | 'edit' | 'delete'; content?: string }>
          : [];
        const knownPaths = getRepoToolExistingPaths(scopeId);

        for (const change of fileChanges) {
          if (
            typeof change?.path !== 'string' ||
            (change.action !== 'create' && change.action !== 'edit' && change.action !== 'delete')
          ) {
            continue;
          }
          const action = resolveRepoWriteAction(change.action, change.path, knownPaths);

          const existing = useChangesetStore.getState().getChangeset(scopeId).changes[change.path];
          const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[change.path] ?? '';
          addChange({
            path: change.path,
            action,
            content: typeof change.content === 'string' ? change.content : '',
            originalContent,
            staged: true,
          });
          if (action === 'delete') {
            knownPaths.delete(change.path);
          } else {
            knownPaths.add(change.path);
          }
        }
      } else if (repoEditInvocation) {
        const normalizedArgs = repoEditInvocation.toolName === 'create_repo_file'
          ? normalizeCreateRepoFileArgs(repoEditInvocation.args)
          : repoEditInvocation.toolName === 'delete_repo_file'
            ? normalizeDeleteRepoFileArgs(repoEditInvocation.args)
            : normalizeEditRepoFileArgs(repoEditInvocation.args);
        const path = typeof (normalizedArgs as { path?: unknown }).path === 'string'
          ? (normalizedArgs as { path: string }).path
          : null;
        const action = repoEditInvocation.toolName === 'create_repo_file'
          ? 'create'
          : repoEditInvocation.toolName === 'delete_repo_file'
            ? 'delete'
            : 'edit';
        if (!path) continue;
        const knownPaths = getRepoToolExistingPaths(scopeId);
        const resolvedAction = resolveRepoWriteAction(action, path, knownPaths);
        if (resolvedAction === 'delete' && !knownPaths.has(path)) {
          continue;
        }
        const existing = useChangesetStore.getState().getChangeset(scopeId).changes[path];
        const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[path] ?? '';
        addChange({
          path,
          action: resolvedAction,
          content: typeof (normalizedArgs as { content?: unknown }).content === 'string' ? (normalizedArgs as { content: string }).content : '',
          originalContent,
          staged: true,
        });
      } else {
        for (const edit of textFileEdits) {
          const existing = useChangesetStore.getState().getChangeset(scopeId).changes[edit.path];
          const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[edit.path] ?? '';
          addChange({
            path: edit.path,
            action: 'edit',
            content: edit.content,
            originalContent,
            staged: true,
          });
        }
      }

      appliedPseudoRepoMessageIdsRef.current.add(message.id);
    }
  }, [activeRepo, addChange, isStreaming, messages, scopeId]);
  // Auto-open PR modal when streaming finishes with staged changes.
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;

    if (wasStreaming && !isStreaming && activeRepo && onReadyForPR) {
      const lastAssistantMessage = messages.findLast((message) => message.role === 'assistant');
      const lastAssistantIndex = lastAssistantMessage
        ? messages.findIndex((message) => message.id === lastAssistantMessage.id)
        : -1;
      const allowPseudoRepoWrites = lastAssistantIndex >= 0
        ? allowPseudoRepoWritesForAssistantMessage(messages as Array<{
            id: string;
            role: string;
            content: string;
            parts?: Array<{ type?: string; text?: string; reasoning?: string; toolInvocation?: ProposalToolInvocationLike }>;
            toolInvocations?: ProposalToolInvocationLike[];
          }>, lastAssistantIndex) || repoEditIntentRef.current
        : repoEditIntentRef.current;
      const messageToolActivity = lastAssistantMessage?.id
        ? toolActivityRef.current[lastAssistantMessage.id] || []
        : [];
      const messageServerToolEvents = lastAssistantMessage?.id
        ? serverToolEventsRef.current[lastAssistantMessage.id] || []
        : [];
      const executedRepoWrites = lastAssistantMessage
        ? collectRepoWorkflowToolNames(
            lastAssistantMessage as {
              content?: string;
              parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
              toolInvocations?: Array<{ toolName?: string }>;
            },
            messageToolActivity,
            messageServerToolEvents,
          ).some((toolName) => REPO_EDIT_TOOL_NAMES.has(toolName))
        : false;
      const recoverablePseudoRepoWrites = lastAssistantMessage
        ? hasRecoverablePseudoRepoWrites(
            lastAssistantMessage as {
              content?: string;
              parts?: Array<{ type?: string; text?: string }>;
            },
            allowPseudoRepoWrites,
          )
        : false;

      if (!executedRepoWrites && !recoverablePseudoRepoWrites) {
        return;
      }

      const stagedCount = useChangesetStore.getState().getStagedCount(scopeId);
      if (stagedCount > 0) {
        // Streaming finished with staged changes — open PR modal
        onReadyForPR(panelId);
      }
    }
  }, [activeRepo, isStreaming, messages, onReadyForPR, panelId, scopeId]);

  // requestConversationIdRef is synced with conversationId during render (line 264)

  useEffect(() => {
    if (conversationId) {
      useActivityStore.getState().setStreaming(conversationId, isStreaming);
    }
    return () => {
      if (conversationId) {
        useActivityStore.getState().setStreaming(conversationId, false);
      }
    };
  }, [isStreaming, conversationId]);

  // Track previous conversation so we can save its file state on switch
  const prevConversationIdRef = useRef<string | null>(null);

  /** Replace the panel's changeset + preview with saved data from IndexedDB. */
  const restoreFileState = useCallback((convId: string) => {
    // If this scope was already hydrated (from DB or user interaction) this session,
    // the in-memory changeset store already has the correct state — skip the async DB read.
    // This eliminates race conditions when rapidly switching between visited conversations.
    if (hydratedScopesRef.current.has(scopeId)) {
  
      return;
    }

    db.conversationFiles.get(convId).then((saved) => {
      // Each conversation has its own isolated scope in the changeset store,
      // so writing to a non-current scope is safe — it pre-populates the store
      // for when the user returns to that conversation. No staleness guard needed.
      hydratedScopesRef.current.add(scopeId);
      const csStore = useChangesetStore.getState();
      const psStore = usePreviewStore.getState();
      const currentChangeset = csStore.getChangeset(scopeId);
      const currentPreview = psStore.getPreview(scopeId);
      const hasLiveState =
        currentChangeset.activeRepo !== null ||
        Object.keys(currentChangeset.changes).length > 0 ||
        currentPreview.files.length > 0;
      if (saved) {
        const { changeset: cs, preview } = saved;
        if (cs.activeRepo) {
            csStore.switchActiveRepo(scopeId, cs.activeRepo);
          } else {
          csStore.clearActiveRepo(scopeId);
        }
        csStore.setPullRequest(scopeId, cs.pullRequest ?? null);
        csStore.setRepoFileTree(scopeId, cs.repoFileTree);
        csStore.setSelectedRepoFilePath(scopeId, cs.selectedRepoFilePath ?? null);
        const restoredCache = cs.repoFileCache
          ?? saved.repoFileCache
          ?? Object.fromEntries(
            Object.values(cs.changes)
              .filter((change) => typeof change.originalContent === 'string')
              .map((change) => [change.path, change.originalContent as string])
          );
        for (const [path, content] of Object.entries(restoredCache)) {
          csStore.cacheRepoFile(scopeId, path, content);
        }
        for (const change of Object.values(cs.changes)) {
          csStore.addChange(scopeId, change);
        }
        psStore.replacePreview(scopeId, {
          isOpen: preview.isOpen ?? false,
          files: preview.files as PreviewFile[],
          activeFileId: preview.activeFileId,
          projectType: preview.projectType as ProjectType,
          railWidth: typeof (preview as Record<string, unknown>).railWidth === 'number' ? (preview as Record<string, unknown>).railWidth as number : 320,
          activeView:
            preview.activeView === 'changes'
              ? 'changes'
              : preview.activeView === 'repo'
                ? 'repo'
              : 'preview',
        });
      } else if (!hasLiveState) {
        resetPanelFileState();
      }
      // Reset pseudo-repo tracking only for the scope the user is currently viewing.
      if (convIdRef.current === convId) {
        appliedPseudoRepoMessageIdsRef.current = new Set();
      }
    });
  }, [resetPanelFileState, scopeId]);

  const hydrateConversationMessages = useCallback((convId: string) => {
    db.messages.getByConversation(convId).then((msgs) => {
      // Guard against stale results when rapidly switching conversations.
      if (convIdRef.current !== convId) return;
      safeSetMessages(toStoredAIMessages(msgs));
    });
  }, [safeSetMessages]);

  // Load messages (and file state) from IndexedDB when switching conversations
  useEffect(() => {
    // Always keep these refs in sync — they're needed by callbacks (onFinish, onToolCall)
    // even during streaming.
    if (conversationId && pendingConversationIdRef.current === conversationId) {
      pendingConversationIdRef.current = null;
    }
    if (conversationId !== null) {
      convIdRef.current = conversationId;
    }
    // When going to null, we intentionally leave convIdRef pointing at the old conversation
    // until the next conversation is assigned. This prevents losing streaming responses.

    // If the user navigates to a different conversation while one is streaming,
    // abort the stream. The stream's partial result is already being persisted
    // to IndexedDB via onFinish/onToolCall, so nothing is lost.
    const prevConvId = prevConversationIdRef.current;
    if (isStreaming && prevConvId !== null && conversationId !== prevConvId) {
      stop();
      // Return early and let the stop() cascade handle cleanup.
      // When isStreaming becomes false, this effect will re-run and
      // perform the full conversation switch (save files, hydrate messages).
      return;
    }

    // Don't hydrate or reset messages while streaming — it would clobber the live buffer.
    // Also wait until the AI SDK session ID catches up with the visible conversation so
    // persisted messages never hydrate into the previous conversation's session bucket.
    // Note: prevConversationIdRef is NOT updated here so that the deferred re-run
    // still sees the actual previous conversation and performs the full switch.
    if (isStreaming || aiChatSessionId !== chatSessionId) return;

    prevConversationIdRef.current = conversationId;

    // Transition: null → new conversation (just created).
    // The user may have already set up a repo/changeset on the blank thread.
    // Preserve current state and associate it with the new conversation instead of clearing.
    if (prevConvId === null && conversationId !== null) {
      if (skipNextLoadRef.current) {
        // Just created this conversation — preserve current state
        skipNextLoadRef.current = false;
        hydratedScopesRef.current.add(scopeId);

        // Migrate changeset data from the panel scope to the new conversation scope.
        // When startRepoChatInNewThread attaches a repo on scopeId=panelId and then
        // a conversation is created, the scope shifts to conversationId. Without this
        // migration, onToolCall and subsequent reads see an empty changeset.
        const prevScopeId = panelId;
        if (prevScopeId !== scopeId) {
          const csStore = useChangesetStore.getState();
          const psStore = usePreviewStore.getState();
          csStore.replaceChangeset(scopeId, csStore.getChangeset(prevScopeId));
          psStore.replacePreview(scopeId, psStore.getPreview(prevScopeId));
        }

        // When the AI SDK session ID changed (draft→convId), the AI SDK resets
        // its internal message store to []. If that happened, hydrate from DB
        // so the user message and assistant response aren't lost.
        if (messagesRef.current.length === 0) {
          hydrateConversationMessages(conversationId);
        }
        void saveConversationFiles(conversationId);
        return;
      }
      // Navigating to an existing conversation on startup — restore its file state
      hydrateConversationMessages(conversationId);
      restoreFileState(conversationId);
      return;
    }

    // Save file state for the conversation we're leaving.
    // Pass the previous conversation's scope so we read from the correct
    // changeset store entry — scopeId already points at the NEW conversation.
    if (prevConvId) {
      const prevScopeId = getChatScopeId(panelId, prevConvId);
      void saveConversationFiles(prevConvId, prevScopeId);
    }

    if (conversationId) {
      if (skipNextLoadRef.current) {
        skipNextLoadRef.current = false;
        hydratedScopesRef.current.add(scopeId);
        // Same guard as above: if the AI SDK reset messages due to a session ID
        // change, we need to restore them from the database.
        if (messagesRef.current.length === 0) {
          hydrateConversationMessages(conversationId);
        }
        return;
      }
      hydrateConversationMessages(conversationId);

      // Restore file state for this conversation
      restoreFileState(conversationId);
    } else {
      const initialBlankThread = prevConvId === null;
      const preservePanelRepoHandoff = useUIStore.getState().preservePanelRepoHandoffs[panelId] === true;
      if (preservePanelRepoHandoff) {
        useUIStore.getState().clearPanelRepoHandoff(panelId);
      }
      safeSetMessages([] as AIMessage[]);
      if (!preservePanelRepoHandoff && !initialBlankThread) {
        resetPanelFileState();
      }
    }

    // Clear hermes tool activity and server-side detection flag on conversation switch
    setToolActivityMap({});
    setAgentStatus(null);
    setConversationAutoApproveEnabled(false);
    toolActivityRef.current = {};
    serverToolEventsRef.current = {};
    serverToolEventKeysRef.current = {};
    serverSideToolsDetectedRef.current = false;

  }, [aiChatSessionId, chatSessionId, conversationId, safeSetMessages, panelId, resetPanelFileState, restoreFileState, saveConversationFiles, hydrateConversationMessages, isStreaming, scopeId]);

  // Auto-save file state (debounced) whenever the panel's file state changes
  useEffect(() => {
    // Use the prop directly rather than the ref, since the ref may still
    // point to a previous conversation during the null→new transition.
    const convId = conversationId;
    if (!convId) return;
    if (Object.keys(changeset.changes).length === 0 && !changeset.activeRepo && preview.files.length === 0) return;

    const timer = setTimeout(() => {
      void saveConversationFiles(convId);
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [conversationId, changeset, preview, saveConversationFiles]);

  useEffect(() => {
    return () => {
      if (autoContinueTimerRef.current) {
        clearTimeout(autoContinueTimerRef.current);
      }
      const convId = convIdRef.current;
      if (convId) {
        void saveConversationFiles(convId);
      }
    };
  }, [saveConversationFiles]);

  const queueMessage = useCallback((contentOverride?: string) => {
    const content = (contentOverride ?? draftInput).trim();
    if (!content) return false;

    setQueuedMessages((prev) => [...prev, createQueuedMessage(content)]);
    if (contentOverride === undefined) {
      setDraftInput('');
    }
    return true;
  }, [draftInput]);

  const sendMessage = useCallback(async (rawContent: string, options?: SendMessageOptions) => {
    const content = rawContent.trim();
    if (!content) return;
    // Guard against duplicate / reentrant sends (e.g. React StrictMode, fast
    // double-clicks, or effects re-firing while the first send is in-flight).
    if (isSendingRef.current) {
      console.warn('[useChat:sendMessage] Duplicate send blocked');
      return;
    }
    isSendingRef.current = true;
    const clearDraft = options?.clearDraft ?? false;

    const providerInfo = PROVIDERS[effectiveProvider as keyof typeof PROVIDERS];

    // Check if API key is needed but missing
    if (providerInfo?.needsApiKey && !config.apiKey) {
      isSendingRef.current = false;
      setApiKeyModalOpen(true);
      return;
    }

    // Reset auto-continue counter and stop flag on explicit user messages
    unknownFinishRetryRef.current = 0;
    repoStopRetryRef.current = 0;
    userStoppedRef.current = false;

    let convId = conversationId ?? pendingConversationIdRef.current;
    let createdConversationId: string | null = null;

    // Create conversation if needed
    if (!convId) {
      try {
        convId = await createConversation(effectiveProvider, effectiveModel, defaultSystemPrompt);
        createdConversationId = convId;
        pendingConversationIdRef.current = convId;
        convIdRef.current = convId;
        requestConversationIdRef.current = convId;
        await saveConversationFiles(convId, scopeId);
      } catch (e) {
        console.error('Failed to create conversation:', e);
        isSendingRef.current = false;
        return;
      }
    }

    const currentPendingProposal = findPendingProposal(messagesRef.current as Array<{
      id: string;
      role: string;
      content?: string;
      parts?: Array<{ type?: string; text?: string; reasoning?: string; toolInvocation?: { toolName?: string; state?: string; args?: Record<string, unknown>; result?: unknown } }>;
      toolInvocations?: Array<{ toolName?: string; state?: string; args?: Record<string, unknown>; result?: unknown }>;
    }>) ?? pendingProposalRef.current;
    const pendingProposalKey = getPendingProposalKey(currentPendingProposal);
    const approvalFollowUp = isRepoApprovalFollowUpMessage(content) &&
      (pendingProposalKey !== null || approvedProposalContinuationRef.current !== null);
    // Persist user message to IndexedDB
    const effectiveRepoEditIntent = isRepoMode && activeRepo
      ? (typeof options?.repoEditIntentOverride === 'boolean'
          ? options.repoEditIntentOverride
          : approvalFollowUp || isRepoEditIntentMessage(content))
      : false;

    repoEditIntentRef.current = effectiveRepoEditIntent;
    if (approvalFollowUp) {
      approvedProposalContinuationRef.current = {
        conversationId: convId,
        proposalKey: pendingProposalKey ?? approvedProposalContinuationRef.current?.proposalKey ?? null,
      };
      pendingProposalRef.current = currentPendingProposal;
    } else if (!effectiveRepoEditIntent) {
      approvedProposalContinuationRef.current = null;
    }

    const userMsgId = crypto.randomUUID();
    await db.messages.add({
      id: userMsgId,
      conversationId: convId,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    });
    await db.conversations.update(convId, { updatedAt: new Date().toISOString() });

    // Auto-rename conversation from first message
    const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
    if (conv?.title === 'New conversation') {
      const title = content.slice(0, CONVERSATION_TITLE_MAX_LENGTH) + (content.length > CONVERSATION_TITLE_MAX_LENGTH ? '...' : '');
      await renameConversation(convId, title);
    }

    // Clear input and send to AI
    if (clearDraft) {
      setDraftInput('');
    }

    // Sanitize any partial tool invocations from interrupted streams
    const currentMessages = messagesRef.current;
    const sanitized = sanitizeRetryMessages(currentMessages);
    if (sanitized !== currentMessages) {
      safeSetMessages(sanitized, true);
    }

    const repoFileTreeForRequest = await ensureRepoFileTreeLoaded();
    delete toolActivityRef.current.current;
    delete serverToolEventsRef.current.current;
    delete serverToolEventKeysRef.current.current;
    serverSideToolsDetectedRef.current = false;
    setAgentStatus(null);
    activeRequestBodyRef.current = buildRequestBody({
      conversationId: convId,
      repoFileTree: repoFileTreeForRequest,
      continuingApprovedProposal: approvalFollowUp,
      repoEditIntent: effectiveRepoEditIntent,
    });

    try {
      await append(
        { role: 'user', content },
        convId
          ? {
              body: {
                conversation_id: convId,
                ...(isRepoMode && activeRepo ? { repo_edit_intent: repoEditIntentRef.current } : {}),
                ...(repoFileTreeForRequest.length > 0
                  ? { repo_file_tree: repoFileTreeForRequest }
                  : {}),
                ...(approvalFollowUp ? { continuing_approved_proposal: true } : {}),
              },
            }
          : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      const expectedAbort =
        message.includes('abort') ||
        message.includes('cancel') ||
        message.includes('stopped');
      if (!expectedAbort) {
        activeRequestBodyRef.current = null;
        isSendingRef.current = false;
        throw error;
      }
      activeRequestBodyRef.current = null;
    } finally {
      isSendingRef.current = false;
      // STEP 9: Auto-clear plan mode after sending
      useChatStore.getState().setPlanMode(false);
    }

    if (createdConversationId && pendingConversationIdRef.current === createdConversationId) {
      skipNextLoadRef.current = true;
      // Don't clear pendingConversationIdRef before onConversationCreated —
      // it keeps the active AI chat session stable until conversationId is set by the parent.
      // The conversation-switch effect clears it once conversationId matches.
      onConversationCreated?.(createdConversationId);
    }
    return true;
  }, [activeRepo, append, buildRequestBody, config, conversationId, createConversation, defaultSystemPrompt, effectiveModel, effectiveProvider, ensureRepoFileTreeLoaded, isRepoMode, onConversationCreated, renameConversation, saveConversationFiles, scopeId, safeSetMessages, sanitizeRetryMessages]);

  const handleSend = useCallback(() => {
    if (effectiveBusy) {
      queueMessage();
      return;
    }
    void sendMessage(draftInput, { clearDraft: true });
  }, [draftInput, effectiveBusy, queueMessage, sendMessage]);

  const handleQuickSend = useCallback((content: string) => {
    if (effectiveBusy) {
      queueMessage(content);
      return;
    }
    void sendMessage(content);
  }, [effectiveBusy, queueMessage, sendMessage]);

  useEffect(() => {
    if (!pendingPanelPrompt || effectiveBusy) {
      return;
    }

    clearPanelPrompt(panelId);
    if (pendingPanelPrompt.autoSend) {
      void sendMessage(pendingPanelPrompt.content, {
        repoEditIntentOverride: pendingPanelPrompt.repoEditIntentOverride,
      });
      return;
    }

    setDraftInput(pendingPanelPrompt.content);
  }, [clearPanelPrompt, effectiveBusy, panelId, pendingPanelPrompt, sendMessage]);

  const handleRemoveQueuedMessage = useCallback((messageId: string) => {
    setQueuedMessages((prev) => removeQueuedMessage(prev, messageId));
  }, []);

  const handleSteerQueuedMessage = useCallback((messageId: string) => {
    const queued = queuedMessages.find((message) => message.id === messageId);
    if (!queued) return;

    if (isStreaming) {
      setQueuedMessages((prev) => moveQueuedMessageToFront(prev, messageId));
      stop();
      return;
    }

    setQueuedMessages((prev) => removeQueuedMessage(prev, messageId));
    void sendMessage(queued.content);
  }, [isStreaming, queuedMessages, sendMessage, stop]);

  useEffect(() => {
    if (effectiveBusy) return;
    if (queuedMessages.length === 0) return;
    if (autoSendingQueuedRef.current) return;

    const nextMessage = queuedMessages[0];
    autoSendingQueuedRef.current = nextMessage.id;

    void (async () => {
      const sent = await sendMessage(nextMessage.content);
      if (sent) {
        setQueuedMessages((prev) => removeQueuedMessage(prev, nextMessage.id));
      }
      autoSendingQueuedRef.current = null;
    })();
  }, [effectiveBusy, queuedMessages, sendMessage]);

  useEffect(() => {
    setQueuedMessages([]);
    autoSendingQueuedRef.current = null;
    pendingProposalRef.current = null;
    explicitProposalKeyRef.current = null;
    approvedProposalContinuationRef.current = null;
    pausedProposalKeyRef.current = null;
    contentProposalStabilityRef.current = { key: null, cycles: 0 };
  }, [conversationId]);

  const handleRegenerate = useCallback(() => {
    const lastUserMessage = messagesRef.current.findLast((message) => message.role === 'user')?.content ?? '';
    repoEditIntentRef.current = isRepoMode && activeRepo ? isRepoEditIntentMessage(lastUserMessage) : false;
    activeRequestBodyRef.current = buildRequestBody();
    reload();
  }, [activeRepo, buildRequestBody, isRepoMode, reload]);

  // Abort in-flight fetch on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, []);

  return {
    messages,
    input: draftInput,
    setInput: setDraftInput,
    handleSend,
    handleQuickSend,
    queuedMessages,
    handleRemoveQueuedMessage,
    handleSteerQueuedMessage,
    handleStop: stop,
    handleRegenerate,
    isStreaming,
    isAnotherPanelStreamingSameProfile,
    error,
    apiKeyModalOpen,
    setApiKeyModalOpen,
    providerUnavailableOpen,
    setProviderUnavailableOpen,
    activeProvider: effectiveProvider,
    activeModel: effectiveModel,
    toolActivityMap,
    agentStatus,
    conversationAutoApproveEnabled,
    setConversationAutoApprove: setConversationAutoApproveEnabled,
  };
}
