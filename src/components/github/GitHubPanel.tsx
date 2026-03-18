import React, { useCallback, useEffect, useState } from 'react';
import { Github, FolderGit2, FileCode, ChevronRight, ChevronDown, Loader2, ExternalLink, AlertCircle, RefreshCw, Edit3, X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore } from '@/stores/preview-store';
import { usePanelStore } from '@/stores/panel-store';
import { cn } from '@/lib/utils';
import { getApiBaseUrl, fetchRepoFileTreeResult } from '@/lib/api';
import { getChatScopeId } from '@/lib/chat-scope';

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  html_url: string;
  permissions?: {
    pull?: boolean;
    push?: boolean;
    admin?: boolean;
  };
}

interface RepoContent {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  sha?: string;
  children?: RepoContent[];
}

interface GitHubPanelProps {
  onSelectFile?: (owner: string, repo: string, path: string, content: string) => void;
  selectedRepo?: { owner: string; repo: string } | null;
  onSelectRepo?: (owner: string, repo: string, branch: string) => void;
}

export const GitHubPanel: React.FC<GitHubPanelProps> = ({
  onSelectFile,
  selectedRepo,
  onSelectRepo,
}) => {
  const { githubPAT } = useSettingsStore();
  const panels = usePanelStore((s) => s.panels);
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const focusedPanel = panels.find((panel) => panel.id === focusedPanelId);
  const scopeId = getChatScopeId(focusedPanelId, focusedPanel?.conversationId ?? null);
  const setPreviewOpen = usePreviewStore((s) => s.setOpen);
  const setPreviewView = usePreviewStore((s) => s.setView);
  const {
    getChangeset,
    switchActiveRepo,
    clearActiveRepo: clearActiveRepoForPanel,
    getChangeCount,
    setRepoFileTree,
    setRepoFileTreeStatus,
  } = useChangesetStore();
  const { activeRepo, isRepoMode } = getChangeset(scopeId);
  const clearActiveRepo = () => clearActiveRepoForPanel(scopeId);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contents, setContents] = useState<RepoContent[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [repoLoadProgress, setRepoLoadProgress] = useState<{ loading: boolean; percent: number; label: string }>({
    loading: false,
    percent: 0,
    label: '',
  });

  const fetchRepos = useCallback(async () => {
    if (!githubPAT) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list-repos', pat: githubPAT }),
        }
      );
      
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = await response.json();
      if (data.error) {
        setError(data.error);
      } else {
        setRepos(data.repos || []);
      }
    } catch (err) {
      setError('Failed to fetch repositories');
    } finally {
      setLoading(false);
    }
  }, [githubPAT]);

  const fetchContents = async (owner: string, repo: string, path = '') => {
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'read-repo', pat: githubPAT, owner, repo, path }),
        }
      );
      
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = await response.json();
      return data.contents || [];
    } catch {
      return [];
    }
  };

  const buildTreeFromFlat = (items: Array<{ path: string; type: 'file' | 'dir'; size?: number; sha?: string }>): RepoContent[] => {
    const root: RepoContent[] = [];
    const dirMap = new Map<string, RepoContent>();

    // Sort so directories come before their children
    const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));

    for (const item of sorted) {
      const node: RepoContent = {
        path: item.path,
        type: item.type,
        size: item.size,
        sha: item.sha,
        ...(item.type === 'dir' ? { children: [] } : {}),
      };

      const parentPath = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '';

      if (parentPath && dirMap.has(parentPath)) {
        dirMap.get(parentPath)!.children!.push(node);
      } else {
        root.push(node);
      }

      if (item.type === 'dir') {
        dirMap.set(item.path, node);
      }
    }

    return root;
  };

  const handleSelectRepo = async (repo: GitHubRepo) => {
    const [owner, repoName] = repo.full_name.split('/');
    onSelectRepo?.(owner, repoName, repo.default_branch);
    setContents([]);
    setExpandedDirs(new Set());
    setRepoLoadProgress({ loading: true, percent: 5, label: 'Connecting to repository...' });

    try {
      // Fetch the full tree in one call
      setRepoLoadProgress({ loading: true, percent: 20, label: 'Fetching repository tree...' });
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'read-tree',
            pat: githubPAT,
            owner,
            repo: repoName,
            branch: repo.default_branch,
          }),
        }
      );

      setRepoLoadProgress({ loading: true, percent: 60, label: 'Processing file tree...' });

      if (!response.ok) {
        // Fallback to old method if tree API fails
        setRepoLoadProgress({ loading: true, percent: 70, label: 'Falling back to directory listing...' });
        const rootContents = await fetchContents(owner, repoName);
        setContents(rootContents);
        setRepoLoadProgress({ loading: true, percent: 100, label: 'Done' });
        setTimeout(() => setRepoLoadProgress({ loading: false, percent: 0, label: '' }), 400);
        return;
      }

      const data = await response.json();

      setRepoLoadProgress({ loading: true, percent: 80, label: `Building tree (${data.items?.length || 0} items)...` });

      const tree = buildTreeFromFlat(data.items || []);

      setRepoLoadProgress({ loading: true, percent: 95, label: 'Rendering...' });

      // Pre-expand root directories
      const rootDirs = new Set(tree.filter(i => i.type === 'dir').map(i => i.path));
      setContents(tree);
      setExpandedDirs(rootDirs);

      setRepoLoadProgress({ loading: true, percent: 100, label: 'Done' });
      setTimeout(() => setRepoLoadProgress({ loading: false, percent: 0, label: '' }), 400);
    } catch {
      // Fallback to old method
      const rootContents = await fetchContents(owner, repoName);
      setContents(rootContents);
      setRepoLoadProgress({ loading: false, percent: 0, label: '' });
    }
  };

  const handleToggleDir = async (path: string) => {
    if (expandedDirs.has(path)) {
      setExpandedDirs(prev => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } else {
      if (selectedRepo) {
        const dirContents = await fetchContents(selectedRepo.owner, selectedRepo.repo, path);
        setContents(prev => updateContentsWithChildren(prev, path, dirContents));
        setExpandedDirs(prev => new Set([...prev, path]));
      }
    }
  };

  const updateContentsWithChildren = (
    items: RepoContent[],
    targetPath: string,
    children: RepoContent[]
  ): RepoContent[] => {
    return items.map(item => {
      if (item.path === targetPath && item.type === 'dir') {
        return { ...item, children };
      }
      if (item.children) {
        return { ...item, children: updateContentsWithChildren(item.children, targetPath, children) };
      }
      return item;
    });
  };

  const handleSelectFile = async (path: string) => {
    if (!selectedRepo || !onSelectFile) return;
    
    setLoadingFile(path);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'read-file',
            pat: githubPAT,
            owner: selectedRepo.owner,
            repo: selectedRepo.repo,
            path,
          }),
        }
      );
      
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = await response.json();
      if (data.content) {
        onSelectFile(selectedRepo.owner, selectedRepo.repo, path, data.content);
      }
    } catch {
      // Handle error silently
    } finally {
      setLoadingFile(null);
    }
  };

  const handleEnableEditMode = async (repo: GitHubRepo) => {
    const [owner, repoName] = repo.full_name.split('/');
    const nextRepo = {
      owner,
      name: repoName,
      defaultBranch: repo.default_branch,
      fullName: repo.full_name,
      permissions: repo.permissions,
    };
    const changeCount = getChangeCount(scopeId);
    const switchingRepos = activeRepo?.fullName && activeRepo.fullName !== nextRepo.fullName;

    if (switchingRepos && changeCount > 0) {
      if (!window.confirm(`You have ${changeCount} pending change${changeCount > 1 ? 's' : ''} for ${activeRepo.fullName}. Switch repos and discard them?`)) {
        return;
      }
    }

    switchActiveRepo(scopeId, nextRepo);
    setRepoFileTreeStatus(scopeId, 'loading');
    setPreviewView(scopeId, 'repo');

    // Fetch full file tree so the agent knows what files exist
    if (githubPAT) {
      const result = await fetchRepoFileTreeResult(githubPAT, owner, repoName, repo.default_branch);
      if (result.error) {
        setRepoFileTreeStatus(scopeId, 'error', result.error);
      } else {
        setRepoFileTree(scopeId, result.paths);
      }
    }
  };

  const handleDisableEditMode = () => {
    const changeCount = getChangeCount(scopeId);
    if (changeCount > 0) {
      if (!window.confirm(`You have ${changeCount} pending change${changeCount > 1 ? 's' : ''}. Disable editing mode? Changes will be lost.`)) {
        return;
      }
    }
    clearActiveRepo();
  };

  useEffect(() => {
    if (githubPAT) {
      void fetchRepos();
    }
  }, [fetchRepos, githubPAT]);

  if (!githubPAT) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <Github className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-sm font-medium mb-2">GitHub Not Connected</h3>
        <p className="text-xs text-muted-foreground">
          Add your GitHub Personal Access Token in Settings → GitHub to browse repositories.
        </p>
      </div>
    );
  }

  const renderContents = (items: RepoContent[], depth = 0): React.ReactNode => {
    return items
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.path.localeCompare(b.path);
      })
      .map(item => {
        const name = item.path.split('/').pop() || item.path;
        const isExpanded = expandedDirs.has(item.path);
        const isLoading = loadingFile === item.path;
        
        return (
          <div key={item.path}>
            <button
              onClick={() => item.type === 'dir' ? handleToggleDir(item.path) : handleSelectFile(item.path)}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-secondary/50 transition-colors',
                isLoading && 'opacity-50'
              )}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              disabled={isLoading}
            >
              {item.type === 'dir' ? (
                <>
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  )}
                  <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                </>
              ) : (
                <>
                  <span className="w-3" />
                  {isLoading ? (
                    <Loader2 className="h-3.5 w-3.5 text-muted-foreground shrink-0 animate-spin" />
                  ) : (
                    <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                </>
              )}
              <span className="truncate">{name}</span>
            </button>
            {item.type === 'dir' && isExpanded && item.children && (
              <div>{renderContents(item.children, depth + 1)}</div>
            )}
          </div>
        );
      });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Github className="h-4 w-4" />
          <span className="text-sm font-medium">GitHub</span>
        </div>
        <button
          onClick={fetchRepos}
          disabled={loading}
          className="p-1 rounded hover:bg-secondary transition-colors"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive bg-destructive/10">
            <AlertCircle className="h-3.5 w-3.5" />
            {error}
          </div>
        )}

        {loading && !repos.length ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : selectedRepo ? (
          <div>
            {/* Selected repo header */}
            <div className="flex items-center gap-2 px-3 py-2 bg-secondary/50 border-b border-border">
              <button
                onClick={() => {
                  onSelectRepo?.('', '', '');
                  setContents([]);
                }}
                className="text-xs text-primary hover:underline"
              >
                ← Back
              </button>
              <span className="text-xs font-medium truncate">
                {selectedRepo.owner}/{selectedRepo.repo}
              </span>
            </div>
            {/* Loading progress */}
            {repoLoadProgress.loading && (
              <div className="px-3 py-3 border-b border-border">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-muted-foreground">{repoLoadProgress.label}</span>
                  <span className="text-xs font-medium tabular-nums">{repoLoadProgress.percent}%</span>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${repoLoadProgress.percent}%` }}
                  />
                </div>
              </div>
            )}
            {/* File tree */}
            <div className="py-1">
              {contents.length > 0 ? (
                renderContents(contents)
              ) : !repoLoadProgress.loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="p-3">
            {isRepoMode && activeRepo && (
              <div className="flex items-center gap-2 px-3 py-1.5 mb-3 bg-primary/10 border border-primary/20 rounded-lg text-xs">
                <Edit3 className="h-3 w-3 text-primary shrink-0" />
                <span className="text-primary font-medium truncate flex-1">
                  Editing: {activeRepo.fullName}
                </span>
                <button
                  onClick={handleDisableEditMode}
                  className="p-0.5 rounded hover:bg-primary/20 transition-colors"
                  title="Disable editing mode"
                >
                  <X className="h-3 w-3 text-primary" />
                </button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {repos.map(repo => {
                const isActive = isRepoMode && activeRepo?.fullName === repo.full_name;
                return (
                  <div
                    key={repo.id}
                    className={cn(
                      'group relative flex flex-col gap-2 p-3 rounded-lg border border-border bg-card hover:bg-secondary/50 transition-colors cursor-pointer',
                      isActive && 'border-primary/40 bg-primary/5'
                    )}
                    onClick={() => handleSelectRepo(repo)}
                  >
                    {/* Action buttons */}
                    <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={e => { e.stopPropagation(); if (isActive) { handleDisableEditMode(); } else { handleEnableEditMode(repo); } }}
                        className={cn(
                          'p-1 rounded transition-colors',
                          isActive
                            ? 'hover:bg-primary/20 text-primary'
                            : 'hover:bg-secondary text-muted-foreground hover:text-foreground'
                        )}
                        title={isActive ? 'Disable editing' : 'Enable editing mode'}
                      >
                        <Edit3 className="h-3 w-3" />
                      </button>
                      <a
                        href={repo.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="p-1 hover:bg-secondary rounded text-muted-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>

                    {/* Repo info */}
                    <div className="flex items-center gap-2 min-w-0">
                      <FolderGit2 className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
                      <span className="text-sm font-medium truncate">{repo.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {repo.private && (
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          Private
                        </span>
                      )}
                      {isActive && (
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                          Editing
                        </span>
                      )}
                    </div>
                    {repo.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">{repo.description}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
