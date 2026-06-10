import { describe, expect, it } from 'vitest';
import { nextRuns, parseCron } from '@/lib/cron-next';

describe('cron-next evaluator', () => {
  it('parses standard fields and rejects malformed expressions', () => {
    expect(parseCron('0 7 * * 1-5')).not.toBeNull();
    expect(parseCron('*/15 * * * *')).not.toBeNull();
    expect(parseCron('bad expr')).toBeNull();
    expect(parseCron('0 7 * *')).toBeNull(); // only 4 fields
    expect(parseCron('99 * * * *')).toBeNull(); // out of range
  });

  it('computes weekday 7AM runs (0 7 * * 1-5)', () => {
    // Sunday 2026-06-07T00:00 local — next runs should be Mon→Fri at 07:00.
    const from = new Date(2026, 5, 7, 0, 0, 0);
    const runs = nextRuns('0 7 * * 1-5', 5, from);
    expect(runs).toHaveLength(5);
    expect(runs[0].getHours()).toBe(7);
    expect(runs[0].getDay()).toBe(1); // Monday
    expect(runs[4].getDay()).toBe(5); // Friday
    expect(runs.every((d) => d.getMinutes() === 0)).toBe(true);
  });

  it('computes every-15-minute runs', () => {
    const from = new Date(2026, 5, 10, 9, 2, 0);
    const runs = nextRuns('*/15 * * * *', 3, from);
    expect(runs.map((d) => d.getMinutes())).toEqual([15, 30, 45]);
  });

  it('returns empty for unparseable schedules', () => {
    expect(nextRuns('not a cron', 5, new Date())).toEqual([]);
  });
});
