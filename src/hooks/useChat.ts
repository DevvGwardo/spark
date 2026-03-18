import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
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
import { db, type Message as StoredMessage } from '@/lib/db';
import { fetchRepoFileTreeResult, getApiBaseUrl } from '@/lib/api';
import { createQueuedMessage, moveQueuedMessageToFront, removeQueuedMessage, type QueuedMessage } from '@/lib/chat-queue';
import { PROVIDERS, supportsReasoningEffort } from '@/lib/providers';
import { useHermesStore } from '@/stores/hermes-store';

import { findPendingProposal, type PendingProposal } from '@/lib/proposed-changes';
import {
  getRepoTurnIntentInstruction,
  isRepoApprovalFollowUpMessage,
  isRepoEditIntentMessage,
  isRepoWriteMessage,
} from '@/lib/repo-intent';
import type { ToolActivityEvent } from '@/components/chat/AgentActivity';
import { countContentLines, getChangeLineDelta } from '@/lib/change-diff';
import { getErrorMessage } from '@/lib/errors';
import { handleServerToolEvent, SERVER_EXECUTED_REPO_TOOLS, SERVER_TOOL_EVENT_TYPES, type ServerToolEvent } from '@/lib/server-tool-events';
import { getChatScopeId } from '@/lib/chat-scope';
import { extractPseudoToolInvocations, extractTextFileEdits, getPseudoToolSourceText } from '@/lib/pseudo-tool-calls';
import {
  normalizeBatchEditRepoFilesArgs,
  normalizeCreateRepoFileArgs,
  normalizeDeleteRepoFileArgs,
  normalizeEditRepoFileArgs,
  normalizeProposeChangesArgs,
} from '@/lib/repo-tool-args';

/** Delay before auto-continue fires after a stalled or interrupted response. */
const AUTO_CONTINUE_DELAY_MS = 300;

/** Debounce interval for auto-saving conversation file state to IndexedDB. */
const AUTO_SAVE_DEBOUNCE_MS = 1000;

/** Max character length for auto-generated conversation titles. */
const CONVERSATION_TITLE_MAX_LENGTH = 50;

/** Max sample paths shown when a repo file lookup fails. */
const REPO_PATH_SAMPLE_LIMIT = 8;

function normalizeRepoPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

function isInvalidRepoReadPath(path: string): boolean {
  return !path || path === '.' || path === '/' || path.endsWith('/');
}

