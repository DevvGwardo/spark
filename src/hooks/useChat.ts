import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useChat as useAIChat, type Message as AIMessage } from '@ai-sdk/react';
import { useShallow } from 'zustand/shallow';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore, type FileType, type PreviewFile, type ProjectType } from '@/stores/preview-store';
import { useActivityStore } from '@/stores/activity-store';
import { db, type Message as StoredMessage } from '@/lib/db';
import { getApiBaseUrl } from '@/lib/api';
import { createQueuedMessage, moveQueuedMessageToFront, removeQueuedMessage, type QueuedMessage } from '@/lib/chat-queue';
import { PROVIDERS, supportsReasoningEffort } from '@/lib/providers';
import { useHermesStore } from '@/stores/hermes-store';
import { findPendingProposal, getProposalDigest, type ProposalMessageLike } from '@/lib/proposed-changes';
import { extractPseudoToolInvocations } from '@/lib/pseudo-tool-calls';
import type { ToolActivityEvent } from '@/components/chat/AgentActivity';

function countLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').length;
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
  const { activeRepo, isRepoMode, repoFileTree } = changeset;
  const hermesToolsetConfig = useHermesStore((s) => s.toolsets);
  const hermesToolsets = useMemo(
    () =>
      Object.entries(hermesToolsetConfig)
        .filter(([, enabled]) => enabled)
        .map(([toolset]) => toolset),
    [hermesToolsetConfig],
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

IMPORTANT: You have tools to work with this repo. When the user asks you to make changes:
1. For a NEW change request that does not already have an approved plan, FIRST use propose_changes to present a plan of ALL files you intend to modify. Wait for user approval before proceeding.
2. If the latest user message is approving your most recent proposal (for example "go ahead", "approved", or "apply it"), do NOT call propose_changes again. Continue executing the already approved plan.
3. After approval, use read_repo_file to read the files you need to modify.
4. Then use batch_edit_repo_files to apply ALL changes at once (preferred), or edit_repo_file / create_repo_file individually.
5. Do NOT ask the user to specify file paths — explore the repo yourself using the file tree below.
6. Do NOT ask clarifying questions. Use your judgment, explore the repo to understand the codebase, and propose changes directly. If the request is ambiguous, make reasonable assumptions and explain them in your proposal.
7. When the user asks you to update multiple things, make sure you address ALL of them, not just one.
8. All changes are staged for a pull request (not applied directly).
9. Never print pseudo-tool syntax like propose_changes(...) or batch_edit_repo_files(...) in visible text. Use the actual tool calls instead.
10. IMPORTANT: If you need to edit many large files, split batch_edit_repo_files into multiple calls (max 3-4 files per batch) to avoid output truncation. For very large files, use individual edit_repo_file calls instead.`;

    if (autoApproveRepoChanges) {
      repoContext += `\n11. The user has enabled auto-approval for repo changes. Still call propose_changes first, then continue immediately without waiting for a follow-up approval message.`;
    }

    if (repoFileTree.length > 0) {
      repoContext += `\n\nRepository file tree:\n${repoFileTree.join('\n')}`;
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

  const resetPanelFileState = useCallback(() => {
    const csStore = useChangesetStore.getState();
    const psStore = usePreviewStore.getState();
    csStore.clearActiveRepo(panelId);
    csStore.clearChanges(panelId);
    csStore.setRepoFileTree(panelId, []);
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
      },
      preview: {
        files: ps.files,
        activeFileId: ps.activeFileId,
        projectType: ps.projectType,
        isOpen: ps.isOpen,
        activeView: ps.activeView,
      },
    });
  }, [panelId]);

  const [draftInput, setDraftInput] = useState('');
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [providerUnavailableOpen, setProviderUnavailableOpen] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [toolActivityMap, setToolActivityMap] = useState<Record<string, ToolActivityEvent[]>>({});
  const requestConversationIdRef = useRef<string | null>(conversationId);
  // Keep the ref in sync with the prop (when conversation switches externally)
  requestConversationIdRef.current = conversationId ?? requestConversationIdRef.current;
  const continuingApprovedProposalRunRef = useRef(false);
  const toolActivityRef = useRef<Record<string, ToolActivityEvent[]>>({});
  const activeConversationId = conversationId ?? pendingConversationIdRef.current;
  const chatSessionId = `${activeConversationId ?? 'draft'}:${panelId}`;
  const autoSendingQueuedRef = useRef<string | null>(null);
  const pauseForProposalRef = useRef(false);
  const awaitingProposalApprovalRef = useRef(false);
  const proposalApprovedRef = useRef(false);
  const stoppedForProposalRef = useRef(false);
  // Per-conversation auto-approve: when user clicks "Allow all" in the approval
  // banner, all subsequent proposals in this conversation are auto-approved without
  // requiring individual approval each turn.
  const conversationAutoApproveRef = useRef(false);
  // Track consecutive 'unknown' finish reasons during active repo work to auto-continue
  // when the model is interrupted (e.g. token limit, dropped stream). Cap retries to
  // prevent infinite loops.
  const unknownFinishRetryRef = useRef(0);
  const MAX_UNKNOWN_FINISH_RETRIES = 3;
  // Signal for the auto-continue effect: set to a convId when onFinish detects an
  // interrupted repo editing session that should be resumed.
  const [autoContinueConvId, setAutoContinueConvId] = useState<string | null>(null);
  const pausedProposalIdRef = useRef<string | null>(null);
  const pendingProposalCacheRef = useRef<{ digest: string; proposal: ReturnType<typeof findPendingProposal> }>({
    digest: '',
    proposal: null,
  });
  const repoFileCacheRef = useRef<Record<string, string>>({});
  const messagesRef = useRef<AIMessage[]>([]);
  const pendingProposalRef = useRef<ReturnType<typeof findPendingProposal>>(null);
  const appliedPseudoRepoMessageIdsRef = useRef<Set<string>>(new Set());

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
                const msgId = parsed.id || 'current';
                const prev = [...(toolActivityRef.current[msgId] || [])];
                const activity = delta.tool_activity as ToolActivityEvent;

                const existingIdx = prev.findIndex(
                  (e) => e.tool === activity.tool && e.input === activity.input && e.status === 'running'
                );
                if (existingIdx >= 0 && activity.status === 'completed') {
                  prev[existingIdx] = activity;
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
    body: {
      provider: effectiveProvider,
      model: effectiveModel,
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      api_key: config.apiKey,
      system_prompt: fullSystemPrompt,
      ...(isRepoMode && activeRepo ? { activeRepo } : {}),
      ...(effectiveProvider === 'hermes' ? { hermes_toolsets: hermesToolsets.join(',') } : {}),
      ...(effectiveProvider === 'hermes' && isRepoMode && activeRepo && githubPAT ? { github_pat: githubPAT } : {}),
      ...(requestConversationIdRef.current ? { conversation_id: requestConversationIdRef.current } : {}),
      ...(continuingApprovedProposalRunRef.current ? { continuing_approved_proposal: true } : {}),
    },
    id: chatSessionId,
    streamProtocol: 'data',
    throttle: 32,
    maxSteps: 50,
    onFinish: async (message, options) => {
      const convId = convIdRef.current;
      if (!convId) return;

      // Persist assistant message (including parts and tool invocations)
      if (!message) return;
      await persistAssistantSnapshot(message as Record<string, unknown>, convId);

      const finishReason = options?.finishReason;
      if (finishReason !== 'tool-calls') {
        // Don't reset proposal state if we manually stopped the stream for approval.
        // The proposal detection effect sets stoppedForProposalRef before calling stop().
        if (stoppedForProposalRef.current) {
          console.log('[useChat:onFinish] Stream stopped for proposal — preserving approval state');
          stoppedForProposalRef.current = false;
        } else if (
          // Auto-continue when the model is interrupted mid-work with an unknown
          // finish reason (common with OpenRouter/Gemini hitting token limits or
          // returning non-standard finish reasons). Only retry if we're in an
          // active repo editing session and haven't exceeded the retry cap.
          (finishReason === 'unknown' || finishReason === 'length') &&
          continuingApprovedProposalRunRef.current &&
          proposalApprovedRef.current &&
          unknownFinishRetryRef.current < MAX_UNKNOWN_FINISH_RETRIES
        ) {
          unknownFinishRetryRef.current += 1;
          console.log(
            `[useChat:onFinish] Unknown finish during active repo work — auto-continuing (attempt ${unknownFinishRetryRef.current}/${MAX_UNKNOWN_FINISH_RETRIES})`,
          );
          // Signal the auto-continue effect to send a continuation message.
          // We can't call append() here because it comes from the same useAIChat
          // call that this onFinish belongs to.
          setAutoContinueConvId(convId);
        } else {
          console.log('[useChat:onFinish] Natural finish, resetting proposal state. finishReason:', finishReason);
          unknownFinishRetryRef.current = 0;
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
        const currentRepo = useChangesetStore.getState().getChangeset(panelId).activeRepo;
        if (!currentRepo || !githubPAT) {
          return 'Error: No active repository or GitHub token not configured.';
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
                path,
              }),
            }
          );
          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            return `Error reading file: server returned ${response.status}${errText ? ` — ${errText.slice(0, 200)}` : ''}`;
          }
          const data = await response.json();
          if (data.error) return `Error reading file: ${data.error}`;
          repoFileCacheRef.current[path] = data.content || '';
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
        const originalContent = existing?.originalContent ?? repoFileCacheRef.current[path] ?? '';
        const oldLines = originalContent ? countLines(originalContent) : 0;
        const newLines = countLines(content);
        addChange({ path, action: 'edit', content, originalContent, staged: true });
        const convId = convIdRef.current;
        if (convId) {
          useActivityStore.getState().addLineStats(convId, Math.max(0, newLines - oldLines), Math.max(0, oldLines - newLines));
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
          useActivityStore.getState().addLineStats(convId, countLines(content), 0);
        }
        return `Staged new file ${path}`;
      }

      if (toolCall.toolName === 'delete_repo_file') {
        if (awaitingProposalApprovalRef.current || !proposalApprovedRef.current) {
          return 'Error: Changes are locked until the user explicitly accepts the proposed changes.';
        }
        const { path } = toolCall.args as { path: string; reason: string };
        const existing = useChangesetStore.getState().getChangeset(panelId).changes[path];
        const originalContent = existing?.originalContent ?? repoFileCacheRef.current[path] ?? '';
        const oldLines = originalContent ? countLines(originalContent) : 0;
        addChange({ path, action: 'delete', content: '', originalContent, staged: true });
        const convId = convIdRef.current;
        if (convId) {
          useActivityStore.getState().addLineStats(convId, 0, oldLines);
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
          const originalContent = existing?.originalContent ?? repoFileCacheRef.current[change.path] ?? '';
          const oldLines = originalContent ? countLines(originalContent) : 0;
          const newLines = countLines(change.content || '');
          if (change.action === 'create') {
            totalAdded += newLines;
          } else if (change.action === 'delete') {
            totalRemoved += oldLines;
          } else {
            totalAdded += Math.max(0, newLines - oldLines);
            totalRemoved += Math.max(0, oldLines - newLines);
          }
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
      continuingApprovedProposalRunRef.current = false;
      proposalApprovedRef.current = false;
      awaitingProposalApprovalRef.current = false;
      console.error('[useChat:onError] Chat error:', err?.message || err, 'provider:', effectiveProvider, 'model:', effectiveModel);
      if (err?.message?.includes('not configured')) {
        setProviderUnavailableOpen(true);
      }
      // Handle truncated tool call JSON (model output exceeded token limit)
      if (err?.message?.includes('JSON parsing failed') || err?.message?.includes('Unexpected end of JSON')) {
        console.warn('Tool call was truncated — the model likely exceeded its output token limit. The response will be retried with a prompt to use smaller changes.');
      }
    },
  });

  // Keep messagesRef in sync for use in callbacks without adding messages to deps
  messagesRef.current = messages;

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

  // Auto-continue effect: when onFinish signals an interrupted repo editing session,
  // sanitize any partial tool calls and send a continuation message.
  useEffect(() => {
    if (!autoContinueConvId) return;
    const targetConvId = autoContinueConvId;
    setAutoContinueConvId(null);

    const currentMessages = messagesRef.current;
    const sanitized = sanitizePartialToolCalls(currentMessages);
    if (sanitized !== currentMessages) {
      setMessages(sanitized);
    }

    // Small delay to let the sanitized messages settle
    const timer = setTimeout(() => {
      append(
        {
          role: 'user',
          content:
            'You were interrupted mid-work. Continue where you left off — complete the remaining file changes from the approved plan.',
        },
        {
          body: {
            conversation_id: targetConvId,
            continuing_approved_proposal: true,
          },
        },
      ).catch((err) => {
        console.error('[useChat:autoContinue] Failed to auto-continue:', err);
        awaitingProposalApprovalRef.current = false;
        proposalApprovedRef.current = false;
        continuingApprovedProposalRunRef.current = false;
      });
    }, 300);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoContinueConvId]);

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
    const shouldPause =
      pauseForProposalRef.current ||
      awaitingProposalApprovalRef.current ||
      (!autoApproveRepoChanges && !conversationAutoApproveRef.current);
    if (!shouldPause) return;
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

      const pseudoInvocations = extractPseudoToolInvocations(message.content || '');
      const repoEditInvocation = pseudoInvocations.find((invocation) =>
        ['batch_edit_repo_files', 'edit_repo_file', 'create_repo_file', 'delete_repo_file'].includes(invocation.toolName),
      );

      if (!repoEditInvocation) continue;

      if (repoEditInvocation.toolName === 'batch_edit_repo_files') {
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
          const originalContent = existing?.originalContent ?? repoFileCacheRef.current[change.path] ?? '';
          addChange({
            path: change.path,
            action: change.action,
            content: typeof change.content === 'string' ? change.content : '',
            originalContent,
            staged: true,
          });
        }
      } else {
        const path = typeof repoEditInvocation.args.path === 'string' ? repoEditInvocation.args.path : null;
        const action = repoEditInvocation.toolName === 'create_repo_file'
          ? 'create'
          : repoEditInvocation.toolName === 'delete_repo_file'
            ? 'delete'
            : 'edit';
        if (!path) continue;
        const existing = useChangesetStore.getState().getChangeset(panelId).changes[path];
        const originalContent = existing?.originalContent ?? repoFileCacheRef.current[path] ?? '';
        addChange({
          path,
          action,
          content: typeof repoEditInvocation.args.content === 'string' ? repoEditInvocation.args.content : '',
          originalContent,
          staged: true,
        });
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
        repoFileCacheRef.current = Object.fromEntries(
          Object.values(cs.changes)
            .filter((change) => typeof change.originalContent === 'string')
            .map((change) => [change.path, change.originalContent as string])
        );
        if (cs.activeRepo) {
          csStore.setActiveRepo(panelId, cs.activeRepo);
        } else {
          csStore.clearActiveRepo(panelId);
        }
        csStore.clearChanges(panelId);
        csStore.setRepoFileTree(panelId, cs.repoFileTree);
        for (const change of Object.values(cs.changes)) {
          csStore.addChange(panelId, change);
        }
        psStore.replacePreview(panelId, {
          isOpen: preview.isOpen ?? false,
          files: preview.files as PreviewFile[],
          activeFileId: preview.activeFileId,
          projectType: preview.projectType as ProjectType,
          activeView: preview.activeView === 'changes' ? 'changes' : 'preview',
        });
      } else {
        repoFileCacheRef.current = {};
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
      repoFileCacheRef.current = {};
      setMessages([]);
      resetPanelFileState();
    }

    // Clear hermes tool activity on conversation switch
    setToolActivityMap({});
    toolActivityRef.current = {};
    appliedPseudoRepoMessageIdsRef.current = new Set();
    // Reset per-conversation auto-approve when switching conversations
    conversationAutoApproveRef.current = false;
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
    const continuingApprovedProposal =
      isProposalApprovalMessage(content) &&
      (awaitingProposalApprovalRef.current || pendingProposalRef.current !== null);

    console.log('[useChat:sendMessage] content:', JSON.stringify(content), 'isApproval:', isProposalApprovalMessage(content), 'awaitingRef:', awaitingProposalApprovalRef.current, 'pendingProposal:', !!pendingProposalRef.current, '→ continuingApproved:', continuingApprovedProposal, 'provider:', effectiveProvider, 'model:', effectiveModel);

    if (continuingApprovedProposal) {
      proposalApprovedRef.current = true;
      awaitingProposalApprovalRef.current = false;
      continuingApprovedProposalRunRef.current = true;
    } else {
      proposalApprovedRef.current = false;
      continuingApprovedProposalRunRef.current = false;
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

    try {
      await append(
        { role: 'user', content },
        convId
          ? {
              body: {
                conversation_id: convId,
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
        throw error;
      }
    }

    if (createdConversationId && pendingConversationIdRef.current === createdConversationId) {
      skipNextLoadRef.current = true;
      // Don't clear pendingConversationIdRef before onConversationCreated —
      // it keeps chatSessionId stable until conversationId is set by the parent.
      // The conversation-switch effect clears it once conversationId matches.
      onConversationCreated?.(createdConversationId);
    }
    return true;
  }, [conversationId, effectiveProvider, effectiveModel, config, defaultSystemPrompt, createConversation, renameConversation, append, onConversationCreated, setMessages]);

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
    reload();
  }, [reload]);

  const setConversationAutoApprove = useCallback((value: boolean) => {
    conversationAutoApproveRef.current = value;
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
    setConversationAutoApprove,
  };
}
