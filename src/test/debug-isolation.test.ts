import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChangesetStore } from '@/stores/changeset-store';
import { handleServerToolEvent, REPO_FILE_READ, REPO_FILE_EDIT } from '@/lib/server-tool-events';

describe('debug isolation outer', () => {
  beforeEach(() => {
    useChangesetStore.setState({ panelChangesets: {} });
    vi.clearAllMocks();
  });

  describe('repo_file_read', () => {
    it('caches file and does NOT call addChange', () => {
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
    });
  });

  describe('repo_file_edit', () => {
    it('calls addChange with correct parameters', () => {
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

      expect(opts.addChange).toHaveBeenCalledTimes(1);
      expect(opts.addChange).toHaveBeenCalledWith({
        path: 'src/app.ts',
        action: 'edit',
        content: 'console.log("world");',
        originalContent: 'console.log("hello");',
        staged: true,
      });
    });

    it('calls addChange even with null conversationId', () => {
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
    });
  });
});
