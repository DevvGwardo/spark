// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createCronArchiveStore } from '../cron-archive-store';

describe('cron-archive store', () => {
  it('archives, lists, and restores jobs', () => {
    const store = createCronArchiveStore(':memory:');
    expect(store.list()).toEqual([]);

    const entry = store.archive('job-1', '2026-06-10T07:00:00.000Z');
    expect(entry).toEqual({ jobId: 'job-1', archivedAt: '2026-06-10T07:00:00.000Z' });
    expect(store.list()).toHaveLength(1);

    store.restore('job-1');
    expect(store.list()).toEqual([]);
    store.close();
  });

  it('is idempotent — re-archiving keeps the original timestamp', () => {
    const store = createCronArchiveStore(':memory:');
    store.archive('job-2', '2026-06-10T07:00:00.000Z');
    const second = store.archive('job-2', '2026-06-11T09:30:00.000Z');
    expect(second.archivedAt).toBe('2026-06-10T07:00:00.000Z');
    expect(store.list()).toHaveLength(1);
    store.close();
  });
});
