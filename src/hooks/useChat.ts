import { useState, useRef, useEffect, useCallback } from 'react';
import { useChat as useAIChat, type Message as AIMessage } from '@ai-sdk/react';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { usePreviewStore } from '@/stores/preview-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { db } from '@/lib/db';
import { getApiBaseUrl } from '@/lib/api';

export function useChat() {
  const {
    activeConversationId,
    createConversation,
    renameConversation,
    loadConversations,
  } = useChatStore();

  const { activeProvider, providers, defaultSystemPrompt, githubPAT } = useSettingsStore();
  const knowledgeContext = useKnowledgeStore((s) => s.getActiveContext());
  const { addFile, setOpen } = usePreviewStore();
  const { activeRepo, isRepoMode, addChange, repoFileTree } = useChangesetStore();
  const config = providers[activeProvider];

  // Build system prompt with knowledge context and active repo
  let fullSystemPrompt = knowledgeContext
    ? `${defaultSystemPrompt}\n\n--- Knowledge Base ---\n${knowledgeContext}`
    : defaultSystemPrompt;

  if (isRepoMode && activeRepo) {
    let repoContext = `\n\n--- GitHub Repository ---\nYou are working on the GitHub repository ${activeRepo.fullName} (default branch: ${activeRepo.defaultBranch}).

IMPORTANT: You have tools to work with this repo. When the user asks you to make changes:
1. First use read_repo_file to read relevant files you need to understand or modify.
2. Then use edit_repo_file (to modify existing files) or create_repo_file (to create new files) to make changes.
3. Do NOT ask the user to specify file paths — explore the repo yourself using the file tree below.
4. All changes are staged for a pull request (not applied directly).`;

    if (repoFileTree.length > 0) {
      repoContext += `\n\nRepository file tree:\n${repoFileTree.join('\n')}`;
    }

    fullSystemPrompt += repoContext;
  }

  const apiBaseUrl = getApiBaseUrl();

  // Use a ref so callbacks always have current conversation ID
  const convIdRef = useRef(activeConversationId);
  convIdRef.current = activeConversationId;

  const [draftInput, setDraftInput] = useState('');
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [providerUnavailableOpen, setProviderUnavailableOpen] = useState(false);

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
      provider: activeProvider,
      model: config.model,
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      ...(activeProvider !== 'lovable' ? { api_key: config.apiKey } : {}),
      system_prompt: fullSystemPrompt,
      ...(isRepoMode && activeRepo ? { activeRepo } : {}),
    },
    id: activeConversationId || undefined,
    streamProtocol: 'data',
    throttle: 32,
    maxSteps: 10,
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
      // Handle preview file tools
      if (toolCall.toolName === 'create_html_file' ||
          toolCall.toolName === 'create_css_file' ||
          toolCall.toolName === 'create_js_file' ||
          toolCall.toolName === 'create_react_component' ||
          toolCall.toolName === 'create_nextjs_page' ||
          toolCall.toolName === 'update_file') {

        const { filename, content } = toolCall.args as { filename: string; content: string };

        let type: 'html' | 'css' | 'js' | 'jsx' | 'tsx' | 'ts' = 'html';
        if (filename.endsWith('.css') || toolCall.toolName === 'create_css_file') {
          type = 'css';
        } else if (filename.endsWith('.js') || toolCall.toolName === 'create_js_file') {
          type = 'js';
        } else if (filename.endsWith('.jsx') || toolCall.toolName === 'create_react_component') {
          type = 'jsx';
        } else if (filename.endsWith('.tsx')) {
          type = 'tsx';
        } else if (filename.endsWith('.ts')) {
          type = 'ts';
        }

        addFile({ filename, content, type });
        setOpen(true);
      }

      // Handle repo tool calls
      if (toolCall.toolName === 'read_repo_file') {
        const { path } = toolCall.args as { path: string };
        const currentRepo = useChangesetStore.getState().activeRepo;
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

      if (toolCall.toolName === 'edit_repo_file') {
        const { path, content } = toolCall.args as { path: string; content: string; description: string };
        addChange({ path, action: 'edit', content });
        setOpen(true);
        return `Staged edit to ${path}`;
      }

      if (toolCall.toolName === 'create_repo_file') {
        const { path, content } = toolCall.args as { path: string; content: string; description: string };
        addChange({ path, action: 'create', content });
        setOpen(true);
        return `Staged new file ${path}`;
      }

      if (toolCall.toolName === 'delete_repo_file') {
        const { path } = toolCall.args as { path: string; reason: string };
        addChange({ path, action: 'delete', content: '' });
        setOpen(true);
        return `Staged deletion of ${path}`;
      }
    },
    onError: (err) => {
      console.error('Chat error:', err);
      if (err?.message?.includes('not configured')) {
        setProviderUnavailableOpen(true);
      }
    },
  });

  // Load messages from IndexedDB when switching conversations
  useEffect(() => {
    if (activeConversationId) {
      db.messages.getByConversation(activeConversationId).then((msgs) => {
        setMessages(
          msgs.map((m) => ({
            id: m.id,
            role: m.role as AIMessage['role'],
            content: m.content,
          }))
        );
      });
    } else {
      setMessages([]);
    }
  }, [activeConversationId, setMessages]);

  const handleSend = useCallback(async () => {
    const content = draftInput.trim();
    if (!content) return;

    // Lovable provider requires LOVABLE_API_KEY on the server — warn if not configured
    if (activeProvider === 'lovable') {
      setProviderUnavailableOpen(true);
      return;
    }

    // Check if API key is needed but missing
    if (!config.apiKey) {
      setApiKeyModalOpen(true);
      return;
    }

    let convId = activeConversationId;

    // Create conversation if needed
    if (!convId) {
      try {
        convId = await createConversation(activeProvider, config.model, defaultSystemPrompt);
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
    setDraftInput('');
    append({ role: 'user', content });
  }, [draftInput, activeConversationId, activeProvider, config, defaultSystemPrompt, createConversation, renameConversation, append]);

  const handleRegenerate = useCallback(() => {
    reload();
  }, [reload]);

  return {
    messages,
    input: draftInput,
    setInput: setDraftInput,
    handleSend,
    handleStop: stop,
    handleRegenerate,
    isStreaming: status === 'streaming' || status === 'submitted',
    error,
    apiKeyModalOpen,
    setApiKeyModalOpen,
    providerUnavailableOpen,
    setProviderUnavailableOpen,
    activeProvider,
  };
}
