import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, Zap, AlertCircle, Loader2, ChevronRight } from 'lucide-react';
import { useSessionsStore, type HermesSession } from '@/stores/sessions-store';
import { useUIStore } from '@/stores/ui-store';
import { getSession, type HermesSessionDetail, type HermesSessionMessage } from '@/lib/hermes-api';
import { deriveTasks } from '@/lib/derive-tasks';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/relative-time';
import { countSessionStatuses } from './hermesSidebarUtils';
import { TaskList } from './TaskList';
import { ToolMessageAccordion } from '@/components/chat/ToolMessageAccordion';

const SIDEBAR_LONG_CONTENT_THRESHOLD = 600;

function statusColor(session: HermesSession): string {
  if (session.status === 'error') return 'bg-red-500';
  if (session.status === 'active') return 'bg-blue-500';
  if (session.messages > 0) return 'bg-emerald-500';
  return 'bg-muted-foreground/30';
}

function statusTextClass(status: string | undefined): string {
  if (status === 'error') return 'text-red-400';
  if (status === 'active') return 'text-blue-400';
  if (status === 'completed') return 'text-emerald-400';
  return 'text-muted-foreground/50';
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

interface SessionCardProps {
  session: HermesSession;
  isSelected: boolean;
  onSelect: (id: string) => void;
  deleteConfirmId: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel: () => void;
  detail: HermesSessionDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  detailTab: 'chat' | 'tasks';
  onTabChange: (tab: 'chat' | 'tasks') => void;
}

function SessionCard({
  session,
  isSelected,
  onSelect,
  deleteConfirmId,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  detail,
  detailLoading,
  detailError,
  detailTab,
  onTabChange,
}: SessionCardProps) {
  const isConfirming = deleteConfirmId === session.id;
  const title = sessionTitle(session);
  const chat = detail?.chat ?? [];

  return (
    <div
      className={cn(
        'group overflow-hidden rounded-lg border transition-colors',
        isSelected
          ? 'border-border/70 bg-background/60'
          : 'border-border/30 bg-background/30 hover:border-border/60 hover:bg-background/50',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(session.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(session.id); } }}
        className="flex w-full cursor-pointer items-start gap-2 px-2.5 py-2 text-left"
      >
        <div className="mt-1 flex-shrink-0">
          <div
            className={cn(
              'h-2 w-2 rounded-full',
              statusColor(session),
              session.status === 'active' && 'animate-pulse',
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate text-[12px] font-medium text-foreground">{title}</span>
            <ChevronRight
              className={cn(
                'h-3 w-3 text-muted-foreground/40 transition-transform',
                isSelected && 'rotate-90 text-muted-foreground/70',
              )}
            />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
            <span className={cn('uppercase tracking-[0.1em]', statusTextClass(session.status))}>
              {session.status}
            </span>
            <span className="text-muted-foreground/30">·</span>
            <span>{session.messages} msg</span>
            <span className="text-muted-foreground/30">·</span>
            <span>{relativeTime(session.created_at)}</span>
          </div>
          {(session.repo || session.model) && (
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground/40">
              {session.model}
              {session.model && session.repo && ' · '}
              {session.repo}
            </div>
          )}
        </div>
        <div className="flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
          {isConfirming ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <span className="mr-0.5 text-[10px] text-muted-foreground">Delete?</span>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteConfirm(session.id); }}
                className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-500/30"
              >
                Yes
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteCancel(); }}
                className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-background/50"
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDeleteRequest(session.id); }}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground/60 hover:bg-red-500/10 hover:text-red-400"
              title="Delete session"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {isSelected && (
        <div className="border-t border-border/40 bg-background/30">
          <div className="flex items-center gap-3 border-b border-border/30 px-2.5 py-1.5">
            <button
              onClick={() => onTabChange('chat')}
              className={cn(
                'text-[10px] uppercase tracking-[0.12em] transition-colors',
                detailTab === 'chat' ? 'text-foreground' : 'text-muted-foreground/50 hover:text-muted-foreground',
              )}
            >
              Chat
            </button>
            <button
              onClick={() => onTabChange('tasks')}
              className={cn(
                'text-[10px] uppercase tracking-[0.12em] transition-colors',
                detailTab === 'tasks' ? 'text-foreground' : 'text-muted-foreground/50 hover:text-muted-foreground',
              )}
            >
              Tasks
            </button>
          </div>

          <div className="max-h-[260px] space-y-1.5 overflow-y-auto px-2.5 py-2">
            {detailLoading ? (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading {detailTab}...
              </div>
            ) : detailError ? (
              <p className="text-[11px] text-red-400/90">{detailError}</p>
            ) : detailTab === 'tasks' ? (
              <TaskList tasks={detail ? deriveTasks(detail) : []} />
            ) : chat.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/60">No chat transcript recorded yet.</p>
            ) : (
              chat
                .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
                .map((message, index) => {
                  const key = `${session.id}-${index}-${message.role}`;

                  if (message.role === 'tool') {
                    return (
                      <ToolMessageAccordion
                        key={key}
                        content={message.content}
                        label="TOOL RESULT"
                        tone="amber"
                      />
                    );
                  }

                  if (message.role === 'system' && message.content.length > SIDEBAR_LONG_CONTENT_THRESHOLD) {
                    return (
                      <ToolMessageAccordion
                        key={key}
                        content={message.content}
                        label="SYSTEM PROMPT"
                        tone="violet"
                      />
                    );
                  }

                  return (
                    <div
                      key={key}
                      className={cn('rounded-md border px-2 py-1.5', roleClass(message.role))}
                    >
                      <p className="mb-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">
                        {roleLabel(message.role)}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/90">
                        {message.content}
                      </p>
                    </div>
                  );
                })
            )}
          </div>
        </div>
      )}
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
  const selectedSessionId = useUIStore((s) => s.selectedSessionId);
  const setSelectedSessionId = useUIStore((s) => s.setSelectedSessionId);
  const viewMode = useUIStore((s) => s.hermesSessionViewMode);
  const setViewMode = useUIStore((s) => s.setHermesSessionViewMode);
  const statusCounts = countSessionStatuses(sessions);
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

  const handleRefresh = () => {
    void (async () => {
      await fetchSessions();
      if (viewMode === 'all-active') {
        await loadActiveSessionDetails();
      } else if (selectedSessionId) {
        await loadSessionDetail(selectedSessionId);
      }
    })();
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Sessions</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            className="rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground/50 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          >
            Refresh
          </button>
          <button
            onClick={() => setViewMode(viewMode === 'all-active' ? 'focused' : 'all-active')}
            className={cn(
              'rounded-md px-1.5 py-0.5 text-[10px] transition-colors',
              viewMode === 'all-active'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground/50 hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground',
            )}
          >
            All Active
          </button>
        </div>
      </div>

      {/* Status counts */}
      {statusCounts.total > 0 && (
        <div className="flex items-center gap-1.5 px-3 pb-2 text-[10px]">
          {statusCounts.active > 0 && (
            <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 text-blue-400">
              {statusCounts.active} active
            </span>
          )}
          {statusCounts.completed > 0 && (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-emerald-400">
              {statusCounts.completed} done
            </span>
          )}
          {statusCounts.error > 0 && (
            <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-red-400">
              {statusCounts.error} error
            </span>
          )}
          <span className="ml-auto text-muted-foreground/40">{statusCounts.total} total</span>
        </div>
      )}

      {/* All-active view */}
      {viewMode === 'all-active' && (
        <div className="mx-3 mb-2 rounded-xl border border-border/40 bg-background/40 p-2">
          <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
            {activeDetailsLoading ? (
              <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] text-muted-foreground/60">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading active tasks...
              </div>
            ) : activeDetailsError ? (
              <p className="px-1 text-[11px] text-red-400/90">{activeDetailsError}</p>
            ) : activeSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-6">
                <Zap className="mb-2 h-7 w-7 text-muted-foreground/30" />
                <p className="text-center text-[11px] text-muted-foreground/50">No active sessions</p>
              </div>
            ) : (
              activeSessions.map((session) => {
                const detail = activeDetails[session.id];
                return (
                  <div key={session.id} className="rounded-md border border-border/30 bg-background/50 px-2 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-[11px] font-medium text-foreground">{sessionTitle(session)}</p>
                      <div className={cn('h-2 w-2 flex-shrink-0 rounded-full', statusColor(session), session.status === 'active' && 'animate-pulse')} />
                    </div>
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground/50">
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
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-400" />
          <span className="text-[11px] text-red-400">{error}</span>
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin text-muted-foreground/60" />
            <span className="text-[11px] text-muted-foreground/60">Loading...</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-8">
            <Zap className="mb-2 h-7 w-7 text-muted-foreground/30" />
            <p className="text-center text-[11px] text-muted-foreground/50">No sessions yet</p>
            <p className="mt-1 text-center text-[10px] text-muted-foreground/40">
              Sessions appear when Hermes processes requests
            </p>
          </div>
        ) : (
          sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              isSelected={selectedSessionId === session.id}
              onSelect={handleSelect}
              deleteConfirmId={deleteConfirmId}
              onDeleteRequest={setDeleteConfirmId}
              onDeleteConfirm={handleDeleteConfirm}
              onDeleteCancel={() => setDeleteConfirmId(null)}
              detail={selectedSessionId === session.id ? selectedSession : null}
              detailLoading={selectedSessionId === session.id ? detailLoading : false}
              detailError={selectedSessionId === session.id ? detailError : null}
              detailTab={detailTab}
              onTabChange={setDetailTab}
            />
          ))
        )}
      </div>
    </div>
  );
}
