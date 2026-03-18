import { beforeEach, describe, expect, it } from 'vitest';
import { useChangesetStore } from '@/stores/changeset-store';

describe('changeset store repo boundaries', () => {
  beforeEach(() => {
    useChangesetStore.setState({ panelChangesets: {} });
  });

  it('clears staged changes when switching a panel to a different repo', () => {
    const store = useChangesetStore.getState();

    store.setActiveRepo('default', {
      owner: 'octo',
      name: 'repo-a',
      defaultBranch: 'main',
      fullName: 'octo/repo-a',
    });
    store.addChange('default', {
      path: 'src/app.ts',
      action: 'edit',
      content: 'next',
      originalContent: 'prev',
      staged: true,
    });
    store.setRepoFileTree('default', ['src/app.ts']);

    store.switchActiveRepo('default', {
      owner: 'octo',
      name: 'repo-b',
      defaultBranch: 'main',
      fullName: 'octo/repo-b',
    });

    expect(store.getChangeset('default')).toEqual({
      activeRepo: {
        owner: 'octo',
        name: 'repo-b',
        defaultBranch: 'main',
        fullName: 'octo/repo-b',
      },
      isRepoMode: true,
      pullRequest: null,
      changes: {},
      repoFileTree: [],
      repoFileCache: {},
      selectedRepoFilePath: null,
      repoFileTreeStatus: 'idle',
      repoFileTreeError: null,
    });
  });

  it('drops staged changes when repo mode is cleared', () => {
    const store = useChangesetStore.getState();

    store.setActiveRepo('default', {
      owner: 'octo',
      name: 'repo-a',
      defaultBranch: 'main',
      fullName: 'octo/repo-a',
    });
    store.addChange('default', {
      path: 'src/app.ts',
      action: 'edit',
      content: 'next',
      originalContent: 'prev',
      staged: true,
    });

    store.clearActiveRepo('default');

    expect(store.getChangeset('default')).toEqual({
      activeRepo: null,
      isRepoMode: false,
      pullRequest: null,
      changes: {},
      repoFileTree: [],
      repoFileCache: {},
      selectedRepoFilePath: null,
      repoFileTreeStatus: 'idle',
      repoFileTreeError: null,
    });
  });

  it('stores repo file cache and selected file per panel', () => {
    const store = useChangesetStore.getState();

    store.setActiveRepo('default', {
      owner: 'octo',
      name: 'repo-a',
      defaultBranch: 'main',
      fullName: 'octo/repo-a',
    });
    store.setRepoFileTree('default', ['README.md']);
    store.cacheRepoFile('default', 'README.md', '# Repo');
    store.setSelectedRepoFilePath('default', 'README.md');

    expect(store.getChangeset('default').repoFileCache).toEqual({ 'README.md': '# Repo' });
    expect(store.getChangeset('default').selectedRepoFilePath).toBe('README.md');
    expect(store.getChangeset('default').repoFileTreeStatus).toBe('ready');
  });

  it('tracks repo tree loading failures separately from cached file contents', () => {
    const store = useChangesetStore.getState();

    store.setActiveRepo('default', {
      owner: 'octo',
      name: 'repo-a',
      defaultBranch: 'main',
      fullName: 'octo/repo-a',
    });

    store.setRepoFileTreeStatus('default', 'loading');
    expect(store.getChangeset('default').repoFileTreeStatus).toBe('loading');
    expect(store.getChangeset('default').repoFileTreeError).toBeNull();

    store.setRepoFileTreeStatus('default', 'error', 'GitHub API error');
    expect(store.getChangeset('default').repoFileTreeStatus).toBe('error');
    expect(store.getChangeset('default').repoFileTreeError).toBe('GitHub API error');
  });

  it('stores created pull request metadata per panel and clears it on repo switch', () => {
    const store = useChangesetStore.getState();

    store.setActiveRepo('default', {
      owner: 'octo',
      name: 'repo-a',
      defaultBranch: 'main',
      fullName: 'octo/repo-a',
    });
    store.setPullRequest('default', {
      number: 42,
      url: 'https://github.com/octo/repo-a/pull/42',
      title: 'feat: persist pr state',
      body: '',
      state: 'open',
      draft: false,
      headBranch: 'ai/chat-changes-42',
      baseBranch: 'main',
    });

    expect(store.getChangeset('default').pullRequest?.number).toBe(42);

    store.switchActiveRepo('default', {
      owner: 'octo',
      name: 'repo-b',
      defaultBranch: 'main',
      fullName: 'octo/repo-b',
    });

    expect(store.getChangeset('default').pullRequest).toBeNull();
  });

  it('batchAddChanges applies all changes atomically', () => {
    const store = useChangesetStore.getState();

    store.batchAddChanges('default', [
      { path: 'server/src/index.ts', action: 'edit', content: 'new index', originalContent: 'old index', staged: true },
      { path: 'client/src/main.tsx', action: 'edit', content: 'new main', originalContent: 'old main', staged: true },
      { path: 'server/src/routes/cards.ts', action: 'edit', content: 'new cards', originalContent: 'old cards', staged: true },
    ]);

    const changes = store.getChangeset('default').changes;
    expect(Object.keys(changes)).toHaveLength(3);
    expect(changes['server/src/index.ts'].content).toBe('new index');
    expect(changes['client/src/main.tsx'].content).toBe('new main');
    expect(changes['server/src/routes/cards.ts'].content).toBe('new cards');
    expect(store.getStagedCount('default')).toBe(3);
  });

  it('batchAddChanges preserves existing changes from other paths', () => {
    const store = useChangesetStore.getState();

    store.addChange('default', {
      path: 'existing.ts',
      action: 'edit',
      content: 'existing content',
      originalContent: 'old',
      staged: true,
    });

    store.batchAddChanges('default', [
      { path: 'new1.ts', action: 'create', content: 'content1', staged: true },
      { path: 'new2.ts', action: 'create', content: 'content2', staged: true },
    ]);

    expect(Object.keys(store.getChangeset('default').changes)).toHaveLength(3);
    expect(store.getChangeset('default').changes['existing.ts'].content).toBe('existing content');
  });

  it('counts added and removed lines for same-length edits in totals', () => {
    const store = useChangesetStore.getState();

    store.addChange('default', {
      path: 'src/app.ts',
      action: 'edit',
      content: ['const a = 2;', 'const b = 3;'].join('\n'),
      originalContent: ['const a = 1;', 'const b = 2;'].join('\n'),
      staged: true,
    });
    store.addChange('default', {
      path: 'src/new.ts',
      action: 'create',
      content: 'export const created = true;',
      staged: false,
    });

    expect(store.getLineTotals('default', 'all')).toEqual({ added: 3, removed: 2 });
    expect(store.getLineTotals('default', 'staged')).toEqual({ added: 2, removed: 2 });
    expect(store.getLineTotals('default', 'unstaged')).toEqual({ added: 1, removed: 0 });
  });
});
