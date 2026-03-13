import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useChat as useAIChat, type Message as AIMessage } from '@ai-sdk/react';
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
import { findPendingProposal, getProposalDigest, type ProposalMessageLike } from '@/lib/proposed-changes';
import { extractPseudoToolInvocations, extractTextFileEdits, getPseudoToolSourceText, type PseudoToolMessageLike } from '@/lib/pseudo-tool-calls';
import { getRepoTurnIntentInstruction, isRepoEditIntentMessage } from '@/lib/repo-intent';
import type { ToolActivityEvent } from '@/components/chat/AgentActivity';
import { countContentLines, getChangeLineDelta } from '@/lib/change-diff';
import { getErrorMessage } from '@/lib/errors';

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

  const samplePaths = repoPaths.slice(0, 8);
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
            result: { error: 'Tool call was interrupted' },
          },
        };
      }
      return part;
    });

    const fixedInvocations = msg.toolInvocations?.map((inv) => {
      if (inv.state === 'partial-call' || inv.state === 'call') {
        msgDirty = true;
        return { ...inv, state: 'result', result: { error: 'Tool call was interrupted' } };
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

async function upsertStoredMessage(message: StoredMessage): Promise<void> {
  try {
    await db.messages.add(message);
  } catch {
    await db.messages.update(message.id, message);
  }
}

function isProposalApprovalMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;

  return [
    /^(go ahead|proceed|apply|accept|approved|looks good|ship it)[.!]?$/,
    /^(yes|yep|yeah|sure|ok|okay)(,?\s+(go ahead|proceed|apply))?[.!]?$/,
    /^(please\s+)?(apply|continue)\b/,
  ].some((pattern) => pattern.test(normalized));
}

const STRUCTURED_REPO_TOOL_NAMES = new Set([
  'propose_changes',
  'read_repo_file',
  'edit_repo_file',
  'create_repo_file',
  'delete_repo_file',
  'batch_edit_repo_files',
]);

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
): string[] {
  const structuredToolNames = collectStructuredToolNames(message);
  const pseudoToolNames = extractPseudoToolInvocations(getPseudoToolSourceText(message as PseudoToolMessageLike))
    .map((invocation) => invocation.toolName);
  const activityNames = toolActivity.map((event) => event.tool.toLowerCase());

  return [...structuredToolNames, ...pseudoToolNames, ...activityNames]
    .map((toolName) => toolName.toLowerCase())
    .filter((toolName) =>
      toolName === 'propose_changes' ||
      toolName === 'read_repo_file' ||
      REPO_EDIT_TOOL_NAMES.has(toolName),
    );
}

function hasRepoContinuationProgress(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
    toolInvocations?: Array<{ toolName?: string }>;
  },
  toolActivity: ToolActivityEvent[] = [],
): boolean {
  return collectRepoWorkflowToolNames(message, toolActivity)
    .some((toolName) => toolName === 'read_repo_file' || REPO_EDIT_TOOL_NAMES.has(toolName));
}

function stalledOnRepoRead(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
    toolInvocations?: Array<{ toolName?: string }>;
  },
  toolActivity: ToolActivityEvent[] = [],
): boolean {
  const orderedRepoWorkflowNames = collectRepoWorkflowToolNames(message, toolActivity);

  if (!orderedRepoWorkflowNames.includes('read_repo_file')) {
    return false;
  }

  // If the final repo workflow step in the assistant turn is still a file read,
  // the model stopped mid-analysis or mid-editing workflow and should continue.
  return orderedRepoWorkflowNames.at(-1) === 'read_repo_file';
}

function hasStructuredRepoToolData(message: {
  parts?: Array<{ type?: string; toolInvocation?: { toolName?: string } }>;
  toolInvocations?: Array<{ toolName?: string }>;
}): boolean {
  const partInvocations = message.parts
    ?.filter((part) => part.type === 'tool-invocation' && part.toolInvocation?.toolName)
    .map((part) => part.toolInvocation?.toolName);
  const toolInvocationNames = message.toolInvocations?.map((invocation) => invocation.toolName);
  return [...(partInvocations || []), ...(toolInvocationNames || [])]
    .some((toolName) => !!toolName && STRUCTURED_REPO_TOOL_NAMES.has(toolName));
}


interface ProviderOverride {
  provider: string;
  model: string;
}

interface AutoContinueRequest {
  conversationId: string;
  content: string;
  continuingApprovedProposal: boolean;
}

function getRepoContinuationProgressDigest(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string; args?: Record<string, unknown> } }>;
    toolInvocations?: Array<{ toolName?: string; args?: Record<string, unknown> }>;
  },
  toolActivity: ToolActivityEvent[] = [],
): string {
  const structuredEntries = [
    ...(message.parts
      ?.filter((part) => part.type === 'tool-invocation' && part.toolInvocation?.toolName)
      .map((part) => ({
        toolName: part.toolInvocation?.toolName?.toLowerCase() ?? '',
        path: typeof part.toolInvocation?.args?.path === 'string' ? part.toolInvocation.args.path : '',
      })) ?? []),
    ...(message.toolInvocations?.map((invocation) => ({
      toolName: invocation.toolName?.toLowerCase() ?? '',
      path: typeof invocation.args?.path === 'string' ? invocation.args.path : '',
    })) ?? []),
  ].filter((entry) =>
    entry.toolName === 'read_repo_file' ||
    REPO_EDIT_TOOL_NAMES.has(entry.toolName),
  );

  const pseudoEntries = extractPseudoToolInvocations(getPseudoToolSourceText(message as PseudoToolMessageLike))
    .map((invocation) => ({
      toolName: invocation.toolName.toLowerCase(),
      path: typeof invocation.args.path === 'string' ? invocation.args.path : '',
    }))
    .filter((entry) =>
      entry.toolName === 'read_repo_file' ||
      REPO_EDIT_TOOL_NAMES.has(entry.toolName),
    );

  const activityEntries = toolActivity
    .map((event) => ({
      toolName: event.tool.toLowerCase(),
      path: event.input,
    }))
    .filter((entry) =>
      entry.toolName === 'read_repo_file' ||
      REPO_EDIT_TOOL_NAMES.has(entry.toolName),
    );

  return [...structuredEntries, ...pseudoEntries, ...activityEntries]
    .map((entry) => `${entry.toolName}:${entry.path}`)
    .join('|');
}

