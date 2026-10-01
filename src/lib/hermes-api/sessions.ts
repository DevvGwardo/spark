import { hermesFetch } from './core';

export interface HermesSession {
  id: string;
  created_at: string;
  updated_at: string | null;
  messages: number;
  model: string;
  status: 'active' | 'completed' | 'error' | string;
  toolsets: string[];
  repo: string | null;
  firstUserMessage: string;
}

export interface HermesSessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content?: string;
  parts?: any[];
}

export interface HermesSessionDetail extends HermesSession {
  chat?: HermesSessionMessage[];
  error?: string | null;
  source?: string | null;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export interface SessionStatusCounts {
  active: number;
  completed: number;
  error: number;
  total: number;
}

export interface SessionsPage {
  sessions: HermesSession[];
  /** Total sessions matching the query, before pagination. */
  total: number;
  /** Aggregate status counts over the full matching set. */
  counts: SessionStatusCounts;
}

export interface FetchSessionsParams {
  limit?: number;
  offset?: number;
  q?: string;
}

export async function fetchSessions(params: FetchSessionsParams = {}): Promise<SessionsPage> {
  const search = new URLSearchParams();
  if (params.limit != null) search.set('limit', String(params.limit));
  if (params.offset != null) search.set('offset', String(params.offset));
  if (params.q && params.q.trim()) search.set('q', params.q.trim());
  const suffix = search.toString() ? `?${search.toString()}` : '';

  const data = await hermesFetch<{
    sessions?: HermesSession[];
    total?: number;
    counts?: Partial<SessionStatusCounts>;
  }>(`/sessions${suffix}`);

  const sessions = data.sessions ?? [];
  return {
    sessions,
    total: data.total ?? sessions.length,
    counts: {
      active: data.counts?.active ?? 0,
      completed: data.counts?.completed ?? 0,
      error: data.counts?.error ?? 0,
      total: data.counts?.total ?? data.total ?? sessions.length,
    },
  };
}

// Coalesce concurrent requests for the same session. The sidebar
// HermesChatsPanel and the main-area SessionHistoryChat both key off the same
// selectedSessionId and each fetch the detail on select — without this they
// fire two identical round-trips. Cleared the moment the request settles, so a
// later poll still gets fresh data (we dedupe duplicates, we don't cache).
const inflightSessionDetail = new Map<string, Promise<HermesSessionDetail>>();

export function getSession(sessionId: string): Promise<HermesSessionDetail> {
  const existing = inflightSessionDetail.get(sessionId);
  if (existing) return existing;

  const request = hermesFetch<HermesSessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`)
    .finally(() => {
      inflightSessionDetail.delete(sessionId);
    });
  inflightSessionDetail.set(sessionId, request);
  return request;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await hermesFetch(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

/** Resolve a Hermes session for `/resume` — exact id, prefix match, or most recent. */
export async function resolveHermesSessionForResume(spec?: string): Promise<HermesSessionDetail> {
  const trimmed = spec?.trim() ?? '';
  if (trimmed) {
    try {
      return await getSession(trimmed);
    } catch {
      const { sessions } = await fetchSessions({ limit: 50, q: trimmed });
      const match =
        sessions.find((s) => s.id === trimmed) ??
        sessions.find((s) => s.id.startsWith(trimmed));
      if (!match) {
        throw new Error(`No Hermes session found matching "${trimmed}"`);
      }
      return getSession(match.id);
    }
  }

  const { sessions } = await fetchSessions({ limit: 1 });
  const recent = sessions[0];
  if (!recent) {
    throw new Error('No Hermes sessions available to resume.');
  }
  return getSession(recent.id);
}

export function hermesSessionTitle(session: Pick<HermesSession, 'id' | 'firstUserMessage'>): string {
  return session.firstUserMessage?.trim().length
    ? session.firstUserMessage.trim()
    : `Session ${session.id.slice(0, 8)}`;
}

export interface ForkHermesSessionResult {
  object: string;
  session: HermesSession & {
    parent_session_id?: string;
    title?: string;
  };
}

export async function forkHermesSession(
  sessionId: string,
  options?: { title?: string },
): Promise<ForkHermesSessionResult> {
  const body: Record<string, string> = {};
  const title = options?.title?.trim();
  if (title) body.title = title;
  return hermesFetch<ForkHermesSessionResult>(
    `/sessions/${encodeURIComponent(sessionId)}/fork`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}