function getRepoPathSuggestions(paths: string[], requestedPath: string, limit = 6): string[] {
  const normalizedRequestedPath = normalizeRepoPath(requestedPath).toLowerCase();
  const requestedBasename = normalizedRequestedPath.split('/').at(-1) || normalizedRequestedPath;

  return paths
    .map((candidatePath) => {
      const normalizedCandidate = candidatePath.toLowerCase();
      const candidateBasename = normalizedCandidate.split('/').at(-1) || normalizedCandidate;
      let score = 0;

      if (normalizedCandidate === normalizedRequestedPath) score += 100;
      if (candidateBasename === requestedBasename) score += 60;
      if (requestedBasename && candidateBasename.includes(requestedBasename)) score += 30;
      if (requestedBasename && normalizedCandidate.includes(requestedBasename)) score += 20;
      if (normalizedRequestedPath && normalizedCandidate.includes(normalizedRequestedPath)) score += 10;

      return { candidatePath, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.candidatePath.localeCompare(right.candidatePath))
    .slice(0, limit)
    .map((entry) => entry.candidatePath);
}

function formatMissingRepoFileError(requestedPath: string, repoPaths: string[]): string {
  const normalizedPath = normalizeRepoPath(requestedPath);
  const suggestions = getRepoPathSuggestions(repoPaths, normalizedPath);

  if (suggestions.length > 0) {
    return `Error: \`${normalizedPath}\` is not present in the selected repository. Choose a real path from the loaded repo tree instead. Possible matches:\n${suggestions.map((path) => `- ${path}`).join('\n')}`;
  }

  const samplePaths = repoPaths.slice(0, REPO_PATH_SAMPLE_LIMIT);
  return `Error: \`${normalizedPath}\` is not present in the selected repository. Choose a real path from the loaded repo tree instead.${samplePaths.length > 0 ? ` Example paths:\n${samplePaths.map((path) => `- ${path}`).join('\n')}` : ''}`;
}

function formatRepoTreeUnavailableError(repoStatus: 'idle' | 'loading' | 'ready' | 'error', repoError?: string | null): string {
  if (repoStatus === 'loading') {
    return 'Error: The selected repository is still indexing. Wait for the repo tree to finish loading before reading files.';
  }

  if (repoStatus === 'error') {
    return `Error: The selected repository tree could not be indexed${repoError ? ` (${repoError})` : ''}. Re-select the repo or wait for indexing to recover before reading files.`;
  }

  return 'Error: The selected repository file tree is not available yet. Load the repo tree before reading files so you can choose a real path.';
}

function getRepoToolExistingPaths(scopeId: string): Set<string> {
  const changeset = useChangesetStore.getState().getChangeset(scopeId);
  return new Set<string>([
    ...changeset.repoFileTree,
    ...Object.keys(changeset.repoFileCache),
    ...Object.keys(changeset.changes),
  ]);
}

function resolveRepoWriteAction(
  requestedAction: 'create' | 'edit' | 'delete',
  path: string,
  existingPaths: Set<string>,
): 'create' | 'edit' | 'delete' {
  if (requestedAction === 'create' && existingPaths.has(path)) {
    return 'edit';
  }
  return requestedAction;
}

/**
 * Sanitize messages so that any tool invocations stuck in 'partial-call' or 'call'
 * state (from an interrupted stream) get a synthetic error result.
 * Without this, the AI SDK throws "ToolInvocation must have a result".
 */
function sanitizePartialToolCalls<T extends { parts?: Array<Record<string, unknown>>; toolInvocations?: Array<Record<string, unknown>> }>(msgs: T[]): T[] {
  let dirty = false;
  const cleaned = msgs.map((msg) => {
    let msgDirty = false;

    const fixedParts = msg.parts?.map((part) => {
      if (
        part.type === 'tool-invocation' &&
        (part as { toolInvocation?: { state?: string } }).toolInvocation &&
        ((part as { toolInvocation: { state: string } }).toolInvocation.state === 'partial-call' ||
         (part as { toolInvocation: { state: string } }).toolInvocation.state === 'call')
      ) {
        msgDirty = true;
        return {
          ...part,
          toolInvocation: {
            ...(part as { toolInvocation: Record<string, unknown> }).toolInvocation,
            state: 'result',
            result: { error: 'Tool call was interrupted mid-execution. Please retry this tool call to complete the operation.' },
          },
        };
      }
      return part;
    });

    const fixedInvocations = msg.toolInvocations?.map((inv) => {
      if (inv.state === 'partial-call' || inv.state === 'call') {
        msgDirty = true;
        return { ...inv, state: 'result', result: { error: 'Tool call was interrupted mid-execution. Please retry this tool call to complete the operation.' } };
      }
      return inv;
    });

    if (msgDirty) {
      dirty = true;
      return { ...msg, parts: fixedParts ?? msg.parts, toolInvocations: fixedInvocations ?? msg.toolInvocations };
    }
    return msg;
  });

  return dirty ? cleaned : msgs;
}

function toStoredAIMessages(msgs: Awaited<ReturnType<typeof db.messages.getByConversation>>): AIMessage[] {
  const restored = msgs.map((m) => ({
    id: m.id,
    role: m.role as AIMessage['role'],
    content: m.content,
    ...(m.parts ? { parts: m.parts } : {}),
    ...(m.toolInvocations ? { toolInvocations: m.toolInvocations } : {}),
  }));

  return sanitizePartialToolCalls(restored);
}

function isServerToolEvent(value: unknown): value is ServerToolEvent {
  return !!value && typeof value === 'object' && 'type' in value && SERVER_TOOL_EVENT_TYPES.has((value as { type: string }).type);
}

function isServerExecutedRepoToolName(toolName: unknown): toolName is string {
  return typeof toolName === 'string' && SERVER_EXECUTED_REPO_TOOLS.has(toolName);
}

function isHermesToolActivityData(
  value: unknown,
): value is { type: 'hermes_tool_activity'; activity: ToolActivityEvent } {
  return !!value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'hermes_tool_activity'
    && !!(value as { activity?: unknown }).activity
    && typeof (value as { activity?: unknown }).activity === 'object';
}

export interface AgentStatusEvent {
  label: string;
  phase?: string;
  iteration?: number;
  elapsed_ms?: number;
  source?: string;
}

function isAgentStatusData(
  value: unknown,
): value is { type: 'agent_status'; status: AgentStatusEvent } {
  return !!value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'agent_status'
    && !!(value as { status?: unknown }).status
    && typeof (value as { status?: unknown }).status === 'object'
    && typeof ((value as { status: { label?: unknown } }).status.label) === 'string';
}

async function upsertStoredMessage(message: StoredMessage): Promise<void> {
  try {
    await db.messages.add(message);
  } catch {
    await db.messages.update(message.id, message);
  }
}

const REPO_EDIT_TOOL_NAMES = new Set([
  'edit_repo_file',
  'create_repo_file',
  'delete_repo_file',
  'batch_edit_repo_files',
]);

const REPO_MODE_DISABLED_HERMES_TOOLSETS = new Set([
  'terminal',
  'files',
  'code_execution',
]);

function collectStructuredToolNames(message: {
  parts?: Array<{ type?: string; toolInvocation?: { toolName?: string } }>;
  toolInvocations?: Array<{ toolName?: string }>;
}): string[] {
  const partInvocations = message.parts
    ?.filter((part) => part.type === 'tool-invocation' && part.toolInvocation?.toolName)
    .map((part) => part.toolInvocation?.toolName ?? '')
    ?? [];
  const toolInvocationNames = message.toolInvocations?.map((invocation) => invocation.toolName ?? '') ?? [];
  return [...partInvocations, ...toolInvocationNames].filter(Boolean);
}

function collectRepoWorkflowToolNames(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
    toolInvocations?: Array<{ toolName?: string }>;
  },
  toolActivity: ToolActivityEvent[] = [],
  serverToolEvents: ServerToolEvent[] = [],
): string[] {
  const structuredToolNames = collectStructuredToolNames(message);
  const activityNames = toolActivity.map((event) => event.tool.toLowerCase());
  const serverEventNames = serverToolEvents.flatMap((event) => {
    switch (event.type) {
      case 'repo_file_read':
        return ['read_repo_file'];
      case 'repo_file_edit':
        return ['edit_repo_file'];
      case 'repo_file_create':
        return ['create_repo_file'];
      case 'repo_file_delete':
        return ['delete_repo_file'];
      case 'repo_batch_edit':
        return ['batch_edit_repo_files'];
      case 'repo_proposal':
        return ['propose_changes'];
      default:
        return [];
    }
  });

  return [...structuredToolNames, ...activityNames, ...serverEventNames]
    .map((toolName) => toolName.toLowerCase())
    .filter((toolName) =>
      toolName === 'read_repo_file' ||
      REPO_EDIT_TOOL_NAMES.has(toolName),
    );
}

function stalledOnRepoRead(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
    toolInvocations?: Array<{ toolName?: string }>;
  },
  toolActivity: ToolActivityEvent[] = [],
  serverToolEvents: ServerToolEvent[] = [],
): boolean {
  const orderedRepoWorkflowNames = collectRepoWorkflowToolNames(message, toolActivity, serverToolEvents);

  if (orderedRepoWorkflowNames.length === 0) {
    return false;
  }

  const lastTool = orderedRepoWorkflowNames.at(-1);

  // Stalled if the final repo workflow step is a file read (stopped mid-analysis)
  if (lastTool === 'read_repo_file') {
    return true;
  }

  return false;
}

