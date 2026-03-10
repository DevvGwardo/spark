import { useState, useRef, useEffect, useCallback } from 'react';
import { useChat as useAIChat, type Message as AIMessage } from '@ai-sdk/react';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore, type FileType, type PreviewFile, type ProjectType } from '@/stores/preview-store';
import { useActivityStore } from '@/stores/activity-store';
import { db } from '@/lib/db';
import { getApiBaseUrl } from '@/lib/api';
import { createQueuedMessage, moveQueuedMessageToFront, removeQueuedMessage, type QueuedMessage } from '@/lib/chat-queue';
import { PROVIDERS } from '@/lib/providers';

function countLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').length;
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
) {
  const {
    createConversation,
    renameConversation,
    loadConversations,
  } = useChatStore();

  const { activeProvider, providers, defaultSystemPrompt, githubPAT } = useSettingsStore();
  const knowledgeContext = useKnowledgeStore((s) => s.getActiveContext());
  const changeset = useChangesetStore((s) => s.getChangeset(panelId));
  const addChangeForPanel = useChangesetStore((s) => s.addChange);
  const preview = usePreviewStore((s) => s.getPreview(panelId));
  const { activeRepo, isRepoMode, repoFileTree } = changeset;
  const addChange = useCallback((change: Parameters<typeof addChangeForPanel>[1]) => addChangeForPanel(panelId, change), [addChangeForPanel, panelId]);

  // When orchestrator is enabled, use its provider/model instead
  const effectiveProvider = providerOverride?.provider ?? activeProvider;
  const config = providers[effectiveProvider];
  const effectiveModel = providerOverride?.model ?? config.model;

  // Build system prompt with knowledge context and active repo
  let fullSystemPrompt = knowledgeContext
    ? `${defaultSystemPrompt}\n\n--- Knowledge Base ---\n${knowledgeContext}`
    : defaultSystemPrompt;

  if (isRepoMode && activeRepo) {
    let repoContext = `\n\n--- GitHub Repository ---\nYou are working on the GitHub repository ${activeRepo.fullName} (default branch: ${activeRepo.defaultBranch}).

IMPORTANT: You have tools to work with this repo. When the user asks you to make changes:
1. FIRST use propose_changes to present a plan of ALL files you intend to modify. Wait for user approval before proceeding.
2. After approval, use read_repo_file to read the files you need to modify.
3. Then use batch_edit_repo_files to apply ALL changes at once (preferred), or edit_repo_file / create_repo_file individually.
4. Do NOT ask the user to specify file paths — explore the repo yourself using the file tree below.
5. When the user asks you to update multiple things, make sure you address ALL of them, not just one.
6. All changes are staged for a pull request (not applied directly).
7. IMPORTANT: If you need to edit many large files, split batch_edit_repo_files into multiple calls (max 3-4 files per batch) to avoid output truncation. For very large files, use individual edit_repo_file calls instead.`;

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
      },
    });
  }, [panelId]);

  const [draftInput, setDraftInput] = useState('');
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [providerUnavailableOpen, setProviderUnavailableOpen] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const chatSessionId = conversationId ? `${conversationId}:${panelId}` : undefined;
  const autoSendingQueuedRef = useRef<string | null>(null);

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
    body: {
      provider: effectiveProvider,
      model: effectiveModel,
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      api_key: config.apiKey,
      system_prompt: fullSystemPrompt,
      ...(isRepoMode && activeRepo ? { activeRepo } : {}),
    },
    id: chatSessionId,
    streamProtocol: 'data',
    throttle: 32,
    maxSteps: 50,
    onFinish: async (message) => {
      const convId = convIdRef.current;
      if (!convId) return;

      // Persist assistant message
      await db.messages.add({
        id: message.id || crypto.randomUUID(),
        conversationId: convId,
        role: 'assistant',
        content: message.content,
        timestamp: new Date().toISOString(),
      });
      await db.conversations.update(convId, { updatedAt: new Date().toISOString() });
      await loadConversations();
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
        // Only auto-open the preview panel when there's previewable content
        // (an HTML file exists, or we just added one)
        const PREVIEWABLE_TYPES: Set<string> = new Set(['html', 'css', 'md']);
        const hasPreviewable =
          previewStore.getPreview(panelId).files.some((f) => PREVIEWABLE_TYPES.has(f.type)) ||
          PREVIEWABLE_TYPES.has(fileType);
        if (hasPreviewable) {
          previewStore.setOpen(panelId, true);
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
          const data = await response.json();
          if (data.error) return `Error reading file: ${data.error}`;
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
        const summary = plan.map((p, i) => `${i + 1}. **${p.action}** \`${p.path}\` — ${p.description}`).join('\n');
        return `## Proposed Changes\n\n${overallSummary ? `${overallSummary}\n\n` : ''}${summary}\n\nUse the accept button below to apply these changes, or tell me what to adjust.`;
      }

      if (toolCall.toolName === 'edit_repo_file') {
        const { path, content } = toolCall.args as { path: string; content: string; description: string };
        const existing = useChangesetStore.getState().getChangeset(panelId).changes[path];
        const oldLines = existing?.originalContent ? countLines(existing.originalContent) : 0;
        const newLines = countLines(content);
        addChange({ path, action: 'edit', content });
        const convId = convIdRef.current;
        if (convId) {
          useActivityStore.getState().addLineStats(convId, Math.max(0, newLines - oldLines), Math.max(0, oldLines - newLines));
        }
        return `Staged edit to ${path}`;
      }

      if (toolCall.toolName === 'create_repo_file') {
        const { path, content } = toolCall.args as { path: string; content: string; description: string };
        addChange({ path, action: 'create', content });
        const convId = convIdRef.current;
        if (convId) {
          useActivityStore.getState().addLineStats(convId, countLines(content), 0);
        }
        return `Staged new file ${path}`;
      }

      if (toolCall.toolName === 'delete_repo_file') {
        const { path } = toolCall.args as { path: string; reason: string };
        const existing = useChangesetStore.getState().getChangeset(panelId).changes[path];
        const oldLines = existing?.originalContent ? countLines(existing.originalContent) : 0;
        addChange({ path, action: 'delete', content: '' });
        const convId = convIdRef.current;
        if (convId) {
          useActivityStore.getState().addLineStats(convId, 0, oldLines);
        }
        return `Staged deletion of ${path}`;
      }

      if (toolCall.toolName === 'batch_edit_repo_files') {
        const { changes: fileChanges } = toolCall.args as {
          changes: Array<{ path: string; action: 'create' | 'edit' | 'delete'; content: string; description: string }>;
        };
        const results: string[] = [];
        let totalAdded = 0;
        let totalRemoved = 0;
        for (const change of fileChanges) {
          const existing = useChangesetStore.getState().getChangeset(panelId).changes[change.path];
          const oldLines = existing?.originalContent ? countLines(existing.originalContent) : 0;
          const newLines = countLines(change.content || '');
          if (change.action === 'create') {
            totalAdded += newLines;
          } else if (change.action === 'delete') {
            totalRemoved += oldLines;
          } else {
            totalAdded += Math.max(0, newLines - oldLines);
            totalRemoved += Math.max(0, oldLines - newLines);
          }
          addChange({ path: change.path, action: change.action, content: change.content || '' });
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
      console.error('Chat error:', err);
      if (err?.message?.includes('not configured')) {
        setProviderUnavailableOpen(true);
      }
      // Handle truncated tool call JSON (model output exceeded token limit)
      if (err?.message?.includes('JSON parsing failed') || err?.message?.includes('Unexpected end of JSON')) {
        console.warn('Tool call was truncated — the model likely exceeded its output token limit. The response will be retried with a prompt to use smaller changes.');
      }
    },
  });

  // Track streaming state in global activity store
  const isStreaming = status === 'streaming' || status === 'submitted';
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
      if (saved) {
        const { changeset: cs, preview } = saved;
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
          isOpen: preview.files.length > 0,
          files: preview.files as PreviewFile[],
          activeFileId: preview.activeFileId,
          projectType: preview.projectType as ProjectType,
        });
      } else {
        resetPanelFileState();
      }
    });
  }, [panelId, resetPanelFileState]);

  // Load messages (and file state) from IndexedDB when switching conversations
  useEffect(() => {
    const prevConvId = prevConversationIdRef.current;
    prevConversationIdRef.current = conversationId;

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
      // Save whatever the user configured while on the blank thread to the new conversation
      void saveConversationFiles(conversationId);

      if (skipNextLoadRef.current) {
        skipNextLoadRef.current = false;
        return;
      }
      db.messages.getByConversation(conversationId).then((msgs) => {
        setMessages(
          msgs.map((m) => ({
            id: m.id,
            role: m.role as AIMessage['role'],
            content: m.content,
          }))
        );
      });
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
      db.messages.getByConversation(conversationId).then((msgs) => {
        setMessages(
          msgs.map((m) => ({
            id: m.id,
            role: m.role as AIMessage['role'],
            content: m.content,
          }))
        );
      });

      // Restore file state for this conversation
      restoreFileState(conversationId);
    } else {
      setMessages([]);
      resetPanelFileState();
    }
  }, [conversationId, setMessages, panelId, resetPanelFileState, restoreFileState, saveConversationFiles]);

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

    let convId = conversationId;

    // Create conversation if needed
    if (!convId) {
      try {
        convId = await createConversation(effectiveProvider, effectiveModel, defaultSystemPrompt);
        // Mark to skip the IndexedDB reload that will be triggered by the conversationId change —
        // append() below will add the user message to AI SDK state directly.
        skipNextLoadRef.current = true;
        onConversationCreated?.(convId);
      } catch (e) {
        console.error('Failed to create conversation:', e);
        return;
      }
    }

    // Persist user message to IndexedDB
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
    await append({ role: 'user', content });
    return true;
  }, [conversationId, effectiveProvider, effectiveModel, config, defaultSystemPrompt, createConversation, renameConversation, append, onConversationCreated]);

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
  };
}
