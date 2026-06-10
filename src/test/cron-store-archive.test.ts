import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hermes-api', () => ({
  fetchCronJobs: vi.fn(),
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn().mockResolvedValue(undefined),
  pauseCronJob: vi.fn((id: string) => Promise.resolve({ id, status: 'paused' })),
  resumeCronJob: vi.fn((id: string) => Promise.resolve({ id, status: 'active' })),
  runCronJob: vi.fn(),
  fetchCronRunHistory: vi.fn(),
}));

vi.mock('@/lib/cron-archive-api', () => ({
  fetchArchivedJobIds: vi.fn().mockResolvedValue([]),
  archiveJobOnServer: vi.fn((jobId: string) => Promise.resolve({ jobId, archivedAt: '2026-06-10T00:00:00Z' })),
  restoreJobOnServer: vi.fn().mockResolvedValue(undefined),
}));

import { useCronStore } from '@/stores/cron-store';
import { pauseCronJob, resumeCronJob } from '@/lib/hermes-api';
import { archiveJobOnServer, restoreJobOnServer } from '@/lib/cron-archive-api';

const seedJob = { id: 'job-1', name: 'Nightly sync', schedule: '0 0 * * *', prompt: 'sync', status: 'active', created_at: '2026-06-10T00:00:00Z' } as never;

describe('cron-store archive', () => {
  beforeEach(() => {
    useCronStore.setState({ jobs: [seedJob], archivedIds: [] });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('archive records on the CloudChat server and pauses the job on Hermes', async () => {
    await useCronStore.getState().archiveJob('job-1');
    expect(archiveJobOnServer).toHaveBeenCalledWith('job-1');
    expect(pauseCronJob).toHaveBeenCalledWith('job-1');
    expect(useCronStore.getState().archivedIds).toContain('job-1');
    expect(useCronStore.getState().jobs[0].status).toBe('paused');
  });

  it('restore clears the server archive and resumes the job', async () => {
    useCronStore.setState({ archivedIds: ['job-1'] });
    await useCronStore.getState().restoreJob('job-1');
    expect(restoreJobOnServer).toHaveBeenCalledWith('job-1');
    expect(resumeCronJob).toHaveBeenCalledWith('job-1');
    expect(useCronStore.getState().archivedIds).not.toContain('job-1');
    expect(useCronStore.getState().jobs[0].status).toBe('active');
  });

  it('deleting an archived job drops its archived tag', async () => {
    useCronStore.setState({ archivedIds: ['job-1'] });
    await useCronStore.getState().deleteJob('job-1');
    expect(useCronStore.getState().archivedIds).not.toContain('job-1');
    expect(useCronStore.getState().jobs).toHaveLength(0);
  });
});
