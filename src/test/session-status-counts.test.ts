import { describe, expect, it } from 'vitest';
import { countSessionStatuses } from '@/components/sidebar/hermesSidebarUtils';
import type { HermesSession } from '@/lib/hermes-api';

function makeSession(status: HermesSession['status']): Pick<HermesSession, 'status'> {
  return { status };
}

describe('countSessionStatuses', () => {
  it('tallies each known status and the total', () => {
    const counts = countSessionStatuses([
      makeSession('active'),
      makeSession('active'),
      makeSession('completed'),
      makeSession('error'),
    ]);
    expect(counts).toEqual({ active: 2, completed: 1, error: 1, total: 4 });
  });

  it('folds unknown statuses into total only', () => {
    const counts = countSessionStatuses([
      makeSession('active'),
      makeSession('queued'),
      makeSession('cancelled'),
    ]);
    expect(counts).toEqual({ active: 1, completed: 0, error: 0, total: 3 });
  });

  it('returns all-zero for an empty list', () => {
    expect(countSessionStatuses([])).toEqual({ active: 0, completed: 0, error: 0, total: 0 });
  });
});
