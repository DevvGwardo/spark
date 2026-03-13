import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TimerReset,
  X,
  XCircle,
} from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { cn } from '@/lib/utils';
import { getApiBaseUrl } from '@/lib/api';
import { GhostIcon } from '@/components/chat/GhostIcon';
import { Progress } from '@/components/ui/progress';

interface FileChange {
  path: string;
  content: string;
  action?: 'create' | 'edit' | 'delete';
  originalContent?: string;
}

interface CreatePRModalProps {
  isOpen: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  baseOwner?: string;
  baseRepo?: string;
  baseBranch: string;
  files: FileChange[];
  onSuccess?: () => void;
}

type MergeMethod = 'squash' | 'merge' | 'rebase';
type CheckStatus = 'success' | 'failure' | 'pending';

interface CreatedPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
}

interface PullRequestCheck {
  name: string;
  provider: string;
  status: CheckStatus;
  detailsUrl: string | null;
  summary: string | null;
}

interface PullRequestCheckProvider {
  name: string;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  checks: PullRequestCheck[];
}

interface PullRequestStatus {
  pr: CreatedPullRequest & {
    merged: boolean;
    mergeable: boolean | null;
    mergeableState: string | null;
  };
  checks: {
    overall: 'passing' | 'failing' | 'pending' | 'none';
    summary: {
      total: number;
      passed: number;
      failed: number;
      pending: number;
    };
    providers: PullRequestCheckProvider[];
  };
}

interface VerificationFinding {
  severity: 'low' | 'medium' | 'high';
  title: string;
  summary: string;
  file?: string;
  suggestion?: string;
}

interface VerificationCommand {
  name: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  summary: string;
  output: string;
  exitCode: number | null;
}

interface VerificationResult {
  summary: {
    status: 'passed' | 'failed' | 'warning';
    findings: number;
    commandsRun: number;
    commandsFailed: number;
  };
  review: {
    status: 'passed' | 'warning' | 'skipped';
    summary: string;
    findings: VerificationFinding[];
  };
  commands: VerificationCommand[];
}

function makeDefaultBranchName() {
  return `ai/chat-changes-${Date.now()}`;
}

function getStatusIcon(status: CheckStatus) {
  if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (status === 'failure') return <XCircle className="h-4 w-4 text-rose-400" />;
  return <Loader2 className="h-4 w-4 animate-spin text-amber-300" />;
}

function getMergeButtonLabel(method: MergeMethod) {
  if (method === 'merge') return 'Merge pull request';
  if (method === 'rebase') return 'Rebase and merge';
  return 'Squash and merge';
}

function getChecksHeadline(summary: PullRequestStatus['checks']['summary']) {
  if (summary.failed > 0) {
    return `${summary.failed} check${summary.failed === 1 ? '' : 's'} failed`;
  }
  if (summary.pending > 0) {
    return `${summary.pending} check${summary.pending === 1 ? '' : 's'} pending`;
  }
  if (summary.total > 0) {
    return `${summary.passed} / ${summary.total} checks passed`;
  }
  return 'No checks reported yet';
}

const VERIFICATION_PROGRESS_STEPS = [
  { threshold: 0, label: 'Cloning repository snapshot', detail: 'Pulling the base branch into a clean workspace.' },
  { threshold: 24, label: 'Finding project workspace', detail: 'Locating the package.json closest to the changed files.' },
  { threshold: 46, label: 'Installing dependencies', detail: 'Using the detected package manager for that workspace.' },
  { threshold: 68, label: 'Running validation scripts', detail: 'Checking lint, types, tests, and build scripts when available.' },
  { threshold: 86, label: 'Generating provider review', detail: 'Asking the selected model for a final code review pass.' },
] as const;

