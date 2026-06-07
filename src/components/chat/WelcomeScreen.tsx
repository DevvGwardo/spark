import React, { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FolderGit2, X, ChevronDown, Loader2, Code2, Globe, FileCode, Server, Search, Bug, TestTube2, Zap } from 'lucide-react';
import { useChangesetStore } from '@/stores/changeset-store';
import { useChatScopeId } from '@/contexts/PanelContext';
import { useSettingsStore } from '@/stores/settings-store';
import { usePreviewStore } from '@/stores/preview-store';
import { getApiBaseUrl, fetchRepoFileTreeResult } from '@/lib/api';
import { cn } from '@/lib/utils';
import { WelcomeHeroMark } from './WelcomeHeroMark';
import { OnboardingMotionConfig, Stagger, StaggerItem, SOFT_SPRING, fadeInUp } from '@/components/onboarding/motion';

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  permissions?: {
    pull?: boolean;
    push?: boolean;
    admin?: boolean;
  };
}

interface SuggestionChip {
  icon: React.ReactNode;
  label: string;
  prompt: string;
}

const generalSuggestions: SuggestionChip[] = [
  { icon: <Globe className="h-3.5 w-3.5" />, label: 'Build a landing page', prompt: 'Build a modern landing page with a hero section, features grid, and a call-to-action footer' },
  { icon: <Code2 className="h-3.5 w-3.5" />, label: 'Create a React component', prompt: 'Create a reusable React component with TypeScript, props interface, and clean styling' },
  { icon: <FileCode className="h-3.5 w-3.5" />, label: 'Write a Python script', prompt: 'Write a Python script that automates a common task with proper error handling and logging' },
  { icon: <Server className="h-3.5 w-3.5" />, label: 'Design a REST API', prompt: 'Design a RESTful API with proper endpoints, request/response schemas, and error handling' },
];

const repoSuggestions: SuggestionChip[] = [
  { icon: <Search className="h-3.5 w-3.5" />, label: 'Explain the codebase structure', prompt: 'Explain the overall structure and architecture of this codebase. What are the main modules, and how do they interact?' },
  { icon: <Bug className="h-3.5 w-3.5" />, label: 'Find and fix bugs', prompt: 'Analyze the codebase for potential bugs, edge cases, or error-handling issues and suggest fixes' },
  { icon: <TestTube2 className="h-3.5 w-3.5" />, label: 'Add unit tests', prompt: 'Identify areas lacking test coverage and write comprehensive unit tests for the most critical modules' },
  { icon: <Zap className="h-3.5 w-3.5" />, label: 'Refactor for performance', prompt: 'Review the codebase for performance bottlenecks and refactor the most impactful areas for better efficiency' },
];

interface WelcomeScreenProps {
  onSendMessage?: (message: string) => void;
  disableRepoActions?: boolean;
}

