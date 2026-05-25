import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { ArrowUp, Settings, Users, X, AlertCircle, Loader2 } from 'lucide-react';
import { useRoomStore, type RoomMessage, type RoomMember } from '@/stores/room-store';
import { cn } from '@/lib/utils';

interface SwarmRoomPanelProps {
  roomId: string;
  onBack?: () => void;
  onSettings?: () => void;
  teamId?: string;
}

const MEMBER_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#ef4444', '#a855f7', '#ec4899', '#14b8a6'];

function getColorIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % MEMBER_COLORS.length;
}

function getColor(name: string): string {
  return MEMBER_COLORS[getColorIndex(name)];
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function MemberAvatar({ name, color, size = 'sm' }: { name: string; color: string; size?: 'sm' | 'md' }) {
  const dim = size === 'md' ? 'w-8 h-8 text-[11px]' : 'w-6 h-6 text-[9px]';
  return (
    <div
      className={`${dim} flex items-center justify-center rounded-full font-semibold shrink-0`}
      style={{ backgroundColor: color + '20', color, border: `1px solid ${color}40` }}
      title={name}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

/**
 * Extract @mention display names from a string, deduplicated.
 */
function extractMentionNames(content: string): string[] {
  const matches = content.match(/@(\w[\w_-]*)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

export const SwarmRoomPanel: React.FC<SwarmRoomPanelProps> = ({ roomId, onBack, onSettings, teamId: teamIdProp }) => {
  const {
    activeRoom,
    messages,
    loading,
    pendingAgents,
    fetchRoom,
    fetchMessages,
    postMessage,
    setActiveRoomId,
    roomTeamIds,
  } = useRoomStore();

  // Use prop teamId or look up from room-store's team-room association
  const teamId = teamIdProp || roomTeamIds[roomId];

  const [inputValue, setInputValue] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const members = activeRoom?.members ?? [];
  const lastMessageId = messages[messages.length - 1]?.id;

  // ── Derive which members are @mentioned in the current input ──
  const mentionedNames = useMemo(() => extractMentionNames(inputValue), [inputValue]);
  const mentionedMembers = useMemo(
    () => members.filter((m) => mentionedNames.includes(m.displayName)),
    [members, mentionedNames],
  );
  const unknownMentions = useMemo(
    () => mentionedNames.filter((name) => !members.some((m) => m.displayName === name)),
    [mentionedNames, members],
  );

  // ── Compute mention dropdown items ──
  const filteredMentions = useMemo(
    () => (showMentions
      ? members.filter((m) => m.displayName.toLowerCase().includes(mentionQuery))
      : []),
    [showMentions, members, mentionQuery],
  );

  // Set active room on mount
  useEffect(() => {
    setActiveRoomId(roomId);
    void fetchRoom(roomId);
    void fetchMessages(roomId, 50);
    return () => setActiveRoomId(null);
  }, [roomId, fetchRoom, fetchMessages, setActiveRoomId]);

  // Poll for new messages every 2 seconds
  useEffect(() => {
    pollRef.current = setInterval(() => {
      void fetchMessages(roomId, 50);
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [roomId, fetchMessages]);

  // Auto-scroll on new messages
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
    return () => {
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
  }, [lastMessageId]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  }, [inputValue]);

  // ── @mention detection on input change ──
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputValue(val);

    const cursorPos = e.target.selectionStart ?? val.length;
    const beforeCursor = val.slice(0, cursorPos);
    const atMatch = beforeCursor.match(/@(\w*)$/);
    if (atMatch) {
      setShowMentions(true);
      setMentionQuery(atMatch[1].toLowerCase());
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  };

  // ── Insert a selected mention into the textarea ──
  const insertMention = (member: RoomMember) => {
    const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
    const before = inputValue.slice(0, cursorPos);
    const after = inputValue.slice(cursorPos);
    const replaced = before.replace(/@\w*$/, `@${member.displayName} `);
    setInputValue(replaced + after);
    setShowMentions(false);
    textareaRef.current?.focus();
  };

  // ── Keyboard navigation ──
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMentions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, filteredMentions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && filteredMentions.length > 0) {
        e.preventDefault();
        insertMention(filteredMentions[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setShowMentions(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // ── Send message ──
  const handleSend = useCallback(async () => {
    const content = inputValue.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const mentionNames = extractMentionNames(content);
      await postMessage(roomId, content, 'user', mentionNames, teamId);
      setInputValue('');
    } catch (e) {
      console.error('Failed to send message:', e);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }, [inputValue, sending, roomId, teamId, postMessage]);

  const isUser = (msg: RoomMessage) => msg.role === 'user' || msg.senderProfile === 'user';

  // ── Check if there are any members to trigger ──
  const willTriggerAnyone = members.length === 0 || mentionedNames.length === 0 || mentionedMembers.length > 0;

  return (
    <div className="flex h-full flex-col bg-transparent">
      {/* Top bar */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[#2F2F2F] px-3">
        {onBack && (
          <button
            onClick={onBack}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors"
            title="Back"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[hsl(var(--text-primary))]">
            {activeRoom?.name ?? 'Room'}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {members.length > 0 && `${members.length} member${members.length !== 1 ? 's' : ''}`}
          </span>
        </div>
        {/* Member avatars */}
        <div className="flex items-center -space-x-1.5">
          {members.slice(0, 5).map((m) => (
            <MemberAvatar key={m.profileName} name={m.displayName} color={m.color || getColor(m.profileName)} />
          ))}
          {members.length > 5 && (
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[hsl(var(--muted))] text-[9px] font-semibold text-muted-foreground border border-[#2F2F2F]">
              +{members.length - 5}
            </div>
          )}
        </div>
        {onSettings && (
          <button
            onClick={onSettings}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors"
            title="Room settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Message area */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loading && messages.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#2F2F2F] border-t-primary" />
              <span className="text-[12px] text-muted-foreground">Loading messages…</span>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <Users className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-[13px] font-medium text-muted-foreground/70 mb-1">No messages yet</p>
            <p className="text-[11px] text-muted-foreground/50 text-center">Type <code className="mx-1 rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 text-[10px]">@agent-name</code> to get an agent's attention</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((msg) => {
              const color = msg.senderProfile === 'user'
                ? undefined
                : members.find((m) => m.profileName === msg.senderProfile)?.color
                  ?? getColor(msg.senderProfile);

              return (
                <div
                  key={msg.id}
                  className={cn(
                    'animate-fade-in-up flex',
                    isUser(msg) ? 'justify-end' : 'justify-start'
                  )}
                >
                  {isUser(msg) ? (
                    <div className="max-w-[80%] rounded-xl bg-primary/15 px-3.5 py-2.5 text-[13px] text-[hsl(var(--text-primary))]">
                      <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                      <div className="mt-1 text-[10px] text-muted-foreground/60 text-right">
                        {formatTime(msg.timestamp)}
                      </div>
                    </div>
                  ) : msg.role === 'system' ? (
                    <div className="w-full text-center">
                      <div className="mx-auto max-w-[80%] rounded-lg bg-[hsl(var(--muted))]/30 px-3 py-2 text-[12px] italic text-muted-foreground/60">
                        <span>{msg.content}</span>
                        <div className="mt-0.5 text-[10px] text-muted-foreground/40">
                          {formatTime(msg.timestamp)}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-[80%]">
                      <div className="flex items-center gap-1.5 mb-1">
                        <div
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span
                          className="text-[11px] font-semibold"
                          style={{ color }}
                        >
                          {msg.senderDisplayName || msg.senderProfile}
                        </span>
                        {(() => {
                          const member = members.find((m) => m.profileName === msg.senderProfile);
                          return member?.model ? (
                            <span className="text-[9px] text-muted-foreground/40 font-mono">{member.model}</span>
                          ) : null;
                        })()}
                        <span className="text-[10px] text-muted-foreground/50">
                          {formatTime(msg.timestamp)}
                        </span>
                      </div>
                      <div
                        className="rounded-xl bg-[hsl(var(--card))] px-3.5 py-2.5 text-[13px] text-[hsl(var(--text-primary))] border-l-2"
                        style={{ borderLeftColor: color }}
                      >
                        <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Typing indicators */}
      {pendingAgents.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-t border-[#2F2F2F]">
          {pendingAgents.map((agent) => {
            const color = members.find((m) => m.profileName === agent.profileName)?.color ?? getColor(agent.profileName);
            return (
              <div
                key={agent.profileName}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] animate-fade-in-up"
                style={{ backgroundColor: color + '12', color }}
              >
                <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                <span className="font-medium">{agent.displayName}</span>
                <span className="opacity-70">is responding…</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Input bar */}
      <div className="relative shrink-0 border-t border-[#2F2F2F] px-3 py-2">
        {/* Mention autocomplete dropdown */}
        {showMentions && (
          <div className="absolute bottom-full left-3 right-3 mb-1 rounded-lg border border-[#2F2F2F] bg-[hsl(var(--card))] py-1 shadow-lg max-h-48 overflow-y-auto z-10">
            {members.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted-foreground/60">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>No agents in this room. Add members in room settings.</span>
              </div>
            ) : filteredMentions.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-muted-foreground/60">
                No agent matches "{mentionQuery}"
              </div>
            ) : (
              filteredMentions.map((m, i) => {
                const color = m.color || getColor(m.profileName);
                return (
                  <button
                    key={m.profileName}
                    onClick={() => insertMention(m)}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] transition-colors',
                      i === mentionIndex ? 'bg-[hsl(var(--muted))]' : 'hover:bg-[hsl(var(--muted))]/50'
                    )}
                  >
                    <MemberAvatar name={m.displayName} color={color} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-[hsl(var(--text-primary))]">{m.displayName}</span>
                        <span className="text-muted-foreground/50">@{m.profileName}</span>
                      </div>
                      {m.model && (
                        <span className="text-[10px] font-mono text-muted-foreground/40 truncate">{m.model}</span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}

        {/* "Will trigger" pills — visible below textarea when @mentions are active */}
        {mentionedMembers.length > 0 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground/40">Will trigger:</span>
            {mentionedMembers.map((m) => {
              const color = m.color || getColor(m.profileName);
              return (
                <span
                  key={m.profileName}
                  className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ backgroundColor: color + '18', color, border: `1px solid ${color}30` }}
                >
                  {m.displayName}
                </span>
              );
            })}
            {mentionedNames.length > 0 && unknownMentions.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-400/70" title={unknownMentions.map((n) => `@${n}`).join(', ')}>
                <AlertCircle className="h-3 w-3" />
                Unknown: {unknownMentions.map((n) => `@${n}`).join(', ')}
              </span>
            )}
          </div>
        )}

        {/* No members warning */}
        {members.length === 0 && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-400/80">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>No agents to trigger. Add members in room settings.</span>
          </div>
        )}

        {/* Textarea + Send */}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={members.length === 0 ? 'Add agents to the room first…' : 'Type a message… (@ to mention)'}
            rows={1}
            className="min-h-[36px] flex-1 resize-none rounded-lg border border-[#2F2F2F] bg-[hsl(var(--card))] px-3 py-2 text-[13px] text-[hsl(var(--text-primary))] placeholder:text-muted-foreground/40 focus:border-[hsl(var(--ring))] focus:outline-none"
          />
          <button
            onClick={() => void handleSend()}
            disabled={!inputValue.trim() || sending}
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
              inputValue.trim() && !sending
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : 'bg-[hsl(var(--muted))] text-muted-foreground cursor-not-allowed'
            )}
          >
            {sending ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
