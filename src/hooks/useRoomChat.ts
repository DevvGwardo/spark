import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRoomStore, type RoomMessage } from '@/stores/room-store';

interface ChatMessageLike {
  id: string;
  role: string;
  content: string;
  timestamp?: string;
}

/**
 * Convert a room message to the ChatMessageLike format that ChatArea expects.
 */
function toChatMessage(msg: RoomMessage): ChatMessageLike {
  const role = msg.role === 'user' ? 'user' : 'assistant';
  let content = msg.content;
  if (role === 'assistant' && msg.senderProfile !== 'user') {
    content = `**${msg.senderDisplayName}**: ${content}`;
  }
  return { id: msg.id, role, content, timestamp: msg.timestamp };
}

export function useRoomChat(roomId: string | null) {
  const {
    activeRoom,
    messages: roomMessages,
    pendingAgents,
    fetchRoom,
    fetchMessages,
    postMessage,
  } = useRoomStore();

  const [input, setInputRaw] = useState('');
  const [sending, setSending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const members = activeRoom?.members ?? [];
  const messages = roomMessages.map(toChatMessage);
  const isStreaming = pendingAgents.length > 0;

  // ── @mention autocomplete state ──
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);

  // Wrap setInput to detect @mentions
  const setInput = useCallback((value: string) => {
    setInputRaw(value);
    // Detect @ mention pattern at cursor
    const cursorPos = value.length;
    const beforeCursor = value.slice(0, cursorPos);
    const atMatch = beforeCursor.match(/@(\w*)$/);
    if (atMatch) {
      setShowMentions(true);
      setMentionQuery(atMatch[1].toLowerCase());
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  }, []);

  const insertMention = useCallback((displayName: string) => {
    setInputRaw((prev) => prev.replace(/@\w*$/, `@${displayName} `));
    setShowMentions(false);
  }, []);

  const filteredMentions = useMemo(
    () => showMentions
      ? members.filter((m) => m.displayName.toLowerCase().includes(mentionQuery))
      : [],
    [showMentions, members, mentionQuery],
  );

  // Poll for new messages
  useEffect(() => {
    if (!roomId) return;
    void fetchRoom(roomId);
    void fetchMessages(roomId, 50);
    pollRef.current = setInterval(() => {
      void fetchMessages(roomId, 50);
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [roomId, fetchRoom, fetchMessages]);

  const handleSend = useCallback(() => {
    const content = input.trim();
    if (!content || !roomId || sending) return;
    setSending(true);
    const mentionNames = content.match(/@(\w+)/g)?.map((m) => m.slice(1)) ?? [];
    postMessage(roomId, content, 'user', mentionNames)
      .then(() => setInput(''))
      .catch(console.error)
      .finally(() => setSending(false));
  }, [input, roomId, sending, postMessage]);

  const handleStop = useCallback(() => {}, []);

  const handleRegenerate = useCallback(() => {
    if (roomId) void fetchMessages(roomId, 50);
  }, [roomId, fetchMessages]);

  // Handle keyboard navigation for mention dropdown
  const handleMentionKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showMentions) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMentionIndex((i) => Math.min(i + 1, filteredMentions.length - 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMentionIndex((i) => Math.max(i - 1, 0));
      return true;
    }
    if (e.key === 'Enter' && filteredMentions.length > 0) {
      e.preventDefault();
      insertMention(filteredMentions[mentionIndex].displayName);
      return true;
    }
    if (e.key === 'Escape') {
      setShowMentions(false);
      return true;
    }
    return false;
  }, [showMentions, mentionIndex, filteredMentions, insertMention]);

  return {
    // Standard chat interface
    messages,
    input,
    setInput,
    handleSend,
    handleStop,
    handleRegenerate,
    isStreaming,
    isAnotherPanelStreamingSameProfile: false,
    error: null,
    apiKeyModalOpen: false,
    setApiKeyModalOpen: () => {},
    activeProvider: 'hermes' as const,
    activeModel: 'room' as string,
    queuedMessages: [] as never[],
    handleQuickSend: undefined,
    handleRemoveQueuedMessage: undefined,
    handleSteerQueuedMessage: undefined,
    toolActivityMap: undefined,
    agentStatus: undefined,
    conversationAutoApproveEnabled: false,
    setConversationAutoApprove: undefined,
    buddyResponse: undefined,
    onUseBuddyResponse: undefined,

    // Room-specific values for @mention UI
    members,
    showMentions,
    mentionIndex,
    filteredMentions,
    insertMention,
    handleMentionKeyDown,
  };
}
