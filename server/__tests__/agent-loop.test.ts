import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { SERVER_AGENT_MAX_STEPS, buildServerRepoTools, RepoContext } from '../agent-loop';

describe('agent-loop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('SERVER_AGENT_MAX_STEPS', () => {
    it('should equal 50', () => {
      expect(SERVER_AGENT_MAX_STEPS).toBe(50);
    });
  });

  describe('buildServerRepoTools', () => {
    let mockEmit: ReturnType<typeof vi.fn>;
    let baseRepo: RepoContext;

    beforeEach(() => {
      mockEmit = vi.fn();
      baseRepo = {
        owner: 'test-owner',
        name: 'test-repo',
        defaultBranch: 'main',
        githubPAT: 'test-pat',
        repoFileTree: ['src/app.ts', 'README.md'],
        repoFileCache: {
          'src/app.ts': 'console.log("hello");',
        },
        repoEditIntent: true,
      };
    });

    describe('tool availability', () => {
      it('should return all 6 tool names when repoEditIntent is true', () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);

        expect(Object.keys(tools)).toHaveLength(6);
        expect(tools).toHaveProperty('propose_changes');
        expect(tools).toHaveProperty('read_repo_file');
        expect(tools).toHaveProperty('edit_repo_file');
        expect(tools).toHaveProperty('create_repo_file');
        expect(tools).toHaveProperty('delete_repo_file');
        expect(tools).toHaveProperty('batch_edit_repo_files');
      });

      it('should expose only read_repo_file for read-only repo turns', () => {
        const tools = buildServerRepoTools(
          {
            ...baseRepo,
            repoEditIntent: false,
          },
          mockEmit,
        );

        expect(Object.keys(tools)).toEqual(['read_repo_file']);
      });
    });

    describe('propose_changes', () => {
      it('should emit a repo_proposal event and return a review prompt', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.propose_changes.execute!(
          {
            summary: 'Refresh the shell',
            plan: [
              {
                path: 'src/app.ts',
                action: 'edit',
                description: 'Update the main shell copy',
              },
            ],
          },
          {},
        );

        expect(result).toBe('Proposal ready for review. Pause for approval before editing repo files.');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_proposal',
          summary: 'Refresh the shell',
          plan: [
            {
              path: 'src/app.ts',
              action: 'edit',
              description: 'Update the main shell copy',
            },
          ],
        });
      });

      it('normalizes provider plan payloads before validation', () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const parsed = tools.propose_changes.parameters.safeParse({
          description: 'Refresh the shell',
          plan: [
            {
              filePath: 'src/app.ts',
              description: 'Update the main shell copy',
            },
          ],
        });

        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data).toEqual({
          summary: 'Refresh the shell',
          plan: [
            {
              path: 'src/app.ts',
              action: 'edit',
              description: 'Update the main shell copy',
            },
          ],
        });
      });
    });

    describe('read_repo_file', () => {
      it('should return cached content and emit repo_file_read event', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.read_repo_file.execute!(
          { path: 'src/app.ts' },
          {}
        );

        expect(result).toBe('console.log("hello");');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_file_read',
          path: 'src/app.ts',
          content: 'console.log("hello");',
        });
        expect(mockEmit).toHaveBeenCalledTimes(1);
      });

      it('should normalize path by stripping leading ./ and emit with normalized path', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.read_repo_file.execute!(
          { path: './src/app.ts' },
          {}
        );

        expect(result).toBe('console.log("hello");');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_file_read',
          path: 'src/app.ts',
          content: 'console.log("hello");',
        });
      });

      it('should return error for invalid path "."', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.read_repo_file.execute!(
          { path: '.' },
          {}
        );

        expect(result).toBe(
          'Error: Choose a concrete file path from the loaded repository tree, not `.`, `/`, or a directory path.'
        );
        expect(mockEmit).not.toHaveBeenCalled();
      });

      it('should return error with suggestions when file not in repoFileTree', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.read_repo_file.execute!(
          { path: 'app.ts' },
          {}
        );

        expect(result).toContain('Error: `app.ts` is not present in the selected repository');
        expect(result).toContain('Possible matches:');
        expect(result).toContain('src/app.ts');
        expect(mockEmit).not.toHaveBeenCalled();
      });

      it('should fetch uncached nested files using slash-preserving GitHub contents paths', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
          ok: true,
          text: vi.fn().mockResolvedValue('export const nested = true;'),
        }));

        const tools = buildServerRepoTools(
          {
            ...baseRepo,
            repoFileTree: ['src/components/Button.tsx'],
            repoFileCache: {},
          },
          mockEmit,
        );

        const result = await tools.read_repo_file.execute!(
          { path: 'src/components/Button.tsx' },
          {},
        );

        expect(result).toBe('export const nested = true;');
        expect(fetch).toHaveBeenCalledWith(
          'https://api.github.com/repos/test-owner/test-repo/contents/src/components/Button.tsx?ref=main',
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer test-pat',
            }),
          }),
        );
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_file_read',
          path: 'src/components/Button.tsx',
          content: 'export const nested = true;',
        });
      });
    });

    describe('edit_repo_file', () => {
      it('should emit repo_file_edit event with originalContent from cache and return staged message', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.edit_repo_file.execute!(
          {
            path: 'src/app.ts',
            content: 'console.log("updated");',
            description: 'Update log message',
          },
          {}
        );

        expect(result).toBe('Staged edit to src/app.ts');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_file_edit',
          path: 'src/app.ts',
          content: 'console.log("updated");',
          originalContent: 'console.log("hello");',
          description: 'Update log message',
        });
        expect(mockEmit).toHaveBeenCalledTimes(1);
      });

      it('should normalize path and use empty string for originalContent when not in cache', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.edit_repo_file.execute!(
          {
            path: './README.md',
            content: '# Updated README',
            description: 'Update readme',
          },
          {}
        );

        expect(result).toBe('Staged edit to README.md');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_file_edit',
          path: 'README.md',
          content: '# Updated README',
          originalContent: '',
          description: 'Update readme',
        });
      });

      it('rejects edits to paths that do not already exist', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.edit_repo_file.execute!(
          {
            path: 'src/missing.ts',
            content: 'export const missing = true;',
            description: 'Should not create a new file',
          },
          {}
        );

        expect(result).toContain('can only modify existing repo files');
        expect(mockEmit).not.toHaveBeenCalled();
      });
    });

    describe('create_repo_file', () => {
      it('should emit repo_file_create event and return staged message', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.create_repo_file.execute!(
          {
            path: 'src/new-file.ts',
            content: 'export const foo = 1;',
            description: 'Add new utility file',
          },
          {}
        );

        expect(result).toBe('Staged new file src/new-file.ts');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_file_create',
          path: 'src/new-file.ts',
          content: 'export const foo = 1;',
          description: 'Add new utility file',
        });
        expect(mockEmit).toHaveBeenCalledTimes(1);
      });

      it('should normalize path when creating file', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.create_repo_file.execute!(
          {
            path: './src/another.ts',
            content: '// new file',
            description: 'Create file',
          },
          {}
        );

        expect(result).toBe('Staged new file src/another.ts');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_file_create',
          path: 'src/another.ts',
          content: '// new file',
          description: 'Create file',
        });
      });

      it('treats create_repo_file on an existing path as an edit', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.create_repo_file.execute!(
          {
            path: 'src/app.ts',
            content: 'console.log("updated via create");',
            description: 'Overwrite existing file',
          },
          {}
        );

        expect(result).toBe('Staged edit to src/app.ts');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_file_edit',
          path: 'src/app.ts',
          content: 'console.log("updated via create");',
          originalContent: 'console.log("hello");',
          description: 'Overwrite existing file',
        });
      });
    });

    describe('delete_repo_file', () => {
      it('should emit repo_file_delete event with originalContent and return staged message', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.delete_repo_file.execute!(
          {
            path: 'src/app.ts',
            reason: 'File no longer needed',
          },
          {}
        );

        expect(result).toBe('Staged deletion of src/app.ts');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_file_delete',
          path: 'src/app.ts',
          originalContent: 'console.log("hello");',
          reason: 'File no longer needed',
        });
        expect(mockEmit).toHaveBeenCalledTimes(1);
      });

      it('should use empty string for originalContent when file not in cache', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.delete_repo_file.execute!(
          {
            path: './README.md',
            reason: 'Remove old docs',
          },
          {}
        );

        expect(result).toBe('Staged deletion of README.md');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_file_delete',
          path: 'README.md',
          originalContent: '',
          reason: 'Remove old docs',
        });
      });
    });

    describe('batch_edit_repo_files', () => {
      it('normalizes missing batch actions before validation', () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const parsed = tools.batch_edit_repo_files.parameters.safeParse({
          changes: [
            {
              path: 'src/app.ts',
              content: 'console.log("edited");',
              description: 'Edit app.ts',
            },
            {
              filePath: 'src/new.ts',
              text: '// new file',
              message: 'Create new.ts',
            },
          ],
        });

        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data).toEqual({
          changes: [
            {
              path: 'src/app.ts',
              action: 'edit',
              content: 'console.log("edited");',
              description: 'Edit app.ts',
            },
            {
              path: 'src/new.ts',
              action: 'create',
              content: '// new file',
              description: 'Create new.ts',
            },
          ],
        });
      });

      it('should emit repo_batch_edit event with all changes and return joined status lines', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.batch_edit_repo_files.execute!(
          {
            changes: [
              {
                path: 'src/app.ts',
                action: 'edit',
                content: 'console.log("edited");',
                description: 'Edit app.ts',
              },
              {
                path: 'src/new.ts',
                action: 'create',
                content: '// new file',
                description: 'Create new.ts',
              },
            ],
          },
          {}
        );

        expect(result).toBe('Staged edit on src/app.ts\nStaged create on src/new.ts');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_batch_edit',
          changes: [
            {
              path: 'src/app.ts',
              action: 'edit',
              content: 'console.log("edited");',
              originalContent: 'console.log("hello");',
              description: 'Edit app.ts',
            },
            {
              path: 'src/new.ts',
              action: 'create',
              content: '// new file',
              originalContent: '',
              description: 'Create new.ts',
            },
          ],
        });
        expect(mockEmit).toHaveBeenCalledTimes(1);
      });

      it('should handle delete action with originalContent and remove from cache', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);

        // First verify the file is in cache by reading it
        await tools.read_repo_file.execute!({ path: 'src/app.ts' }, {});
        mockEmit.mockClear();

        // Then delete it via batch
        const result = await tools.batch_edit_repo_files.execute!(
          {
            changes: [
              {
                path: './src/app.ts',
                action: 'delete',
                content: '',
                description: 'Delete app.ts',
              },
            ],
          },
          {}
        );

        expect(result).toBe('Staged delete on src/app.ts');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_batch_edit',
          changes: [
            {
              path: 'src/app.ts',
              action: 'delete',
              content: '',
              originalContent: 'console.log("hello");',
              description: 'Delete app.ts',
            },
          ],
        });
      });

      it('should normalize paths for all changes in batch', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.batch_edit_repo_files.execute!(
          {
            changes: [
              {
                path: 'src//app.ts',
                action: 'edit',
                content: 'edited',
                description: 'Edit with double slashes',
              },
              {
                path: '.\\src\\new.ts',
                action: 'create',
                content: 'new',
                description: 'Create with backslashes',
              },
            ],
          },
          {}
        );

        expect(result).toBe('Staged edit on src/app.ts\nStaged create on src/new.ts');
        const emittedCall = mockEmit.mock.calls[0][0];
        expect(emittedCall.changes[0].path).toBe('src/app.ts');
        expect(emittedCall.changes[1].path).toBe('src/new.ts');
      });

      it('coerces create actions on existing files to edits', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.batch_edit_repo_files.execute!(
          {
            changes: [
              {
                path: 'src/app.ts',
                action: 'create',
                content: 'console.log("overwritten");',
                description: 'Should update existing file',
              },
            ],
          },
          {}
        );

        expect(result).toBe('Staged edit on src/app.ts');
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'repo_batch_edit',
          changes: [
            {
              path: 'src/app.ts',
              action: 'edit',
              content: 'console.log("overwritten");',
              originalContent: 'console.log("hello");',
              description: 'Should update existing file',
            },
          ],
        });
      });

      it('rejects batch edits that target missing files with edit actions', async () => {
        const tools = buildServerRepoTools(baseRepo, mockEmit);
        const result = await tools.batch_edit_repo_files.execute!(
          {
            changes: [
              {
                path: 'src/missing.ts',
                action: 'edit',
                content: 'export const missing = true;',
                description: 'Should not create a new file',
              },
            ],
          },
          {}
        );

        expect(result).toContain('cannot edit missing file');
        expect(mockEmit).not.toHaveBeenCalled();
      });
    });
  });
});