export const CreatePRModal: React.FC<CreatePRModalProps> = ({
  isOpen,
  onClose,
  owner,
  repo,
  baseOwner,
  baseRepo,
  baseBranch,
  files,
  onSuccess,
}) => {
  const { githubPAT, activeProvider, providers } = useSettingsStore();
  const createFormId = useId();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [branchName, setBranchName] = useState(makeDefaultBranchName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdPr, setCreatedPr] = useState<CreatedPullRequest | null>(null);
  const [prStatus, setPrStatus] = useState<PullRequestStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>('squash');
  const [mergeTitle, setMergeTitle] = useState('');
  const [mergeBody, setMergeBody] = useState('');
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState<string | null>(null);
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null);
  const [verificationProgress, setVerificationProgress] = useState(0);

  const activeProviderConfig = providers[activeProvider];
  const pullRequestBaseOwner = baseOwner || owner;
  const pullRequestBaseRepo = baseRepo || repo;
  const filesFingerprint = useMemo(
    () => JSON.stringify(files.map((file) => [file.path, file.action || 'edit', file.content, file.originalContent || ''])),
    [files],
  );

  const handleRunVerification = useCallback(async () => {
    if (!githubPAT || files.length === 0) return;

    setVerificationLoading(true);
    setVerificationError(null);

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'verify-changes',
            pat: githubPAT,
            owner,
            repo,
            baseBranch,
            files: files.map((file) => ({
              path: file.path,
              content: file.content,
              action: file.action || 'edit',
              originalContent: file.originalContent,
            })),
            provider: activeProvider,
            model: activeProviderConfig.model,
            apiKey: activeProviderConfig.apiKey,
          }),
        },
      );

      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = await response.json();
      if (data.error) {
        setVerificationError(data.error);
        return;
      }

      setVerificationResult(data as VerificationResult);
    } catch {
      setVerificationError('Failed to review staged changes');
    } finally {
      setVerificationLoading(false);
    }
  }, [activeProvider, activeProviderConfig.apiKey, activeProviderConfig.model, baseBranch, files, githubPAT, owner, repo]);

  const loadPullRequestStatus = useCallback(async () => {
    if (!githubPAT || !createdPr) return;

    setStatusLoading(true);
    setStatusError(null);

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'get-pr-status',
            pat: githubPAT,
            owner,
            repo,
            ...(baseOwner ? { baseOwner } : {}),
            ...(baseRepo ? { baseRepo } : {}),
            number: createdPr.number,
          }),
        },
      );

      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = await response.json();
      if (data.error) {
        setStatusError(data.error);
        return;
      }

      setPrStatus(data as PullRequestStatus);
    } catch {
      setStatusError('Failed to load pull request checks');
    } finally {
      setStatusLoading(false);
    }
  }, [baseOwner, baseRepo, createdPr, githubPAT, owner, repo]);

  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setBody('');
      setBranchName(makeDefaultBranchName());
      setLoading(false);
      setError(null);
      setCreatedPr(null);
      setPrStatus(null);
      setStatusLoading(false);
      setStatusError(null);
      setMergeMethod('squash');
      setMergeTitle('');
      setMergeBody('');
      setMergeLoading(false);
      setMergeError(null);
      setMergeSuccess(null);
      setVerificationLoading(false);
      setVerificationError(null);
      setVerificationResult(null);
      setVerificationProgress(0);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || createdPr) return;
    setVerificationLoading(false);
    setVerificationError(null);
    setVerificationResult(null);
    setVerificationProgress(0);
  }, [baseBranch, createdPr, filesFingerprint, isOpen, owner, repo]);

  useEffect(() => {
    if (!verificationLoading) {
      setVerificationProgress(0);
      return;
    }

    setVerificationProgress(12);
    const interval = window.setInterval(() => {
      setVerificationProgress((current) => {
        const remaining = 94 - current;
        if (remaining <= 0) {
          return 94;
        }

        return Math.min(94, current + Math.max(3, remaining * 0.22));
      });
    }, 420);

    return () => window.clearInterval(interval);
  }, [verificationLoading]);

  useEffect(() => {
    if (!createdPr || !isOpen) return;
    void loadPullRequestStatus();

    const interval = window.setInterval(() => {
      if (!mergeSuccess) {
        void loadPullRequestStatus();
      }
    }, 15000);

    return () => window.clearInterval(interval);
  }, [createdPr, isOpen, loadPullRequestStatus, mergeSuccess]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !branchName.trim() || files.length === 0) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create-pr',
            pat: githubPAT,
            owner,
            repo,
            ...(baseOwner ? { baseOwner } : {}),
            ...(baseRepo ? { baseRepo } : {}),
            title,
            body,
            branch: branchName,
            baseBranch,
            files: files.map((file) => ({
              path: file.path,
              content: file.content,
              action: file.action || 'edit',
            })),
          }),
        },
      );

      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = await response.json();
      if (data.error) {
        setError(data.error);
        return;
      }

      const nextPr = data.pr as CreatedPullRequest;
      setCreatedPr(nextPr);
      setMergeTitle(nextPr.title || title);
      setMergeBody(nextPr.body || body);
      onSuccess?.();
    } catch {
      setError('Failed to create pull request');
    } finally {
      setLoading(false);
    }
  };

  const handleMerge = async () => {
    if (!createdPr) return;

    setMergeLoading(true);
    setMergeError(null);

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'merge-pr',
            pat: githubPAT,
            owner,
            repo,
            ...(baseOwner ? { baseOwner } : {}),
            ...(baseRepo ? { baseRepo } : {}),
            number: createdPr.number,
            method: mergeMethod,
            commitTitle: mergeTitle,
            commitMessage: mergeBody,
          }),
        },
      );

      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = await response.json();
      if (data.error) {
        setMergeError(data.error);
        return;
      }

      setMergeSuccess(data?.merged?.message || 'Pull request merged successfully.');
      await loadPullRequestStatus();
    } catch {
      setMergeError('Failed to merge pull request');
    } finally {
      setMergeLoading(false);
    }
  };

  const mergeBlockedReason = useMemo(() => {
    if (!createdPr) return null;
    if (mergeSuccess) return 'This pull request has already been merged.';
    if (!prStatus) return 'Refreshing pull request status...';
    if (prStatus.pr.merged) return 'This pull request is already merged.';
    if (prStatus.pr.state !== 'open') return 'This pull request is closed.';
    if (prStatus.pr.draft) return 'Convert the pull request from draft before merging.';
    if (prStatus.pr.mergeable === false || prStatus.pr.mergeableState === 'dirty') {
      return 'Resolve merge conflicts before merging.';
    }
    if (prStatus.checks.overall === 'failing') return 'Fix failing checks before merging.';
    if (prStatus.checks.overall === 'pending') return 'Wait for checks to finish before merging.';
    return null;
  }, [createdPr, mergeSuccess, prStatus]);

  const mergeDisabled = !createdPr || !!mergeBlockedReason || mergeLoading || statusLoading;
  const verificationRequired = files.length > 0;
  const verificationComplete = !verificationRequired || verificationResult !== null;
  const createDisabled = loading || !title.trim() || files.length === 0 || verificationLoading || !verificationComplete;
  const createLabel = verificationResult?.summary.status === 'failed' ? 'Create PR anyway' : 'Create PR';
  const verificationHeadline = verificationResult
    ? verificationResult.summary.status === 'failed'
      ? `${verificationResult.summary.commandsFailed} command${verificationResult.summary.commandsFailed === 1 ? '' : 's'} failed`
      : verificationResult.review.status === 'skipped'
        ? 'Provider review skipped'
      : verificationResult.summary.status === 'warning'
        ? `${verificationResult.summary.findings} review finding${verificationResult.summary.findings === 1 ? '' : 's'}`
        : 'Verification passed'
    : 'Run a repo review and validation pass before opening the pull request.';
  const activeVerificationStep = VERIFICATION_PROGRESS_STEPS.reduce(
    (currentStep, step) => (verificationProgress >= step.threshold ? step : currentStep),
    VERIFICATION_PROGRESS_STEPS[0],
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={onClose} />
      <div className="relative mx-4 flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-[26px] border border-border/70 bg-background/96 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/60 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/70 bg-muted/30">
              <GitPullRequest className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <h2 className="text-base font-semibold">
                {createdPr ? 'Review Pull Request' : 'Create Pull Request'}
              </h2>
              <p className="text-xs text-muted-foreground">
                {owner}/{repo} → {pullRequestBaseOwner}/{pullRequestBaseRepo}:{baseBranch}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl border border-border/60 p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          data-testid="create-pr-modal-scroll-region"
          className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
        >
          {!createdPr ? (
            <form id={createFormId} onSubmit={handleSubmit} className="space-y-5">
              <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
                      Staged Files
                    </div>
                    <div className="mt-1 text-sm font-medium">
                      {files.length} {files.length === 1 ? 'file' : 'files'} ready for review
                    </div>
                  </div>
                    <div className="rounded-full border border-border/70 px-3 py-1 font-mono text-xs text-muted-foreground">
                    {owner}/{repo}
                    </div>
                </div>

                <div className="mt-4 max-h-44 overflow-y-auto rounded-2xl border border-border/60 bg-background/70">
                  {files.map((file) => (
                    <div
                      key={file.path}
                      className="flex items-center gap-3 border-b border-border/50 px-3 py-2 text-xs last:border-b-0"
                    >
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                          file.action === 'create'
                            ? 'bg-emerald-500/12 text-emerald-400'
                            : file.action === 'delete'
                              ? 'bg-rose-500/12 text-rose-400'
                              : 'bg-amber-500/12 text-amber-300',
                        )}
                      >
                        {file.action || 'edit'}
                      </span>
                      <span className="truncate font-mono text-foreground/85">{file.path}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-5 lg:grid-cols-[1.25fr_0.95fr]">
                <div className="min-w-0 space-y-4">
                  <div>
                    <label className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Pull Request Title
                    </label>
                    <input
                      type="text"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      className="w-full rounded-2xl border border-border/70 bg-background px-4 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="feat: polish the workspace shell"
                      required
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Description
                    </label>
                    <textarea
                      value={body}
                      onChange={(event) => setBody(event.target.value)}
                      rows={6}
                      className="w-full rounded-2xl border border-border/70 bg-background px-4 py-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="Summarize what changed, why, and anything reviewers should check."
                    />
                  </div>
                </div>

                <div className="min-w-0 space-y-4">
                  <div className="rounded-2xl border border-border/70 bg-muted/15 p-4">
                    <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Review & Checks
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {verificationHeadline}
                    </p>

                    <button
                      type="button"
                      onClick={() => void handleRunVerification()}
                      disabled={verificationLoading || files.length === 0}
                      className="mt-4 inline-flex items-center gap-2 rounded-2xl border border-border/70 bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {verificationLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                      {verificationResult ? 'Re-run review & checks' : 'Run review & checks'}
                    </button>

                    {verificationError && (
                      <div className="mt-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                        {verificationError}
                      </div>
                    )}

                    {verificationResult && (
                      <div className="mt-4 space-y-3">
                        <div
                          className={cn(
                            'rounded-2xl border px-4 py-3 text-sm',
                            verificationResult.summary.status === 'failed'
                              ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                              : verificationResult.summary.status === 'warning'
                                ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
                          )}
                        >
                          {verificationResult.review.summary}
                        </div>

                        <div className="space-y-2">
                          {verificationResult.commands.map((command) => (
                            <details
                              key={`${command.name}-${command.command}`}
                              className="overflow-hidden rounded-2xl border border-border/60 bg-background/65"
                            >
                              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm">
                                <div className="flex items-center gap-3">
                                  {getStatusIcon(command.status === 'skipped' ? 'pending' : command.status)}
                                  <span className="font-medium">{command.name}</span>
                                </div>
                                <span className="text-xs text-muted-foreground">{command.command}</span>
                              </summary>
                              <div className="border-t border-border/50 px-4 py-3 text-xs text-muted-foreground">
                                <div>{command.summary}</div>
                                {command.output ? (
                                  <pre className="mt-3 max-h-40 overflow-auto rounded-xl border border-border/60 bg-background/80 p-3 text-[11px] leading-relaxed text-foreground/75">
                                    {command.output}
                                  </pre>
                                ) : null}
                              </div>
                            </details>
                          ))}
                        </div>

                        {verificationResult.review.findings.length > 0 ? (
                          <div className="space-y-2">
                            {verificationResult.review.findings.map((finding, index) => (
                              <div
                                key={`${finding.title}-${index}`}
                                className="rounded-2xl border border-border/60 bg-background/65 px-4 py-3 text-sm"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {finding.severity}
                                  </span>
                                  <span className="font-medium text-foreground">{finding.title}</span>
                                </div>
                                <p className="mt-2 text-muted-foreground">{finding.summary}</p>
                                {finding.file ? (
                                  <div className="mt-2 font-mono text-xs text-muted-foreground">{finding.file}</div>
                                ) : null}
                                {finding.suggestion ? (
                                  <p className="mt-2 text-xs text-muted-foreground">{finding.suggestion}</p>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>

                  <div className="rounded-2xl border border-border/70 bg-muted/15 p-4">
                    <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Branch Settings
                    </div>
                    <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                      <GitBranch className="h-3.5 w-3.5" />
                      base
                      <span className="font-mono text-foreground">{baseBranch}</span>
                    </div>
                    <div className="mt-3">
                      <label className="mb-2 block text-xs font-medium text-muted-foreground">
                        Head branch
                      </label>
                      <input
                        type="text"
                        value={branchName}
                        onChange={(event) => setBranchName(event.target.value)}
                        className="w-full rounded-xl border border-border/70 bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                        placeholder="feature/ai-changes"
                      />
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border/70 bg-muted/15 p-4 text-sm text-muted-foreground">
                    The modal will stay open after creation so you can watch checks and merge when the pull request is ready.
                  </div>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {!verificationComplete && (
                <div className="flex items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  <span>Run review &amp; checks before creating the pull request.</span>
                </div>
              )}

            </form>
          ) : (
            <div className="space-y-5">
              <div className="rounded-[24px] border border-border/70 bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.08),_transparent_45%),linear-gradient(180deg,rgba(255,255,255,0.04),transparent)] p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-muted-foreground">
                      Pull Request #{createdPr.number}
                      <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] normal-case tracking-normal text-foreground/70">
                        {prStatus?.pr.merged ? 'Merged' : createdPr.state}
                      </span>
                    </div>
                    <h3 className="mt-2 text-xl font-semibold tracking-tight">{createdPr.title}</h3>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-3 py-1">
                        <GitBranch className="h-3.5 w-3.5" />
                        {createdPr.headBranch} → {createdPr.baseBranch}
                      </span>
                      {prStatus?.pr.mergeableState && (
                        <span className="rounded-full border border-border/60 px-3 py-1 capitalize">
                          merge state: {prStatus.pr.mergeableState.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void loadPullRequestStatus()}
                      className="inline-flex items-center gap-2 rounded-2xl border border-border/70 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                      <RefreshCw className={cn('h-4 w-4', statusLoading && 'animate-spin')} />
                      Refresh
                    </button>
                    <a
                      href={createdPr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 rounded-2xl bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
                    >
                      View on GitHub
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </div>
                </div>
              </div>

              <div className="grid gap-5 xl:grid-cols-[1.2fr_0.85fr]">
                <div className="space-y-4">
                  <section className="rounded-[24px] border border-border/70 bg-muted/15 p-5">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        {prStatus?.checks.overall === 'failing' ? (
                          <ShieldAlert className="h-5 w-5 text-rose-400" />
                        ) : prStatus?.checks.overall === 'passing' ? (
                          <ShieldCheck className="h-5 w-5 text-emerald-400" />
                        ) : (
                          <TimerReset className="h-5 w-5 text-amber-300" />
                        )}
                        <div>
                          <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
                            Status Checks
                          </div>
                          <div className="mt-1 text-lg font-semibold">
                            {prStatus ? getChecksHeadline(prStatus.checks.summary) : 'Loading checks…'}
                          </div>
                        </div>
                      </div>
                      {prStatus && (
                        <div className="rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground">
                          {prStatus.checks.summary.passed} passed
                          {prStatus.checks.summary.failed > 0 ? ` · ${prStatus.checks.summary.failed} failed` : ''}
                          {prStatus.checks.summary.pending > 0 ? ` · ${prStatus.checks.summary.pending} pending` : ''}
                        </div>
                      )}
                    </div>

                    {statusError && (
                      <div className="mt-4 flex items-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        <span>{statusError}</span>
                      </div>
                    )}

                    <div className="mt-4 space-y-3">
                      {statusLoading && !prStatus ? (
                        <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-background/60 px-4 py-3 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Pulling latest checks from GitHub…
                        </div>
                      ) : prStatus && prStatus.checks.providers.length > 0 ? (
                        prStatus.checks.providers.map((provider) => (
                          <details
                            key={provider.name}
                            open
                            className="overflow-hidden rounded-2xl border border-border/60 bg-background/65"
                          >
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm">
                              <div className="flex items-center gap-3">
                                {provider.failed > 0 ? (
                                  <XCircle className="h-4 w-4 text-rose-400" />
                                ) : provider.pending > 0 ? (
                                  <Loader2 className="h-4 w-4 animate-spin text-amber-300" />
                                ) : (
                                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                                )}
                                <span className="font-medium">{provider.name}</span>
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {provider.failed > 0
                                  ? `${provider.failed} failed`
                                  : provider.pending > 0
                                    ? `${provider.pending} pending`
                                    : `${provider.passed}/${provider.total} passed`}
                              </span>
                            </summary>
                            <div className="border-t border-border/50 px-4 py-2">
                              {provider.checks.map((check) => (
                                <div
                                  key={`${provider.name}-${check.name}`}
                                  className="flex items-start justify-between gap-3 border-b border-border/40 py-2 text-sm last:border-b-0"
                                >
                                  <div className="flex min-w-0 items-start gap-3">
                                    {getStatusIcon(check.status)}
                                    <div className="min-w-0">
                                      <div className="truncate font-medium">{check.name}</div>
                                      {check.summary && (
                                        <div className="mt-0.5 text-xs text-muted-foreground">{check.summary}</div>
                                      )}
                                    </div>
                                  </div>
                                  {check.detailsUrl ? (
                                    <a
                                      href={check.detailsUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="shrink-0 rounded-full border border-border/60 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                                    >
                                      Open
                                    </a>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </details>
                        ))
                      ) : (
                        <div className="rounded-2xl border border-border/60 bg-background/60 px-4 py-3 text-sm text-muted-foreground">
                          No checks are attached yet. Refresh after your GitHub providers finish reporting.
                        </div>
                      )}
                    </div>
                  </section>
                </div>

                <div className="space-y-4">
                  <section className="rounded-[24px] border border-border/70 bg-muted/15 p-5">
                    <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
                      Merge Controls
                    </div>
                    <div className="mt-4 space-y-4">
                      <div>
                        <label className="mb-2 block text-xs font-medium text-muted-foreground">
                          Merge strategy
                        </label>
                        <select
                          value={mergeMethod}
                          onChange={(event) => setMergeMethod(event.target.value as MergeMethod)}
                          className="w-full rounded-2xl border border-border/70 bg-background px-3 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                          <option value="squash">Squash and merge</option>
                          <option value="merge">Create merge commit</option>
                          <option value="rebase">Rebase and merge</option>
                        </select>
                      </div>

                      <div>
                        <label className="mb-2 block text-xs font-medium text-muted-foreground">
                          Commit message
                        </label>
                        <input
                          type="text"
                          value={mergeTitle}
                          onChange={(event) => setMergeTitle(event.target.value)}
                          className="w-full rounded-2xl border border-border/70 bg-background px-3 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-xs font-medium text-muted-foreground">
                          Description
                        </label>
                        <textarea
                          value={mergeBody}
                          onChange={(event) => setMergeBody(event.target.value)}
                          rows={5}
                          className="w-full rounded-2xl border border-border/70 bg-background px-3 py-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                          placeholder="Add context for the final merge commit."
                        />
                      </div>

                      {mergeBlockedReason ? (
                        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                          {mergeBlockedReason}
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                          Checks are clear. This pull request is ready to merge.
                        </div>
                      )}

                      {mergeError && (
                        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                          {mergeError}
                        </div>
                      )}

                      {mergeSuccess && (
                        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                          {mergeSuccess}
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              </div>
            </div>
          )}
        </div>

        {createdPr ? (
          <div className="flex items-center justify-between border-t border-border/60 bg-background/96 px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl border border-border/70 px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleMerge}
              disabled={mergeDisabled}
              className={cn(
                'inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-medium transition-opacity',
                mergeDisabled
                  ? 'cursor-not-allowed border border-border/60 bg-muted/30 text-muted-foreground'
                  : 'bg-foreground text-background hover:opacity-90',
              )}
            >
              {mergeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitPullRequest className="h-4 w-4" />}
              {getMergeButtonLabel(mergeMethod)}
            </button>
          </div>
        ) : (
          <div
            data-testid="create-pr-modal-footer"
            className="flex items-center justify-between gap-3 border-t border-border/60 bg-background/96 px-6 py-4"
          >
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl border border-border/70 px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              form={createFormId}
              disabled={createDisabled}
              className="inline-flex items-center gap-2 rounded-2xl bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitPullRequest className="h-4 w-4" />}
              {createLabel}
            </button>
          </div>
        )}

        {verificationLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/72 backdrop-blur-md">
            <div
              role="status"
              aria-live="polite"
              className="mx-6 w-full max-w-md rounded-[28px] border border-border/70 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.08),_transparent_55%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.38)]"
            >
              <div className="flex flex-col items-center text-center">
                <div className="relative flex h-28 w-28 items-center justify-center rounded-full border border-border/60 bg-background/80 shadow-[0_0_0_14px_rgba(255,255,255,0.03)]">
                  <GhostIcon size={72} />
                </div>
                <div className="mt-5 inline-flex items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.24em] text-emerald-200/90">
                  Review &amp; Checks
                </div>
                <h3 className="mt-4 text-xl font-semibold tracking-tight text-foreground">
                  Running verification
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {activeVerificationStep.detail}
                </p>
              </div>

              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  <span>{activeVerificationStep.label}</span>
                  <span className="font-mono text-foreground/85">{Math.round(verificationProgress)}%</span>
                </div>
                <Progress
                  value={verificationProgress}
                  className="h-2.5 bg-background/70 [&>div]:bg-[linear-gradient(90deg,rgba(245,208,84,0.95),rgba(16,185,129,0.95))]"
                />
              </div>

              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                {VERIFICATION_PROGRESS_STEPS.map((step) => {
                  const isActive = activeVerificationStep.label === step.label;
                  const isComplete = verificationProgress > step.threshold + 8;

                  return (
                    <div
                      key={step.label}
                      className={cn(
                        'rounded-2xl border px-3 py-2 text-left',
                        isActive
                          ? 'border-emerald-500/35 bg-emerald-500/10 text-foreground'
                          : isComplete
                            ? 'border-border/60 bg-background/60 text-foreground/80'
                            : 'border-border/50 bg-background/35 text-muted-foreground',
                      )}
                    >
                      <div className="text-[11px] font-medium uppercase tracking-[0.18em]">
                        {step.label}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
