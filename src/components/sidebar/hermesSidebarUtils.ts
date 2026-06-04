import type { HermesSession } from '@/lib/hermes-api';

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(value);
}

type FilterableSession = Pick<
  HermesSession,
  'id' | 'model' | 'repo' | 'firstUserMessage'
>;

// Case-insensitive substring filter over a session's title/id/repo/model.
// An empty (or whitespace-only) query returns every session unchanged.
export function filterSessions<T extends FilterableSession>(
  sessions: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) =>
    [session.firstUserMessage, session.id, session.repo, session.model]
      .some((field) => field?.toLowerCase().includes(needle)),
  );
}
