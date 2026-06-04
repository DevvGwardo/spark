import { describe, expect, it } from 'vitest';
import { filterSessions } from '@/components/sidebar/hermesSidebarUtils';
import type { HermesSession } from '@/lib/hermes-api';

function makeSession(overrides: Partial<HermesSession>): HermesSession {
  return {
    id: 'sess-000',
    created_at: '2026-06-03T00:00:00Z',
    updated_at: null,
    messages: 0,
    model: 'claude-opus-4-8',
    status: 'completed',
    toolsets: [],
    repo: null,
    firstUserMessage: '',
    ...overrides,
  };
}

const sessions: HermesSession[] = [
  makeSession({ id: 'abc123', firstUserMessage: 'Refactor the auth module', repo: 'cloud-chat-hub' }),
  makeSession({ id: 'def456', firstUserMessage: 'Write release notes', repo: 'spark-landing', model: 'claude-sonnet-4-6' }),
  makeSession({ id: 'ghi789', firstUserMessage: 'Fix the flaky test' }),
];

describe('filterSessions', () => {
  it('returns all sessions for an empty or whitespace-only query', () => {
    expect(filterSessions(sessions, '')).toHaveLength(3);
    expect(filterSessions(sessions, '   ')).toHaveLength(3);
  });

  it('matches the session title case-insensitively', () => {
    const result = filterSessions(sessions, 'REFACTOR');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('abc123');
  });

  it('matches by id', () => {
    const result = filterSessions(sessions, 'def456');
    expect(result.map((s) => s.id)).toEqual(['def456']);
  });

  it('matches by repo', () => {
    const result = filterSessions(sessions, 'spark-landing');
    expect(result.map((s) => s.id)).toEqual(['def456']);
  });

  it('matches by model', () => {
    const result = filterSessions(sessions, 'sonnet');
    expect(result.map((s) => s.id)).toEqual(['def456']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterSessions(sessions, 'nonexistent-needle')).toEqual([]);
  });
});
