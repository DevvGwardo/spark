import { describe, expect, it } from 'vitest';
import { summarizeCronRuns } from '@/components/sidebar/hermesSidebarUtils';
import type { CronRun } from '@/lib/hermes-api';

function run(status: CronRun['status']): Pick<CronRun, 'status'> {
  return { status };
}

describe('summarizeCronRuns', () => {
  it('counts succeeded/failed and computes a 0–1 success rate from a mixed list', () => {
    const summary = summarizeCronRuns([
      run('success'),
      run('success'),
      run('success'),
      run('error'),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.successRate).toBeCloseTo(0.75);
  });

  it('excludes running runs from the success rate but counts them in total', () => {
    const summary = summarizeCronRuns([run('success'), run('error'), run('running')]);
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.successRate).toBeCloseTo(0.5);
  });

  it('returns a zeroed summary with rate 0 for an empty list', () => {
    expect(summarizeCronRuns([])).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      successRate: 0,
    });
  });
});
