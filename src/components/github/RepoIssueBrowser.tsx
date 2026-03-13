import React, { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Bug,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitFork,
  Loader2,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  cloneGitHubRepo,
  forkGitHubRepo,
  listGitHubIssues,
  listGitHubRepos,
  searchGitHubRepos,
  type GitHubIssueSummary,
  type GitHubRepoSummary,
} from '@/lib/api';
import { attachRepoToPanel } from '@/lib/repo-workflow';
import { cn } from '@/lib/utils';
import { type ActiveRepo } from '@/stores/changeset-store';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

interface RepoIssueBrowserProps {
  isOpen: boolean;
  onClose: () => void;
}

type IssueSort = 'updated' | 'created' | 'comments';
type IssueDirection = 'asc' | 'desc';
type IssueState = 'open' | 'closed' | 'all';

const issueSortOptions: Array<{ value: IssueSort; label: string; direction: IssueDirection }> = [
  { value: 'updated', label: 'Recently updated', direction: 'desc' },
  { value: 'created', label: 'Newest first', direction: 'desc' },
  { value: 'comments', label: 'Most commented', direction: 'desc' },
  { value: 'created', label: 'Oldest first', direction: 'asc' },
];

const issueStateOptions: Array<{ value: IssueState; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
  { value: 'closed', label: 'Closed' },
];

function formatIssueTimestamp(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return 'Unknown';
  }

  const diffMs = timestamp - Date.now();
  const minutes = Math.round(diffMs / 60_000);
  const hours = Math.round(diffMs / 3_600_000);
  const days = Math.round(diffMs / 86_400_000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  if (Math.abs(hours) < 48) return formatter.format(hours, 'hour');
  return formatter.format(days, 'day');
}

function buildIssueFixPrompt(issueRepo: GitHubRepoSummary, editableRepo: GitHubRepoSummary, issue: GitHubIssueSummary) {
  const labelList = issue.labels.map((label) => label.name).filter(Boolean).join(', ');
  const lines = [
    `Fix GitHub issue #${issue.number} in ${issueRepo.full_name}.`,
    `Issue title: ${issue.title}`,
    issue.state ? `Issue state: ${issue.state}` : '',
    labelList ? `Labels: ${labelList}` : '',
    editableRepo.full_name !== issueRepo.full_name
      ? `Use ${editableRepo.full_name} as the editable working copy and keep the pull request target on ${issueRepo.full_name}.`
      : `Use ${editableRepo.full_name} as the editable repository.`,
    '',
    'Issue description:',
    issue.body?.trim() || 'No issue description was provided.',
    '',
    'Inspect the repository, propose the required code changes, implement them, and explain how the fix addresses the issue.',
  ].filter(Boolean);

  return lines.join('\n');
}

function toActiveRepo(issueRepo: GitHubRepoSummary, editableRepo: GitHubRepoSummary, issue?: GitHubIssueSummary | null): ActiveRepo {
  return {
    owner: editableRepo.owner.login,
    name: editableRepo.name,
    defaultBranch: editableRepo.default_branch,
    fullName: editableRepo.full_name,
    ...(editableRepo.full_name !== issueRepo.full_name
      ? {
          baseOwner: issueRepo.owner.login,
          baseName: issueRepo.name,
          baseFullName: issueRepo.full_name,
        }
      : {}),
    ...(editableRepo.localClone.exists ? { localPath: editableRepo.localClone.path } : {}),
    ...(issue
      ? {
          issue: {
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            state: issue.state,
            labels: issue.labels.map((label) => label.name).filter(Boolean),
            updatedAt: issue.updated_at,
          },
        }
      : {}),
  };
}