export const WelcomeScreen = React.forwardRef<HTMLDivElement, WelcomeScreenProps>(({
  onSendMessage,
  disableRepoActions = false,
}, ref) => {
  const scopeId = useChatScopeId();
  const setPreviewView = usePreviewStore((s) => s.setPreferredView);
  const {
    getChangeset,
    clearActiveRepo: clearActiveRepoForPanel,
    switchActiveRepo,
    setRepoFileTree,
    getChangeCount,
  } = useChangesetStore();
  const { activeRepo, isRepoMode } = getChangeset(scopeId);
  const clearActiveRepo = () => clearActiveRepoForPanel(scopeId);
  const { githubPAT } = useSettingsStore();
  const activeProvider = useSettingsStore((s) => s.activeProvider);
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
        .then(r => { if (!r.ok) throw new Error(`Server returned ${r.status}`); return r.json(); })
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

  const handleSelectRepo = async (repo: GitHubRepo) => {
    const [owner, repoName] = (repo.full_name ?? '').split('/');
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
    setOpen(false);
    setSearch('');
    useChangesetStore.getState().setRepoFileTreeStatus(scopeId, 'loading');
    setPreviewView(scopeId, 'repo');

    // Fetch full file tree so the agent knows what files exist
    if (githubPAT) {
      const result = await fetchRepoFileTreeResult(githubPAT, owner, repoName, repo.default_branch);
      if (result.error) {
        useChangesetStore.getState().setRepoFileTreeStatus(scopeId, 'error', result.error);
      } else {
        setRepoFileTree(scopeId, result.paths);
      }
    }
  };

  const filteredRepos = repos.filter(r =>
    (r.full_name ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <OnboardingMotionConfig>
    <div ref={ref} className="flex flex-col items-center justify-center h-full px-4 md:px-6">
      <Stagger className="w-full text-center max-w-[520px]">
        {/* Hero mark — refined sizing, with a soft entrance pop + idle float */}
        <StaggerItem className="flex justify-center mb-5 md:mb-6">
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: [0, -5, 0] }}
            transition={{
              opacity: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
              scale: SOFT_SPRING,
              y: { duration: 5, repeat: Infinity, ease: 'easeInOut', delay: 0.5 },
            }}
            className="relative"
          >
            <div className="pointer-events-none absolute inset-0 -z-10 rounded-[24px] bg-primary/20 blur-2xl" aria-hidden />
            <WelcomeHeroMark className="h-16 w-16 md:h-20 md:w-20 rounded-[20px] md:rounded-[24px]" />
          </motion.div>
        </StaggerItem>

        {/* Title block */}
        <StaggerItem>
          <h1 className="text-[20px] md:text-[22px] font-semibold tracking-[-0.02em] text-foreground">
            What do you want to build?
          </h1>
        </StaggerItem>
        <StaggerItem>
          <p className="mt-1.5 text-[13px] md:text-[14px] text-muted-foreground">
            {activeProvider === 'hermes'
              ? 'Chat, or hand off a task to your Hermes agent — it can browse, run code, and manage your repos.'
              : 'Start a conversation or pick a suggestion to get going.'}
          </p>
        </StaggerItem>

        {/* Repo selector / active badge */}
        <StaggerItem className="mt-5">
          {isRepoMode && activeRepo ? (
            <div className="inline-flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-full bg-primary/8 border border-primary/15 text-[12px] text-primary/90 font-medium">
              <FolderGit2 className="h-3.5 w-3.5 opacity-70" />
              <span className="font-mono">{activeRepo.fullName}</span>
              {getChangeset(scopeId).repoFileTreeStatus === 'loading' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary/80">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  Loading
                </span>
              )}
              <button
                onClick={clearActiveRepo}
                className="ml-0.5 p-1 rounded-full hover:bg-primary/15 transition-colors"
                title="Stop editing"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : githubPAT ? (
            <div ref={dropdownRef} className="relative inline-block">
              <button
                onClick={() => setOpen(!open)}
                className={cn(
                  'inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border text-[12px] font-medium transition-all duration-150',
                  open
                    ? 'border-primary/30 bg-primary/5 text-foreground shadow-sm'
                    : 'border-border/60 hover:border-border hover:bg-secondary/40 text-muted-foreground'
                )}
              >
                <FolderGit2 className="h-3.5 w-3.5" />
                <span>Select a repo</span>
                {loading ? (
                  <Loader2 className="h-3 w-3 animate-spin ml-0.5" />
                ) : (
                  <ChevronDown className={cn('h-3 w-3 ml-0.5 transition-transform duration-200', open && 'rotate-180')} />
                )}
              </button>

              <AnimatePresence>
              {open && (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.97 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-80 origin-top bg-popover/95 backdrop-blur-xl border border-border/60 rounded-xl shadow-2xl shadow-black/20 z-50 overflow-hidden"
                >
                  <div className="p-2">
                    <input
                      type="text"
                      placeholder="Search repositories..."
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      className="w-full px-3 py-2 text-[12px] bg-secondary/40 border border-border/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 placeholder:text-muted-foreground/50 transition-all"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-56 overflow-y-auto px-1.5 pb-1.5">
                    {loading ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : filteredRepos.length === 0 ? (
                      <div className="px-3 py-4 text-[12px] text-muted-foreground/60 text-center">
                        {search ? 'No repos match your search' : 'No repositories found'}
                      </div>
                    ) : (
                      filteredRepos.map(repo => (
                        <button
                          key={repo.id}
                          onClick={() => handleSelectRepo(repo)}
                          className="w-full flex items-center gap-2.5 px-2.5 py-2 text-left rounded-lg hover:bg-secondary/60 active:bg-secondary transition-colors"
                        >
                          <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[12px] font-medium truncate">{repo.full_name}</span>
                              {repo.private && (
                                <span className="text-[10px] leading-none px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground/70 font-medium shrink-0">
                                  Private
                                </span>
                              )}
                            </div>
                            {repo.description && (
                              <p className="text-[11px] text-muted-foreground/50 truncate mt-0.5">{repo.description}</p>
                            )}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
              </AnimatePresence>
            </div>
          ) : null}
        </StaggerItem>

        {/* Suggestion chips */}
        <StaggerItem className="mt-6">
          <Stagger className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {(isRepoMode && activeRepo ? repoSuggestions : generalSuggestions).map((chip) => (
              <motion.button
                key={chip.label}
                variants={fadeInUp}
                whileHover={disableRepoActions ? undefined : { scale: 1.02, y: -2 }}
                whileTap={disableRepoActions ? undefined : { scale: 0.98 }}
                onClick={() => onSendMessage?.(chip.prompt)}
                disabled={disableRepoActions}
                className={cn(
                  'flex items-center gap-2.5 px-3.5 py-3 rounded-[10px] bg-[#1E1E1E] border border-[#2F2F2F] text-left',
                  'hover:border-primary/30 hover:bg-[#252525] transition-colors duration-150',
                  'text-[12px] text-[#8A8A8A] hover:text-foreground',
                  disableRepoActions && 'cursor-not-allowed opacity-50 hover:border-[#2F2F2F] hover:bg-[#1E1E1E] hover:text-[#8A8A8A]',
                )}
              >
                <span className="shrink-0 text-muted-foreground">{chip.icon}</span>
                <span className="font-normal">{chip.label}</span>
              </motion.button>
            ))}
          </Stagger>
        </StaggerItem>
      </Stagger>
    </div>
    </OnboardingMotionConfig>
  );
});
WelcomeScreen.displayName = 'WelcomeScreen';