export function useChat(
  conversationId: string | null,
  onConversationCreated?: (id: string) => void,
  providerOverride?: ProviderOverride,
  panelId: string = 'default',
  onReadyForPR?: (panelId: string) => void,
) {
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
  const changeset = useChangesetStore(useShallow((s) => s.getChangeset(panelId)));
  const addChangeForPanel = useChangesetStore((s) => s.addChange);
  const preview = usePreviewStore(useShallow((s) => s.getPreview(panelId)));
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
  const addChange = useCallback((change: Parameters<typeof addChangeForPanel>[1]) => addChangeForPanel(panelId, change), [addChangeForPanel, panelId]);

  // When orchestrator is enabled, use its provider/model instead
  const effectiveProvider = providerOverride?.provider ?? activeProvider;
  const config = providers[effectiveProvider];
  const effectiveModel = providerOverride?.model ?? config.model;
  const reasoningEffort = supportsReasoningEffort(effectiveProvider, effectiveModel)
    ? config.reasoningEffort
    : undefined;

  // Build system prompt with knowledge context and active repo
  let fullSystemPrompt = knowledgeContext
    ? `${defaultSystemPrompt}\n\n--- Knowledge Base ---\n${knowledgeContext}`
    : defaultSystemPrompt;

  if (isRepoMode && activeRepo) {
    let repoContext = `\n\n--- GitHub Repository ---\nYou are working on the GitHub repository ${activeRepo.fullName} (default branch: ${activeRepo.defaultBranch}).

IMPORTANT: First determine whether the current user turn is asking for read-only repository help or for actual code changes.
- If the user is asking what the repo is, how it works, where something lives, for an overview, or for analysis/review, stay read-only: inspect files as needed and answer directly.
- Only enter the proposal-and-edit workflow when the user explicitly asks you to modify the repository.
- Never treat repo selection by itself as permission to edit.

When the user asks you to make changes:
1. For a NEW change request that does not already have an approved plan, FIRST use propose_changes to present a plan of ALL files you intend to modify. Wait for user approval before proceeding.
2. If the latest user message is approving your most recent proposal (for example "go ahead", "approved", or "apply it"), do NOT call propose_changes again. Continue executing the already approved plan.
3. After approval, use read_repo_file to read the files you need to modify.
4. Then use batch_edit_repo_files to apply ALL changes at once (preferred), or edit_repo_file / create_repo_file individually.
5. Do NOT ask the user to specify file paths or share files — explore the repo yourself using the repository context provided with the request.
6. Do NOT ask clarifying questions. Use your judgment, explore the repo to understand the codebase, and propose changes directly. If the request is ambiguous, make reasonable assumptions and explain them in your proposal.
7. When the user asks you to update multiple things, make sure you address ALL of them, not just one.
8. All changes are staged for a pull request (not applied directly).
9. Never print pseudo-tool syntax like propose_changes(...) or batch_edit_repo_files(...) in visible text. Use the actual tool calls instead.
10. IMPORTANT: If you need to edit many large files, split batch_edit_repo_files into multiple calls (max 3-4 files per batch) to avoid output truncation. For very large files, use individual edit_repo_file calls instead.
11. Never conclude that the repository is empty or inaccessible just because a guessed file path failed to read. If a read fails, choose another path from the loaded repo tree and continue exploring.
12. Do not guess generic placeholder paths like \`.\`, \`/\`, \`src/main\`, \`server\`, \`client\`, or \`package.json\` unless that exact path is present in the loaded repo tree.`;

    if (autoApproveRepoChanges) {
      repoContext += `\n13. The user has enabled auto-approval for repo changes. Still call propose_changes first, then continue immediately without waiting for a follow-up approval message.`;
    }

    fullSystemPrompt += repoContext;
  }

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

  const resetPanelFileState = useCallback(() => {
    const csStore = useChangesetStore.getState();
    const psStore = usePreviewStore.getState();
    csStore.clearActiveRepo(panelId);
    psStore.resetPreview(panelId);
  }, [panelId]);

  const saveConversationFiles = useCallback((convId: string) => {
    const cs = useChangesetStore.getState().getChangeset(panelId);
    const ps = usePreviewStore.getState().getPreview(panelId);
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
  }, [panelId]);

  const activeRepoKey = activeRepo ? `${activeRepo.owner}/${activeRepo.name}` : null;
  const previousActiveRepoKeyRef = useRef<string | null>(activeRepoKey);

  useEffect(() => {
    const previousRepoKey = previousActiveRepoKeyRef.current;
    previousActiveRepoKeyRef.current = activeRepoKey;

    if (previousRepoKey === activeRepoKey) {
      return;
    }

    appliedPseudoRepoMessageIdsRef.current = new Set();
  }, [activeRepoKey]);

  const [draftInput, setDraftInput] = useState('');
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [providerUnavailableOpen, setProviderUnavailableOpen] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [toolActivityMap, setToolActivityMap] = useState<Record<string, ToolActivityEvent[]>>({});
  const requestConversationIdRef = useRef<string | null>(conversationId);
  // Keep the ref in sync with the prop (when conversation switches externally)
  requestConversationIdRef.current = conversationId ?? requestConversationIdRef.current;
  const activeRequestBodyRef = useRef<Record<string, unknown> | null>(null);
  const continuingApprovedProposalRunRef = useRef(false);
  const toolActivityRef = useRef<Record<string, ToolActivityEvent[]>>({});
  const activeConversationId = conversationId ?? pendingConversationIdRef.current;
  const chatSessionId = `${activeConversationId ?? 'draft'}:${panelId}`;
  const autoSendingQueuedRef = useRef<string | null>(null);
  const pauseForProposalRef = useRef(false);
  const awaitingProposalApprovalRef = useRef(false);
  const proposalApprovedRef = useRef(false);
  const stoppedForProposalRef = useRef(false);
  const [conversationAutoApproveEnabled, setConversationAutoApproveEnabledState] = useState(false);
  // Per-conversation auto-approve: when user clicks "Allow all" in the approval
  // banner, all subsequent proposals in this conversation are auto-approved without
  // requiring individual approval each turn.
  const conversationAutoApproveRef = useRef(false);
  // Track consecutive 'unknown' finish reasons during active repo work to auto-continue
  // when the model is interrupted (e.g. token limit, dropped stream). Cap retries to
  // prevent infinite loops.
  const unknownFinishRetryRef = useRef(0);
  const MAX_UNKNOWN_FINISH_RETRIES = 3;
  const repoStopRetryRef = useRef(0);
  const MAX_REPO_STOP_RETRIES = 2;
  const approvedRepoContinuationRetryRef = useRef(0);
  const MAX_APPROVED_REPO_CONTINUATIONS = 8;
  const autoContinueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedProposalIdRef = useRef<string | null>(null);
  const pendingProposalCacheRef = useRef<{ digest: string; proposal: ReturnType<typeof findPendingProposal> }>({
    digest: '',
    proposal: null,
  });
  const messagesRef = useRef<AIMessage[]>([]);
  const pendingProposalRef = useRef<ReturnType<typeof findPendingProposal>>(null);
  const appliedPseudoRepoMessageIdsRef = useRef<Set<string>>(new Set());
  const lastApprovedRepoProgressDigestRef = useRef('');

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
    console.log(`[useChat:fetch] Sending request to ${url} provider=${effectiveProvider}`);
    const response = await fetch(url, init);
    console.log(`[useChat:fetch] Response status=${response.status} ok=${response.ok} hasBody=${!!response.body}`);
    if (!response.ok) {
      const text = await response.clone().text().catch(() => '');
      console.error(`[useChat:fetch] Error response body:`, text.slice(0, 500));
    }
    if (effectiveProvider !== 'hermes' || !response.body) return response;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        const text = decoder.decode(value, { stream: true });
        buffer += text;

        // Extract tool_activity from SSE data lines before SDK processes them
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              const delta = parsed?.choices?.[0]?.delta;
              if (delta?.tool_activity) {
                // Use 'current' as the key during streaming — the chunk ID
                // from providers like Hermes won't match the AI SDK message ID
                const msgId = 'current';
                const prev = [...(toolActivityRef.current[msgId] || [])];
                const activity = delta.tool_activity as ToolActivityEvent;

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
                  prev[existingIdx] = {
                    ...prev[existingIdx],
                    ...activity,
                    input: prev[existingIdx].input || activity.input,
                    output: activity.output ?? prev[existingIdx].output,
                  };
                } else if (existingIdx < 0) {
                  prev.push(activity);
                }

                toolActivityRef.current = { ...toolActivityRef.current, [msgId]: prev };
                setToolActivityMap({ ...toolActivityRef.current });
              }
            } catch {
              // Not valid JSON, skip
            }
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
  }, [effectiveProvider]);

  const ensureRepoFileTreeLoaded = useCallback(async (): Promise<string[]> => {
    const currentChangeset = useChangesetStore.getState().getChangeset(panelId);
    if (!currentChangeset.isRepoMode || !currentChangeset.activeRepo) {
      return [];
    }

    if (currentChangeset.repoFileTree.length > 0) {
      return currentChangeset.repoFileTree;
    }

    if (!githubPAT) {
      return [];
    }

    useChangesetStore.getState().setRepoFileTreeStatus(panelId, 'loading');

    const result = await fetchRepoFileTreeResult(
      githubPAT,
      currentChangeset.activeRepo.owner,
      currentChangeset.activeRepo.name,
      currentChangeset.activeRepo.defaultBranch,
    );

    if (result.error) {
      useChangesetStore.getState().setRepoFileTreeStatus(panelId, 'error', result.error);
      return [];
    }

    useChangesetStore.getState().setRepoFileTree(panelId, result.paths);
    return result.paths;
  }, [githubPAT, panelId]);

  const buildRequestBody = useCallback((overrides?: {
    conversationId?: string | null;
    repoFileTree?: string[];
    repoFileCache?: Record<string, string>;
  }) => {
    const conversationIdForRequest = overrides?.conversationId ?? requestConversationIdRef.current;
    const repoFileTreeForRequest = overrides?.repoFileTree ?? repoFileTree;
    const repoFileCacheForRequest = overrides?.repoFileCache ?? changeset.repoFileCache;

    return {
      provider: effectiveProvider,
      model: effectiveModel,
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      api_key: config.apiKey,
      system_prompt: isRepoMode && activeRepo
        ? `${fullSystemPrompt}\n\n${getRepoTurnIntentInstruction(repoEditIntentRef.current)}`
        : fullSystemPrompt,
      ...(isRepoMode && activeRepo ? { activeRepo } : {}),
      ...(isRepoMode && activeRepo ? { repo_edit_intent: repoEditIntentRef.current } : {}),
      ...(effectiveProvider === 'hermes' ? { hermes_toolsets: effectiveHermesToolsets.join(',') } : {}),
      ...(effectiveProvider === 'hermes' && isRepoMode && activeRepo && githubPAT ? { github_pat: githubPAT } : {}),
      ...(isRepoMode && repoFileTreeForRequest.length > 0 ? { repo_file_tree: repoFileTreeForRequest } : {}),
      ...(isRepoMode && Object.keys(repoFileCacheForRequest).length > 0
        ? { repo_file_cache: repoFileCacheForRequest }
        : {}),
      ...(conversationIdForRequest ? { conversation_id: conversationIdForRequest } : {}),
    };
  }, [
    activeRepo,
    changeset.repoFileCache,
    config.apiKey,
    config.maxTokens,
    config.temperature,
    config.topP,
    effectiveHermesToolsets,
    effectiveModel,
    effectiveProvider,
    fullSystemPrompt,
    githubPAT,
    isRepoMode,
    reasoningEffort,
    repoFileTree,
  ]);

  const requestBody = activeRequestBodyRef.current ?? buildRequestBody();

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
    id: chatSessionId,
    streamProtocol: 'data',
    throttle: 32,
    maxSteps: 50,
    onFinish: async (message, options) => {
      const convId = convIdRef.current;
      if (!convId) return;

      // Remap tool activity from 'current' to the actual message ID
      if (message?.id && toolActivityRef.current['current']) {
        const currentActivity = toolActivityRef.current['current'];
        delete toolActivityRef.current['current'];
        toolActivityRef.current[message.id] = currentActivity;
        setToolActivityMap({ ...toolActivityRef.current });
      }

      // Persist assistant message (including parts and tool invocations)
      if (!message) return;
      await persistAssistantSnapshot(message as Record<string, unknown>, convId);

      const finishReason = options?.finishReason;
      const continuingApprovedRepoTurn =
        continuingApprovedProposalRunRef.current &&
        proposalApprovedRef.current;
      const messageToolActivity = message.id ? toolActivityRef.current[message.id] || [] : [];
      const repoProgressDigest = getRepoContinuationProgressDigest(
        message as {
          content?: string;
          parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string; args?: Record<string, unknown> } }>;
          toolInvocations?: Array<{ toolName?: string; args?: Record<string, unknown> }>;
        },
        messageToolActivity,
      );
      if (
        continuingApprovedRepoTurn &&
        repoProgressDigest &&
        repoProgressDigest !== lastApprovedRepoProgressDigestRef.current
      ) {
        repoStopRetryRef.current = 0;
        lastApprovedRepoProgressDigestRef.current = repoProgressDigest;
      }
      if (finishReason !== 'tool-calls') {
        // Don't reset proposal state if we manually stopped the stream for approval.
        // The proposal detection effect sets stoppedForProposalRef before calling stop().
        if (stoppedForProposalRef.current) {
          console.log('[useChat:onFinish] Stream stopped for proposal — preserving approval state');
          stoppedForProposalRef.current = false;
          activeRequestBodyRef.current = null;
        } else if (
          // Auto-continue when the model is interrupted mid-work with an unknown
          // finish reason (common with OpenRouter/Gemini hitting token limits or
          // returning non-standard finish reasons). Only retry if we're in an
          // active repo editing session and haven't exceeded the retry cap.
          (finishReason === 'unknown' || finishReason === 'length') &&
          continuingApprovedRepoTurn &&
          approvedRepoContinuationRetryRef.current < MAX_APPROVED_REPO_CONTINUATIONS &&
          unknownFinishRetryRef.current < MAX_UNKNOWN_FINISH_RETRIES
        ) {
          approvedRepoContinuationRetryRef.current += 1;
          unknownFinishRetryRef.current += 1;
          console.log(
            `[useChat:onFinish] Unknown finish during active repo work — auto-continuing (attempt ${approvedRepoContinuationRetryRef.current}/${MAX_APPROVED_REPO_CONTINUATIONS}, unknown ${unknownFinishRetryRef.current}/${MAX_UNKNOWN_FINISH_RETRIES})`,
          );
          scheduleAutoContinue({
            conversationId: convId,
            content: 'You were interrupted mid-work. Continue where you left off — complete the remaining file changes from the approved plan.',
            continuingApprovedProposal: true,
          });
        } else if (
          finishReason === 'stop' &&
          effectiveProvider === 'hermes' &&
          activeRepo &&
          continuingApprovedRepoTurn &&
          approvedRepoContinuationRetryRef.current < MAX_APPROVED_REPO_CONTINUATIONS &&
          repoStopRetryRef.current < MAX_REPO_STOP_RETRIES &&
          !hasRepoContinuationProgress(
            message as {
              content?: string;
              parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
              toolInvocations?: Array<{ toolName?: string }>;
            },
            messageToolActivity,
          )
        ) {
          approvedRepoContinuationRetryRef.current += 1;
          repoStopRetryRef.current += 1;
          console.log(
            `[useChat:onFinish] Hermes acknowledged the approved plan without using repo tools — auto-continuing (attempt ${approvedRepoContinuationRetryRef.current}/${MAX_APPROVED_REPO_CONTINUATIONS}, stall ${repoStopRetryRef.current}/${MAX_REPO_STOP_RETRIES})`,
          );
          scheduleAutoContinue({
            conversationId: convId,
            content: 'You acknowledged the approved repo plan but did not execute any repo tools. Continue the accepted plan now: read the files you need and stage the approved changes without asking for approval again.',
            continuingApprovedProposal: true,
          });
        } else if (
          finishReason === 'stop' &&
          effectiveProvider === 'hermes' &&
          activeRepo &&
          (!pendingProposalRef.current || continuingApprovedRepoTurn) &&
          (!continuingApprovedRepoTurn || approvedRepoContinuationRetryRef.current < MAX_APPROVED_REPO_CONTINUATIONS) &&
          repoStopRetryRef.current < MAX_REPO_STOP_RETRIES &&
          stalledOnRepoRead(
            message as {
              content?: string;
              parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
              toolInvocations?: Array<{ toolName?: string }>;
            },
            messageToolActivity,
          )
        ) {
          if (continuingApprovedRepoTurn) {
            approvedRepoContinuationRetryRef.current += 1;
          }
          repoStopRetryRef.current += 1;
          console.log(
            `[useChat:onFinish] Hermes stopped after repo read without finishing the repo workflow — auto-continuing (${continuingApprovedRepoTurn ? `approved ${approvedRepoContinuationRetryRef.current}/${MAX_APPROVED_REPO_CONTINUATIONS}, ` : ''}stall ${repoStopRetryRef.current}/${MAX_REPO_STOP_RETRIES})`,
          );
          scheduleAutoContinue({
            conversationId: convId,
            content: continuingApprovedRepoTurn
              ? 'You stopped in the middle of the approved repo work after reading a file. Continue the accepted plan now and do not stop after a single read_repo_file result.'
              : repoEditIntentRef.current
                ? 'You stopped in the middle of repo analysis after reading a file. Continue inspecting the repo as needed, then call propose_changes with the full plan. Do not stop after a single read_repo_file result.'
                : "You stopped in the middle of a read-only repo analysis after reading a file. Continue inspecting the repo as needed and answer the user's question directly. Do not call propose_changes or edit repo files unless the user explicitly asks for modifications.",
            continuingApprovedProposal: continuingApprovedRepoTurn,
          });
        } else {
          console.log('[useChat:onFinish] Natural finish, resetting proposal state. finishReason:', finishReason);
          unknownFinishRetryRef.current = 0;
          repoStopRetryRef.current = 0;
          approvedRepoContinuationRetryRef.current = 0;
          lastApprovedRepoProgressDigestRef.current = '';
          activeRequestBodyRef.current = null;
          // If this was a continuation run that made repo edits, signal ready for PR
          if (continuingApprovedProposalRunRef.current) {
            const stagedCount = useChangesetStore.getState().getStagedCount(panelId);
            if (stagedCount > 0 && onReadyForPR) {
              console.log('[useChat:onFinish] Continuation run finished with', stagedCount, 'staged changes — signaling ready for PR');
              // Delay slightly to let pseudo-tool extraction finish processing
              setTimeout(() => onReadyForPR(panelId), 500);
            }
          }
          awaitingProposalApprovalRef.current = false;
          proposalApprovedRef.current = false;
          continuingApprovedProposalRunRef.current = false;
        }
      } else {
        console.log('[useChat:onFinish] Tool-calls finish, keeping proposal state');
      }
    },
    onToolCall: async ({ toolCall }) => {
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
        const previewState = previewStore.getPreview(panelId);
        // Check if file already exists (update it) or add new
        const existing = previewState.files.find((f) => f.filename === filename);
        if (existing) {
          previewStore.updateFile(panelId, existing.id, content);
        } else {
          previewStore.addFile(panelId, { filename, content, type: fileType });
        }
        return JSON.stringify({ success: true, filename, message: `Created ${filename}` });
      }

      // Handle repo tool calls
      if (toolCall.toolName === 'read_repo_file') {
        const { path } = toolCall.args as { path: string };
        const normalizedPath = normalizeRepoPath(path);
        const currentRepo = useChangesetStore.getState().getChangeset(panelId).activeRepo;
        if (!currentRepo || !githubPAT) {
          return 'Error: No active repository or GitHub token not configured.';
        }

        if (isInvalidRepoReadPath(normalizedPath)) {
          return 'Error: Choose a concrete file path from the loaded repository tree, not `.` , `/`, or a directory path.';
        }

        const currentChangeset = useChangesetStore.getState().getChangeset(panelId);
        const repoTree = currentChangeset.repoFileTree.length > 0
          ? currentChangeset.repoFileTree
          : await ensureRepoFileTreeLoaded();

        const repoTreeStatus = useChangesetStore.getState().getChangeset(panelId).repoFileTreeStatus;
        const repoTreeError = useChangesetStore.getState().getChangeset(panelId).repoFileTreeError;

        if (repoTree.length === 0) {
          return formatRepoTreeUnavailableError(repoTreeStatus, repoTreeError);
        }

        if (!repoTree.includes(normalizedPath)) {
          return formatMissingRepoFileError(normalizedPath, repoTree);
        }

        // Return cached content if available (avoids redundant GitHub API calls)
        const cached = useChangesetStore.getState().getChangeset(panelId).repoFileCache[normalizedPath];
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
          useChangesetStore.getState().cacheRepoFile(panelId, normalizedPath, data.content || '');
          return data.content || '';
        } catch {
          return 'Error: Failed to read file from GitHub.';
        }
      }

      if (toolCall.toolName === 'propose_changes') {
        // The plan is rendered in the chat as the tool result — no side effects needed
        const { summary: overallSummary, plan } = toolCall.args as {
          summary?: string;
          plan: Array<{ path: string; action: string; description: string }>;
        };
        console.log('[useChat:onToolCall] propose_changes called. approvedRef:', proposalApprovedRef.current, 'awaitingRef:', awaitingProposalApprovalRef.current, 'autoApprove:', autoApproveRepoChanges, 'plan items:', plan?.length);
        if (proposalApprovedRef.current && !awaitingProposalApprovalRef.current) {
          pauseForProposalRef.current = false;
          continuingApprovedProposalRunRef.current = true;
          const summary = plan.map((p, i) => `${i + 1}. **${p.action}** \`${p.path}\` — ${p.description}`).join('\n');
          return `The user already approved the current proposal. Do not ask for approval again. Continue directly with read_repo_file and repo edit tools for this accepted scope.\n\n${overallSummary ? `${overallSummary}\n\n` : ''}${summary}`;
        }
        const proposalIsAutoApproved = autoApproveRepoChanges || conversationAutoApproveRef.current;
        pauseForProposalRef.current = !proposalIsAutoApproved;
        awaitingProposalApprovalRef.current = !proposalIsAutoApproved;
        proposalApprovedRef.current = proposalIsAutoApproved;
        continuingApprovedProposalRunRef.current = proposalIsAutoApproved;
        const summary = plan.map((p, i) => `${i + 1}. **${p.action}** \`${p.path}\` — ${p.description}`).join('\n');
        return proposalIsAutoApproved
          ? `## Proposed Changes\n\n${overallSummary ? `${overallSummary}\n\n` : ''}${summary}\n\nAuto-approved. Proceeding with the requested changes now.`
          : `## Proposed Changes\n\n${overallSummary ? `${overallSummary}\n\n` : ''}${summary}\n\nUse the accept button below to apply these changes, or tell me what to adjust.`;
      }

      if (toolCall.toolName === 'edit_repo_file') {
        if (awaitingProposalApprovalRef.current || !proposalApprovedRef.current) {
          return 'Error: Changes are locked until the user explicitly accepts the proposed changes.';
        }
        const { path, content } = toolCall.args as { path: string; content: string; description: string };
        const existing = useChangesetStore.getState().getChangeset(panelId).changes[path];
        const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(panelId).repoFileCache[path] ?? '';
        addChange({ path, action: 'edit', content, originalContent, staged: true });
        const convId = convIdRef.current;
        if (convId) {
          const lineDelta = getChangeLineDelta({ action: 'edit', content, originalContent });
          useActivityStore.getState().addLineStats(convId, lineDelta.added, lineDelta.removed);
        }
        return `Staged edit to ${path}`;
      }

      if (toolCall.toolName === 'create_repo_file') {
        if (awaitingProposalApprovalRef.current || !proposalApprovedRef.current) {
          return 'Error: Changes are locked until the user explicitly accepts the proposed changes.';
        }
        const { path, content } = toolCall.args as { path: string; content: string; description: string };
        addChange({ path, action: 'create', content, staged: true });
        const convId = convIdRef.current;
        if (convId) {
          useActivityStore.getState().addLineStats(convId, countContentLines(content), 0);
        }
        return `Staged new file ${path}`;
      }

      if (toolCall.toolName === 'delete_repo_file') {
        if (awaitingProposalApprovalRef.current || !proposalApprovedRef.current) {
          return 'Error: Changes are locked until the user explicitly accepts the proposed changes.';
        }
        const { path } = toolCall.args as { path: string; reason: string };
        const existing = useChangesetStore.getState().getChangeset(panelId).changes[path];
        const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(panelId).repoFileCache[path] ?? '';
        addChange({ path, action: 'delete', content: '', originalContent, staged: true });
        const convId = convIdRef.current;
        if (convId) {
          useActivityStore.getState().addLineStats(convId, 0, countContentLines(originalContent));
        }
        return `Staged deletion of ${path}`;
      }

      if (toolCall.toolName === 'batch_edit_repo_files') {
        if (awaitingProposalApprovalRef.current || !proposalApprovedRef.current) {
          return 'Error: Changes are locked until the user explicitly accepts the proposed changes.';
        }
        const { changes: fileChanges } = toolCall.args as {
          changes: Array<{ path: string; action: 'create' | 'edit' | 'delete'; content: string; description: string }>;
        };
        const results: string[] = [];
        let totalAdded = 0;
        let totalRemoved = 0;
        for (const change of fileChanges) {
          const existing = useChangesetStore.getState().getChangeset(panelId).changes[change.path];
          const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(panelId).repoFileCache[change.path] ?? '';
          const lineDelta = getChangeLineDelta({
            action: change.action,
            content: change.content || '',
            originalContent,
          });
          totalAdded += lineDelta.added;
          totalRemoved += lineDelta.removed;
          addChange({
            path: change.path,
            action: change.action,
            content: change.content || '',
            originalContent,
            staged: true,
          });
          results.push(`Staged ${change.action} on ${change.path}`);
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
      continuingApprovedProposalRunRef.current = false;
      proposalApprovedRef.current = false;
      awaitingProposalApprovalRef.current = false;
      approvedRepoContinuationRetryRef.current = 0;
      lastApprovedRepoProgressDigestRef.current = '';
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

  const scheduleAutoContinue = useCallback((request: AutoContinueRequest) => {
    const currentMessages = messagesRef.current;
    const sanitized = sanitizePartialToolCalls(currentMessages);
    if (sanitized !== currentMessages) {
      setMessages(sanitized);
    }

    if (autoContinueTimerRef.current) {
      clearTimeout(autoContinueTimerRef.current);
    }

    autoContinueTimerRef.current = setTimeout(() => {
      autoContinueTimerRef.current = null;
      activeRequestBodyRef.current = buildRequestBody({
        conversationId: request.conversationId,
      });
      append(
        {
          role: 'system',
          content: request.content,
        },
        {
          body: {
            conversation_id: request.conversationId,
            ...(isRepoMode && activeRepo ? { repo_edit_intent: repoEditIntentRef.current } : {}),
            ...(request.continuingApprovedProposal
              ? { continuing_approved_proposal: true }
              : {}),
          },
        },
      ).catch((err) => {
        console.error('[useChat:autoContinue] Failed to auto-continue:', err);
        awaitingProposalApprovalRef.current = false;
        proposalApprovedRef.current = false;
        continuingApprovedProposalRunRef.current = false;
        approvedRepoContinuationRetryRef.current = 0;
        lastApprovedRepoProgressDigestRef.current = '';
        activeRequestBodyRef.current = null;
      });
    }, 300);
  }, [activeRepo, append, buildRequestBody, isRepoMode, setMessages]);

  // Track streaming state in global activity store
  const isStreaming = status === 'streaming' || status === 'submitted';
  const proposalDigest = getProposalDigest(messages as ProposalMessageLike[]);
  if (pendingProposalCacheRef.current.digest !== proposalDigest) {
    pendingProposalCacheRef.current = {
      digest: proposalDigest,
      proposal: findPendingProposal(messages as ProposalMessageLike[]),
    };
  }
  const pendingProposal = pendingProposalCacheRef.current.proposal;
  pendingProposalRef.current = pendingProposal;

  useEffect(() => {
    if (!pendingProposal) {
      pausedProposalIdRef.current = null;
      return;
    }
    if (!isStreaming) return;
    // Pause when:
    // 1. Explicit flag from onToolCall for propose_changes
    // 2. Already in approval-awaiting state
    // 3. Auto-approve is off and a content-matched proposal is detected
    //    (Hermes/local models may output proposals as text, not structured tool calls)
    const hasApprovedProposalContinuation =
      proposalApprovedRef.current ||
      continuingApprovedProposalRunRef.current;
    const shouldPause =
      pauseForProposalRef.current ||
      awaitingProposalApprovalRef.current ||
      (
        !hasApprovedProposalContinuation &&
        !autoApproveRepoChanges &&
        !conversationAutoApproveRef.current
      );
    if (!shouldPause) return;
    // Hermes can re-stream the same pending proposal with a new assistant
    // message ID while the approval stop is still settling. Once we're already
    // awaiting approval for a paused proposal, don't stop again.
    if (awaitingProposalApprovalRef.current && pausedProposalIdRef.current !== null) return;
    if (pausedProposalIdRef.current === pendingProposal.messageId) return;

    pausedProposalIdRef.current = pendingProposal.messageId;
    pauseForProposalRef.current = false;
    // Ensure the approval-awaiting state is set even for content-matched proposals
    // (where onToolCall was never invoked for propose_changes).
    awaitingProposalApprovalRef.current = true;
    // Mark that we're stopping for a proposal so onFinish doesn't reset proposal state
    stoppedForProposalRef.current = true;

    console.log('[useChat:proposalEffect] Pausing stream for proposal approval. messageId:', pendingProposal.messageId);

    const convId = convIdRef.current;
    const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');

    void (async () => {
      if (convId && latestAssistant) {
        await persistAssistantSnapshot(latestAssistant as Record<string, unknown>, convId);
      }

      stop();

      if (!conversationId && pendingConversationIdRef.current) {
        const createdConversationId = pendingConversationIdRef.current;
        // Don't clear pendingConversationIdRef here — clearing it before
        // onConversationCreated sets conversationId causes chatSessionId to
        // change to 'draft:...', which makes the AI SDK reset messages to [].
        // The conversation-switch effect (line 757) clears it once conversationId is set.
        skipNextLoadRef.current = true;
        onConversationCreated?.(createdConversationId);
      }
    })();
  }, [autoApproveRepoChanges, conversationId, isStreaming, messages, onConversationCreated, pendingProposal, persistAssistantSnapshot, stop]);

  useEffect(() => {
    if (isStreaming || !activeRepo) return;

    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      if (appliedPseudoRepoMessageIdsRef.current.has(message.id)) continue;
      if (hasStructuredRepoToolData(message as {
        parts?: Array<{ type?: string; toolInvocation?: { toolName?: string } }>;
        toolInvocations?: Array<{ toolName?: string }>;
      })) continue;

      const sourceText = getPseudoToolSourceText(message);
      const pseudoInvocations = extractPseudoToolInvocations(sourceText);
      const repoEditInvocation = pseudoInvocations.find((invocation) =>
        ['batch_edit_repo_files', 'edit_repo_file', 'create_repo_file', 'delete_repo_file'].includes(invocation.toolName),
      );
      const textFileEdits = repoEditInvocation ? [] : extractTextFileEdits(sourceText);

      if (!repoEditInvocation && textFileEdits.length === 0) continue;

      if (repoEditInvocation?.toolName === 'batch_edit_repo_files') {
        const fileChanges = Array.isArray(repoEditInvocation.args.changes)
          ? repoEditInvocation.args.changes as Array<{ path?: string; action?: 'create' | 'edit' | 'delete'; content?: string }>
          : [];

        for (const change of fileChanges) {
          if (
            typeof change?.path !== 'string' ||
            (change.action !== 'create' && change.action !== 'edit' && change.action !== 'delete')
          ) {
            continue;
          }

          const existing = useChangesetStore.getState().getChangeset(panelId).changes[change.path];
          const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(panelId).repoFileCache[change.path] ?? '';
          addChange({
            path: change.path,
            action: change.action,
            content: typeof change.content === 'string' ? change.content : '',
            originalContent,
            staged: true,
          });
        }
      } else if (repoEditInvocation) {
        const path = typeof repoEditInvocation.args.path === 'string' ? repoEditInvocation.args.path : null;
        const action = repoEditInvocation.toolName === 'create_repo_file'
          ? 'create'
          : repoEditInvocation.toolName === 'delete_repo_file'
            ? 'delete'
            : 'edit';
        if (!path) continue;
        const existing = useChangesetStore.getState().getChangeset(panelId).changes[path];
        const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(panelId).repoFileCache[path] ?? '';
        addChange({
          path,
          action,
          content: typeof repoEditInvocation.args.content === 'string' ? repoEditInvocation.args.content : '',
          originalContent,
          staged: true,
        });
      } else {
        for (const edit of textFileEdits) {
          const existing = useChangesetStore.getState().getChangeset(panelId).changes[edit.path];
          const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(panelId).repoFileCache[edit.path] ?? '';
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
  }, [activeRepo, addChange, isStreaming, messages, panelId]);

  // Auto-open PR modal when hermes finishes editing files (pseudo-tool path).
  // The pseudo-tool extraction effect above runs when !isStreaming and adds
  // staged changes. We watch for that transition and signal readyForPR.
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;

    // Only trigger on streaming → not streaming transition
    if (wasStreaming && !isStreaming && activeRepo && effectiveProvider === 'hermes' && onReadyForPR) {
      // Use a timeout to let the pseudo-tool extraction effect run first
      const timer = setTimeout(() => {
        const stagedCount = useChangesetStore.getState().getStagedCount(panelId);
        if (stagedCount > 0) {
          console.log('[useChat:autoPR] Hermes finished streaming with', stagedCount, 'staged changes — opening PR modal');
          onReadyForPR(panelId);
        }
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [activeRepo, effectiveProvider, isStreaming, onReadyForPR, panelId]);

  // requestConversationIdRef is synced with conversationId during render (line 264)

  useEffect(() => {
    const convId = convIdRef.current;
    if (convId) {
      useActivityStore.getState().setStreaming(convId, isStreaming);
    }
    return () => {
      const id = convIdRef.current;
      if (id) {
        useActivityStore.getState().setStreaming(id, false);
      }
    };
  }, [isStreaming, conversationId]);

  // Track previous conversation so we can save its file state on switch
  const prevConversationIdRef = useRef<string | null>(null);

  /** Replace the panel's changeset + preview with saved data from IndexedDB. */
  const restoreFileState = useCallback((convId: string) => {
    db.conversationFiles.get(convId).then((saved) => {
      const csStore = useChangesetStore.getState();
      const psStore = usePreviewStore.getState();
      appliedPseudoRepoMessageIdsRef.current = new Set();
      if (saved) {
        const { changeset: cs, preview } = saved;
        if (cs.activeRepo) {
          csStore.switchActiveRepo(panelId, cs.activeRepo);
        } else {
          csStore.clearActiveRepo(panelId);
        }
        csStore.setRepoFileTree(panelId, cs.repoFileTree);
        csStore.setSelectedRepoFilePath(panelId, cs.selectedRepoFilePath ?? null);
        const restoredCache = cs.repoFileCache
          ?? saved.repoFileCache
          ?? Object.fromEntries(
            Object.values(cs.changes)
              .filter((change) => typeof change.originalContent === 'string')
              .map((change) => [change.path, change.originalContent as string])
          );
        for (const [path, content] of Object.entries(restoredCache)) {
          csStore.cacheRepoFile(panelId, path, content);
        }
        for (const change of Object.values(cs.changes)) {
          csStore.addChange(panelId, change);
        }
        psStore.replacePreview(panelId, {
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
      } else {
        resetPanelFileState();
      }
    });
  }, [panelId, resetPanelFileState]);

  const hydrateConversationMessages = useCallback((convId: string) => {
    db.messages.getByConversation(convId).then((msgs) => {
      setMessages(toStoredAIMessages(msgs));
    });
  }, [setMessages]);

  // Load messages (and file state) from IndexedDB when switching conversations
  useEffect(() => {
    const prevConvId = prevConversationIdRef.current;
    prevConversationIdRef.current = conversationId;

    if (conversationId && pendingConversationIdRef.current === conversationId) {
      pendingConversationIdRef.current = null;
    }

    // Update convIdRef for callbacks (onFinish, onToolCall).
    // When switching from a conversation to null (new thread), keep the old ID briefly
    // so that an in-flight onFinish can still persist the assistant's response.
    if (conversationId !== null) {
      convIdRef.current = conversationId;
    }
    // When going to null, we intentionally leave convIdRef pointing at the old conversation
    // until the next conversation is assigned. This prevents losing streaming responses.

    // Transition: null → new conversation (just created).
    // The user may have already set up a repo/changeset on the blank thread.
    // Preserve current state and associate it with the new conversation instead of clearing.
    if (prevConvId === null && conversationId !== null) {
      if (skipNextLoadRef.current) {
        // Just created this conversation — preserve current state
        skipNextLoadRef.current = false;
        void saveConversationFiles(conversationId);
        return;
      }
      // Navigating to an existing conversation on startup — restore its file state
      hydrateConversationMessages(conversationId);
      restoreFileState(conversationId);
      return;
    }

    // Save file state for the conversation we're leaving
    if (prevConvId) {
      void saveConversationFiles(prevConvId);
    }

    if (conversationId) {
      if (skipNextLoadRef.current) {
        skipNextLoadRef.current = false;
        return;
      }
      hydrateConversationMessages(conversationId);

      // Restore file state for this conversation
      restoreFileState(conversationId);
    } else {
      setMessages([]);
      resetPanelFileState();
    }

    // Clear hermes tool activity on conversation switch
    setToolActivityMap({});
    toolActivityRef.current = {};
    appliedPseudoRepoMessageIdsRef.current = new Set();
    // Reset per-conversation auto-approve when switching conversations
    conversationAutoApproveRef.current = false;
    setConversationAutoApproveEnabledState(false);
  }, [conversationId, setMessages, panelId, resetPanelFileState, restoreFileState, saveConversationFiles, hydrateConversationMessages]);

  // Auto-save file state (debounced) whenever the panel's file state changes
  useEffect(() => {
    // Use the prop directly rather than the ref, since the ref may still
    // point to a previous conversation during the null→new transition.
    const convId = conversationId;
    if (!convId) return;
    if (Object.keys(changeset.changes).length === 0 && !changeset.activeRepo && preview.files.length === 0) return;

    const timer = setTimeout(() => {
      void saveConversationFiles(convId);
    }, 1000);
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

  const sendMessage = useCallback(async (rawContent: string, clearDraft = false) => {
    const content = rawContent.trim();
    if (!content) return;

    const providerInfo = PROVIDERS[effectiveProvider as keyof typeof PROVIDERS];

    // Check if API key is needed but missing
    if (providerInfo?.needsApiKey && !config.apiKey) {
      setApiKeyModalOpen(true);
      return;
    }

    // Reset auto-continue counter on explicit user messages
    unknownFinishRetryRef.current = 0;
    repoStopRetryRef.current = 0;
    approvedRepoContinuationRetryRef.current = 0;
    lastApprovedRepoProgressDigestRef.current = '';

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
      } catch (e) {
        console.error('Failed to create conversation:', e);
        return;
      }
    }

    // Persist user message to IndexedDB
    const isProposalFollowUp =
      awaitingProposalApprovalRef.current || pendingProposalRef.current !== null;
    const continuingApprovedProposal =
      isProposalApprovalMessage(content) &&
      isProposalFollowUp;

    console.log('[useChat:sendMessage] content:', JSON.stringify(content), 'isApproval:', isProposalApprovalMessage(content), 'awaitingRef:', awaitingProposalApprovalRef.current, 'pendingProposal:', !!pendingProposalRef.current, '→ continuingApproved:', continuingApprovedProposal, 'provider:', effectiveProvider, 'model:', effectiveModel);

    if (isProposalFollowUp) {
      pauseForProposalRef.current = false;
      pausedProposalIdRef.current = null;
      awaitingProposalApprovalRef.current = false;
    }

    if (continuingApprovedProposal) {
      proposalApprovedRef.current = true;
      continuingApprovedProposalRunRef.current = true;
      repoEditIntentRef.current = true;
    } else {
      proposalApprovedRef.current = false;
      continuingApprovedProposalRunRef.current = false;
      repoEditIntentRef.current = isRepoMode && activeRepo ? isRepoEditIntentMessage(content) : false;
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
      const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
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
      setMessages(sanitized);
    }

    const repoFileTreeForRequest = await ensureRepoFileTreeLoaded();
    activeRequestBodyRef.current = buildRequestBody({
      conversationId: convId,
      repoFileTree: repoFileTreeForRequest,
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
                ...(continuingApprovedProposal
                  ? { continuing_approved_proposal: true }
                  : {}),
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
        throw error;
      }
      approvedRepoContinuationRetryRef.current = 0;
      lastApprovedRepoProgressDigestRef.current = '';
      activeRequestBodyRef.current = null;
    }

    if (createdConversationId && pendingConversationIdRef.current === createdConversationId) {
      skipNextLoadRef.current = true;
      // Don't clear pendingConversationIdRef before onConversationCreated —
      // it keeps chatSessionId stable until conversationId is set by the parent.
      // The conversation-switch effect clears it once conversationId matches.
      onConversationCreated?.(createdConversationId);
    }
    return true;
  }, [activeRepo, append, buildRequestBody, config, conversationId, createConversation, defaultSystemPrompt, effectiveModel, effectiveProvider, ensureRepoFileTreeLoaded, isRepoMode, onConversationCreated, renameConversation, setMessages]);

  const handleSend = useCallback(() => {
    if (isStreaming) {
      queueMessage();
      return;
    }
    void sendMessage(draftInput, true);
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
      void sendMessage(pendingPanelPrompt.content);
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
  }, [conversationId]);

  const handleRegenerate = useCallback(() => {
    const lastUserMessage = [...messagesRef.current].reverse().find((message) => message.role === 'user')?.content ?? '';
    repoEditIntentRef.current = isRepoMode && activeRepo ? isRepoEditIntentMessage(lastUserMessage) : false;
    activeRequestBodyRef.current = buildRequestBody();
    reload();
  }, [activeRepo, buildRequestBody, isRepoMode, reload]);

  const setConversationAutoApprove = useCallback((value: boolean) => {
    conversationAutoApproveRef.current = value;
    setConversationAutoApproveEnabledState(value);
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
    error,
    apiKeyModalOpen,
    setApiKeyModalOpen,
    providerUnavailableOpen,
    setProviderUnavailableOpen,
    activeProvider: effectiveProvider,
    activeModel: effectiveModel,
    toolActivityMap,
    conversationAutoApproveEnabled,
    setConversationAutoApprove,
  };
}
