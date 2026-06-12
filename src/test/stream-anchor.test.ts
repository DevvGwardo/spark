import { beforeEach, describe, expect, it } from 'vitest';
import { useActivityStore } from '@/stores/activity-store';

describe('stream anchors (elapsed-timer persistence across panel remount)', () => {
  beforeEach(() => {
    useActivityStore.setState({ backgroundRuns: {}, streamAnchors: {} });
  });

  it('persists the anchor independently of per-panel activity state', () => {
    const store = useActivityStore.getState();
    store.markStreamAnchor('conv-1', 1000);
    // Simulate the panel closing: streaming flag cleared, anchor untouched.
    store.setStreaming('conv-1', false);
    store.clearActivity('conv-1');
    expect(useActivityStore.getState().streamAnchors['conv-1']).toBe(1000);
  });

  it('clearStreamAnchor removes only the targeted conversation', () => {
    const store = useActivityStore.getState();
    store.markStreamAnchor('conv-1', 1000);
    store.markStreamAnchor('conv-2', 2000);
    store.clearStreamAnchor('conv-1');
    expect(useActivityStore.getState().streamAnchors).toEqual({ 'conv-2': 2000 });
  });

  it('a new stream start overwrites a stale anchor', () => {
    const store = useActivityStore.getState();
    store.markStreamAnchor('conv-1', 1000);
    store.markStreamAnchor('conv-1', 5000);
    expect(useActivityStore.getState().streamAnchors['conv-1']).toBe(5000);
  });
});
