import { describe, expect, it } from 'vitest';

import {
  normalizeBatchEditRepoFilesArgs,
  normalizeCreateRepoFileArgs,
  normalizeDeleteRepoFileArgs,
  normalizeEditRepoFileArgs,
  normalizeProposeChangesArgs,
} from '@/lib/repo-tool-args';

describe('repo-tool-args', () => {
  it('infers missing batch change actions from existing repo paths', () => {
    const normalized = normalizeBatchEditRepoFilesArgs(
      {
        changes: [
          {
            path: 'src/App.tsx',
            content: 'export default function App() { return <main>Updated</main>; }',
            description: 'Refresh app shell',
          },
          {
            path: 'src/new.ts',
            content: 'export const created = true;',
            description: 'Add helper',
          },
        ],
      },
      { existingPaths: ['src/App.tsx'] },
    ) as { changes: Array<{ path: string; action: string }> };

    expect(normalized.changes).toEqual([
      expect.objectContaining({ path: 'src/App.tsx', action: 'edit' }),
      expect.objectContaining({ path: 'src/new.ts', action: 'create' }),
    ]);
  });

  it('unwraps nested provider payloads for batch edits', () => {
    const normalized = normalizeBatchEditRepoFilesArgs({
      parameters: {
        edits: [
          {
            filePath: 'README.md',
            type: 'update',
            text: '# Updated',
            message: 'Refresh docs',
          },
        ],
      },
    }) as { changes: Array<{ path: string; action: string; content: string; description: string }> };

    expect(normalized.changes).toEqual([
      {
        path: 'README.md',
        action: 'edit',
        content: '# Updated',
        description: 'Refresh docs',
      },
    ]);
  });

  it('coerces explicit create actions to edit when the repo path already exists', () => {
    const normalized = normalizeBatchEditRepoFilesArgs(
      {
        changes: [
          {
            path: 'src/App.tsx',
            action: 'create',
            content: 'export default function App() { return <main>Updated</main>; }',
            description: 'Overwrite app shell',
          },
        ],
      },
      { existingPaths: ['src/App.tsx'] },
    ) as { changes: Array<{ path: string; action: string }> };

    expect(normalized.changes).toEqual([
      expect.objectContaining({ path: 'src/App.tsx', action: 'edit' }),
    ]);
  });

  it('normalizes propose_changes plans with missing actions', () => {
    const normalized = normalizeProposeChangesArgs(
      {
        description: 'Update the shell and docs',
        plan: [
          {
            file: 'src/App.tsx',
            description: 'Update the shell',
          },
        ],
      },
      { existingPaths: ['src/App.tsx'] },
    ) as { summary: string; plan: Array<{ path: string; action: string; description: string }> };

    expect(normalized.summary).toBe('Update the shell and docs');
    expect(normalized.plan).toEqual([
      {
        path: 'src/App.tsx',
        action: 'edit',
        description: 'Update the shell',
      },
    ]);
  });

  it('accepts file-path aliases for single-file repo tools', () => {
    expect(normalizeEditRepoFileArgs({
      filePath: 'src/App.tsx',
      text: 'updated',
      message: 'Refresh App',
    })).toEqual({
      filePath: 'src/App.tsx',
      text: 'updated',
      message: 'Refresh App',
      path: 'src/App.tsx',
      content: 'updated',
      description: 'Refresh App',
    });

    expect(normalizeCreateRepoFileArgs({
      parameters: JSON.stringify({
        filename: 'src/new.ts',
        contents: 'export const created = true;',
      }),
    })).toEqual({
      filename: 'src/new.ts',
      contents: 'export const created = true;',
      path: 'src/new.ts',
      content: 'export const created = true;',
      description: 'Create src/new.ts',
    });

    expect(normalizeDeleteRepoFileArgs({
      targetPath: 'src/old.ts',
      summary: 'Remove dead code',
    })).toEqual({
      targetPath: 'src/old.ts',
      summary: 'Remove dead code',
      path: 'src/old.ts',
      reason: 'Remove dead code',
    });
  });
});
