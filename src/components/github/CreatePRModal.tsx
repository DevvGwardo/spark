import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Bold,
  CheckCircle2,
  Code,
  ExternalLink,
  FileCode,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Italic,
  Link as LinkIcon,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tag,
  TimerReset,
  UserPlus,
  X,
  XCircle,
} from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useActivityStore } from '@/stores/activity-store';
import { cn } from '@/lib/utils';
import { getApiBaseUrl } from '@/lib/api';
import { Progress } from '@/components/ui/progress';
import type { PullRequestRecord } from '@/lib/pull-request';

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
  initialPullRequest?: PullRequestRecord | null;
  onPullRequestCreated?: (pr: PullRequestRecord) => void;
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

async function getResponseErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json() as { error?: unknown; message?: unknown };
    if (typeof data.error === 'string' && data.error.trim().length > 0) {
      return data.error;
    }
    if (typeof data.message === 'string' && data.message.trim().length > 0) {
      return data.message;
    }
  } catch {
    try {
      const text = await response.text();
      if (text.trim().length > 0) {
        return text;
      }
    } catch {
      // Ignore body parsing failures and fall back to the caller-provided message.
    }
  }

  return fallback;
}

function normalizeGitHubActionError(message: string) {
  if (/bad credentials/i.test(message)) {
    return 'GitHub authentication failed: Bad credentials. Update your GitHub PAT in Settings and retry.';
  }

  if (/valid github pat is required/i.test(message)) {
    return 'GitHub authentication failed: add a valid GitHub PAT in Settings and retry.';
  }

  return message;
}

type VerificationStep =
  | 'cloning'
  | 'applying_changes'
  | 'finding_workspace'
  | 'installing'
  | 'running_scripts'
  | 'reviewing';

const VERIFICATION_STEP_ORDER: VerificationStep[] = [
  'cloning',
  'applying_changes',
  'finding_workspace',
  'installing',
  'running_scripts',
  'reviewing',
];

/** Steps shown in the overlay grid (applying_changes and finding_workspace are fast and merged visually). */
const VERIFICATION_DISPLAY_STEPS: { step: VerificationStep; label: string }[] = [
  { step: 'cloning', label: 'Cloning repository snapshot' },
  { step: 'finding_workspace', label: 'Finding project workspace' },
  { step: 'installing', label: 'Installing dependencies' },
  { step: 'running_scripts', label: 'Running validation scripts' },
  { step: 'reviewing', label: 'Generating provider review' },
];

