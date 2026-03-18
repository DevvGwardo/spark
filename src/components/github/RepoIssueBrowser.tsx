import React, { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertCircle,
  AtSign,
  Bell,
  BookMarked,
  BookOpen,
  Bug,
  Check,
  Code2,
  Copy,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleX,
  Download,
  ExternalLink,
  GitBranch,
  GitFork,
  GitPullRequest,
  Languages,
  Loader2,
  MessageCircle,
  MessageSquare,
  Paperclip,
  Plus,
  Reply,
  Search,
  Send,
  Settings,
  SmilePlus,
  Sparkles,
  Star,
  Timer,
  Trash2,
  Type,
  X,
  ArrowDown,
  ArrowUp,
} from 'lucide-react';
import {
  addCommentReaction,
  cloneGitHubRepo,
  createGitHubIssue,
  createIssueBranch,
  createIssueComment,
  forkGitHubRepo,
  getRepoActivity,
  listGitHubIssues,
  listGitHubRepos,
  listIssueComments,
  listLinkedPRs,
  searchGitHubRepos,
  translateText,
  type GitHubIssueComment,
  type GitHubIssueSummary,
  type GitHubRepoSummary,
  type LinkedPR,
  type ReactionContent,
  type RepoActivityData,
} from '@/lib/api';
import { buildIssueExplainPrompt, buildIssueFixPrompt } from '@/lib/issue-chat-prompts';
import { attachRepoToPanel, getPanelChatScopeId, startRepoChatInNewThread } from '@/lib/repo-workflow';
import { cn } from '@/lib/utils';
import { type ActiveRepo } from '@/stores/changeset-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

// ─── Design tokens ───────────────────────────────────────────
const V4 = {
  bgPage: '#0B0B0E',
  bgCard: '#16161A',
  bgElevated: '#1A1A1E',
  bgDetail: '#0F0F12',
  bgHover: 'rgba(255,255,255,0.03)',
  bgSelected: 'rgba(255,255,255,0.05)',
  borderSubtle: '#2A2A2E',
  borderStrong: '#3A3A40',
  textPrimary: '#FAFAF9',
  textSecondary: '#6B6B70',
  textTertiary: '#4A4A50',
  textMuted: '#8E8E93',
  accentAmber: '#F59E0B',
  accentAmberDark: '#E88B00',
  accentGreen: '#32D583',
  accentIndigo: '#6366F1',
  accentCoral: '#E85A4F',
  accentRed: '#EF4444',
  accentPurple: '#8B5CF6',
  accentBlue: '#3178C6',
  fontHeading: "'Fraunces', serif",
  fontBody: "'DM Sans', sans-serif",
} as const;

const overlayMotion = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
  transition: { duration: 0.15, ease: 'easeOut' as const },
};

// ─── Types & constants ───────────────────────────────────────
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
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
];

const AVATAR_COLORS = ['#D97706', '#3B82F6', '#A855F7', '#EF4444', '#22C55E', '#EC4899', '#6366F1', '#14B8A6'];

const sortIcons: Record<string, React.FC<{ className?: string; style?: React.CSSProperties }>> = {
  'updated:desc': Timer,
  'created:desc': ArrowDown,
  'created:asc': ArrowUp,
  'comments:desc': MessageCircle,
};

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

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

function toActiveRepo(issueRepo: GitHubRepoSummary, editableRepo: GitHubRepoSummary, issue?: GitHubIssueSummary | null): ActiveRepo {
  return {
    owner: editableRepo.owner.login,
    name: editableRepo.name,
    defaultBranch: editableRepo.default_branch,
    fullName: editableRepo.full_name,
    permissions: editableRepo.permissions,
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
            body: issue.body,
            url: issue.html_url,
            state: issue.state,
            labels: issue.labels.map((label) => label.name).filter(Boolean),
            updatedAt: issue.updated_at,
          },
        }
      : {}),
  };
}

// ─── Ghost button helper ─────────────────────────────────────
function GhostBtn({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      style={{ borderColor: V4.borderSubtle, color: V4.textSecondary }}
      {...props}
    >
      {children}
    </button>
  );
}

// ─── Overlay backdrop ────────────────────────────────────────
function OverlayBackdrop({ onClick }: { onClick: () => void }) {
  return <div className="fixed inset-0 z-30" onClick={onClick} />;
}

