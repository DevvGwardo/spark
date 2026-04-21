import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, Zap, AlertCircle, Loader2 } from 'lucide-react';
import { useSessionsStore, type HermesSession } from '@/stores/sessions-store';
import { useUIStore } from '@/stores/ui-store';
import { getSession, type HermesSessionDetail, type HermesSessionMessage } from '@/lib/hermes-api';
import { deriveTasks } from '@/lib/derive-tasks';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/relative-time';
import { TaskList } from './TaskList';

function statusColor(session: HermesSession): string {
  if (session.status === 'error') return 'bg-red-500';
  if (session.status === 'active') return 'bg-blue-500';
  if (session.messages > 0) return 'bg-green-500';
  return 'bg-gray-400';
}

function sessionTitle(session: Pick<HermesSession, 'id' | 'firstUserMessage'>): string {
  return session.firstUserMessage?.trim().length
    ? session.firstUserMessage.trim()
    : `Session ${session.id.slice(0, 8)}`;
}

function roleLabel(role: HermesSessionMessage['role']): string {
  if (role === 'assistant' || role === 'user' || role === 'system' || role === 'tool') return role;
  return 'message';
}

function roleClass(role: HermesSessionMessage['role']): string {
  if (role === 'user') return 'border-blue-500/20 bg-blue-500/5';
  if (role === 'assistant') return 'border-emerald-500/20 bg-emerald-500/5';
  if (role === 'system') return 'border-violet-500/20 bg-violet-500/5';
  if (role === 'tool') return 'border-amber-500/20 bg-amber-500/5';
  return 'border-border/30 bg-background/50';
}

interface SessionRowProps {
  session: HermesSession;
  selectedId: string | null;
  onSelect: (id: string) => void;
  deleteConfirmId: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel: () => void;
}

function SessionRow({ session, selectedId, onSelect, deleteConfirmId, onDeleteRequest, onDeleteConfirm, onDeleteCancel }: SessionRowProps) {
  const msgCount = session.messages;
  const isConfirming = deleteConfirmId === session.id;
  const title = sessionTitle(session);

  return (
    <div
      className={cn(
        'group flex items-start gap-2 px-3 py-2 rounded-lg hover:bg-[hsl(var(--sidebar-active))] transition-colors cursor-pointer',
        selectedId === session.id && 'bg-[hsl(var(--sidebar-active))]'
      )}
      onClick={() => onSelect(session.id)}
    >
      <div className="flex-shrink-0 mt-1">
        <div className={cn('w-2 h-2 rounded-full', statusColor(session), session.status === 'active' && 'animate-pulse')} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium truncate">{title}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px] text-muted-foreground/70">{msgCount} messages</span>
          <span className="text-[11px] text-muted-foreground/40">{relativeTime(session.created_at)}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={cn(
            'text-[10px] uppercase tracking-wide',
            session.status === 'error'
              ? 'text-red-400'
              : session.status === 'active'
                ? 'text-blue-400'
                : 'text-muted-foreground/40',
          )}>
            {session.status}
          </span>
          {session.repo && (
            <span className="text-[10px] text-muted-foreground/40 truncate">{session.repo}</span>
          )}
        </div>
        {session.model && (
          <p className="text-[10px] text-muted-foreground/40 mt-0.5">{session.model}</p>
        )}
      </div>
      <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {isConfirming ? (
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground mr-1">Delete?</span>
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteConfirm(session.id); }}
              className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
            >
              Yes
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteCancel(); }}
              className="px-1.5 py-0.5 text-[10px] rounded hover:bg-background/50"
            >
              No
            </button>
          </div>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteRequest(session.id); }}
            className="p-1 rounded hover:bg-background/50"
            title="Delete session"
          >
            <Trash2 className="h-3.5 w-3.5 text-red-400" />
          </button>
        )}
      </div>
    </div>
  );
}