export const RepoIssueBrowser: React.FC<RepoIssueBrowserProps> = ({ isOpen, onClose }) => {
  const { githubPAT } = useSettingsStore();
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const { queuePanelPrompt, setActiveTab, setSettingsOpen } = useUIStore();
  const [repoQuery, setRepoQuery] = useState('');
  const deferredRepoQuery = useDeferredValue(repoQuery.trim());
  const [issueQuery, setIssueQuery] = useState('');
  const deferredIssueQuery = useDeferredValue(issueQuery.trim());
  const [repos, setRepos] = useState<GitHubRepoSummary[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoSummary | null>(null);
  const [workingRepo, setWorkingRepo] = useState<GitHubRepoSummary | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [issues, setIssues] = useState<GitHubIssueSummary[]>([]);
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssueSummary | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [issuePage, setIssuePage] = useState(1);
  const [issueTotalPages, setIssueTotalPages] = useState(1);
  const [issueTotalCount, setIssueTotalCount] = useState(0);
  const [issueHasNextPage, setIssueHasNextPage] = useState(false);
  const [issueHasPreviousPage, setIssueHasPreviousPage] = useState(false);
  const [issueSort, setIssueSort] = useState<IssueSort>('updated');
  const [issueDirection, setIssueDirection] = useState<IssueDirection>('desc');
  const [issueState, setIssueState] = useState<IssueState>('open');
  const [actionLoading, setActionLoading] = useState<'clone' | 'fork' | 'attach' | 'fix' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !githubPAT) {
      return;
    }

    let cancelled = false;
    setRepoLoading(true);
    setRepoError(null);

    const request = deferredRepoQuery
      ? searchGitHubRepos(githubPAT, deferredRepoQuery)
      : listGitHubRepos(githubPAT).then((results) => ({
          repos: results,
          totalCount: results.length,
          page: 1,
          perPage: results.length || 25,
        }));

    request
      .then((result) => {
        if (cancelled) return;
        setRepos(result.repos);
        setSelectedRepo((current) => {
          if (!current) {
            return result.repos[0] || null;
          }

          return result.repos.find((repo) => repo.full_name === current.full_name) || result.repos[0] || null;
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setRepoError(error instanceof Error ? error.message : 'Failed to load repositories');
      })
      .finally(() => {
        if (!cancelled) {
          setRepoLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [deferredRepoQuery, githubPAT, isOpen]);

  useEffect(() => {
    if (!selectedRepo) {
      setWorkingRepo(null);
      return;
    }

    setWorkingRepo(selectedRepo);
    setIssuePage(1);
    setSelectedIssue(null);
    setActionError(null);
  }, [selectedRepo]);

  useEffect(() => {
    if (!isOpen || !githubPAT || !selectedRepo) {
      return;
    }

    let cancelled = false;
    setIssuesLoading(true);
    setIssuesError(null);

    listGitHubIssues(githubPAT, selectedRepo.owner.login, selectedRepo.name, {
      page: issuePage,
      sort: issueSort,
      direction: issueDirection,
      state: issueState,
      query: deferredIssueQuery,
    })
      .then((result) => {
        if (cancelled) return;
        setIssues(result.issues);
        setIssueTotalPages(result.totalPages);
        setIssueTotalCount(result.totalCount);
        setIssueHasNextPage(result.hasNextPage);
        setIssueHasPreviousPage(result.hasPreviousPage);
        setSelectedIssue((current) => current && result.issues.some((issue) => issue.id === current.id) ? current : result.issues[0] || null);
      })
      .catch((error) => {
        if (cancelled) return;
        setIssuesError(error instanceof Error ? error.message : 'Failed to load issues');
      })
      .finally(() => {
        if (!cancelled) {
          setIssuesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [deferredIssueQuery, githubPAT, isOpen, issueDirection, issuePage, issueSort, issueState, selectedRepo]);

  const selectedSortKey = useMemo(
    () => `${issueSort}:${issueDirection}`,
    [issueDirection, issueSort],
  );

  const handleCloneRepo = async () => {
    if (!githubPAT || !selectedRepo) {
      return;
    }

    setActionLoading('clone');
    setActionError(null);
    try {
      const result = await cloneGitHubRepo(
        githubPAT,
        selectedRepo.owner.login,
        selectedRepo.name,
        selectedRepo.default_branch,
      );
      setSelectedRepo(result.repo);
      setWorkingRepo((current) => current?.full_name === selectedRepo.full_name ? result.repo : current);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to clone repository');
    } finally {
      setActionLoading(null);
    }
  };

  const handleForkRepo = async () => {
    if (!githubPAT || !selectedRepo) {
      return;
    }

    setActionLoading('fork');
    setActionError(null);
    try {
      const result = await forkGitHubRepo(
        githubPAT,
        selectedRepo.owner.login,
        selectedRepo.name,
        selectedRepo.default_branch,
      );
      setWorkingRepo(result.repo);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to fork repository');
    } finally {
      setActionLoading(null);
    }
  };

  const handleAttachRepo = async (issue?: GitHubIssueSummary | null, autoFix = false) => {
    if (!githubPAT || !selectedRepo || !workingRepo) {
      return;
    }

    setActionLoading(autoFix ? 'fix' : 'attach');
    setActionError(null);
    try {
      const attached = await attachRepoToPanel({
        panelId: focusedPanelId,
        repo: toActiveRepo(selectedRepo, workingRepo, issue),
        githubPAT,
        openPreview: true,
      });

      if (!attached) {
        return;
      }

      setActiveTab('chat');

      if (autoFix && issue) {
        useOrchestratorStore.getState().setEnabled(false);
        queuePanelPrompt(focusedPanelId, {
          content: buildIssueFixPrompt(selectedRepo, workingRepo, issue),
          autoSend: true,
        });
      }

      onClose();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to attach repository');
    } finally {
      setActionLoading(null);
    }
  };

  const workingCopyLabel = workingRepo && selectedRepo && workingRepo.full_name !== selectedRepo.full_name
    ? `Working copy: ${workingRepo.full_name}`
    : null;

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={onClose} />
      <div className="relative flex h-[88vh] w-full max-w-7xl flex-col overflow-hidden rounded-[28px] border border-border/70 bg-background/96 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/60 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/70 bg-muted/30">
              <Bug className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Repo Issues</h2>
              <p className="text-xs text-muted-foreground">
                Search a repository, browse 25 issues at a time, then attach or fix directly in chat.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl border border-border/60 p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            aria-label="Close repo issue browser"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!githubPAT ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <AlertCircle className="h-10 w-10 text-muted-foreground/60" />
            <div>
              <h3 className="text-sm font-semibold">GitHub access is required</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a GitHub PAT in settings before browsing repositories or loading issues.
              </p>
            </div>
            <button
              onClick={() => {
                onClose();
                setSettingsOpen(true);
              }}
              className="rounded-xl border border-border/60 bg-background/80 px-4 py-2 text-sm font-medium transition-colors hover:bg-muted/50"
            >
              Open settings
            </button>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[360px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col border-b border-border/60 lg:border-b-0 lg:border-r">
              <div className="border-b border-border/60 px-5 py-4">
                <div className="rounded-2xl border border-border/60 bg-muted/15 p-3">
                  <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-background/70 px-3 py-2">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <input
                      value={repoQuery}
                      onChange={(event) => setRepoQuery(event.target.value)}
                      placeholder="Search repositories"
                      className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/55"
                    />
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground/75">
                    {deferredRepoQuery ? 'Searching GitHub repositories' : 'Showing your recent repositories'}
                  </p>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {repoError && (
                  <div className="mb-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                    {repoError}
                  </div>
                )}
                {repoLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : repos.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                    <FolderGit2 className="h-9 w-9 text-muted-foreground/45" />
                    <p className="mt-3 text-sm font-medium">No repositories found</p>
                    <p className="mt-1 text-xs text-muted-foreground/75">
                      Try a different repo name or owner.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {repos.map((repo) => {
                      const isSelected = selectedRepo?.full_name === repo.full_name;
                      return (
                        <button
                          key={repo.id || repo.full_name}
                          onClick={() => {
                            setSelectedRepo(repo);
                            setWorkingRepo(repo);
                          }}
                          className={cn(
                            'w-full rounded-2xl border px-3 py-3 text-left transition-colors',
                            isSelected
                              ? 'border-primary/35 bg-primary/8'
                              : 'border-border/60 bg-background/40 hover:bg-muted/30',
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="truncate text-sm font-medium">{repo.full_name}</span>
                              </div>
                              {repo.description && (
                                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/75">
                                  {repo.description}
                                </p>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              {repo.localClone.exists && (
                                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                                  Local
                                </span>
                              )}
                              {repo.private && (
                                <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  Private
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>

            <section className="flex min-h-0 flex-col">
              {!selectedRepo ? (
                <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
                  <Sparkles className="h-10 w-10 text-muted-foreground/45" />
                  <p className="mt-3 text-sm font-medium">Pick a repository</p>
                  <p className="mt-1 text-xs text-muted-foreground/75">
                    The issue list, sorting controls, and repo actions appear here once a repository is selected.
                  </p>
                </div>
              ) : (
                <>
                  <div className="border-b border-border/60 px-6 py-5">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-lg font-semibold">{selectedRepo.full_name}</h3>
                          {selectedRepo.localClone.exists && (
                            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                              Cloned locally
                            </span>
                          )}
                          {workingCopyLabel && (
                            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                              {workingCopyLabel}
                            </span>
                          )}
                        </div>
                        {selectedRepo.description && (
                          <p className="mt-2 max-w-3xl text-sm text-muted-foreground/80">{selectedRepo.description}</p>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5">
                            <GitBranch className="h-3.5 w-3.5" />
                            {selectedRepo.default_branch}
                          </span>
                          {workingRepo?.localClone.path && (
                            <button
                              onClick={() => void navigator.clipboard.writeText(workingRepo.localClone.path || '')}
                              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-1 transition-colors hover:bg-muted/40"
                              title={workingRepo.localClone.path}
                            >
                              <Copy className="h-3.5 w-3.5" />
                              Copy clone path
                            </button>
                          )}
                          <a
                            href={selectedRepo.html_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-1 transition-colors hover:bg-muted/40"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Open on GitHub
                          </a>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => void handleAttachRepo(null, false)}
                          disabled={actionLoading !== null}
                          className="rounded-xl border border-border/60 bg-background/80 px-3 py-2 text-sm font-medium transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {actionLoading === 'attach' ? 'Attaching...' : 'Attach repo'}
                        </button>
                        <button
                          onClick={() => void handleCloneRepo()}
                          disabled={selectedRepo.localClone.exists || actionLoading !== null}
                          className="rounded-xl border border-border/60 bg-background/80 px-3 py-2 text-sm font-medium transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {actionLoading === 'clone' ? 'Cloning...' : selectedRepo.localClone.exists ? 'Clone ready' : 'Clone locally'}
                        </button>
                        <button
                          onClick={() => void handleForkRepo()}
                          disabled={actionLoading !== null}
                          className="rounded-xl border border-primary/35 bg-primary/10 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {actionLoading === 'fork' ? 'Forking...' : workingRepo && workingRepo.full_name !== selectedRepo.full_name ? 'Fork ready' : 'Fork & clone'}
                        </button>
                      </div>
                    </div>

                    {actionError && (
                      <div className="mt-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
                        {actionError}
                      </div>
                    )}
                  </div>

                  <div className="grid min-h-0 flex-1 gap-0 xl:grid-cols-[minmax(0,1fr)_360px]">
                    <div className="flex min-h-0 flex-col border-b border-border/60 xl:border-b-0 xl:border-r">
                      <div className="border-b border-border/60 px-6 py-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-3 py-2">
                              <Search className="h-4 w-4 text-muted-foreground" />
                              <input
                                value={issueQuery}
                                onChange={(event) => {
                                  setIssueQuery(event.target.value);
                                  startTransition(() => setIssuePage(1));
                                }}
                                placeholder="Search issue titles and descriptions"
                                className="w-64 bg-transparent text-sm outline-none placeholder:text-muted-foreground/55"
                              />
                            </div>
                            <select
                              value={selectedSortKey}
                              onChange={(event) => {
                                const [sort, direction] = event.target.value.split(':') as [IssueSort, IssueDirection];
                                setIssueSort(sort);
                                setIssueDirection(direction);
                                setIssuePage(1);
                              }}
                              className="rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm outline-none"
                            >
                              {issueSortOptions.map((option) => (
                                <option key={`${option.value}:${option.direction}`} value={`${option.value}:${option.direction}`}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <select
                              value={issueState}
                              onChange={(event) => {
                                setIssueState(event.target.value as IssueState);
                                setIssuePage(1);
                              }}
                              className="rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm outline-none"
                            >
                              {issueStateOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{issueTotalCount.toLocaleString()} issues</span>
                            <span className="text-muted-foreground/35">·</span>
                            <span>25 per page</span>
                          </div>
                        </div>
                      </div>

                      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                        {issuesError && (
                          <div className="mb-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
                            {issuesError}
                          </div>
                        )}

                        {issuesLoading ? (
                          <div className="flex items-center justify-center py-16">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                          </div>
                        ) : issues.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-16 text-center">
                            <Bug className="h-9 w-9 text-muted-foreground/45" />
                            <p className="mt-3 text-sm font-medium">No issues found</p>
                            <p className="mt-1 text-xs text-muted-foreground/75">
                              Adjust the issue filter, sorting, or search query.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {issues.map((issue) => {
                              const isSelected = selectedIssue?.id === issue.id;
                              return (
                                <button
                                  key={issue.id}
                                  onClick={() => setSelectedIssue(issue)}
                                  className={cn(
                                    'w-full rounded-2xl border px-4 py-3 text-left transition-colors',
                                    isSelected
                                      ? 'border-primary/35 bg-primary/8'
                                      : 'border-border/60 bg-background/40 hover:bg-muted/30',
                                  )}
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <span>#{issue.number}</span>
                                        <span className="text-muted-foreground/35">·</span>
                                        <span>{formatIssueTimestamp(issue.updated_at)}</span>
                                      </div>
                                      <h4 className="mt-1 line-clamp-2 text-sm font-medium">{issue.title}</h4>
                                      {issue.body && (
                                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/75">
                                          {issue.body}
                                        </p>
                                      )}
                                      <div className="mt-3 flex flex-wrap gap-1.5">
                                        {issue.labels.slice(0, 4).map((label) => (
                                          <span
                                            key={`${issue.id}:${label.name}`}
                                            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                                            style={{
                                              backgroundColor: `#${label.color}20`,
                                              color: `#${label.color}`,
                                            }}
                                          >
                                            {label.name}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                    <div className="shrink-0 text-xs text-muted-foreground">
                                      {issue.comments} comments
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between border-t border-border/60 px-6 py-4">
                        <div className="text-xs text-muted-foreground">
                          Page {issuePage} of {issueTotalPages}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setIssuePage((page) => Math.max(1, page - 1))}
                            disabled={!issueHasPreviousPage || issuesLoading}
                            className="inline-flex items-center gap-1 rounded-xl border border-border/60 px-3 py-2 text-sm transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <ChevronLeft className="h-4 w-4" />
                            Previous
                          </button>
                          <button
                            onClick={() => setIssuePage((page) => page + 1)}
                            disabled={!issueHasNextPage || issuesLoading}
                            className="inline-flex items-center gap-1 rounded-xl border border-border/60 px-3 py-2 text-sm transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Next
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="flex min-h-0 flex-col">
                      {selectedIssue ? (
                        <>
                          <div className="border-b border-border/60 px-6 py-5">
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <span>Issue #{selectedIssue.number}</span>
                                  <span className="text-muted-foreground/35">·</span>
                                  <span>{selectedIssue.user.login}</span>
                                </div>
                                <h4 className="mt-2 text-base font-semibold">{selectedIssue.title}</h4>
                                <div className="mt-3 flex flex-wrap gap-1.5">
                                  {selectedIssue.labels.map((label) => (
                                    <span
                                      key={`${selectedIssue.id}:${label.name}`}
                                      className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                                      style={{
                                        backgroundColor: `#${label.color}20`,
                                        color: `#${label.color}`,
                                      }}
                                    >
                                      {label.name}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <a
                                href={selectedIssue.html_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-border/60 px-3 py-2 text-xs font-medium transition-colors hover:bg-muted/40"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                GitHub
                              </a>
                            </div>

                            <div className="mt-5 flex flex-wrap gap-2">
                              <button
                                onClick={() => void handleAttachRepo(selectedIssue, false)}
                                disabled={actionLoading !== null}
                                className="inline-flex items-center gap-2 rounded-xl border border-border/60 bg-background/80 px-3 py-2 text-sm font-medium transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <FolderGit2 className="h-4 w-4" />
                                Attach repo
                              </button>
                              <button
                                onClick={() => void handleAttachRepo(selectedIssue, true)}
                                disabled={actionLoading !== null}
                                className="inline-flex items-center gap-2 rounded-xl border border-primary/35 bg-primary/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {actionLoading === 'fix' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                                Fix issue in chat
                              </button>
                            </div>
                          </div>

                          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                            <div className="rounded-2xl border border-border/60 bg-background/40 p-4">
                              <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                Issue Description
                              </div>
                              <div className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
                                {selectedIssue.body?.trim() || 'No issue description provided.'}
                              </div>
                            </div>

                            <div className="mt-4 rounded-2xl border border-border/60 bg-muted/15 p-4 text-sm text-muted-foreground">
                              <div className="flex items-center gap-2 font-medium text-foreground">
                                <GitFork className="h-4 w-4" />
                                Editable target
                              </div>
                              <p className="mt-2">
                                {workingRepo?.full_name || selectedRepo.full_name}
                              </p>
                              {workingRepo?.full_name !== selectedRepo.full_name && (
                                <p className="mt-2 text-xs text-muted-foreground/80">
                                  Pull requests stay targeted at {selectedRepo.full_name}, but edits are staged against your fork.
                                </p>
                              )}
                              {workingRepo?.localClone.path && (
                                <p className="mt-2 break-all text-xs text-muted-foreground/80">
                                  Local clone: {workingRepo.localClone.path}
                                </p>
                              )}
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
                          <Bug className="h-10 w-10 text-muted-foreground/45" />
                          <p className="mt-3 text-sm font-medium">Choose an issue</p>
                          <p className="mt-1 text-xs text-muted-foreground/75">
                            Selecting an issue prepares the repo attachment and one-click fix workflow.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
};
