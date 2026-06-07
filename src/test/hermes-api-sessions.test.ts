import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSessions } from '@/lib/hermes-api';

function mockJsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('hermes sessions api (pagination)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards limit/offset/q as query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ sessions: [], total: 0, counts: { active: 0, completed: 0, error: 0, total: 0 } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessions({ limit: 50, offset: 100, q: 'refactor' });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/sessions?');
    expect(url).toContain('limit=50');
    expect(url).toContain('offset=100');
    expect(url).toContain('q=refactor');
  });

  it('omits the query string entirely when no params are given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ sessions: [], total: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessions();

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('?');
  });

  it('returns the page plus server total and counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        sessions: [{ id: 'a' }, { id: 'b' }],
        total: 12171,
        counts: { active: 3, completed: 12000, error: 168, total: 12171 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchSessions({ limit: 50 });

    expect(page.sessions).toHaveLength(2);
    expect(page.total).toBe(12171);
    expect(page.counts).toEqual({ active: 3, completed: 12000, error: 168, total: 12171 });
  });

  it('falls back gracefully when the server omits total/counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ sessions: [{ id: 'a' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchSessions();

    expect(page.total).toBe(1);
    expect(page.counts.total).toBe(1);
    expect(page.counts.active).toBe(0);
  });

  it('drops a blank query rather than sending q=', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ sessions: [], total: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessions({ q: '   ' });

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('q=');
  });
});
