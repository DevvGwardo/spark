import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the stores before importing the module under test
const mockCacheRepoFile = vi.fn();

vi.mock('@/stores/changeset-store', () => ({
  useChangesetStore: {
    getState: () => ({
      cacheRepoFile: mockCacheRepoFile,
    }),
    setState: vi.fn(),
  },
}));

// Import the module under test after mocks are set up
import {
  SERVER_TOOL_EVENT_TYPES,
  SERVER_EXECUTED_REPO_TOOLS,
  handleServerToolEvent,
  REPO_FILE_READ,
  REPO_FILE_EDIT,
  REPO_FILE_CREATE,
  REPO_FILE_DELETE,
  REPO_BATCH_EDIT,
  REPO_PROPOSAL,
} from '@/lib/server-tool-events';
import type {
  RepoFileReadEvent,
  RepoFileEditEvent,
  RepoFileCreateEvent,
  RepoFileDeleteEvent,
  RepoBatchEditEvent,
  RepoProposalEvent,
} from '@/lib/server-tool-events';

describe('server-tool-events', () => {
  beforeEach(() => {
    mockCacheRepoFile.mockClear();
  });

  describe('constants', () => {
    it('SERVER_TOOL_EVENT_TYPES contains exactly the 6 expected event types', () => {
      const expectedTypes: Array<typeof REPO_FILE_READ | typeof REPO_FILE_EDIT | typeof REPO_FILE_CREATE | typeof REPO_FILE_DELETE | typeof REPO_BATCH_EDIT | typeof REPO_PROPOSAL> = [
        'repo_file_read',
        'repo_file_edit',
        'repo_file_create',
        'repo_file_delete',
        'repo_batch_edit',
        'repo_proposal',
      ];
      expect(SERVER_TOOL_EVENT_TYPES.size).toBe(6);
      for (const type of expectedTypes) {
        expect(SERVER_TOOL_EVENT_TYPES.has(type)).toBe(true);
      }
    });

    it('SERVER_EXECUTED_REPO_TOOLS contains exactly the 6 expected tool names', () => {
      const expectedTools = [
        'read_repo_file',
        'edit_repo_file',
        'create_repo_file',
        'delete_repo_file',
        'batch_edit_repo_files',
        'propose_changes',
      ];
      expect(SERVER_EXECUTED_REPO_TOOLS.size).toBe(6);
      for (const tool of expectedTools) {
        expect(SERVER_EXECUTED_REPO_TOOLS.has(tool)).toBe(true);
      }
    });
  });

  describe('handleServerToolEvent', () => {
    const scopeId = 'test-panel';
    const conversationId = 'conv-123';

    function createMockOpts(overrides: { conversationId?: string | null } = {}) {
      return {
        conversationId: 'conversationId' in overrides ? overrides.conversationId! : conversationId,
        addChange: vi.fn(),
      };
    }

    describe('repo_file_read', () => {
      it('caches the file in changeset store and does NOT call addChange', () => {
        const opts = createMockOpts();
        const event: RepoFileReadEvent = {
          type: REPO_FILE_READ,
          path: 'src/app.ts',
          content: 'console.log("hello");',
        };

        handleServerToolEvent(event, scopeId, opts);

        expect(mockCacheRepoFile).toHaveBeenCalledTimes(1);
        expect(mockCacheRepoFile).toHaveBeenCalledWith(scopeId, 'src/app.ts', 'console.log("hello");');
        expect(opts.addChange).not.toHaveBeenCalled();
      });
    });

    describe('repo_file_edit', () => {
      it('caches originalContent and calls addChange with action=edit and staged=true', () => {
        const opts = createMockOpts();
        const event: RepoFileEditEvent = {
          type: REPO_FILE_EDIT,
          path: 'src/app.ts',
          content: 'console.log("world");',
          originalContent: 'console.log("hello");',
          description: 'Update log message',
        };

        handleServerToolEvent(event, scopeId, opts);

        expect(mockCacheRepoFile).toHaveBeenCalledTimes(1);
        expect(mockCacheRepoFile).toHaveBeenCalledWith(scopeId, 'src/app.ts', 'console.log("hello");');

        expect(opts.addChange).toHaveBeenCalledTimes(1);
        expect(opts.addChange).toHaveBeenCalledWith({
          path: 'src/app.ts',
          action: 'edit',
          content: 'console.log("world");',
          originalContent: 'console.log("hello");',
          staged: true,
        });
      });

      it('calls addChange even when conversationId is null', () => {
        const opts = createMockOpts({ conversationId: null });
        const event: RepoFileEditEvent = {
          type: REPO_FILE_EDIT,
          path: 'src/app.ts',
          content: 'console.log("world");',
          originalContent: 'console.log("hello");',
          description: 'Update log message',
        };

        handleServerToolEvent(event, scopeId, opts);

        expect(opts.addChange).toHaveBeenCalledTimes(1);
      });
    });

    describe('repo_file_create', () => {
      it('calls addChange with action=create and staged=true', () => {
        const opts = createMockOpts();
        const event: RepoFileCreateEvent = {
          type: REPO_FILE_CREATE,
          path: 'src/new.ts',
          content: 'export const foo = 1;\nexport const bar = 2;',
          description: 'Create new file',
        };

        handleServerToolEvent(event, scopeId, opts);

        expect(opts.addChange).toHaveBeenCalledTimes(1);
        expect(opts.addChange).toHaveBeenCalledWith({
          path: 'src/new.ts',
          action: 'create',
          content: 'export const foo = 1;\nexport const bar = 2;',
          staged: true,
        });
      });

      it('calls addChange even when conversationId is null', () => {
        const opts = createMockOpts({ conversationId: null });
        const event: RepoFileCreateEvent = {
          type: REPO_FILE_CREATE,
          path: 'src/new.ts',
          content: 'export const foo = 1;',
          description: 'Create new file',
        };

        handleServerToolEvent(event, scopeId, opts);

        expect(opts.addChange).toHaveBeenCalledTimes(1);
      });
    });

    describe('repo_file_delete', () => {
      it('caches originalContent and calls addChange with action=delete, content="", staged=true', () => {
        const opts = createMockOpts();
        const event: RepoFileDeleteEvent = {
          type: REPO_FILE_DELETE,
          path: 'src/old.ts',
          originalContent: 'line1\nline2\nline3',
          reason: 'File no longer needed',
        };

        handleServerToolEvent(event, scopeId, opts);

        expect(mockCacheRepoFile).toHaveBeenCalledTimes(1);
        expect(mockCacheRepoFile).toHaveBeenCalledWith(scopeId, 'src/old.ts', 'line1\nline2\nline3');

        expect(opts.addChange).toHaveBeenCalledTimes(1);
        expect(opts.addChange).toHaveBeenCalledWith({
          path: 'src/old.ts',
          action: 'delete',
          content: '',
          originalContent: 'line1\nline2\nline3',
          staged: true,
        });
      });

      it('calls addChange even when conversationId is null', () => {
        const opts = createMockOpts({ conversationId: null });
        const event: RepoFileDeleteEvent = {
          type: REPO_FILE_DELETE,
          path: 'src/old.ts',
          originalContent: 'line1\nline2',
          reason: 'File no longer needed',
        };

        handleServerToolEvent(event, scopeId, opts);

        expect(opts.addChange).toHaveBeenCalledTimes(1);
      });
    });

    describe('repo_batch_edit', () => {
      it('processes multiple changes, caches non-create originals, calls addChange for each', () => {
        const opts = createMockOpts();
        const event: RepoBatchEditEvent = {
          type: REPO_BATCH_EDIT,
          changes: [
            {
              path: 'src/create.ts',
              action: 'create',
              content: 'new line 1\nnew line 2',
              originalContent: '',
              description: 'Create file',
            },
            {
              path: 'src/edit.ts',
              action: 'edit',
              content: 'updated line',
              originalContent: 'original line 1\noriginal line 2',
              description: 'Edit file',
            },
            {
              path: 'src/delete.ts',
              action: 'delete',
              content: '',
              originalContent: 'delete line 1\ndelete line 2\ndelete line 3',
              description: 'Delete file',
            },
          ],
        };

        handleServerToolEvent(event, scopeId, opts);

        // cacheRepoFile is called for edit and delete, but NOT create
        expect(mockCacheRepoFile).toHaveBeenCalledTimes(2);
        expect(mockCacheRepoFile).toHaveBeenNthCalledWith(1, scopeId, 'src/edit.ts', 'original line 1\noriginal line 2');
        expect(mockCacheRepoFile).toHaveBeenNthCalledWith(2, scopeId, 'src/delete.ts', 'delete line 1\ndelete line 2\ndelete line 3');

        expect(opts.addChange).toHaveBeenCalledTimes(3);
        expect(opts.addChange).toHaveBeenNthCalledWith(1, {
          path: 'src/create.ts',
          action: 'create',
          content: 'new line 1\nnew line 2',
          originalContent: '',
          staged: true,
        });
        expect(opts.addChange).toHaveBeenNthCalledWith(2, {
          path: 'src/edit.ts',
          action: 'edit',
          content: 'updated line',
          originalContent: 'original line 1\noriginal line 2',
          staged: true,
        });
        expect(opts.addChange).toHaveBeenNthCalledWith(3, {
          path: 'src/delete.ts',
          action: 'delete',
          content: '',
          originalContent: 'delete line 1\ndelete line 2\ndelete line 3',
          staged: true,
        });
      });

      it('calls addChange even when conversationId is null', () => {
        const opts = createMockOpts({ conversationId: null });
        const event: RepoBatchEditEvent = {
          type: REPO_BATCH_EDIT,
          changes: [
            {
              path: 'src/create.ts',
              action: 'create',
              content: 'new line',
              originalContent: '',
              description: 'Create file',
            },
          ],
        };

        handleServerToolEvent(event, scopeId, opts);

        expect(opts.addChange).toHaveBeenCalledTimes(1);
      });

      it('does not call addChange when there are no changes', () => {
        const opts = createMockOpts();
        const event: RepoBatchEditEvent = {
          type: REPO_BATCH_EDIT,
          changes: [],
        };

        handleServerToolEvent(event, scopeId, opts);

        expect(opts.addChange).toHaveBeenCalledTimes(0);
      });
    });

    describe('repo_proposal', () => {
      it('does nothing (no-op) - verify no addChange or cacheRepoFile calls', () => {
        const opts = createMockOpts();
        const event: RepoProposalEvent = {
          type: REPO_PROPOSAL,
          summary: 'Proposal summary',
          plan: [
            { path: 'src/file1.ts', action: 'edit', description: 'Edit file 1' },
            { path: 'src/file2.ts', action: 'create', description: 'Create file 2' },
          ],
        };

        handleServerToolEvent(event, scopeId, opts);

        expect(opts.addChange).not.toHaveBeenCalled();
        expect(mockCacheRepoFile).not.toHaveBeenCalled();
      });
    });
  });
});
