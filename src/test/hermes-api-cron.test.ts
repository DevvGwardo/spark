import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronJob, fetchCronJobs } from '@/lib/hermes-api';

function mockJsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('hermes cron api', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards conversation_id when fetching cron jobs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ jobs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchCronJobs('conv-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/hermes/cron?conversation_id=conv-123');
  });

  it('includes conversation metadata when creating cron jobs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({
      job: { id: 'job-1', name: 'Daily', schedule: '0 9 * * *', prompt: 'test', status: 'active', created_at: '2026-04-10T09:00:00Z' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await createCronJob('0 9 * * *', 'Summarize updates', 'Daily', {
      conversationId: 'conv-123',
      conversationTitle: 'Bug triage',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body));
    expect(payload.conversation_id).toBe('conv-123');
    expect(payload.conversation_title).toBe('Bug triage');
  });
});
