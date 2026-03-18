import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActivityStore } from '@/stores/activity-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { handleServerToolEvent, REPO_FILE_READ, REPO_FILE_EDIT, REPO_FILE_CREATE } from '@/lib/server-tool-events';

describe('debug isolation outer', () => {
  beforeEach(() => {
    useChangesetStore.setState({ panelChangesets: {} });
    useActivityStore.setState({ activities: {} });
    vi.clearAllMocks();
  });

  describe('repo_file_read', () => {
    it('caches file and does NOT call addChange', () => {
      const spy = vi.spyOn(useActivityStore.getState(), 'addLineStats').mockImplementation(() => {});
      
      const opts = {
        conversationId: 'conv-123',
        addChange: vi.fn(),
      };
      const event = {
        type: REPO_FILE_READ,
        path: 'src/app.ts',
        content: 'console.log("hello");',
      };

      handleServerToolEvent(event, 'test-panel', opts);
      
      expect(opts.addChange).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not call addLineStats even with conversationId', () => {
      const spy = vi.spyOn(useActivityStore.getState(), 'addLineStats').mockImplementation(() => {});
      
      const opts = {
        conversationId: 'conv-123',
        addChange: vi.fn(),
      };
      const event = {
        type: REPO_FILE_READ,
        path: 'src/app.ts',
        content: 'console.log("hello");',
      };

      handleServerToolEvent(event, 'test-panel', opts);
      
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('repo_file_edit', () => {
    it('calls addLineStats', () => {
      const spy = vi.spyOn(useActivityStore.getState(), 'addLineStats').mockImplementation(() => {});
      
      const opts = {
        conversationId: 'conv-123',
        addChange: vi.fn(),
      };
      const event = {
        type: REPO_FILE_EDIT,
        path: 'src/app.ts',
        content: 'console.log("world");',
        originalContent: 'console.log("hello");',
        description: 'Update log message',
      };

      handleServerToolEvent(event, 'test-panel', opts);
      
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('conv-123', 1, 1);
    });

    it('does NOT call addLineStats with null conversationId', () => {
      const spy = vi.spyOn(useActivityStore.getState(), 'addLineStats').mockImplementation(() => {});
      
      const opts = {
        conversationId: null,
        addChange: vi.fn(),
      };
      const event = {
        type: REPO_FILE_EDIT,
        path: 'src/app.ts',
        content: 'console.log("world");',
        originalContent: 'console.log("hello");',
        description: 'Update log message',
      };

      handleServerToolEvent(event, 'test-panel', opts);
      
      expect(opts.addChange).toHaveBeenCalledTimes(1);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