// ─── Main component ──────────────────────────────────────────
export const RepoIssueBrowser: React.FC<RepoIssueBrowserProps> = ({ isOpen, onClose }) => {
  const { githubPAT } = useSettingsStore();
  const activeProvider = useSettingsStore((s) => s.activeProvider);
  const activeProviderConfig = useSettingsStore((s) => s.providers[s.activeProvider]);
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const capturedPanelIdRef = useRef(focusedPanelId);
  useEffect(() => {
    if (isOpen) {
      capturedPanelIdRef.current = focusedPanelId;
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const targetPanelId = isOpen ? capturedPanelIdRef.current : focusedPanelId;
  const { setActiveTab, setSettingsOpen } = useUIStore();
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
  const [issueRefreshNonce, setIssueRefreshNonce] = useState(0);
  const [issueSort, setIssueSort] = useState<IssueSort>('updated');
  const [issueDirection, setIssueDirection] = useState<IssueDirection>('desc');
  const [issueState, setIssueState] = useState<IssueState>('open');
  const [activeLabels, setActiveLabels] = useState<string[]>([]);
  const [knownLabels, setKnownLabels] = useState<Array<{ name: string; color: string }>>([]);
  const [actionLoading, setActionLoading] = useState<'clone' | 'fork' | 'attach' | 'fix' | 'explain' | 'branch' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [translatedTitle, setTranslatedTitle] = useState<string | null>(null);
  const [translatedBody, setTranslatedBody] = useState<string | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const [comments, setComments] = useState<GitHubIssueComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [linkedPRs, setLinkedPRs] = useState<LinkedPR[]>([]);
  const [linkedPRsLoaded, setLinkedPRsLoaded] = useState(false);
  const [createdBranch, setCreatedBranch] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [activityData, setActivityData] = useState<RepoActivityData | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState(false);
  const [activityRetryNonce, setActivityRetryNonce] = useState(0);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [replyingTo, setReplyingTo] = useState<GitHubIssueComment | null>(null);
  const [replySubmitting, setReplySubmitting] = useState(false);
  const [reactionPickerCommentId, setReactionPickerCommentId] = useState<number | null>(null);
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const [createIssueTitle, setCreateIssueTitle] = useState('');
  const [createIssueBody, setCreateIssueBody] = useState('');
  const [createIssueSubmitting, setCreateIssueSubmitting] = useState(false);
  const [createIssueError, setCreateIssueError] = useState<string | null>(null);
  // V4 overlay state
  const [overlayOpen, setOverlayOpen] = useState<'filter' | 'sort' | 'actions' | 'repoSwitcher' | null>(null);
  const [cmdSearchQuery, setCmdSearchQuery] = useState('');

  // ─── Effects ─────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (overlayOpen) {
          setOverlayOpen(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, overlayOpen]);

  useEffect(() => {
    if (!isOpen || !githubPAT) return;
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
          if (!current) return result.repos[0] || null;
          return result.repos.find((repo) => repo.full_name === current.full_name) || result.repos[0] || null;
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setRepoError(error instanceof Error ? error.message : 'Failed to load repositories');
      })
      .finally(() => {
        if (!cancelled) setRepoLoading(false);
      });
    return () => { cancelled = true; };
  }, [deferredRepoQuery, githubPAT, isOpen]);

  useEffect(() => {
    if (!selectedRepo) {
      setWorkingRepo(null);
      return;
    }
    setWorkingRepo(selectedRepo);
    setIssuePage(1);
    setSelectedIssue(null);
    setActiveLabels([]);
    setKnownLabels([]);
    setActionError(null);
    setCreateIssueOpen(false);
    setCreateIssueTitle('');
    setCreateIssueBody('');
    setCreateIssueError(null);
  }, [selectedRepo]);

  useEffect(() => {
    if (!selectedRepo || !githubPAT) {
      setActivityData(null);
      setActivityLoading(false);
      setActivityError(false);
      return;
    }
    let cancelled = false;
    setActivityLoading(true);
    setActivityError(false);
    getRepoActivity(githubPAT, selectedRepo.owner.login, selectedRepo.name)
      .then((data) => { if (!cancelled) { setActivityData(data); setActivityLoading(false); } })
      .catch(() => { if (!cancelled) { setActivityData(null); setActivityLoading(false); setActivityError(true); } });
    return () => { cancelled = true; };
  }, [selectedRepo, githubPAT, activityRetryNonce]);

  useEffect(() => {
    setTranslatedTitle(null);
    setTranslatedBody(null);
    setShowTranslation(false);
    setComments([]);
    setCommentsLoading(false);
    setLinkedPRs([]);
    setLinkedPRsLoaded(false);
    setCreatedBranch(null);
    setCopied(false);
    setShowComments(true);
    setReplyingTo(null);
    setReactionPickerCommentId(null);
  }, [selectedIssue]);

  useEffect(() => {
    if (!selectedIssue || !selectedRepo || !githubPAT) return;
    let cancelled = false;
    listLinkedPRs(githubPAT, selectedRepo.owner.login, selectedRepo.name, selectedIssue.number)
      .then((prs) => { if (!cancelled) { setLinkedPRs(prs); setLinkedPRsLoaded(true); } })
      .catch(() => { if (!cancelled) setLinkedPRsLoaded(true); });
    if (selectedIssue.comments > 0) {
      setCommentsLoading(true);
      listIssueComments(githubPAT, selectedRepo.owner.login, selectedRepo.name, selectedIssue.number)
        .then((result) => { if (!cancelled) setComments(result); })
        .catch((error) => { if (!cancelled) setActionError(error instanceof Error ? error.message : 'Failed to load comments'); })
        .finally(() => { if (!cancelled) setCommentsLoading(false); });
    }
    return () => { cancelled = true; };
  }, [selectedIssue, selectedRepo, githubPAT]);

  useEffect(() => {
    if (!isOpen || !githubPAT || !selectedRepo) return;
    let cancelled = false;
    setIssuesLoading(true);
    setIssuesError(null);
    listGitHubIssues(githubPAT, selectedRepo.owner.login, selectedRepo.name, {
      page: issuePage,
      sort: issueSort,
      direction: issueDirection,
      state: issueState,
      query: deferredIssueQuery,
      labels: activeLabels.length > 0 ? activeLabels : undefined,
    })
      .then((result) => {
        if (cancelled) return;
        setIssues(result.issues);
        setIssueTotalPages(result.totalPages);
        setIssueTotalCount(result.totalCount);
        setIssueHasNextPage(result.hasNextPage);
        setIssueHasPreviousPage(result.hasPreviousPage);
        setSelectedIssue((current) => current && result.issues.some((issue) => issue.id === current.id) ? current : result.issues[0] || null);
        setKnownLabels((prev) => {
          const seen = new Map(prev.map((l) => [l.name, l.color]));
          for (const issue of result.issues) {
            for (const label of issue.labels) {
              if (label.name && !seen.has(label.name)) {
                seen.set(label.name, label.color);
              }
            }
          }
          return Array.from(seen.entries()).map(([name, color]) => ({ name, color })).sort((a, b) => a.name.localeCompare(b.name));
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setIssuesError(error instanceof Error ? error.message : 'Failed to load issues');
      })
      .finally(() => { if (!cancelled) setIssuesLoading(false); });
    return () => { cancelled = true; };
  }, [activeLabels, deferredIssueQuery, githubPAT, isOpen, issueDirection, issuePage, issueRefreshNonce, issueSort, issueState, selectedRepo]);

  const selectedSortKey = useMemo(() => `${issueSort}:${issueDirection}`, [issueDirection, issueSort]);
  const selectedSortLabel = useMemo(
    () => issueSortOptions.find((o) => `${o.value}:${o.direction}` === selectedSortKey)?.label || 'Updated',
    [selectedSortKey],
  );
  const createIssueTitleTrimmed = createIssueTitle.trim();

  const resetCreateIssueDraft = () => {
    setCreateIssueOpen(false);
    setCreateIssueTitle('');
    setCreateIssueBody('');
    setCreateIssueError(null);
  };

  const openCreateIssueDraft = () => {
    setCreateIssueOpen(true);
    setCreateIssueError(null);
    setSelectedIssue(null);
  };

  // ─── Handlers (unchanged) ─────────────────────────────────
  const handleCloneRepo = async () => {
    if (!githubPAT || !selectedRepo) return;
    const repoAtCallTime = selectedRepo;
    setActionLoading('clone');
    setActionError(null);
    try {
      const result = await cloneGitHubRepo(githubPAT, repoAtCallTime.owner.login, repoAtCallTime.name, repoAtCallTime.default_branch);
      setSelectedRepo(result.repo);
      setWorkingRepo((current) => current?.full_name === repoAtCallTime.full_name ? result.repo : current);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to clone repository');
    } finally {
      setActionLoading(null);
    }
  };

  const handleForkRepo = async () => {
    if (!githubPAT || !selectedRepo) return;
    const repoAtCallTime = selectedRepo;
    setActionLoading('fork');
    setActionError(null);
    try {
      const result = await forkGitHubRepo(githubPAT, repoAtCallTime.owner.login, repoAtCallTime.name, repoAtCallTime.default_branch);
      setWorkingRepo(result.repo);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to fork repository');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreateIssue = async () => {
    if (!githubPAT || !selectedRepo || !createIssueTitleTrimmed) return;
    setCreateIssueSubmitting(true);
    setCreateIssueError(null);
    try {
      const createdIssue = await createGitHubIssue(githubPAT, selectedRepo.owner.login, selectedRepo.name, {
        title: createIssueTitleTrimmed,
        ...(createIssueBody.trim() ? { body: createIssueBody.trim() } : {}),
      });
      setIssueQuery('');
      setIssueState('open');
      setIssueSort('created');
      setIssueDirection('desc');
      setActiveLabels([]);
      setIssuePage(1);
      setIssues((current) => [createdIssue, ...current.filter((issue) => issue.id !== createdIssue.id)].slice(0, 25));
      setSelectedIssue(createdIssue);
      setIssueRefreshNonce((current) => current + 1);
      resetCreateIssueDraft();
    } catch (error) {
      setCreateIssueError(error instanceof Error ? error.message : 'Failed to create issue');
    } finally {
      setCreateIssueSubmitting(false);
    }
  };

  const handleAttachRepo = async (issue?: GitHubIssueSummary | null, autoFix = false) => {
    if (!githubPAT || !selectedRepo || !workingRepo) return;
    setActionLoading(autoFix ? 'fix' : 'attach');
    setActionError(null);
    try {
      if (autoFix && issue) {
        const started = await startRepoChatInNewThread({
          panelId: targetPanelId,
          repo: toActiveRepo(selectedRepo, workingRepo, issue),
          githubPAT,
          prompt: buildIssueFixPrompt(selectedRepo, workingRepo, issue),
          openPreview: true,
          repoEditIntentOverride: true,
        });
        if (!started) return;
        setActiveTab('chat');
        onClose();
        return;
      }
      const attached = await attachRepoToPanel({
        panelId: targetPanelId,
        scopeId: getPanelChatScopeId(targetPanelId),
        repo: toActiveRepo(selectedRepo, workingRepo, issue),
        githubPAT,
        openPreview: false,
      });
      if (!attached) return;
      setActiveTab('chat');
      onClose();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to attach repository');
    } finally {
      setActionLoading(null);
    }
  };

  const handleTranslate = async () => {
    if (!selectedIssue || isTranslating) return;
    setIsTranslating(true);
    setActionError(null);
    try {
      const textToTranslate = [`Title: ${selectedIssue.title}`, '', selectedIssue.body?.trim() || ''].join('\n');
      const raw = await translateText(activeProvider, activeProviderConfig.apiKey || '', activeProviderConfig.model, textToTranslate);
      const result = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();
      const lines = result.split('\n');
      const titleLine = lines[0]?.replace(/^Title:\s*/i, '') || selectedIssue.title;
      const bodyText = lines.slice(1).join('\n').trim() || null;
      setTranslatedTitle(titleLine);
      setTranslatedBody(bodyText);
      setShowTranslation(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Translation failed');
    } finally {
      setIsTranslating(false);
    }
  };

  const handleExplainIssue = async () => {
    if (!githubPAT || !selectedRepo || !selectedIssue) return;
    const explainRepo = toActiveRepo(selectedRepo, selectedRepo, selectedIssue);
    setActionLoading('explain');
    setActionError(null);
    try {
      const started = await startRepoChatInNewThread({
        panelId: targetPanelId,
        repo: explainRepo,
        githubPAT,
        prompt: buildIssueExplainPrompt(selectedRepo, selectedRepo, selectedIssue),
        openPreview: false,
        repoEditIntentOverride: false,
      });
      if (!started) return;
      setActiveTab('chat');
      onClose();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to explain issue');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCopyContext = async () => {
    if (!selectedIssue || !selectedRepo) return;
    const labelList = selectedIssue.labels.map((l) => l.name).filter(Boolean).join(', ');
    const md = [
      `# ${selectedIssue.title}`, '', `**Repo:** ${selectedRepo.full_name}`, `**Issue:** #${selectedIssue.number}`,
      `**State:** ${selectedIssue.state}`, labelList ? `**Labels:** ${labelList}` : '', `**URL:** ${selectedIssue.html_url}`,
      '', '## Description', '', selectedIssue.body?.trim() || 'No description provided.',
    ].filter(Boolean).join('\n');
    await navigator.clipboard.writeText(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCreateBranch = async () => {
    if (!githubPAT || !selectedRepo || !workingRepo || !selectedIssue) return;
    setActionLoading('branch');
    setActionError(null);
    try {
      const result = await createIssueBranch(githubPAT, workingRepo.owner.login, workingRepo.name, workingRepo.default_branch, selectedIssue);
      setCreatedBranch(result.branch);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to create branch');
    } finally {
      setActionLoading(null);
    }
  };

  const handleSubmitComment = async () => {
    if (!githubPAT || !selectedRepo || !selectedIssue || !commentText.trim()) return;
    setCommentSubmitting(true);
    setActionError(null);
    try {
      const newComment = await createIssueComment(githubPAT, selectedRepo.owner.login, selectedRepo.name, selectedIssue.number, commentText.trim());
      setComments((prev) => [...prev, newComment]);
      setCommentText('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to post comment');
    } finally {
      setCommentSubmitting(false);
    }
  };

  const handleSubmitReply = async () => {
    if (!githubPAT || !selectedRepo || !selectedIssue || !replyingTo || !commentText.trim()) return;
    setReplySubmitting(true);
    setActionError(null);
    try {
      const quoteLine = replyingTo.body.split('\n')[0].slice(0, 80);
      const body = `> ${quoteLine}${replyingTo.body.length > 80 ? '...' : ''}\n\n@${replyingTo.user.login} ${commentText.trim()}`;
      const newComment = await createIssueComment(githubPAT, selectedRepo.owner.login, selectedRepo.name, selectedIssue.number, body);
      setComments((prev) => [...prev, newComment]);
      setCommentText('');
      setReplyingTo(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to post reply');
    } finally {
      setReplySubmitting(false);
    }
  };

  const handleAddReaction = async (commentId: number, reaction: ReactionContent) => {
    if (!githubPAT || !selectedRepo) return;
    try {
      await addCommentReaction(githubPAT, selectedRepo.owner.login, selectedRepo.name, commentId, reaction);
      setComments((prev) =>
        prev.map((c) =>
          c.id === commentId && c.reactions
            ? { ...c, reactions: { ...c.reactions, [reaction]: (c.reactions[reaction] || 0) + 1 } }
            : c,
        ),
      );
      setReactionPickerCommentId(null);
    } catch {
      setReactionPickerCommentId(null);
    }
  };

  const reactionEmojis: Array<{ content: ReactionContent; emoji: string }> = [
    { content: '+1', emoji: '\u{1F44D}' },
    { content: '-1', emoji: '\u{1F44E}' },
    { content: 'laugh', emoji: '\u{1F604}' },
    { content: 'hooray', emoji: '\u{1F389}' },
    { content: 'heart', emoji: '\u{2764}\u{FE0F}' },
    { content: 'rocket', emoji: '\u{1F680}' },
    { content: 'eyes', emoji: '\u{1F440}' },
  ];

  const workingCopyLabel = workingRepo && selectedRepo && workingRepo.full_name !== selectedRepo.full_name
    ? `Working copy: ${workingRepo.full_name}`
    : null;

  const openCount = issueState === 'open' ? issueTotalCount : issues.filter((i) => i.state === 'open').length;
  const closedCount = issueState === 'closed' ? issueTotalCount : issues.filter((i) => i.state === 'closed').length;

  if (!isOpen) return null;

  // ─── Render ─────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative flex flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{ width: 1340, maxWidth: '95vw', height: 860, maxHeight: '92vh', background: V4.bgPage, borderColor: V4.borderSubtle, fontFamily: V4.fontBody }}
      >
        {/* ─── HEADER ─────────────────────────────────────── */}
        <div className="flex h-14 shrink-0 items-center gap-3.5 border-b px-6" style={{ borderColor: V4.borderSubtle }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `linear-gradient(135deg, ${V4.accentAmber}, ${V4.accentAmberDark})`, boxShadow: '0 0 16px rgba(245,158,11,0.25)' }}>
            <Sparkles className="h-[18px] w-[18px]" style={{ color: V4.bgPage }} />
          </div>
          <div>
            <h2 className="text-[17px] font-semibold leading-tight" style={{ fontFamily: V4.fontHeading, color: V4.textPrimary }}>Repo Issues</h2>
            <p className="text-[11px]" style={{ color: V4.textSecondary }}>Browse and manage repository issues</p>
          </div>
          <div className="flex-1" />
          <div className="flex h-[34px] w-[280px] items-center gap-2 rounded-lg border px-3" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
            <Search className="h-3.5 w-3.5 shrink-0" style={{ color: V4.textTertiary }} />
            <input value={cmdSearchQuery} onChange={(e) => setCmdSearchQuery(e.target.value)} placeholder="Quick search or jump to..." className="flex-1 bg-transparent text-xs outline-none placeholder:text-[#4A4A50]" style={{ color: V4.textPrimary }} />
            <kbd className="rounded border px-1.5 py-0.5 text-[10px]" style={{ borderColor: V4.borderStrong, color: V4.textTertiary, background: V4.bgElevated }}>⌘K</kbd>
          </div>
          <button className="flex h-[34px] w-[34px] items-center justify-center rounded-lg border transition-colors hover:bg-white/[0.03]" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
            <Bell className="h-4 w-4" style={{ color: V4.textSecondary }} />
          </button>
          <button onClick={() => { onClose(); setSettingsOpen(true); }} className="flex h-[34px] w-[34px] items-center justify-center rounded-lg border transition-colors hover:bg-white/[0.03]" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
            <Settings className="h-4 w-4" style={{ color: V4.textSecondary }} />
          </button>
          <div className="h-6 w-px" style={{ background: V4.borderSubtle }} />
          <div className="flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-semibold text-white" style={{ background: `linear-gradient(135deg, ${V4.accentIndigo}, ${V4.accentPurple})` }}>H</div>
          <button onClick={onClose} className="flex h-[34px] w-[34px] items-center justify-center rounded-lg transition-colors hover:bg-white/[0.03]" aria-label="Close">
            <X className="h-4 w-4" style={{ color: V4.textTertiary }} />
          </button>
        </div>

        {!githubPAT ? (
          /* ─── No PAT state ──────────────────────────────── */
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <AlertCircle className="h-10 w-10" style={{ color: V4.textTertiary }} />
            <div>
              <h3 className="text-sm font-semibold" style={{ color: V4.textPrimary }}>GitHub access is required</h3>
              <p className="mt-1 text-xs" style={{ color: V4.textSecondary }}>Add a GitHub PAT in settings before browsing repositories or loading issues.</p>
            </div>
            <button onClick={() => { onClose(); setSettingsOpen(true); }} className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-white/[0.03]" style={{ borderColor: V4.borderSubtle, color: V4.textPrimary }}>
              Open settings
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* ─── REPOS PANEL ───────────────────────────── */}
            <div className="flex w-[280px] shrink-0 flex-col border-r" style={{ borderColor: V4.borderSubtle, background: V4.bgPage }}>
              <div className="p-4">
                <div className="flex h-9 items-center gap-2 rounded-lg border px-3" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
                  <Search className="h-3.5 w-3.5 shrink-0" style={{ color: V4.textTertiary }} />
                  <input value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} placeholder="Search repos..." className="w-full bg-transparent text-[13px] outline-none placeholder:text-[#4A4A50]" style={{ color: V4.textPrimary }} />
                </div>
              </div>

              {/* Activity */}
              {activityLoading && !activityData && (
                <div className="flex flex-col gap-1.5 px-4 pb-3">
                  <span className="text-[11px] font-semibold uppercase tracking-[1px]" style={{ fontFamily: V4.fontHeading, color: V4.textSecondary }}>Activity</span>
                  <div className="flex h-[52px] items-end gap-[2px] rounded-xl border p-2" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
                    {Array.from({ length: 30 }, (_, i) => (
                      <div key={i} className="flex-1 animate-pulse rounded-[2px]" style={{ height: Math.max(4, Math.round(Math.random() * 30)), backgroundColor: '#F59E0B18', minWidth: 3 }} />
                    ))}
                  </div>
                </div>
              )}
              {activityError && !activityLoading && !activityData && (
                <div className="flex flex-col gap-1.5 px-4 pb-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-[1px]" style={{ fontFamily: V4.fontHeading, color: V4.textSecondary }}>Activity</span>
                    <button onClick={() => setActivityRetryNonce((n) => n + 1)} className="text-[10px] transition-colors" style={{ color: V4.accentAmber }}>Retry</button>
                  </div>
                  <div className="flex h-[52px] items-center justify-center rounded-xl border" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
                    <span className="text-[11px]" style={{ color: V4.textTertiary }}>Failed to load activity</span>
                  </div>
                </div>
              )}
              {activityData && activityData.days.length > 0 && (
                <div className="flex flex-col gap-1.5 px-4 pb-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-[1px]" style={{ fontFamily: V4.fontHeading, color: V4.textSecondary }}>Activity</span>
                    <span className="text-[10px]" style={{ color: V4.textTertiary }}>30d</span>
                  </div>
                  <div className="flex h-[52px] items-end gap-[2px] rounded-xl border p-2" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
                    {activityData.days.map((count, i) => {
                      const max = Math.max(...activityData.days, 1);
                      const ratio = count / max;
                      const height = Math.max(2, Math.round(ratio * 40));
                      const alpha = count === 0 ? '18' : ratio < 0.2 ? '33' : ratio < 0.4 ? '55' : ratio < 0.65 ? '80' : ratio < 0.85 ? 'BB' : '';
                      return <div key={i} className="flex-1 rounded-[2px]" style={{ height, backgroundColor: `#F59E0B${alpha}`, minWidth: 3 }} />;
                    })}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <div className="flex items-center gap-1">
                      <div className="h-[5px] w-[5px] rounded-full" style={{ background: V4.accentAmber }} />
                      <span className="text-[10px]" style={{ color: V4.textSecondary }}>{activityData.totalCommits}{activityData.commitsCapped ? '+' : ''} {selectedRepo?.default_branch || 'default'} commits</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="h-[5px] w-[5px] rounded-full" style={{ background: V4.accentBlue }} />
                      <span className="text-[10px]" style={{ color: V4.textSecondary }}>{activityData.openedPullRequests} PRs</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="h-[5px] w-[5px] rounded-full" style={{ background: V4.accentGreen }} />
                      <span className="text-[10px]" style={{ color: V4.textSecondary }}>{activityData.openedIssues} issues</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="px-4 pb-2">
                <p className="text-[11px] font-semibold uppercase tracking-[1.2px]" style={{ fontFamily: V4.fontHeading, color: V4.textTertiary }}>
                  {deferredRepoQuery ? 'Search Results' : 'Recent'}
                </p>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
                {repoError && (
                  <div className="mb-2 rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: '#EF444430', background: '#EF444410', color: '#FCA5A5' }}>{repoError}</div>
                )}
                {repoLoading ? (
                  <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" style={{ color: V4.textTertiary }} /></div>
                ) : repos.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                    <GitBranch className="h-8 w-8" style={{ color: V4.borderSubtle }} />
                    <p className="mt-3 text-[13px] font-medium" style={{ color: V4.textPrimary }}>No repositories found</p>
                    <p className="mt-1 text-[11px]" style={{ color: V4.textTertiary }}>Try a different repo name or owner.</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {repos.map((repo) => {
                      const isSelected = selectedRepo?.full_name === repo.full_name;
                      return (
                        <button
                          key={repo.id || repo.full_name}
                          onClick={() => { setSelectedRepo(repo); setWorkingRepo(repo); }}
                          className="flex w-full items-center gap-2.5 rounded-lg p-2.5 text-left transition-all duration-200"
                          style={{
                            background: isSelected ? V4.bgElevated : 'transparent',
                            borderLeft: isSelected ? `3px solid ${V4.accentAmber}` : '3px solid transparent',
                          }}
                        >
                          <GitBranch className="mt-0.5 h-4 w-4 shrink-0" style={{ color: isSelected ? V4.accentAmber : V4.textTertiary }} />
                          <div className="min-w-0 flex-1">
                            <span className={cn('block truncate text-[13px]', isSelected ? 'font-semibold' : 'font-medium')} style={{ color: isSelected ? V4.textPrimary : '#DDDDDDB3' }}>{repo.name}</span>
                            <span className="block truncate text-[11px]" style={{ color: V4.textSecondary }}>{repo.owner.login}</span>
                            {repo.description && <p className="mt-0.5 line-clamp-2 text-[11px] leading-[1.4]" style={{ color: V4.textSecondary }}>{repo.description}</p>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* ─── ISSUES PANEL ──────────────────────────── */}
            <div className="flex min-w-0 flex-1 flex-col border-r" style={{ borderColor: V4.borderSubtle }}>
              {!selectedRepo ? (
                <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
                  <Sparkles className="h-10 w-10" style={{ color: V4.borderSubtle }} />
                  <p className="mt-3 text-[13px] font-medium" style={{ color: V4.textPrimary }}>Pick a repository</p>
                  <p className="mt-1 text-[11px]" style={{ color: V4.textTertiary }}>The issue list, sorting controls, and repo actions appear here once a repository is selected.</p>
                </div>
              ) : (
                <>
                  {/* Repo info bar */}
                  <div className="border-b px-6 py-5" style={{ borderColor: V4.borderSubtle }}>
                    <div className="flex flex-col gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <BookMarked className="h-5 w-5" style={{ color: V4.textSecondary }} />
                          <h3 className="text-[18px] font-semibold" style={{ color: V4.textPrimary, letterSpacing: '-0.2px' }}>{selectedRepo.full_name}</h3>
                        </div>
                        {selectedRepo.description && <p className="mt-1.5 text-[13px]" style={{ color: V4.textMuted }}>{selectedRepo.description}</p>}
                        <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px]" style={{ color: V4.textSecondary }}>
                          {selectedRepo.stargazers_count != null && (
                            <span className="inline-flex items-center gap-1"><Star className="h-3 w-3" />{selectedRepo.stargazers_count.toLocaleString()}</span>
                          )}
                          {selectedRepo.forks_count != null && (
                            <span className="inline-flex items-center gap-1"><GitFork className="h-3 w-3" />{selectedRepo.forks_count.toLocaleString()}</span>
                          )}
                          {selectedRepo.language && (
                            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: V4.accentBlue }} />{selectedRepo.language}</span>
                          )}
                          <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" />{selectedRepo.default_branch}</span>
                        </div>
                      </div>
                      {workingCopyLabel && (
                        <div className="inline-flex w-fit items-center gap-1.5 rounded-lg border px-2.5 py-1.5" style={{ borderColor: '#3B82F630', background: '#3B82F610' }}>
                          <GitFork className="h-3 w-3 text-[#3B82F6]" />
                          <span className="text-[11px] text-[#3B82F6]">{workingCopyLabel}</span>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <GhostBtn onClick={() => { createIssueOpen ? resetCreateIssueDraft() : openCreateIssueDraft(); }} disabled={createIssueSubmitting}>
                          {createIssueSubmitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                          {createIssueOpen ? 'Cancel draft' : 'New issue'}
                        </GhostBtn>
                        <GhostBtn onClick={() => void handleAttachRepo(null, false)} disabled={actionLoading !== null}>
                          <Paperclip className="h-3 w-3" />
                          {actionLoading === 'attach' ? 'Attaching...' : 'Attach'}
                        </GhostBtn>
                        <button
                          onClick={() => void handleCloneRepo()}
                          disabled={selectedRepo.localClone.exists || actionLoading !== null}
                          className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
                          style={{ borderColor: `${V4.accentAmber}33`, color: V4.accentAmber }}
                        >
                          <Download className="h-3 w-3" />
                          {actionLoading === 'clone' ? 'Cloning...' : selectedRepo.localClone.exists ? 'Clone ready' : 'Clone'}
                        </button>
                        <button
                          onClick={() => void handleForkRepo()}
                          disabled={actionLoading !== null}
                          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
                          style={{ background: V4.accentAmber, color: V4.bgPage }}
                        >
                          <GitFork className="h-3 w-3" />
                          {actionLoading === 'fork' ? 'Forking...' : workingRepo && workingRepo.full_name !== selectedRepo.full_name ? 'Fork ready' : 'Fork & Clone'}
                        </button>
                        <div className="flex-1" />
                        <a href={selectedRepo.html_url} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center rounded-lg border p-1.5 transition-colors hover:bg-white/[0.03]" style={{ borderColor: V4.borderSubtle, color: V4.textSecondary }}>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                    {actionError && (
                      <div className="mt-3 rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: '#EF444430', background: '#EF444410', color: '#FCA5A5' }}>{actionError}</div>
                    )}
                  </div>

                  {/* Search & filter row */}
                  <div className="border-b px-6 py-3" style={{ borderColor: V4.borderSubtle }}>
                    <div className="flex h-8 items-center gap-2 rounded-lg border px-2.5" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
                      <Search className="h-3.5 w-3.5 shrink-0" style={{ color: V4.textTertiary }} />
                      <input
                        value={issueQuery}
                        onChange={(e) => { setIssueQuery(e.target.value); startTransition(() => setIssuePage(1)); }}
                        placeholder="Search issues..."
                        className="w-full bg-transparent text-xs outline-none placeholder:text-[#4A4A50]"
                        style={{ color: V4.textPrimary }}
                      />
                    </div>
                    <div className="mt-2.5 flex items-center gap-1">
                      {issueStateOptions.map((option) => {
                        const isActive = issueState === option.value;
                        return (
                          <button
                            key={option.value}
                            onClick={() => { setIssueState(option.value); setIssuePage(1); }}
                            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] transition-all duration-150"
                            style={{
                              background: isActive ? V4.bgElevated : 'transparent',
                              color: isActive ? V4.textPrimary : V4.textSecondary,
                              fontWeight: isActive ? 500 : 400,
                            }}
                          >
                            {option.label}
                            {option.value === 'open' && openCount > 0 && (
                              <span className="rounded-lg px-1.5 py-px text-[10px] font-medium" style={{ background: `${V4.accentAmber}20`, color: V4.accentAmber }}>{openCount.toLocaleString()}</span>
                            )}
                            {option.value === 'closed' && closedCount > 0 && (
                              <span className="rounded-lg px-1.5 py-px text-[10px] font-medium" style={{ background: `${V4.accentRed}22`, color: V4.accentRed }}>{closedCount.toLocaleString()}</span>
                            )}
                          </button>
                        );
                      })}
                      <div className="flex-1" />
                      <div className="relative">
                        <button
                          onClick={() => setShowSortDropdown((prev) => !prev)}
                          className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors hover:bg-white/[0.03]"
                          style={{ borderColor: V4.borderSubtle, color: V4.textSecondary }}
                        >
                          {selectedSortLabel.split(' ').pop()}
                          <ChevronDown className="h-3 w-3" style={{ color: V4.textTertiary }} />
                        </button>
                        <AnimatePresence>
                          {showSortDropdown && (
                            <>
                              <OverlayBackdrop onClick={() => setShowSortDropdown(false)} />
                              <motion.div
                                {...overlayMotion}
                                className="absolute right-0 top-full z-40 mt-1 w-[240px] overflow-hidden rounded-xl border py-1"
                                style={{ background: V4.bgCard, borderColor: V4.borderSubtle, boxShadow: '0 12px 32px rgba(0,0,0,0.37)' }}
                              >
                                <div className="px-3 py-2">
                                  <span className="text-[15px] font-semibold" style={{ fontFamily: V4.fontHeading, color: V4.textPrimary }}>Sort by</span>
                                </div>
                                {issueSortOptions.map((option) => {
                                  const key = `${option.value}:${option.direction}`;
                                  const isActive = selectedSortKey === key;
                                  const Icon = sortIcons[key] || Timer;
                                  return (
                                    <button
                                      key={key}
                                      onClick={() => { setIssueSort(option.value); setIssueDirection(option.direction); setIssuePage(1); setShowSortDropdown(false); }}
                                      className="flex w-full items-center gap-2.5 px-3 py-2 text-[12px] transition-colors hover:bg-white/[0.03]"
                                      style={{ color: isActive ? V4.textPrimary : V4.textSecondary }}
                                    >
                                      <Icon className="h-3.5 w-3.5" style={{ color: isActive ? V4.accentAmber : V4.textTertiary }} />
                                      <span className="flex-1 text-left">{option.label}</span>
                                      {isActive && <Check className="h-3.5 w-3.5" style={{ color: V4.accentAmber }} />}
                                    </button>
                                  );
                                })}
                              </motion.div>
                            </>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>

                    {/* Labels filter */}
                    {knownLabels.length > 0 && (
                      <div className="mt-2.5 flex items-center gap-2 overflow-x-auto scrollbar-none">
                        {activeLabels.length > 0 && (
                          <button onClick={() => { setActiveLabels([]); setIssuePage(1); }} className="inline-flex shrink-0 items-center gap-1 px-2 py-0.5 text-[10px] transition-colors" style={{ color: V4.textTertiary }}>
                            <X className="h-2.5 w-2.5" /> Clear
                          </button>
                        )}
                        {knownLabels.map((label) => {
                          const isActive = activeLabels.includes(label.name);
                          return (
                            <button
                              key={label.name}
                              onClick={() => { setActiveLabels((prev) => isActive ? prev.filter((l) => l !== label.name) : [...prev, label.name]); setIssuePage(1); }}
                              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[11px] font-medium transition-all duration-150"
                              style={{
                                background: isActive ? `#${label.color}20` : V4.bgCard,
                                borderColor: isActive ? `#${label.color}40` : V4.borderSubtle,
                                color: `#${label.color}`,
                                opacity: isActive ? 1 : 0.7,
                              }}
                            >
                              <span className="h-[6px] w-[6px] rounded-full" style={{ backgroundColor: `#${label.color}` }} />
                              {label.name}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Create issue form */}
                    {createIssueOpen && (
                      <div className="mt-3 overflow-hidden rounded-xl border" style={{ background: V4.bgElevated, borderColor: V4.borderSubtle, boxShadow: '0 12px 32px rgba(0,0,0,0.22)' }}>
                        <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: V4.borderSubtle }}>
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: V4.accentAmber }}>Draft New Issue</p>
                            <p className="mt-0.5 text-[11px]" style={{ color: V4.textSecondary }}>Capture the problem here, then create it directly on GitHub.</p>
                          </div>
                          <button onClick={resetCreateIssueDraft} className="rounded-lg border px-2 py-1 text-[11px] transition-colors hover:bg-white/[0.04]" style={{ borderColor: V4.borderSubtle, color: V4.textSecondary }}>Cancel</button>
                        </div>
                        <div className="space-y-3 px-3.5 py-3.5">
                          <div className="space-y-1.5">
                            <label htmlFor="new-issue-title" className="text-[11px] font-medium" style={{ color: V4.textMuted }}>Title</label>
                            <input
                              id="new-issue-title"
                              value={createIssueTitle}
                              onChange={(e) => setCreateIssueTitle(e.target.value)}
                              placeholder="Describe the bug, task, or improvement"
                              className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none transition-colors placeholder:text-[#4A4A50] focus:border-[#F59E0B66]"
                              style={{ borderColor: V4.borderSubtle, background: V4.bgPage, color: V4.textPrimary }}
                              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleCreateIssue(); } }}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label htmlFor="new-issue-body" className="text-[11px] font-medium" style={{ color: V4.textMuted }}>Details</label>
                            <textarea
                              id="new-issue-body"
                              value={createIssueBody}
                              onChange={(e) => setCreateIssueBody(e.target.value)}
                              placeholder="What should someone know before they pick this up?"
                              rows={6}
                              className="w-full resize-none rounded-lg border px-3 py-2 text-[13px] leading-6 outline-none transition-colors placeholder:text-[#4A4A50] focus:border-[#F59E0B66]"
                              style={{ borderColor: V4.borderSubtle, background: V4.bgPage, color: V4.textPrimary }}
                              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleCreateIssue(); } }}
                            />
                          </div>
                          {createIssueError && (
                            <div className="rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: '#EF444430', background: '#EF444410', color: '#FCA5A5' }}>{createIssueError}</div>
                          )}
                        </div>
                        <div className="flex items-center justify-between border-t px-3.5 py-2.5" style={{ borderColor: V4.borderSubtle }}>
                          <p className="text-[11px]" style={{ color: V4.textTertiary }}>Use Cmd/Ctrl+Enter to create quickly.</p>
                          <button
                            onClick={() => void handleCreateIssue()}
                            disabled={createIssueSubmitting || !createIssueTitleTrimmed}
                            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ background: createIssueTitleTrimmed ? V4.accentAmber : V4.bgElevated, color: createIssueTitleTrimmed ? V4.bgPage : V4.textTertiary }}
                          >
                            {createIssueSubmitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                            Create issue
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Issue list */}
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {issuesError && (
                      <div className="mx-6 mt-3 rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: '#EF444430', background: '#EF444410', color: '#FCA5A5' }}>{issuesError}</div>
                    )}
                    {issuesLoading ? (
                      <div className="flex items-center justify-center py-16"><Loader2 className="h-5 w-5 animate-spin" style={{ color: V4.textTertiary }} /></div>
                    ) : issues.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-16 text-center">
                        <Bug className="h-8 w-8" style={{ color: V4.borderSubtle }} />
                        <p className="mt-3 text-[13px] font-medium" style={{ color: V4.textPrimary }}>No issues found</p>
                        <p className="mt-1 text-[11px]" style={{ color: V4.textTertiary }}>
                          {deferredIssueQuery || activeLabels.length > 0 ? 'Adjust the issue filter, sorting, or search query.' : 'Create the first issue for this repository or adjust the current filters.'}
                        </p>
                        {!createIssueOpen && (
                          <button onClick={openCreateIssueDraft} className="mt-4 inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/[0.03]" style={{ borderColor: V4.borderSubtle, color: V4.textPrimary }}>
                            <Plus className="h-3 w-3" /> New issue
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col">
                        {issues.map((issue) => {
                          const isSelected = selectedIssue?.id === issue.id;
                          return (
                            <button
                              key={issue.id}
                              onClick={() => setSelectedIssue(issue)}
                              className="w-full text-left transition-all duration-200"
                              style={{
                                background: isSelected ? V4.bgCard : 'transparent',
                                borderLeft: isSelected ? `3px solid ${V4.accentAmber}` : '3px solid transparent',
                                borderBottom: `1px solid ${V4.borderSubtle}`,
                                boxShadow: isSelected ? '0 0 20px rgba(245,158,11,0.06)' : 'none',
                              }}
                            >
                              <div className="flex flex-col gap-1.5 px-5 py-3.5">
                                <h4 className={cn('line-clamp-2 text-[14px]', isSelected ? 'font-semibold' : 'font-medium')} style={{ color: V4.textPrimary }}>{issue.title}</h4>
                                {issue.body && <p className="line-clamp-2 text-[13px] leading-[1.4]" style={{ color: V4.textTertiary }}>{issue.body}</p>}
                                <div className="flex items-center gap-2 text-[11px]" style={{ color: V4.textTertiary }}>
                                  <span>#{issue.number}</span>
                                  <span>opened by {issue.user.login}</span>
                                  <span className="flex-1" />
                                  <span>{formatIssueTimestamp(issue.updated_at)}</span>
                                  {issue.comments > 0 && (
                                    <span className="inline-flex items-center gap-1"><MessageSquare className="h-3 w-3" />{issue.comments}</span>
                                  )}
                                </div>
                                {issue.labels.length > 0 && (
                                  <div className="flex flex-wrap gap-1.5">
                                    {issue.labels.slice(0, 4).map((label) => (
                                      <span key={`${issue.id}:${label.name}`} className="inline-flex items-center gap-1 rounded-lg px-1.5 py-px text-[10px] font-medium" style={{ backgroundColor: `#${label.color}18`, color: `#${label.color}` }}>
                                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `#${label.color}` }} />
                                        {label.name}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Pagination */}
                  <div className="flex items-center gap-2 border-t px-6 py-3" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
                    <button onClick={() => setIssuePage((p) => Math.max(1, p - 1))} disabled={!issueHasPreviousPage || issuesLoading} className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] transition-colors hover:bg-white/[0.03] disabled:cursor-not-allowed disabled:opacity-40" style={{ borderColor: V4.borderSubtle, color: V4.textTertiary }}>
                      <ChevronLeft className="h-3 w-3" /> Prev
                    </button>
                    <button onClick={() => setIssuePage((p) => p + 1)} disabled={!issueHasNextPage || issuesLoading} className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] transition-colors hover:bg-white/[0.03] disabled:cursor-not-allowed disabled:opacity-40" style={{ borderColor: V4.borderSubtle, color: V4.textSecondary }}>
                      Next <ChevronRight className="h-3 w-3" />
                    </button>
                    <div className="flex-1" />
                    <span className="text-[11px]" style={{ color: V4.textTertiary }}>{issueTotalCount.toLocaleString()} issues</span>
                    <span className="text-[11px]" style={{ color: V4.textTertiary }}>Page {issuePage} of {issueTotalPages}</span>
                    <span className="rounded-lg border px-2 py-1 text-[11px]" style={{ borderColor: V4.borderSubtle, color: V4.textTertiary, background: V4.bgElevated }}>25 per page</span>
                  </div>
                </>
              )}
            </div>

            {/* ─── DETAIL PANEL ───────────────────────────── */}
            <div className="flex w-[400px] shrink-0 flex-col" style={{ background: V4.bgDetail }}>
              {selectedIssue ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  {/* Detail header */}
                  <div className="border-b px-6 py-5" style={{ borderColor: V4.borderSubtle }}>
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-start gap-2">
                        <h4 className="min-w-0 flex-1 text-[16px] font-semibold leading-[1.4]" style={{ color: V4.textPrimary }}>
                          {showTranslation && translatedTitle ? translatedTitle : selectedIssue.title}
                        </h4>
                        <a href={selectedIssue.html_url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center justify-center rounded-lg border p-1.5 transition-colors hover:bg-white/[0.03]" style={{ borderColor: V4.borderSubtle, color: V4.textTertiary }}>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                      <div className="flex items-center gap-2 text-xs" style={{ color: V4.textTertiary }}>
                        <span className="font-mono text-[11px]">#{selectedIssue.number}</span>
                        <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{
                          background: selectedIssue.state === 'open' ? `${V4.accentGreen}20` : `${V4.accentRed}20`,
                          color: selectedIssue.state === 'open' ? V4.accentGreen : V4.accentRed,
                        }}>
                          <span className="h-[6px] w-[6px] rounded-full" style={{ background: selectedIssue.state === 'open' ? V4.accentGreen : V4.accentRed }} />
                          {selectedIssue.state === 'open' ? 'Open' : 'Closed'}
                        </span>
                        <span>{selectedIssue.user.login} &middot; {formatIssueTimestamp(selectedIssue.updated_at)}</span>
                      </div>
                      {selectedIssue.labels.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {selectedIssue.labels.map((label) => (
                            <span key={label.name} className="rounded-lg px-2.5 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `#${label.color}15`, color: `#${label.color}` }}>{label.name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex flex-col gap-2 border-b px-4 py-3" style={{ borderColor: V4.borderSubtle }}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        onClick={() => void handleAttachRepo(selectedIssue, true)}
                        disabled={actionLoading !== null}
                        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ background: V4.accentAmber, color: V4.bgPage }}
                      >
                        {actionLoading === 'fix' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                        Fix issue
                      </button>
                      <GhostBtn onClick={() => void handleExplainIssue()} disabled={actionLoading !== null}>
                        {actionLoading === 'explain' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Explain'}
                      </GhostBtn>
                      <button onClick={() => void handleCopyContext()} disabled={copied} className="inline-flex items-center justify-center rounded-lg border p-1.5 transition-colors hover:bg-white/[0.03]" style={{ borderColor: V4.borderSubtle, color: copied ? V4.accentAmber : V4.textTertiary }}>
                        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      </button>
                      {!createdBranch && (
                        <button onClick={() => void handleCreateBranch()} disabled={actionLoading !== null} className="inline-flex items-center justify-center rounded-lg border p-1.5 transition-colors hover:bg-white/[0.03] disabled:cursor-not-allowed disabled:opacity-50" style={{ borderColor: V4.borderSubtle, color: V4.textTertiary }}>
                          {actionLoading === 'branch' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        onClick={() => { if (showTranslation) { setShowTranslation(false); } else if (translatedTitle) { setShowTranslation(true); } else { void handleTranslate(); } }}
                        disabled={isTranslating}
                        className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50')}
                        style={{
                          borderColor: showTranslation ? `${V4.accentIndigo}40` : V4.borderSubtle,
                          background: showTranslation ? `${V4.accentIndigo}15` : 'transparent',
                          color: showTranslation ? V4.accentIndigo : V4.textSecondary,
                        }}
                      >
                        {isTranslating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Languages className="h-3 w-3" />}
                        {isTranslating ? 'Translating...' : showTranslation ? 'Original' : 'Translate'}
                      </button>
                      <div className="flex-1" />
                      <GhostBtn onClick={() => void handleAttachRepo(selectedIssue, false)} disabled={actionLoading !== null}>
                        <Paperclip className="h-3 w-3" />
                        {actionLoading === 'attach' ? 'Attaching...' : 'Attach'}
                      </GhostBtn>
                    </div>
                    {createdBranch && (
                      <div className="inline-flex items-center gap-1.5 rounded-lg px-3 py-[7px]" style={{ background: `${V4.accentAmber}15` }}>
                        <GitBranch className="h-3 w-3 shrink-0" style={{ color: V4.accentAmber }} />
                        <span className="min-w-0 truncate font-mono text-[11px] font-medium" style={{ color: V4.accentAmber }}>{createdBranch}</span>
                        <button onClick={() => { void navigator.clipboard.writeText(createdBranch); }} className="shrink-0 transition-colors hover:opacity-80" style={{ color: V4.accentAmber }}><Copy className="h-2.5 w-2.5" /></button>
                      </div>
                    )}
                  </div>

                  {/* Body + PRs — scrollable */}
                  <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5">
                    <div className="whitespace-pre-wrap break-words text-[14px] leading-[1.65]" style={{ color: V4.textMuted }}>
                      {showTranslation && translatedBody ? translatedBody : selectedIssue.body?.trim() || 'No issue description provided.'}
                    </div>

                    {/* Linked PRs */}
                    {linkedPRsLoaded && linkedPRs.length > 0 && (
                      <div className="mt-5 border-t pt-4" style={{ borderColor: V4.borderSubtle }}>
                        <div className="mb-3 flex items-center gap-2">
                          <GitPullRequest className="h-3.5 w-3.5" style={{ color: V4.accentIndigo }} />
                          <span className="text-[12px] font-semibold" style={{ color: V4.textPrimary }}>Linked Pull Requests</span>
                        </div>
                        <div className="flex flex-col gap-2">
                          {linkedPRs.map((pr) => (
                            <a key={pr.number} href={pr.html_url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors hover:bg-white/[0.03]" style={{ background: V4.bgCard, borderColor: V4.borderSubtle, boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
                              <span className={cn('h-[6px] w-[6px] shrink-0 rounded-full')} style={{ background: pr.state === 'open' ? V4.accentGreen : pr.draft ? V4.accentBlue : V4.accentPurple }} />
                              <span className="shrink-0 font-mono text-[11px] font-medium" style={{ color: V4.accentPurple }}>#{pr.number}</span>
                              <span className="min-w-0 flex-1 truncate" style={{ color: V4.textMuted }}>{pr.title}</span>
                              <span className="shrink-0 text-[11px] font-medium" style={{ color: pr.state === 'open' ? V4.accentGreen : pr.draft ? V4.accentBlue : V4.textTertiary }}>
                                {pr.draft ? 'Draft' : pr.state === 'open' ? 'Open' : 'Closed'}
                              </span>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Comments section */}
                  {selectedIssue.comments > 0 && (
                    <div className="flex shrink-0 flex-col overflow-hidden" style={{ maxHeight: showComments ? 230 : undefined }}>
                      <button onClick={() => setShowComments((prev) => !prev)} className="flex w-full items-center justify-between border-t px-6 py-3 pb-1.5 text-xs" style={{ borderColor: V4.borderSubtle }}>
                        <span className="font-semibold" style={{ color: V4.textPrimary }}>Comments ({selectedIssue.comments})</span>
                        {showComments ? <ChevronDown className="h-3.5 w-3.5" style={{ color: V4.textTertiary }} /> : <ChevronUp className="h-3.5 w-3.5" style={{ color: V4.textTertiary }} />}
                      </button>
                      {showComments && (
                        <div className="min-h-0 flex-1 overflow-y-auto px-6">
                          {commentsLoading ? (
                            <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin" style={{ color: V4.textTertiary }} /></div>
                          ) : comments.length === 0 ? (
                            <p className="py-2 text-center text-[11px]" style={{ color: V4.textTertiary }}>No comments loaded.</p>
                          ) : (
                            <div className="flex flex-col">
                              {comments.map((comment, index) => (
                                <div key={comment.id} className={cn('group/comment py-3', index > 0 && 'border-t')} style={{ borderColor: V4.borderSubtle }}>
                                  <div className="flex items-center justify-between text-[11px]">
                                    <div className="flex items-center gap-2">
                                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold" style={{ backgroundColor: getAvatarColor(comment.user.login), color: V4.bgPage }}>{comment.user.login[0]?.toUpperCase()}</span>
                                      <span className="text-xs font-medium" style={{ color: V4.textPrimary }}>{comment.user.login}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <span style={{ color: V4.textTertiary }}>{formatIssueTimestamp(comment.created_at)}</span>
                                      <div className={cn('flex items-center gap-2 transition-opacity', reactionPickerCommentId === comment.id ? 'opacity-100' : 'opacity-0 group-hover/comment:opacity-100')}>
                                        <button onClick={() => { setReplyingTo(comment); setCommentText(''); setReactionPickerCommentId(null); }} className="rounded-md border px-1.5 py-1 transition-colors hover:bg-white/[0.06]" style={{ borderColor: V4.borderSubtle, color: V4.textTertiary }}><Reply className="h-3.5 w-3.5" /></button>
                                        <div className="relative">
                                          <button onClick={() => setReactionPickerCommentId(reactionPickerCommentId === comment.id ? null : comment.id)} className={cn('rounded-md border px-1.5 py-1 transition-colors')} style={{ borderColor: reactionPickerCommentId === comment.id ? `${V4.accentAmber}30` : V4.borderSubtle, background: reactionPickerCommentId === comment.id ? `${V4.accentAmber}15` : 'transparent', color: reactionPickerCommentId === comment.id ? V4.accentAmber : V4.textTertiary }}>
                                            <SmilePlus className="h-3.5 w-3.5" />
                                          </button>
                                          <AnimatePresence>
                                            {reactionPickerCommentId === comment.id && (
                                              <motion.div {...overlayMotion} className="absolute right-0 top-full z-10 mt-1 flex items-center gap-0.5 rounded-[20px] border px-2 py-1.5 shadow-lg" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
                                                {reactionEmojis.map(({ content, emoji }) => (
                                                  <button key={content} onClick={() => void handleAddReaction(comment.id, content)} className="flex h-7 w-7 items-center justify-center rounded-full text-sm transition-all hover:scale-110 hover:bg-white/[0.08]" style={{ filter: 'grayscale(1) brightness(10)' }} title={content}>{emoji}</button>
                                                ))}
                                              </motion.div>
                                            )}
                                          </AnimatePresence>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="mt-2 whitespace-pre-wrap break-words text-xs leading-[1.5]" style={{ color: V4.textSecondary }}>{comment.body}</div>
                                  {comment.reactions && Object.entries(comment.reactions).some(([, v]) => v > 0) && (
                                    <div className="mt-2 flex flex-wrap gap-1">
                                      {reactionEmojis.filter(({ content }) => (comment.reactions?.[content] || 0) > 0).map(({ content, emoji }) => (
                                        <button key={content} onClick={() => setReactionPickerCommentId(reactionPickerCommentId === comment.id ? null : comment.id)} className="inline-flex items-center gap-1 rounded-[10px] border px-2 py-0.5 text-[10px] transition-colors hover:border-[#F59E0B30] hover:bg-[#F59E0B08]" style={{ borderColor: V4.borderSubtle }}>
                                          <span>{emoji}</span><span style={{ color: V4.textSecondary }}>{comment.reactions?.[content]}</span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Comment footer */}
                  <div className="shrink-0 border-t px-4 py-3" style={{ borderColor: V4.borderSubtle }}>
                    <div className="flex flex-col gap-2">
                      {replyingTo && (
                        <div className="flex items-center gap-2 overflow-hidden rounded-t-lg border-b px-3 py-2" style={{ background: V4.bgSelected, borderColor: V4.borderSubtle }}>
                          <Reply className="h-3 w-3 shrink-0" style={{ color: V4.accentAmberDark }} />
                          <span className="text-[11px]" style={{ color: V4.textTertiary }}>Replying to</span>
                          <span className="text-[11px] font-medium" style={{ color: V4.accentAmberDark }}>{replyingTo.user.login}</span>
                          <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: V4.textTertiary }}>{replyingTo.body.split('\n')[0].slice(0, 60)}{replyingTo.body.length > 60 ? '...' : ''}</span>
                          <button onClick={() => setReplyingTo(null)} className="shrink-0 rounded p-0.5 transition-colors hover:bg-white/[0.06]" style={{ color: V4.textTertiary }}><X className="h-3 w-3" /></button>
                        </div>
                      )}
                      <div className="overflow-hidden rounded-xl border" style={{ background: V4.bgCard, borderColor: V4.borderSubtle }}>
                        <div className="px-3.5 py-3">
                          <textarea
                            value={commentText}
                            onChange={(e) => setCommentText(e.target.value)}
                            placeholder={replyingTo ? `Reply to ${replyingTo.user.login}...` : 'Write a comment...'}
                            rows={2}
                            className="w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-[#4A4A50]"
                            style={{ color: V4.textPrimary }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { replyingTo ? void handleSubmitReply() : void handleSubmitComment(); }
                              if (e.key === 'Escape' && replyingTo) setReplyingTo(null);
                            }}
                          />
                        </div>
                        <div className="flex items-center justify-between px-3 py-2">
                          <div className="flex items-center gap-2">
                            <Type className="h-3.5 w-3.5" style={{ color: V4.textTertiary }} />
                            <AtSign className="h-3.5 w-3.5" style={{ color: V4.textTertiary }} />
                            <Code2 className="h-3.5 w-3.5" style={{ color: V4.textTertiary }} />
                          </div>
                          <button
                            onClick={() => { replyingTo ? void handleSubmitReply() : void handleSubmitComment(); }}
                            disabled={(commentSubmitting || replySubmitting) || !commentText.trim()}
                            className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ background: commentText.trim() ? V4.accentAmber : V4.bgElevated, color: commentText.trim() ? V4.bgPage : V4.textTertiary }}
                          >
                            {(commentSubmitting || replySubmitting) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                            {replyingTo ? 'Reply' : 'Comment'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : createIssueOpen ? (
                <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border" style={{ borderColor: V4.borderSubtle, background: V4.bgElevated }}>
                    <Plus className="h-5 w-5" style={{ color: V4.accentAmber }} />
                  </div>
                  <p className="mt-4 text-[13px] font-medium" style={{ color: V4.textPrimary }}>Drafting a new issue</p>
                  <p className="mt-1 max-w-[260px] text-[11px] leading-5" style={{ color: V4.textTertiary }}>Add the title and details in the middle column. Once created, it will open here with attach, explain, and fix actions.</p>
                </div>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                  <Bug className="h-8 w-8" style={{ color: V4.borderSubtle }} />
                  <p className="mt-3 text-[13px] font-medium" style={{ color: V4.textPrimary }}>Choose an issue</p>
                  <p className="mt-1 text-[11px]" style={{ color: V4.textTertiary }}>Selecting an issue prepares the repo attachment and one-click fix workflow.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
