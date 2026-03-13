import { useState, useRef, useEffect, useCallback } from 'react';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useChatStore } from '@/stores/chat-store';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { db } from '@/lib/db';
import { getApiBaseUrl } from '@/lib/api';
import { createQueuedMessage, moveQueuedMessageToFront, removeQueuedMessage, type QueuedMessage } from '@/lib/chat-queue';
import { supportsReasoningEffort } from '@/lib/providers';
import { getErrorMessage } from '@/lib/errors';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface SSEEvent {
  type: string;
  data: string;
}

function parseSSEEvents(buffer: string): { events: SSEEvent[]; remaining: string } {
  const parts = buffer.split('\n\n');
  const remaining = parts.pop() || '';
  const events: SSEEvent[] = [];

  for (const eventStr of parts) {
    if (!eventStr.trim()) continue;
    const lines = eventStr.split('\n');
    let eventType = '';
    let eventData = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7);
      if (line.startsWith('data: ')) eventData = line.slice(6);
    }
    if (eventType && eventData) {
      events.push({ type: eventType, data: eventData });
    }
  }

  return { events, remaining };
}

export function useOrchestrator(
  conversationId: string | null,
  onConversationCreated?: (id: string) => void
) {
  const {
    createConversation,
    renameConversation,
    loadConversations,
  } = useChatStore();

  const { providers, defaultSystemPrompt } = useSettingsStore();
  const knowledgeContext = useKnowledgeStore((s) => s.getActiveContext());

  const {
    planningProvider,
    planningModel,
    codingProvider,
    codingModel,
    maxSubAgents,
    updateOrchestration,
    updateTask,
    resetOrchestration,
  } = useOrchestratorStore();

  const planningConfig = providers[planningProvider];
  const codingConfig = providers[codingProvider];
  const planningReasoningEffort = supportsReasoningEffort(planningProvider, planningModel)
    ? planningConfig.reasoningEffort
    : undefined;
  const codingReasoningEffort = supportsReasoningEffort(codingProvider, codingModel)
    ? codingConfig.reasoningEffort
    : undefined;

  // Build system prompt with knowledge context
  const fullSystemPrompt = knowledgeContext
    ? `${defaultSystemPrompt}\n\n--- Knowledge Base ---\n${knowledgeContext}`
    : defaultSystemPrompt;

  const apiBaseUrl = getApiBaseUrl();

  // Ref to always have current conversation ID in callbacks
  const convIdRef = useRef(conversationId);
  const pendingConversationIdRef = useRef<string | null>(null);
  convIdRef.current = conversationId ?? pendingConversationIdRef.current;

  const [messages, setMessages] = useState<Message[]>([]);
  const [draftInput, setDraftInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [providerUnavailableOpen, setProviderUnavailableOpen] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const autoSendingQueuedRef = useRef<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Load messages from IndexedDB when conversationId changes
  useEffect(() => {
    if (conversationId && pendingConversationIdRef.current === conversationId) {
      pendingConversationIdRef.current = null;
    }

    if (conversationId) {
      db.messages.getByConversation(conversationId).then((msgs) => {
        setMessages(
          msgs.map((m) => ({
            id: m.id,
            role: m.role as Message['role'],
            content: m.content,
          }))
        );
      });
    } else {
      setMessages([]);
    }
  }, [conversationId]);

  // Clean up abort controller on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const processStream = useCallback(
    async (response: Response, assistantMsgId: string) => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantContent = '';

      // Stall detection: abort if no data received for 45 seconds
      const STALL_TIMEOUT_MS = 45_000;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const resetStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          console.warn('Orchestrator stream stalled — aborting');
          reader.cancel().catch(() => {});
        }, STALL_TIMEOUT_MS);
      };

      try {
        resetStallTimer();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetStallTimer();

          buffer += decoder.decode(value, { stream: true });
          const { events, remaining } = parseSSEEvents(buffer);
          buffer = remaining;

          for (const event of events) {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(event.data);
            } catch {
              console.warn('Failed to parse SSE event data:', event.data);
              continue;
            }

            switch (event.type) {
              case 'status': {
                const phase = parsed.phase as string;
                updateOrchestration({
                  phase: phase as 'planning' | 'executing' | 'synthesizing',
                });
                break;
              }

              case 'plan': {
                const plan = parsed.plan as string;
                const tasks = parsed.tasks as Array<{ id: string; description: string }>;

                updateOrchestration({
                  phase: 'executing',
                  plan,
                  tasks: tasks.map((t) => ({
                    id: t.id,
                    description: t.description,
                    status: 'pending' as const,
                  })),
                });
                break;
              }

              case 'subtask_start': {
                const taskId = parsed.taskId as string;
                updateTask(taskId, { status: 'running' });
                break;
              }

              case 'subtask_complete': {
                const taskId = parsed.taskId as string;
                const result = parsed.result as string | undefined;
                updateTask(taskId, { status: 'done', result });
                break;
              }

              case 'token': {
                const content = parsed.content as string;
                assistantContent += content;

                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, content: assistantContent }
                      : m
                  )
                );
                break;
              }

              case 'subtask_heartbeat': {
                // Heartbeat — no action needed, the SSE data arriving resets the stall timer
                break;
              }

              case 'error': {
                const errorMsg = (parsed.message as string) || 'Orchestration failed';
                updateOrchestration({ phase: 'error', error: errorMsg });
                setError(new Error(errorMsg));
                break;
              }

              case 'done': {
                updateOrchestration({ phase: 'done' });
                break;
              }
            }
          }
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        reader.releaseLock();
      }

      return assistantContent;
    },
    [updateOrchestration, updateTask]
  );

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

    // Check API keys for both planning and coding providers
    if (!planningConfig?.apiKey) {
      setApiKeyModalOpen(true);
      return;
    }
    if (!codingConfig?.apiKey) {
      setApiKeyModalOpen(true);
      return;
    }

    setError(undefined);
    resetOrchestration();

    let convId = conversationId ?? pendingConversationIdRef.current;
    let createdConversationId: string | null = null;

    // Create conversation if needed
    if (!convId) {
      try {
        convId = await createConversation(
          planningProvider,
          planningModel,
          defaultSystemPrompt
        );
        createdConversationId = convId;
        pendingConversationIdRef.current = convId;
        convIdRef.current = convId;
      } catch (e) {
        console.error('Failed to create conversation:', e);
        setError(e instanceof Error ? e : new Error('Failed to create conversation'));
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

    // Add user message to local state
    const userMessage: Message = { id: userMsgId, role: 'user', content };
    setMessages((prev) => [...prev, userMessage]);

    // Auto-rename conversation from first message
    const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
    if (conv?.title === 'New conversation') {
      const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
      await renameConversation(convId!, title);
    }

    // Clear input
    if (clearDraft) {
      setDraftInput('');
    }

    // Build the full messages array for the API
    const allMessages = [
      ...messages,
      userMessage,
    ].map((m) => ({ role: m.role, content: m.content }));

    // Create placeholder assistant message
    const assistantMsgId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: 'assistant', content: '' },
    ]);

    // Start streaming
    setIsStreaming(true);
    updateOrchestration({ phase: 'planning' });

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch(`${apiBaseUrl}/functions/v1/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          orchestrator_provider: planningProvider,
          orchestrator_model: planningModel,
          orchestrator_api_key: planningConfig.apiKey,
          ...(planningReasoningEffort ? { orchestrator_reasoning_effort: planningReasoningEffort } : {}),
          sub_agent_provider: codingProvider,
          sub_agent_model: codingModel,
          sub_agent_api_key: codingConfig.apiKey,
          ...(codingReasoningEffort ? { sub_agent_reasoning_effort: codingReasoningEffort } : {}),
          messages: allMessages,
          system_prompt: fullSystemPrompt,
          max_sub_agents: maxSubAgents,
          temperature: planningConfig.temperature,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const errorMsg = errorBody || `Orchestration request failed (${response.status})`;
        throw new Error(errorMsg);
      }

      if (!response.body) {
        throw new Error('Response body is empty — streaming not supported');
      }

      const finalContent = await processStream(response, assistantMsgId);

      // Persist the final assistant message to IndexedDB
      await db.messages.add({
        id: assistantMsgId,
        conversationId: convId!,
        role: 'assistant',
        content: finalContent,
        timestamp: new Date().toISOString(),
      });
      await db.conversations.update(convId!, { updatedAt: new Date().toISOString() });
      await loadConversations();

      if (createdConversationId) {
        onConversationCreated?.(createdConversationId);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // User cancelled — keep whatever content was accumulated
        updateOrchestration({ phase: 'idle' });
      } else {
        const err = new Error(getErrorMessage(e));
        console.error('Orchestration error:', err);
        setError(err);
        updateOrchestration({ phase: 'error', error: err.message });

        // Remove the empty assistant placeholder if no content was generated
        setMessages((prev) => {
          const msg = prev.find((m) => m.id === assistantMsgId);
          if (msg && !msg.content) {
            return prev.filter((m) => m.id !== assistantMsgId);
          }
          return prev;
        });
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
    return true;
  }, [
    conversationId,
    messages,
    planningProvider,
    planningModel,
    planningConfig,
    planningReasoningEffort,
    codingProvider,
    codingModel,
    codingConfig,
    codingReasoningEffort,
    maxSubAgents,
    fullSystemPrompt,
    apiBaseUrl,
    defaultSystemPrompt,
    createConversation,
    renameConversation,
    loadConversations,
    onConversationCreated,
    resetOrchestration,
    updateOrchestration,
    processStream,
  ]);

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
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setIsStreaming(false);
      return;
    }

    setQueuedMessages((prev) => removeQueuedMessage(prev, messageId));
    void sendMessage(queued.content);
  }, [isStreaming, queuedMessages, sendMessage]);

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

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsStreaming(false);
  }, []);

  const handleRegenerateWrapper = useCallback(async () => {
    // Remove the last assistant message
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return;

    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;

    // Remove both last assistant and last user from state
    setMessages((prev) =>
      prev.filter((m) => m.id !== lastAssistant.id && m.id !== lastUser.id)
    );

    // Set input so handleSend can pick it up
    setDraftInput(lastUser.content);
    regeneratePendingRef.current = true;
  }, [messages]);

  // Auto-trigger send when regenerate sets draft input
  const regeneratePendingRef = useRef(false);
  useEffect(() => {
    if (regeneratePendingRef.current && draftInput) {
      regeneratePendingRef.current = false;
      handleSend();
    }
  }, [draftInput, handleSend]);

  return {
    messages,
    input: draftInput,
    setInput: setDraftInput,
    handleSend,
    handleQuickSend,
    queuedMessages,
    handleRemoveQueuedMessage,
    handleSteerQueuedMessage,
    handleStop,
    handleRegenerate: handleRegenerateWrapper,
    isStreaming,
    error,
    apiKeyModalOpen,
    setApiKeyModalOpen,
    providerUnavailableOpen,
    setProviderUnavailableOpen,
    activeProvider: planningProvider,
    activeModel: planningModel,
  };
}
