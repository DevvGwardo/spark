import React, { useState, useEffect, useRef } from 'react';
import { FolderGit2, X, ChevronDown, Loader2 } from 'lucide-react';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePanelId } from '@/contexts/PanelContext';
import { useSettingsStore } from '@/stores/settings-store';
import { getApiBaseUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
}

export const WelcomeScreen = React.forwardRef<HTMLDivElement>((_, ref) => {
  const panelId = usePanelId();
  const { getChangeset, clearActiveRepo: clearActiveRepoForPanel, setActiveRepo: setActiveRepoForPanel } = useChangesetStore();
  const { activeRepo, isRepoMode } = getChangeset(panelId);
  const clearActiveRepo = () => clearActiveRepoForPanel(panelId);
  const setActiveRepo = (repo: Parameters<typeof setActiveRepoForPanel>[1]) => setActiveRepoForPanel(panelId, repo);
  const { githubPAT } = useSettingsStore();
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (githubPAT && !isRepoMode) {
      setLoading(true);
      fetch(`${getApiBaseUrl()}/functions/v1/github-integration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list-repos', pat: githubPAT }),
      })
        .then(r => r.json())
        .then(data => setRepos(data.repos || []))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [githubPAT, isRepoMode]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelectRepo = (repo: GitHubRepo) => {
    const [owner, repoName] = repo.full_name.split('/');
    setActiveRepo({
      owner,
      name: repoName,
      defaultBranch: repo.default_branch,
      fullName: repo.full_name,
    });
    setOpen(false);
    setSearch('');
  };

  const filteredRepos = repos.filter(r =>
    r.full_name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div ref={ref} className="flex flex-col items-center justify-center h-full px-6">
      <div className="text-center max-w-md space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">CloudChat</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          What do you want to build?
        </p>
        {isRepoMode && activeRepo ? (
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-xs text-primary font-medium mt-2">
            <FolderGit2 className="h-3.5 w-3.5" />
            <span>Editing: {activeRepo.fullName}</span>
            <button
              onClick={clearActiveRepo}
              className="p-0.5 rounded-full hover:bg-primary/20 transition-colors"
              title="Stop editing"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : githubPAT ? (
          <div ref={dropdownRef} className="relative inline-block mt-2">
            <button
              onClick={() => setOpen(!open)}
              className={cn(
                'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                'border-border hover:border-primary/40 hover:bg-secondary/50 text-muted-foreground'
              )}
            >
              <FolderGit2 className="h-3.5 w-3.5" />
              <span>Select a repo</span>
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
              )}
            </button>

            {open && (
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-72 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden">
                <div className="p-2 border-b border-border">
                  <input
                    type="text"
                    placeholder="Search repos..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full px-2 py-1 text-xs bg-transparent border border-border rounded focus:outline-none focus:border-primary/50"
                    autoFocus
                  />
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {loading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : filteredRepos.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                      {search ? 'No repos match your search' : 'No repositories found'}
                    </div>
                  ) : (
                    filteredRepos.map(repo => (
                      <button
                        key={repo.id}
                        onClick={() => handleSelectRepo(repo)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/50 transition-colors"
                      >
                        <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium truncate">{repo.full_name}</span>
                            {repo.private && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                                Private
                              </span>
                            )}
                          </div>
                          {repo.description && (
                            <p className="text-[10px] text-muted-foreground truncate">{repo.description}</p>
                          )}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
});
WelcomeScreen.displayName = 'WelcomeScreen';