export const CreatePRModal: React.FC<CreatePRModalProps> = ({
  isOpen,
  onClose,
  owner,
  repo,
  baseOwner,
  baseRepo,
  baseBranch,
  files,
  initialPullRequest = null,
  onPullRequestCreated,
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
  const [isDraft, setIsDraft] = useState(false);
  const [generateMetadataLoading, setGenerateMetadataLoading] = useState(false);
  const [generateMetadataError, setGenerateMetadataError] = useState<string | null>(null);

  const activeProviderConfig = providers[activeProvider];
  const filesFingerprint = useMemo(
    () => JSON.stringify(files.map((file) => [file.path, file.action || 'edit', file.content, file.originalContent || ''])),
    [files],
  );

  const allProvidersPayload = useMemo(
    () => Object.fromEntries(
      Object.entries(providers)
        .filter(([, c]) => c.apiKey)
        .map(([k, c]) => [k, { apiKey: c.apiKey, model: c.model }]),
    ),
    [providers],
  );

  const [activeStep, setActiveStep] = useState<VerificationStep | null>(null);
  const [activeStepLabel, setActiveStepLabel] = useState('');
  const [activeStepDetail, setActiveStepDetail] = useState('');
  const [completedSteps, setCompletedSteps] = useState<Set<VerificationStep>>(new Set());

  const handleRunVerification = useCallback(async () => {
    if (!githubPAT || files.length === 0) return;

    setVerificationLoading(true);
    setVerificationError(null);
    setActiveStep(null);
    setActiveStepLabel('');
    setActiveStepDetail('');
    setCompletedSteps(new Set());

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'verify-changes',
            stream: true,
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
            allProviders: allProvidersPayload,
          }),
        },
      );

      if (!response.ok) throw new Error(`Server returned ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let result: VerificationResult | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = JSON.parse(line.slice(6)) as
            | { type: 'progress'; step: VerificationStep; label: string; detail: string }
            | ({ type: 'result' } & VerificationResult)
            | { type: 'error'; error: string };

          if (payload.type === 'progress') {
            setCompletedSteps((prev) => {
              if (!prev.size) return prev;
              const next = new Set(prev);
              // Mark all earlier steps as completed
              for (const s of VERIFICATION_STEP_ORDER) {
                if (s === payload.step) break;
                next.add(s);
              }
              return next;
            });
            setActiveStep(payload.step);
            setActiveStepLabel(payload.label);
            setActiveStepDetail(payload.detail);
          } else if (payload.type === 'result') {
            const { type: _, ...rest } = payload;
            result = rest;
          } else if (payload.type === 'error') {
            setVerificationError(payload.error);
          }
        }
      }

      if (result) {
        setVerificationResult(result);
      }
    } catch {
      setVerificationError('Failed to review staged changes');
    } finally {
      setVerificationLoading(false);
    }
  }, [activeProvider, activeProviderConfig.apiKey, activeProviderConfig.model, allProvidersPayload, baseBranch, files, githubPAT, owner, repo]);

  const handleGenerateMetadata = useCallback(async () => {
    if (files.length === 0) return;

    setGenerateMetadataLoading(true);
    setGenerateMetadataError(null);

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'generate-pr-metadata',
            pat: githubPAT,
            owner,
            repo,
            files: files.map((file) => ({
              path: file.path,
              content: file.content,
              action: file.action || 'edit',
              originalContent: file.originalContent,
            })),
            provider: activeProvider,
            model: activeProviderConfig.model,
            apiKey: activeProviderConfig.apiKey,
            allProviders: allProvidersPayload,
          }),
        },
      );

      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = await response.json();
      if (data.error) {
        setGenerateMetadataError(data.error);
        return;
      }

      if (data.title) setTitle(data.title);
      if (data.body) setBody(data.body);
    } catch {
      setGenerateMetadataError('Failed to generate PR metadata');
    } finally {
      setGenerateMetadataLoading(false);
    }
  }, [activeProvider, activeProviderConfig.apiKey, activeProviderConfig.model, allProvidersPayload, files, githubPAT, owner, repo]);

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
    if (!isOpen) return;

    setCreatedPr(initialPullRequest);
    setPrStatus(null);
    setStatusError(null);
    setMergeTitle(initialPullRequest?.title || '');
    setMergeBody(initialPullRequest?.body || '');
    setMergeError(null);
    setMergeSuccess(null);
  }, [initialPullRequest, isOpen]);

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
      setGenerateMetadataLoading(false);
      setGenerateMetadataError(null);
      setIsDraft(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || createdPr) return;
    setVerificationLoading(false);
    setVerificationError(null);
    setVerificationResult(null);
  }, [baseBranch, createdPr, filesFingerprint, isOpen, owner, repo]);

  const setVerification = useActivityStore((s) => s.setVerification);

  // Compute progress percentage from real step events
  const verificationProgress = useMemo(() => {
    if (!activeStep) return 0;
    const totalSteps = VERIFICATION_STEP_ORDER.length;
    const currentIndex = VERIFICATION_STEP_ORDER.indexOf(activeStep);
    if (currentIndex < 0) return 0;
    // Each step is an equal slice; being on a step means it's in progress
    return Math.round(((currentIndex + 0.5) / totalSteps) * 100);
  }, [activeStep]);

  // Sync verification state to the global activity store for the ghost overlay
  useEffect(() => {
    if (!verificationLoading || !activeStep) {
      setVerification({ active: false, progress: 0, stepLabel: '', stepDetail: '' });
      return;
    }
    setVerification({
      active: true,
      progress: verificationProgress,
      stepLabel: activeStepLabel,
      stepDetail: activeStepDetail,
    });
  }, [verificationLoading, activeStep, verificationProgress, activeStepLabel, activeStepDetail, setVerification]);

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
      if (!githubPAT.trim()) {
        setError('GitHub authentication failed: add a valid GitHub PAT in Settings and retry.');
        return;
      }

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
            draft: isDraft,
            files: files.map((file) => ({
              path: file.path,
              content: file.content,
              action: file.action || 'edit',
            })),
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          normalizeGitHubActionError(
            await getResponseErrorMessage(response, `Failed to create pull request (${response.status})`),
          ),
        );
      }
      const data = await response.json();
      if (data.error) {
        setError(normalizeGitHubActionError(data.error));
        return;
      }

      const nextPr = data.pr as CreatedPullRequest;
      setCreatedPr(nextPr);
      setMergeTitle(nextPr.title || title);
      setMergeBody(nextPr.body || body);
      onPullRequestCreated?.(nextPr);
      onSuccess?.();
    } catch (error) {
      setError(
        normalizeGitHubActionError(
          error instanceof Error ? error.message : 'Failed to create pull request',
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleMerge = async () => {
    if (!createdPr) return;

    setMergeLoading(true);
    setMergeError(null);

    try {
      if (!githubPAT.trim()) {
        setMergeError('GitHub authentication failed: add a valid GitHub PAT in Settings and retry.');
        return;
      }

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

      if (!response.ok) {
        throw new Error(
          normalizeGitHubActionError(
            await getResponseErrorMessage(response, `Failed to merge pull request (${response.status})`),
          ),
        );
      }
      const data = await response.json();
      if (data.error) {
        setMergeError(normalizeGitHubActionError(data.error));
        return;
      }

      setMergeSuccess(data?.merged?.message || 'Pull request merged successfully.');
      await loadPullRequestStatus();
    } catch (error) {
      setMergeError(
        normalizeGitHubActionError(
          error instanceof Error ? error.message : 'Failed to merge pull request',
        ),
      );
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
  const createLabel = verificationResult?.summary.status === 'failed'
    ? 'Create PR anyway'
    : isDraft
      ? 'Create Draft PR'
      : 'Create PR';
  const verificationHeadline = verificationResult
    ? verificationResult.summary.status === 'failed'
      ? `${verificationResult.summary.commandsFailed} command${verificationResult.summary.commandsFailed === 1 ? '' : 's'} failed`
      : verificationResult.review.status === 'skipped'
        ? 'Provider review skipped'
      : verificationResult.summary.status === 'warning'
        ? `${verificationResult.summary.findings} review finding${verificationResult.summary.findings === 1 ? '' : 's'}`
        : 'Verification passed'
    : 'Run a repo review and validation pass before opening the pull request.';
  const activeVerificationDisplay = activeStepLabel || 'Preparing...';

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={onClose} />
      <div className="relative mx-4 flex max-h-[88vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[20px] border border-[#1E1E22] bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[#1E1E22] px-6 py-[18px]">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#16161A]">
            <GitMerge className="h-5 w-5 text-[#6B6B70]" />
          </div>
          <h2 className="text-base font-semibold text-[#FAFAF9]">
            {createdPr ? 'Review Pull Request' : 'Create Pull Request'}
          </h2>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#16161A] text-[#6B6B70] transition-colors hover:bg-[#1E1E22] hover:text-[#FAFAF9]"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>

        {/* Body */}
        <div
          data-testid="create-pr-modal-scroll-region"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {!createdPr ? (
            <form id={createFormId} onSubmit={handleSubmit}>
              {/* Top Section */}
              <div className="space-y-5 bg-background p-6">
                {/* Branch Info */}
                <div className="flex items-center gap-2.5 rounded-xl border border-[#1E1E22] bg-[#111115] p-3.5">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[#2A2A2E] bg-[#16161A] px-3 py-1.5 text-[13px] font-medium text-[#FAFAF9]">
                    <GitBranch className="h-3.5 w-3.5 text-[#6B6B70]" />
                    <input
                      type="text"
                      value={branchName}
                      onChange={(event) => setBranchName(event.target.value)}
                      className="min-w-0 max-w-[180px] bg-transparent text-[13px] font-medium text-[#FAFAF9] focus:outline-none"
                      placeholder="feature/ai-changes"
                    />
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-[#4A4A50]" />
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[#2A2A2E] bg-[#16161A] px-3 py-1.5 text-[13px] font-medium text-[#FAFAF9]">
                    <GitBranch className="h-3.5 w-3.5 text-[#6B6B70]" />
                    {baseBranch}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[#32D58315] px-3 py-1.5 text-xs font-medium text-[#32D583]">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    No conflicts
                  </span>
                  <span className="text-xs font-medium text-[#6B6B70]">
                    {files.length} file{files.length !== 1 ? 's' : ''}
                    {files.filter((f) => f.action !== 'delete').length > 0 && ` · +${files.filter((f) => f.action !== 'delete').length}`}
                    {files.filter((f) => f.action === 'delete').length > 0 && ` −${files.filter((f) => f.action === 'delete').length}`}
                  </span>
                </div>

                {/* Title */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[13px] font-medium text-[#6B6B70]">Title</label>
                    <button
                      type="button"
                      onClick={() => void handleGenerateMetadata()}
                      disabled={generateMetadataLoading || files.length === 0}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-[#6B6B70] transition-colors hover:bg-[#1E1E22] hover:text-[#DDDDDDB3] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {generateMetadataLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                      Generate with AI
                    </button>
                  </div>
                  {generateMetadataError && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-100">
                      {generateMetadataError}
                    </div>
                  )}
                  <div className="flex items-center rounded-xl border border-primary/25 bg-[#16161A] px-4 py-3.5 focus-within:border-primary/40">
                    <input
                      type="text"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      className="min-w-0 flex-1 bg-transparent text-sm text-[#FAFAF9] placeholder:text-[#4A4A50] focus:outline-none"
                      placeholder="feat: polish the workspace shell"
                      required
                    />
                    <span className="ml-3 shrink-0 text-xs font-medium text-[#4A4A50]">{title.length}/72</span>
                  </div>
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <label className="text-[13px] font-medium text-[#6B6B70]">Description</label>
                  <textarea
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    className="h-[120px] w-full rounded-xl border border-[#2A2A2E] bg-[#16161A] px-4 py-3.5 text-sm text-[#FAFAF9] placeholder:text-[#4A4A50] resize-none focus:outline-none focus:border-[#3A3A3E]"
                    placeholder="Summarize what changed..."
                  />
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#16161A] text-[#6B6B70]">
                      <Bold className="h-3.5 w-3.5" />
                    </span>
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#16161A] text-[#6B6B70]">
                      <Italic className="h-3.5 w-3.5" />
                    </span>
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#16161A] text-[#6B6B70]">
                      <Code className="h-3.5 w-3.5" />
                    </span>
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#16161A] text-[#6B6B70]">
                      <LinkIcon className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-[11px] font-medium text-[#4A4A50]">Supports Markdown</span>
                  </div>
                </div>
              </div>

              {/* Bottom Section */}
              <div className="space-y-5 px-6 pb-6">
                {/* Metadata Row — Reviewers & Labels */}
                <div className="flex gap-4">
                  <div className="flex-1 space-y-2">
                    <label className="text-[13px] font-medium text-[#6B6B70]">Reviewers</label>
                    <div className="flex h-11 items-center gap-2.5 rounded-xl border border-[#1E1E22] bg-[#111115] px-3.5">
                      <UserPlus className="h-4 w-4 text-[#4A4A50]" />
                      <span className="text-[13px] text-[#4A4A50]">Add reviewers</span>
                      <div className="ml-auto flex -space-x-1.5">
                        {[0, 1, 2].map((i) => (
                          <div key={i} className="h-[22px] w-[22px] rounded-full border border-[#2A2A2E] bg-[#1E1E22]" />
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 space-y-2">
                    <label className="text-[13px] font-medium text-[#6B6B70]">Labels</label>
                    <div className="flex h-11 items-center gap-2.5 rounded-xl border border-[#1E1E22] bg-[#111115] px-3.5">
                      <Tag className="h-4 w-4 text-[#4A4A50]" />
                      <span className="text-[13px] text-[#4A4A50]">Add labels</span>
                    </div>
                  </div>
                </div>

                {/* Files Changed */}
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <label className="text-[13px] font-medium text-[#6B6B70]">Files changed</label>
                    <span className="rounded-lg bg-[#1E1E22] px-2 py-0.5 text-[11px] font-medium text-[#8B8B90]">
                      {files.length}
                    </span>
                    <div className="flex-1" />
                    {files.filter((f) => f.action !== 'delete').length > 0 && (
                      <span className="font-mono text-[11px] font-medium text-[#32D583]">
                        +{files.filter((f) => f.action !== 'delete').length}
                      </span>
                    )}
                  </div>
                  <div className="max-h-44 overflow-y-auto rounded-xl border border-[#1E1E22] bg-[#111115]">
                    {files.map((file) => (
                      <div
                        key={file.path}
                        className="flex h-[42px] items-center gap-3 border-b border-[#1A1A1E] px-4 last:border-b-0"
                      >
                        <FileCode className="h-3.5 w-3.5 shrink-0 text-[#4A4A50]" />
                        <span className="min-w-0 truncate font-mono text-xs text-[#DDDDDDB3]">{file.path}</span>
                        <div className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] font-medium">
                          {file.action === 'delete' ? (
                            <span className="text-[#F87171]">deleted</span>
                          ) : (
                            <>
                              <span className="text-[#32D583]">
                                +{file.content.split('\n').length}
                              </span>
                              {file.originalContent != null && (
                                <span className="text-[#F87171]">
                                  -{file.originalContent.split('\n').length}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Pre-submit Checks — unified card for progress + results */}
                <div className="rounded-xl border border-[#1E1E22] bg-[#111115]">
                  <div className="flex items-center gap-3.5 p-4">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#32D58312]">
                      <ShieldCheck className="h-[18px] w-[18px] text-[#32D583]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-[#DDDDDDB3]">Pre-submit checks</div>
                      <p className="text-xs text-[#4A4A50]">
                        {verificationLoading
                          ? activeStepLabel || 'Starting verification...'
                          : verificationResult ? verificationHeadline : 'Run lint, tests & review before opening'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRunVerification()}
                      disabled={verificationLoading || files.length === 0}
                      className="inline-flex shrink-0 items-center justify-center rounded-lg border border-[#2A2A2E] bg-[#1E1E22] px-3.5 py-[7px] text-xs font-medium text-[#DDDDDDB3] transition-colors hover:bg-[#2A2A2E] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {verificationLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                      {verificationResult ? 'Re-run checks' : 'Run checks'}
                    </button>
                  </div>

                  {/* Inline progress steps while loading */}
                  {verificationLoading && (
                    <div role="status" aria-live="polite">
                      <div className="border-t border-[#1E1E22] px-4 py-2.5">
                        <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                          <span>{activeVerificationDisplay}</span>
                          <span className="font-mono text-foreground/85">{Math.round(verificationProgress)}%</span>
                        </div>
                        <Progress
                          value={verificationProgress}
                          className="h-1.5 bg-background/70 [&>div]:bg-[linear-gradient(90deg,rgba(245,208,84,0.95),rgba(16,185,129,0.95))]"
                        />
                      </div>
                      <div className="divide-y divide-[#1E1E22] border-t border-[#1E1E22]">
                        {VERIFICATION_DISPLAY_STEPS.map((displayStep) => {
                          const isActive = activeStep === displayStep.step;
                          const isComplete = completedSteps.has(displayStep.step);

                          return (
                            <div
                              key={displayStep.step}
                              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                            >
                              <div className="flex items-center gap-2">
                                {isActive ? (
                                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-300" />
                                ) : isComplete ? (
                                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                                ) : (
                                  <div className="h-4 w-4 shrink-0 rounded-full border border-[#2A2A2E]" />
                                )}
                                <span className={cn(
                                  'font-medium',
                                  isActive ? 'text-foreground' : isComplete ? 'text-foreground/80' : 'text-[#4A4A50]',
                                )}>
                                  {displayStep.label}
                                </span>
                              </div>
                              <span className="text-xs text-[#4A4A50]">
                                {isActive ? 'running' : isComplete ? 'done' : ''}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Error banner */}
                  {verificationError && (
                    <div className="border-t border-[#1E1E22] px-3 py-2 text-sm text-rose-300">
                      {verificationError}
                    </div>
                  )}

                  {/* Results — rendered inside the same card */}
                  {verificationResult && (
                    <div className="border-t border-[#1E1E22]">
                      <div
                        className={cn(
                          'px-3 py-2 text-sm',
                          verificationResult.review.status === 'skipped'
                            ? 'bg-amber-500/10 text-amber-100'
                            : verificationResult.summary.status === 'failed'
                              ? 'bg-rose-500/10 text-rose-200'
                              : verificationResult.summary.status === 'warning'
                                ? 'bg-amber-500/10 text-amber-100'
                                : 'bg-emerald-500/10 text-emerald-200',
                        )}
                      >
                        {verificationResult.review.status === 'skipped' && (
                          <AlertCircle className="mr-1.5 -mt-0.5 inline-block h-3.5 w-3.5" />
                        )}
                        {verificationResult.review.summary}
                      </div>

                      <div className="divide-y divide-[#1E1E22]">
                        {verificationResult.commands.map((command) => (
                          <details
                            key={`${command.name}-${command.command}`}
                          >
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm">
                              <div className="flex items-center gap-2">
                                {getStatusIcon(command.status === 'skipped' ? 'pending' : command.status === 'passed' ? 'success' : 'failure')}
                                <span className="font-medium">{command.name}</span>
                              </div>
                              <span className="text-xs text-[#4A4A50]">{command.command}</span>
                            </summary>
                            <div className="border-t border-[#1E1E22] px-3 py-2 text-xs text-[#6B6B70]">
                              <div>{command.summary}</div>
                              {command.output ? (
                                <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-[#1E1E22] bg-[#0B0B0E] p-2 text-[11px] leading-relaxed text-[#DDDDDDB3]">
                                  {command.output}
                                </pre>
                              ) : null}
                            </div>
                          </details>
                        ))}
                      </div>

                      {verificationResult.review.findings.length > 0 ? (
                        <div className="divide-y divide-[#1E1E22] border-t border-[#1E1E22]">
                          {verificationResult.review.findings.map((finding, index) => (
                            <div
                              key={`${finding.title}-${index}`}
                              className="px-3 py-2 text-sm"
                            >
                              <div className="flex items-center gap-2">
                                <span className="rounded-lg border border-[#1E1E22] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#6B6B70]">
                                  {finding.severity}
                                </span>
                                <span className="font-medium text-[#FAFAF9]">{finding.title}</span>
                              </div>
                              <p className="mt-1.5 text-[#6B6B70]">{finding.summary}</p>
                              {finding.file ? (
                                <div className="mt-1.5 font-mono text-xs text-[#4A4A50]">{finding.file}</div>
                              ) : null}
                              {finding.suggestion ? (
                                <p className="mt-1.5 text-xs text-[#4A4A50]">{finding.suggestion}</p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>

                {error && (
                  <div className="mt-4 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                {!verificationComplete && (
                  <div className="mt-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                    <ShieldAlert className="h-4 w-4 shrink-0" />
                    <span>Run review &amp; checks before creating the pull request.</span>
                  </div>
                )}

                {/* Footer — inside scroll area */}
                <div
                  data-testid="create-pr-modal-footer"
                  className="flex h-16 items-center justify-between border-t border-[#1A1A1E] pt-5"
                >
                  <label className="flex items-center gap-2 text-[13px] text-[#6B6B70]">
                    <input
                      type="checkbox"
                      checked={isDraft}
                      onChange={(event) => setIsDraft(event.target.checked)}
                      className="h-4 w-4 rounded border-[#2A2A2E] bg-[#111115] accent-primary"
                    />
                    Create as draft
                  </label>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={onClose}
                      className="rounded-[10px] border border-[#1E1E22] px-5 py-[9px] text-sm font-medium text-[#6B6B70] transition-colors hover:bg-[#16161A] hover:text-[#FAFAF9]"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={createDisabled}
                      className="inline-flex items-center gap-2 rounded-[10px] bg-primary px-6 py-[9px] text-sm font-semibold text-[#0B0B0E] shadow-[0_6px_20px_rgba(255,132,0,0.25)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                    >
                      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitPullRequest className="h-4 w-4" />}
                      {createLabel}
                    </button>
                  </div>
                </div>
              </div>
            </form>
          ) : (
            <div className="space-y-5 p-6">
              <div className="rounded-xl border border-[#1E1E22] bg-[#111115] p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-xs text-[#6B6B70]">
                      Pull Request #{createdPr.number}
                      <span className="rounded-lg border border-[#1E1E22] px-2 py-0.5 text-[10px] text-[#DDDDDDB3]">
                        {prStatus?.pr.merged ? 'Merged' : createdPr.state}
                      </span>
                    </div>
                    <h3 className="mt-2 text-lg font-semibold tracking-tight text-[#FAFAF9]">{createdPr.title}</h3>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#6B6B70]">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#2A2A2E] bg-[#16161A] px-3 py-1.5 font-mono text-[#FAFAF9]">
                        <GitBranch className="h-3 w-3 text-[#6B6B70]" />
                        {createdPr.headBranch} → {createdPr.baseBranch}
                      </span>
                      {prStatus?.pr.mergeableState && (
                        <span className="rounded-full border border-[#2A2A2E] bg-[#16161A] px-3 py-1.5 capitalize text-[#DDDDDDB3]">
                          merge state: {prStatus.pr.mergeableState.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void loadPullRequestStatus()}
                      className="inline-flex items-center gap-2 rounded-[10px] border border-[#1E1E22] px-3 py-2 text-sm font-medium text-[#6B6B70] transition-colors hover:bg-[#16161A] hover:text-[#FAFAF9]"
                    >
                      <RefreshCw className={cn('h-4 w-4', statusLoading && 'animate-spin')} />
                      Refresh
                    </button>
                    <a
                      href={createdPr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 rounded-[10px] border border-[#1E1E22] px-3 py-2 text-sm font-medium text-[#6B6B70] transition-colors hover:bg-[#16161A] hover:text-[#FAFAF9]"
                    >
                      View on GitHub
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </div>
                </div>
              </div>

              <div className="grid gap-5">
                <div className="space-y-4">
                  <section className="rounded-xl border border-[#1E1E22] bg-[#111115] p-5">
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
                          <div className="text-[13px] font-medium text-[#6B6B70]">
                            Status Checks
                          </div>
                          <div className="mt-1 text-lg font-semibold text-[#FAFAF9]">
                            {prStatus ? getChecksHeadline(prStatus.checks.summary) : 'Loading checks…'}
                          </div>
                        </div>
                      </div>
                      {prStatus && (
                        <div className="rounded-lg border border-[#1E1E22] px-3 py-1 text-xs text-[#6B6B70]">
                          {prStatus.checks.summary.passed} passed
                          {prStatus.checks.summary.failed > 0 ? ` · ${prStatus.checks.summary.failed} failed` : ''}
                          {prStatus.checks.summary.pending > 0 ? ` · ${prStatus.checks.summary.pending} pending` : ''}
                        </div>
                      )}
                    </div>

                    {statusError && (
                      <div className="mt-4 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        <span>{statusError}</span>
                      </div>
                    )}

                    <div className="mt-4 space-y-3">
                      {statusLoading && !prStatus ? (
                        <div className="flex items-center gap-2 rounded-xl border border-[#1E1E22] bg-[#0B0B0E] px-4 py-3 text-sm text-[#6B6B70]">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Pulling latest checks from GitHub…
                        </div>
                      ) : prStatus && prStatus.checks.providers.length > 0 ? (
                        prStatus.checks.providers.map((provider) => (
                          <details
                            key={provider.name}
                            open
                            className="overflow-hidden rounded-xl border border-[#1E1E22] bg-[#0B0B0E]"
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
                                <span className="font-medium text-[#FAFAF9]">{provider.name}</span>
                              </div>
                              <span className="text-xs text-[#6B6B70]">
                                {provider.failed > 0
                                  ? `${provider.failed} failed`
                                  : provider.pending > 0
                                    ? `${provider.pending} pending`
                                    : `${provider.passed}/${provider.total} passed`}
                              </span>
                            </summary>
                            <div className="border-t border-[#1E1E22] px-4 py-2">
                              {provider.checks.map((check) => (
                                <div
                                  key={`${provider.name}-${check.name}`}
                                  className="flex items-start justify-between gap-3 border-b border-[#1A1A1E] py-2 text-sm last:border-b-0"
                                >
                                  <div className="flex min-w-0 items-start gap-3">
                                    {getStatusIcon(check.status)}
                                    <div className="min-w-0">
                                      <div className="truncate font-medium text-[#FAFAF9]">{check.name}</div>
                                      {check.summary && (
                                        <div className="mt-0.5 text-xs text-[#4A4A50]">{check.summary}</div>
                                      )}
                                    </div>
                                  </div>
                                  {check.detailsUrl ? (
                                    <a
                                      href={check.detailsUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="shrink-0 rounded-lg border border-[#1E1E22] px-2 py-1 text-[11px] text-[#6B6B70] transition-colors hover:bg-[#16161A] hover:text-[#FAFAF9]"
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
                        <div className="rounded-xl border border-[#1E1E22] bg-[#0B0B0E] px-4 py-3 text-sm text-[#6B6B70]">
                          No checks are attached yet. Refresh after your GitHub providers finish reporting.
                        </div>
                      )}
                    </div>
                  </section>
                </div>

                <div className="space-y-4">
                  <section className="rounded-xl border border-[#1E1E22] bg-[#111115] p-5">
                    <div className="text-[13px] font-medium text-[#6B6B70]">
                      Merge Controls
                    </div>
                    <div className="mt-4 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="mb-2 block text-[13px] font-medium text-[#6B6B70]">
                            Merge strategy
                          </label>
                          <select
                            value={mergeMethod}
                            onChange={(event) => setMergeMethod(event.target.value as MergeMethod)}
                            className="w-full rounded-xl border border-[#1E1E22] bg-[#16161A] px-3 py-3 text-sm text-[#FAFAF9] focus:outline-none focus:border-[#2A2A2E]"
                          >
                            <option value="squash">Squash and merge</option>
                            <option value="merge">Create merge commit</option>
                            <option value="rebase">Rebase and merge</option>
                          </select>
                        </div>

                        <div>
                          <label className="mb-2 block text-[13px] font-medium text-[#6B6B70]">
                            Commit message
                          </label>
                          <input
                            type="text"
                            value={mergeTitle}
                            onChange={(event) => setMergeTitle(event.target.value)}
                            className="w-full rounded-xl border border-[#1E1E22] bg-[#16161A] px-3 py-3 text-sm text-[#FAFAF9] focus:outline-none focus:border-[#2A2A2E]"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="mb-2 block text-[13px] font-medium text-[#6B6B70]">
                          Description
                        </label>
                        <textarea
                          value={mergeBody}
                          onChange={(event) => setMergeBody(event.target.value)}
                          rows={5}
                          className="w-full rounded-xl border border-[#1E1E22] bg-[#16161A] px-3 py-3 text-sm text-[#FAFAF9] placeholder:text-[#4A4A50] resize-none focus:outline-none focus:border-[#2A2A2E]"
                          placeholder="Add context for the final merge commit."
                        />
                      </div>

                      {mergeBlockedReason ? (
                        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                          {mergeBlockedReason}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                          Checks are clear. This pull request is ready to merge.
                        </div>
                      )}

                      {mergeError && (
                        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                          {mergeError}
                        </div>
                      )}

                      {mergeSuccess && (
                        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
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

        {/* Footer — only for post-creation (merge) view */}
        {createdPr && (
          <div className="flex h-16 items-center justify-between border-t border-[#1A1A1E] px-6">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[10px] border border-[#1E1E22] px-5 py-[9px] text-sm font-medium text-[#6B6B70] transition-colors hover:bg-[#16161A] hover:text-[#FAFAF9]"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleMerge}
              disabled={mergeDisabled}
              className={cn(
                'inline-flex items-center gap-2 rounded-[10px] px-5 py-[9px] text-sm font-semibold transition-opacity',
                mergeDisabled
                  ? 'cursor-not-allowed border border-[#1E1E22] bg-[#16161A] text-[#4A4A50]'
                  : 'bg-primary text-[#0B0B0E] shadow-[0_6px_20px_rgba(255,132,0,0.25)] hover:opacity-90',
              )}
            >
              {mergeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitPullRequest className="h-4 w-4" />}
              {getMergeButtonLabel(mergeMethod)}
            </button>
          </div>
        )}

      </div>
    </div>
  );
};