/**
 * Detect when the agent describes what edit tools it will use in text
 * but stops without actually calling them. This happens when the LLM
 * generates text like "I'll use batch_edit_repo_files" instead of
 * actually invoking the tool.
 */
function describedEditButDidNotExecute(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
    toolInvocations?: Array<{ toolName?: string }>;
  },
  toolActivity: ToolActivityEvent[] = [],
  serverToolEvents: ServerToolEvent[] = [],
  editIntent: boolean,
): boolean {
  if (!editIntent) return false;

  const content = getPseudoToolSourceText(message);
  const pseudoInvocations = extractPseudoToolInvocations(content);
  const recoverablePseudoEdit = pseudoInvocations.some((invocation) => REPO_EDIT_TOOL_NAMES.has(invocation.toolName));
  const recoverableTextEdit = extractTextFileEdits(content).length > 0;

  if (recoverablePseudoEdit || recoverableTextEdit) {
    return false;
  }

  // Check if the response text mentions repo edit tools
  const mentionsEditTools = /\b(?:batch_edit_repo_files|edit_repo_file|create_repo_file|delete_repo_file)\b/.test(content);
  if (!mentionsEditTools) return false;

  // Check if any edit tool was actually called (via structured tool invocations or tool activity)
  const repoWorkflowNames = collectRepoWorkflowToolNames(message, toolActivity, serverToolEvents);
  const calledEditTool = repoWorkflowNames.some((name) => REPO_EDIT_TOOL_NAMES.has(name));

  // Agent described an edit tool but never actually called one
  return !calledEditTool;
}

