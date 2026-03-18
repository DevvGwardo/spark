import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActivityStore } from '@/stores/activity-store';

describe('vitest spy isolation test', () => {
  beforeEach(() => {
    useActivityStore.setState({ activities: {} });
    vi.clearAllMocks();
  });

  it('first test - spy gets called', () => {
    const spy = vi.spyOn(useActivityStore.getState(), 'addLineStats').mockImplementation(() => {});
    useActivityStore.getState().addLineStats('conv-123', 1, 1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('second test - spy should not see previous call', () => {
    const spy = vi.spyOn(useActivityStore.getState(), 'addLineStats').mockImplementation(() => {});
    // Not calling anything
    expect(spy).not.toHaveBeenCalled();
  });
});
