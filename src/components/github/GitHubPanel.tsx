import React, { useState, useEffect } from 'react';
import { Github, FolderGit2, FileCode, ChevronRight, ChevronDown, Loader2, ExternalLink, AlertCircle, RefreshCw, Edit3, X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { cn } from '@/lib/utils';

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  html_url: string;
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
  const { activeRepo, isRepoMode, setActiveRepo, clearActiveRepo, getChangeCount } = useChangesetStore();
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contents, setContents] = useState<RepoContent[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingFile, setLoadingFile] = useState<string | null>(null);

  const fetchRepos = async () => {
    if (!githubPAT) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list-repos', pat: githubPAT }),
        }
      );
      
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
  };

  const fetchContents = async (owner: string, repo: string, path = '') => {
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'read-repo', pat: githubPAT, owner, repo, path }),
        }
      );
      
      const data = await response.json();
      return data.contents || [];
    } catch {
      return [];
    }
  };

  const handleSelectRepo = async (repo: GitHubRepo) => {
    const [owner, repoName] = repo.full_name.split('/');
    onSelectRepo?.(owner, repoName, repo.default_branch);
    
    const rootContents = await fetchContents(owner, repoName);
    setContents(rootContents);
    setExpandedDirs(new Set());
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
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/github-integration`,
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

  const handleEnableEditMode = (repo: GitHubRepo) => {
    const [owner, repoName] = repo.full_name.split('/');
    setActiveRepo({
      owner,
      name: repoName,
      defaultBranch: repo.default_branch,
      fullName: repo.full_name,
    });
  };

  const handleDisableEditMode = () => {
    const changeCount = getChangeCount();
    if (changeCount > 0) {
      if (!window.confirm(`You have ${changeCount} pending change${changeCount > 1 ? 's' : ''}. Disable editing mode? Changes will be lost.`)) {
        return;
      }
    }
    clearActiveRepo();
  };

  useEffect(() => {
    if (githubPAT) {
      fetchRepos();
    }
  }, [githubPAT]);

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
            {/* File tree */}
            <div className="py-1">
              {contents.length > 0 ? (
                renderContents(contents)
              ) : (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="py-1">
            {isRepoMode && activeRepo && (
              <div className="flex items-center gap-2 px-3 py-1.5 mb-1 bg-primary/10 border-b border-primary/20 text-xs">
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
            {repos.map(repo => {
              const isActive = isRepoMode && activeRepo?.fullName === repo.full_name;
              return (
                <div
                  key={repo.id}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 hover:bg-secondary/50 transition-colors',
                    isActive && 'bg-primary/5'
                  )}
                >
                  <button
                    onClick={() => handleSelectRepo(repo)}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                  >
                    <FolderGit2 className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">{repo.name}</span>
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
                        <p className="text-xs text-muted-foreground truncate">{repo.description}</p>
                      )}
                    </div>
                  </button>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={e => { e.stopPropagation(); if (isActive) { handleDisableEditMode(); } else { handleEnableEditMode(repo); } }}
                      className={cn(
                        'p-1 rounded transition-colors text-xs',
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
                      className="p-1 hover:bg-secondary rounded"
                    >
                      <ExternalLink className="h-3 w-3 text-muted-foreground" />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