interface ProviderOverride {
  provider: string;
  model: string;
}

interface AutoContinueRequest {
  conversationId: string;
  content: string;
  continuingApprovedProposal?: boolean;
  forceRepoEditIntent?: boolean;
}

interface SendMessageOptions {
  clearDraft?: boolean;
  repoEditIntentOverride?: boolean;
}

function summarizeContentForLog(content: string, limit = 220): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

function getPendingProposalKey(proposal: PendingProposal | null): string | null {
  if (!proposal) return null;
  return JSON.stringify({
    summary: proposal.summary ?? null,
    excerpt: proposal.excerpt ?? null,
    plan: proposal.plan,
  });
}

function getServerToolEventKey(event: ServerToolEvent): string {
  return JSON.stringify(event);
}

function hasRecoverablePseudoRepoWrites(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string }>;
  },
  allowPseudoRepoWrites: boolean,
): boolean {
  if (!allowPseudoRepoWrites) {
    return false;
  }

  const sourceText = getPseudoToolSourceText(message);
  if (
    extractPseudoToolInvocations(sourceText).some((invocation) => REPO_EDIT_TOOL_NAMES.has(invocation.toolName))
  ) {
    return true;
  }

  return extractTextFileEdits(sourceText).length > 0;
}

function allowPseudoRepoWritesForAssistantMessage(
  messages: Array<{ role: string; content: string }>,
  assistantIndex: number,
): boolean {
  if (assistantIndex <= 0) {
    return false;
  }

  const previousUserMessage = messages.slice(0, assistantIndex).findLast((message) =>
    message.role === 'user' && typeof message.content === 'string' && message.content.trim().length > 0,
  );

  return previousUserMessage ? isRepoWriteMessage(previousUserMessage.content) : false;
}