export function HermesChatsPanel() {
  const { sessions, activeDetails, loading, error, fetchSessions, fetchActiveDetails, deleteSession } = useSessionsStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detailRequestRef = useRef(0);
  const [selectedSession, setSelectedSession] = useState<HermesSessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'chat' | 'tasks'>('chat');
  const [activeDetailsLoading, setActiveDetailsLoading] = useState(false);
  const [activeDetailsError, setActiveDetailsError] = useState<string | null>(null);
  const sessionChat = selectedSession?.chat ?? [];
  const selectedSessionId = useUIStore((s) => s.selectedSessionId);
  const setSelectedSessionId = useUIStore((s) => s.setSelectedSessionId);
  const viewMode = useUIStore((s) => s.hermesSessionViewMode);
  const setViewMode = useUIStore((s) => s.setHermesSessionViewMode);
  const activeSessions = sessions.filter((session) => session.status === 'active');
  const activeSessionIds = activeSessions.map((session) => session.id).join(',');

  const loadSessionDetail = useCallback(async (sessionId: string, silent = false) => {
    const requestId = ++detailRequestRef.current;
    if (!silent) {
      setDetailLoading(true);
    }

    try {
      const detail = await getSession(sessionId);
      if (requestId !== detailRequestRef.current) return;
      setSelectedSession(detail);
      setDetailError(null);
    } catch (err) {
      if (requestId !== detailRequestRef.current) return;
      setSelectedSession(null);
      setDetailError(err instanceof Error ? err.message : 'Failed to fetch session detail');
    } finally {
      if (!silent && requestId === detailRequestRef.current) {
        setDetailLoading(false);
      }
    }
  }, []);

  const loadActiveSessionDetails = useCallback(async (silent = false) => {
    if (!silent) {
      setActiveDetailsLoading(true);
    }

    try {
      await fetchActiveDetails();
      setActiveDetailsError(null);
    } catch (err) {
      setActiveDetailsError(err instanceof Error ? err.message : 'Failed to fetch active sessions');
    } finally {
      if (!silent) {
        setActiveDetailsLoading(false);
      }
    }
  }, [fetchActiveDetails]);

  useEffect(() => {
    void fetchSessions();

    // Auto-refresh every 10s
    intervalRef.current = setInterval(() => {
      void (async () => {
        await fetchSessions();
        if (viewMode === 'all-active') {
          await loadActiveSessionDetails(true);
        } else if (selectedSessionId) {
          await loadSessionDetail(selectedSessionId, true);
        }
      })();
    }, 10000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSessions, loadActiveSessionDetails, loadSessionDetail, selectedSessionId, viewMode]);

  useEffect(() => {
    if (!selectedSessionId) {
      detailRequestRef.current += 1;
      setSelectedSession(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    void loadSessionDetail(selectedSessionId);
  }, [loadSessionDetail, selectedSessionId]);

  useEffect(() => {
    if (viewMode !== 'all-active') return;
    void loadActiveSessionDetails();
  }, [loadActiveSessionDetails, viewMode]);

  useEffect(() => {
    if (viewMode !== 'all-active' || activeSessions.length === 0) return;
    void loadActiveSessionDetails(true);
  }, [activeSessionIds, activeSessions.length, loadActiveSessionDetails, viewMode]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const stillExists = sessions.some((session) => session.id === selectedSessionId);
    if (stillExists) return;
    detailRequestRef.current += 1;
    setSelectedSessionId(null);
    setSelectedSession(null);
    setDetailError(null);
    setDetailLoading(false);
  }, [selectedSessionId, sessions, setSelectedSessionId]);

  const handleSelect = (id: string) => {
    if (selectedSessionId === id) {
      detailRequestRef.current += 1;
      setDetailError(null);
      setDetailLoading(false);
      setSelectedSessionId(null);
      return;
    }

    setSelectedSessionId(id);
  };

  const handleDeleteConfirm = async (id: string) => {
    await deleteSession(id);
    setDeleteConfirmId(null);
    if (selectedSessionId === id) {
      detailRequestRef.current += 1;
      setSelectedSessionId(null);
      setSelectedSession(null);
      setDetailError(null);
      setDetailLoading(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide">Sessions</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              void (async () => {
                await fetchSessions();
                if (viewMode === 'all-active') {
                  await loadActiveSessionDetails();
                } else if (selectedSessionId) {
                  await loadSessionDetail(selectedSessionId);
                }
              })();
            }}
            className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={() => setViewMode(viewMode === 'all-active' ? 'focused' : 'all-active')}
            className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            {viewMode === 'all-active' ? 'Focused' : 'All Active'}
          </button>
        </div>
      </div>

      {/* Selected session info */}
      {viewMode === 'focused' && selectedSessionId && (
        <div className="mx-3 mb-2 p-2 rounded-lg bg-[hsl(var(--sidebar-active))] border border-border/30">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground truncate">
              Session {selectedSessionId.slice(0, 8)}
            </p>
            {selectedSession?.status && (
              <span className={cn(
                'text-[9px] uppercase tracking-wide',
                selectedSession.status === 'error'
                  ? 'text-red-400'
                  : selectedSession.status === 'active'
                    ? 'text-blue-400'
                    : 'text-muted-foreground/60',
              )}>
                {selectedSession.status}
              </span>
            )}
          </div>
          {selectedSession?.repo && (
            <p className="text-[10px] text-muted-foreground/50 mt-0.5 truncate">{selectedSession.repo}</p>
          )}
          {selectedSession?.error && !detailError && (
            <p className="text-[10px] text-red-400/90 mt-1 truncate">{selectedSession.error}</p>
          )}

          <div className="mt-2 flex items-center gap-2 border-b border-border/30 pb-2">
            <button
              onClick={() => setDetailTab('chat')}
              className={cn(
                'text-[10px] transition-colors',
                detailTab === 'chat' ? 'text-foreground' : 'text-muted-foreground/50 hover:text-muted-foreground',
              )}
            >
              Chat
            </button>
            <button
              onClick={() => setDetailTab('tasks')}
              className={cn(
                'text-[10px] transition-colors',
                detailTab === 'tasks' ? 'text-foreground' : 'text-muted-foreground/50 hover:text-muted-foreground',
              )}
            >
              Tasks
            </button>
          </div>

          <div className="mt-2 max-h-[260px] overflow-y-auto pr-1 space-y-1.5">
            {detailLoading ? (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading {detailTab}...
              </div>
            ) : detailError ? (
              <p className="text-[11px] text-red-400/90">{detailError}</p>
            ) : detailTab === 'tasks' ? (
              <TaskList tasks={selectedSession ? deriveTasks(selectedSession) : []} />
            ) : sessionChat.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/60">No chat transcript recorded for this session yet.</p>
            ) : (
              sessionChat
                .filter((message) => typeof message.content === 'string' && message.content.trim().length > 0)
                .map((message, index) => (
                  <div
                    key={`${selectedSessionId}-${index}-${message.role}`}
                    className={cn('rounded-md border px-2 py-1.5', roleClass(message.role))}
                  >
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground/60 mb-0.5">
                      {roleLabel(message.role)}
                    </p>
                    <p className="text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground/90">
                      {message.content}
                    </p>
                  </div>
                ))
            )}
          </div>
        </div>
      )}

      {viewMode === 'all-active' && (
        <div className="mx-3 mb-2 p-2 rounded-lg bg-[hsl(var(--sidebar-active))] border border-border/30">
          <div className="max-h-[320px] overflow-y-auto pr-1 space-y-2">
            {activeDetailsLoading ? (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading active tasks...
              </div>
            ) : activeDetailsError ? (
              <p className="text-[11px] text-red-400/90">{activeDetailsError}</p>
            ) : activeSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 px-4">
                <Zap className="h-8 w-8 text-muted-foreground/30 mb-2" />
                <p className="text-[12px] text-muted-foreground/50 text-center">No active sessions</p>
                <p className="text-[11px] text-muted-foreground/40 text-center mt-1">
                  Sessions appear when hermes processes requests
                </p>
              </div>
            ) : (
              activeSessions.map((session) => {
                const detail = activeDetails[session.id];
                return (
                  <div key={session.id} className="rounded-md border border-border/30 bg-background/40 px-2 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-medium text-foreground truncate">{sessionTitle(session)}</p>
                      <div className={cn('h-2 w-2 rounded-full flex-shrink-0', statusColor(session), session.status === 'active' && 'animate-pulse')} />
                    </div>
                    <p className="mt-0.5 text-[10px] text-muted-foreground/50 truncate">
                      Session {session.id.slice(0, 8)}
                    </p>
                    <div className="mt-2">
                      <TaskList tasks={detail ? deriveTasks(detail) : []} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-3 mb-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
          <span className="text-[11px] text-red-400">{error}</span>
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-1">
        {loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-[12px] text-muted-foreground/50">Loading...</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 px-4">
            <Zap className="h-8 w-8 text-muted-foreground/30 mb-2" />
            <p className="text-[12px] text-muted-foreground/50 text-center">No active sessions</p>
            <p className="text-[11px] text-muted-foreground/40 text-center mt-1">
              Sessions appear when hermes processes requests
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selectedId={selectedSessionId}
                onSelect={handleSelect}
                deleteConfirmId={deleteConfirmId}
                onDeleteRequest={setDeleteConfirmId}
                onDeleteConfirm={handleDeleteConfirm}
                onDeleteCancel={() => setDeleteConfirmId(null)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