export function useChat(
  conversationId: string | null,
  onConversationCreated?: (id: string) => void,
  providerOverride?: ProviderOverride,
  panelId: string = 'default',
  onReadyForPR?: (panelId: string) => void,
  stateScopeId?: string,
) {
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
  const hermesToolsets = useMemo(
    () =>
      Object.entries(hermesToolsetConfig)
        .filter(([, enabled]) => enabled)
        .map(([toolset]) => toolset),
    [hermesToolsetConfig],
  );
  const effectiveHermesToolsets = useMemo(
    () => (
      isRepoMode
        ? hermesToolsets.filter((toolset) => !REPO_MODE_DISABLED_HERMES_TOOLSETS.has(toolset))
        : hermesToolsets
    ),
    [hermesToolsets, isRepoMode],
  );
  const addChange = useCallback((change: Parameters<typeof addChangeForPanel>[1]) => addChangeForPanel(scopeId, change), [addChangeForPanel, scopeId]);

  // When orchestrator is enabled, use its provider/model instead
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
10. Do not guess generic placeholder paths like \`.\`, \`/\`, \`src/main\`, \`server\`, \`client\`, or \`package.json\` unless that exact path is present in the loaded repo tree.`;

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
  const requestConversationIdRef = useRef<string | null>(conversationId);
  // Keep the ref in sync with the prop (when conversation switches externally)
  requestConversationIdRef.current = conversationId ?? requestConversationIdRef.current;
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
  const stableChatSessionIdRef = useRef(chatSessionId);
  const isStreamingRef = useRef(false);
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
  const messagesRef = useRef<AIMessage[]>([]);

  const persistAssistantSnapshot = useCallback(async (message: Record<string, unknown>, convId: string) => {
    const messageId = typeof message.id === 'string' && message.id ? message.id : crypto.randomUUID();
    await upsertStoredMessage({
      id: messageId,
      conversationId: convId,
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : '',
      timestamp: new Date().toISOString(),
      parts: message.parts as unknown[] | undefined,
      toolInvocations: message.toolInvocations as unknown[] | undefined,
    });
    await db.conversations.update(convId, { updatedAt: new Date().toISOString() });
    await loadConversations();
  }, [loadConversations]);

  const hermesStreamFetch = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
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
    if (effectiveProvider !== 'hermes' || !response.body) return response;

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
        const { done, value } = await reader.read();
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
  }, [effectiveProvider, scopeId]);

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
        !!(currentIsRepoMode && currentActiveRepo && currentGithubPAT),
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
      ...(effectiveProvider === 'hermes' ? { hermes_toolsets: effectiveHermesToolsets.join(',') } : {}),
      ...(currentIsRepoMode && currentActiveRepo && currentGithubPAT ? { github_pat: currentGithubPAT } : {}),
      ...(currentIsRepoMode && repoFileTreeForRequest.length > 0 ? { repo_file_tree: repoFileTreeForRequest } : {}),
      ...(currentIsRepoMode && Object.keys(repoFileCacheForRequest).length > 0
        ? { repo_file_cache: repoFileCacheForRequest }
        : {}),
      ...(conversationIdForRequest ? { conversation_id: conversationIdForRequest } : {}),
      ...(continuingApprovedProposal ? { continuing_approved_proposal: true } : {}),
    };
  }, [
    buildRepoSystemPrompt,
    config.apiKey,
    config.maxTokens,
    config.temperature,
    config.topP,
    effectiveHermesToolsets,
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
    stop,
    reload,
    setMessages,
    error,
  } = useAIChat({
    api: `${apiBaseUrl}/functions/v1/chat`,
    fetch: hermesStreamFetch,
    body: requestBody,
    experimental_prepareRequestBody: ({ id, messages: requestMessages, requestData, requestBody: perRequestBody }) => ({
      id,
      messages: requestMessages,
      data: requestData,
      ...(activeRequestBodyRef.current ?? buildRequestBody()),
      ...(perRequestBody ?? {}),
    }),
    id: stableChatSessionIdRef.current,
    streamProtocol: 'data',
    throttle: 32,
    maxSteps: 100,
    onFinish: async (message, options) => {
      const convId = convIdRef.current;
      if (!convId) return;
      setAgentStatus(null);

      // Remap tool activity from 'current' to the actual message ID
      if (message?.id && toolActivityRef.current['current']) {
        const currentActivity = toolActivityRef.current['current'];
        delete toolActivityRef.current['current'];
        toolActivityRef.current[message.id] = currentActivity;
        setToolActivityMap({ ...toolActivityRef.current });
      }
      if (message?.id && serverToolEventsRef.current['current']) {
        const currentEvents = serverToolEventsRef.current['current'];
        delete serverToolEventsRef.current['current'];
        serverToolEventsRef.current[message.id] = currentEvents;
      }
      if (message?.id && serverToolEventKeysRef.current.current) {
        const currentEventKeys = serverToolEventKeysRef.current.current;
        delete serverToolEventKeysRef.current.current;
        serverToolEventKeysRef.current[message.id] = currentEventKeys;
      }

      // Persist assistant message (including parts and tool invocations)
      if (!message) return;
      await persistAssistantSnapshot(message as Record<string, unknown>, convId);

      const finishReason = options?.finishReason;
      const messageToolActivity = message.id ? toolActivityRef.current[message.id] || [] : [];
      const messageServerToolEvents = message.id ? serverToolEventsRef.current[message.id] || [] : [];
      const repoWorkflowNames = collectRepoWorkflowToolNames(
        message as {
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
        typeof message.content === 'string' ? message.content : '',
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
      if (finishReason !== 'tool-calls') {
        if (
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
              message as {
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
            message as {
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
        const convId = convIdRef.current;
        if (convId) {
          const lineDelta = getChangeLineDelta({ action: 'edit', content, originalContent });
          useActivityStore.getState().addLineStats(convId, lineDelta.added, lineDelta.removed);
        }
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
        const convId = convIdRef.current;
        if (convId) {
          const lineDelta = getChangeLineDelta({ action, content, originalContent });
          useActivityStore.getState().addLineStats(convId, lineDelta.added, lineDelta.removed);
        }
        return action === 'edit' ? `Staged edit to ${path}` : `Staged new file ${path}`;
      }

      if (toolCall.toolName === 'delete_repo_file') {
        const normalizedArgs = normalizeDeleteRepoFileArgs(toolCall.args) as { path?: unknown };
        const path = typeof normalizedArgs.path === 'string' ? normalizedArgs.path : '';
        if (!path) {
          return 'Error: delete_repo_file is missing a valid path.';
        }
        const existing = useChangesetStore.getState().getChangeset(scopeId).changes[path];
        const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[path] ?? '';
        addChange({ path, action: 'delete', content: '', originalContent, staged: true });
        const convId = convIdRef.current;
        if (convId) {
          useActivityStore.getState().addLineStats(convId, 0, countContentLines(originalContent));
        }
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
        let totalAdded = 0;
        let totalRemoved = 0;
        for (const change of fileChanges) {
          if (!change?.path || (change.action !== 'create' && change.action !== 'edit' && change.action !== 'delete')) {
            continue;
          }
          const action = resolveRepoWriteAction(change.action, change.path, knownPaths);
          if (action === 'edit' && !knownPaths.has(change.path) && !approvedPlanEditPaths.has(change.path)) {
            return `Error: batch_edit_repo_files cannot edit missing file \`${change.path}\`. Use create only for genuinely new files and edit only for paths already in the repo.`;
          }
          const existing = useChangesetStore.getState().getChangeset(scopeId).changes[change.path];
          const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[change.path] ?? '';
          const lineDelta = getChangeLineDelta({
            action,
            content: change.content || '',
            originalContent,
          });
          totalAdded += lineDelta.added;
          totalRemoved += lineDelta.removed;
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
        const convId = convIdRef.current;
        if (convId && (totalAdded > 0 || totalRemoved > 0)) {
          useActivityStore.getState().addLineStats(convId, totalAdded, totalRemoved);
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

  // Keep messagesRef in sync for use in callbacks without adding messages to deps
  messagesRef.current = messages;

  // Wrapper that prevents overwriting the AI SDK streaming buffer unless forced
  const safeSetMessages = useCallback((msgs: AIMessage[], force = false) => {
    if (!force && isStreamingRef.current) return;
    setMessages(msgs);
  }, [setMessages]);

  const scheduleAutoContinue = useCallback((request: AutoContinueRequest) => {
    const currentMessages = messagesRef.current;
    const sanitized = sanitizePartialToolCalls(currentMessages);
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
  }, [activeRepo, append, buildRequestBody, isRepoMode, safeSetMessages]);

  // Track streaming state in global activity store
  const isStreaming = status === 'streaming' || status === 'submitted';
  isStreamingRef.current = isStreaming;
  // Only update stable session ID when not streaming to prevent AI SDK message resets
  if (!isStreaming) {
    stableChatSessionIdRef.current = chatSessionId;
  }
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

    if (!isStreaming || !pendingProposal || autoApproveRepoChanges || approvedProposalContinuationRef.current) {
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
      void persistAssistantSnapshot(proposalMessage as Record<string, unknown>, persistedConversationId);
    }

    if (!conversationId && pendingConversationIdRef.current) {
      skipNextLoadRef.current = true;
      onConversationCreated?.(pendingConversationIdRef.current);
    }
  }, [
    autoApproveRepoChanges,
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

    // Don't hydrate or reset messages while streaming — it would clobber the live buffer.
    // The effect will re-run once streaming ends (isStreaming is in deps).
    // Note: prevConversationIdRef is NOT updated here so that the deferred re-run
    // still sees the actual previous conversation and performs the full switch.
    if (isStreaming) return;

    const prevConvId = prevConversationIdRef.current;
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

        // When stableChatSessionIdRef changed (draft→convId), the AI SDK resets
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
    toolActivityRef.current = {};
    serverToolEventsRef.current = {};
    serverToolEventKeysRef.current = {};
    serverSideToolsDetectedRef.current = false;

  }, [conversationId, safeSetMessages, panelId, resetPanelFileState, restoreFileState, saveConversationFiles, hydrateConversationMessages, isStreaming, scopeId]);

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

    // Reset auto-continue counter on explicit user messages
    unknownFinishRetryRef.current = 0;
    repoStopRetryRef.current = 0;

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
    const sanitized = sanitizePartialToolCalls(currentMessages);
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
    }

    if (createdConversationId && pendingConversationIdRef.current === createdConversationId) {
      skipNextLoadRef.current = true;
      // Don't clear pendingConversationIdRef before onConversationCreated —
      // it keeps chatSessionId stable until conversationId is set by the parent.
      // The conversation-switch effect clears it once conversationId matches.
      onConversationCreated?.(createdConversationId);
    }
    return true;
  }, [activeRepo, append, buildRequestBody, config, conversationId, createConversation, defaultSystemPrompt, effectiveModel, effectiveProvider, ensureRepoFileTreeLoaded, isRepoMode, onConversationCreated, renameConversation, saveConversationFiles, scopeId, safeSetMessages]);

  const handleSend = useCallback(() => {
    if (isStreaming) {
      queueMessage();
      return;
    }
    void sendMessage(draftInput, { clearDraft: true });
  }, [draftInput, isStreaming, queueMessage, sendMessage]);

  const handleQuickSend = useCallback((content: string) => {
    if (isStreaming) {
      queueMessage(content);
      return;
    }
    void sendMessage(content);
  }, [isStreaming, queueMessage, sendMessage]);

  useEffect(() => {
    if (!pendingPanelPrompt || isStreaming) {
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
  }, [clearPanelPrompt, isStreaming, panelId, pendingPanelPrompt, sendMessage]);

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
    if (isStreaming) return;
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
  }, [isStreaming, queuedMessages, sendMessage]);

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
    error,
    apiKeyModalOpen,
    setApiKeyModalOpen,
    providerUnavailableOpen,
    setProviderUnavailableOpen,
    activeProvider: effectiveProvider,
    activeModel: effectiveModel,
    toolActivityMap,
    agentStatus,
  };
}
