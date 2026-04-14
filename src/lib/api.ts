import type { Provider } from '@/stores/settings-store';

const API_PORT_STORAGE_KEY = 'cloudchat.apiPort';

export interface RepoFileTreeResult {
  paths: string[];
  error: string | null;
}

export interface GitHubRepoSummary {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  html_url: string;
  fork: boolean;
  owner: {
    login: string;
    avatar_url: string | null;
  };
  permissions?: {
    pull?: boolean;
    push?: boolean;
    admin?: boolean;
  };
  stargazers_count?: number;
  forks_count?: number;
  language?: string | null;
  localClone: {
    exists: boolean;
    path: string | null;
  };
}

export interface GitHubIssueSummary {
  id: number;
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: string;
  comments: number;
  created_at: string;
  updated_at: string;
  user: {
    login: string;
    avatar_url: string | null;
  };
  labels: Array<{
    id: number;
    name: string;
    color: string;
    description: string | null;
  }>;
}

export interface RepoSearchResult {
  repos: GitHubRepoSummary[];
  totalCount: number;
  incompleteResults?: boolean;
  page: number;
  perPage: number;
}

export interface RepoIssuesResult {
  issues: GitHubIssueSummary[];
  totalCount: number;
  incompleteResults?: boolean;
  page: number;
  perPage: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export interface CloneRepoResult {
  clone: {
    exists: boolean;
    path: string | null;
  };
  repo: GitHubRepoSummary;
}

export interface ForkRepoResult {
  repo: GitHubRepoSummary;
  sourceRepo: {
    owner: string;
    repo: string;
    fullName: string;
  };
}

export function getApiPortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const apiPort = parsed.searchParams.get('apiPort');
    if (!apiPort) {
      return null;
    }

    const port = Number(apiPort);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function storeApiPort(port: number) {
  try {
    window.sessionStorage.setItem(API_PORT_STORAGE_KEY, String(port));
  } catch (err) {
    console.warn('[api] Failed to store API port in sessionStorage', err);
  }
}

export function getStoredApiPort(): number | null {
  try {
    const raw = window.sessionStorage.getItem(API_PORT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const port = Number(raw);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Returns the base URL for the local API server.
 */
export function getApiBaseUrl(): string {
  // Electron preload-injected port — most authoritative source in Electron.
  // Check before URL params because HMR reloads can strip query params
  // while the preload's contextBridge value persists.
  if (window.electronAPI?.apiPort) {
    storeApiPort(window.electronAPI.apiPort);
    return `http://localhost:${window.electronAPI.apiPort}`;
  }

  // URL param — Electron main process sets this on initial load.
  const apiPort = getApiPortFromUrl(window.location.href);
  if (apiPort) {
    storeApiPort(apiPort);
    return `http://localhost:${apiPort}`;
  }

  // Web-only: use stored port from a previous page load in this session
  const storedPort = getStoredApiPort();
  if (storedPort) {
    return `http://localhost:${storedPort}`;
  }

  return import.meta.env.VITE_API_URL || 'http://localhost:3001';
}

/**
 * Fetches the full file tree for a repo using the Git Trees API.
 * Returns a flat array of file paths (e.g. ["src/index.ts", "src/lib/utils.ts"]).
 */
export async function fetchRepoFileTree(
  pat: string,
  owner: string,
  repo: string,
  branch: string
): Promise<string[]> {
  const result = await fetchRepoFileTreeResult(pat, owner, repo, branch);
  return result.paths;
}

export async function fetchRepoFileTreeResult(
  pat: string,
  owner: string,
  repo: string,
  branch: string
): Promise<RepoFileTreeResult> {
  const baseUrl = getApiBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/functions/v1/github-integration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read-tree', pat, owner, repo, branch }),
    });

    let data: Record<string, unknown> = {};
    try {
      data = await response.json();
    } catch {
      // Non-JSON response body — fall through with empty data
    }

    if (!response.ok) {
      return {
        paths: [],
        error: typeof data.error === 'string' && data.error
          ? data.error
          : `Server returned ${response.status}`,
      };
    }

    const items = (data.items || []) as Array<{ path: string; type: string }>;
    return {
      paths: items
        .filter(i => i.type === 'file')
        .map(i => i.path)
        .sort(),
      error: typeof data.error === 'string' && data.error ? data.error : null,
    };
  } catch {
    return {
      paths: [],
      error: 'Failed to index repository tree.',
    };
  }
}

export async function validateApiKey(
  provider: Provider,
  apiKey: string
): Promise<{ valid: boolean; models?: string[]; defaultModel?: string; error?: string }> {
  const baseUrl = getApiBaseUrl();

  const response = await fetch(`${baseUrl}/functions/v1/validate-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, api_key: apiKey }),
  });

  return response.json();
}

async function postGitHubIntegration<T>(payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}/functions/v1/github-integration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let data: Record<string, unknown> = {};
  try {
    data = await response.json();
  } catch {
    // Non-JSON response body — fall through with empty data
  }

  if (!response.ok || data.error) {
    throw new Error(typeof data.error === 'string' && data.error ? data.error : `Server returned ${response.status}`);
  }

  return data as T;
}

export async function listGitHubRepos(pat: string): Promise<GitHubRepoSummary[]> {
  const result = await postGitHubIntegration<{ repos: GitHubRepoSummary[] }>({
    action: 'list-repos',
    pat,
  });
  return result.repos || [];
}

export async function searchGitHubRepos(pat: string, query: string, page = 1): Promise<RepoSearchResult> {
  return postGitHubIntegration<RepoSearchResult>({
    action: 'search-repos',
    pat,
    query,
    page,
  });
}

export async function listGitHubIssues(
  pat: string,
  owner: string,
  repo: string,
  options: {
    page?: number;
    sort?: 'created' | 'updated' | 'comments';
    direction?: 'asc' | 'desc';
    state?: 'open' | 'closed' | 'all';
    query?: string;
    labels?: string[];
  } = {},
): Promise<RepoIssuesResult> {
  return postGitHubIntegration<RepoIssuesResult>({
    action: 'list-issues',
    pat,
    owner,
    repo,
    ...options,
  });
}

export async function createGitHubIssue(
  pat: string,
  owner: string,
  repo: string,
  input: {
    title: string;
    body?: string;
  },
): Promise<GitHubIssueSummary> {
  const result = await postGitHubIntegration<{ issue: GitHubIssueSummary }>({
    action: 'create-issue',
    pat,
    owner,
    repo,
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
  });
  return result.issue;
}

export async function cloneGitHubRepo(
  pat: string,
  owner: string,
  repo: string,
  branch?: string,
): Promise<CloneRepoResult> {
  return postGitHubIntegration<CloneRepoResult>({
    action: 'clone-repo',
    pat,
    owner,
    repo,
    ...(branch ? { branch } : {}),
  });
}

export async function forkGitHubRepo(
  pat: string,
  owner: string,
  repo: string,
  branch?: string,
): Promise<ForkRepoResult> {
  return postGitHubIntegration<ForkRepoResult>({
    action: 'fork-repo',
    pat,
    owner,
    repo,
    ...(branch ? { branch } : {}),
  });
}

export type ReactionContent = '+1' | '-1' | 'laugh' | 'hooray' | 'confused' | 'heart' | 'rocket' | 'eyes';

export interface CommentReactions {
  '+1': number;
  '-1': number;
  laugh: number;
  hooray: number;
  confused: number;
  heart: number;
  rocket: number;
  eyes: number;
}

export interface GitHubIssueComment {
  id: number;
  user: { login: string; avatar_url: string | null };
  body: string;
  created_at: string;
  updated_at: string;
  reactions?: CommentReactions;
}

export interface LinkedPR {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  user: { login: string };
  created_at: string;
}

export async function listIssueComments(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssueComment[]> {
  const result = await postGitHubIntegration<{ comments: GitHubIssueComment[] }>({
    action: 'list-issue-comments',
    pat,
    owner,
    repo,
    issueNumber,
  });
  return result.comments || [];
}

export async function createIssueComment(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<GitHubIssueComment> {
  const result = await postGitHubIntegration<{ comment: GitHubIssueComment }>({
    action: 'create-issue-comment',
    pat,
    owner,
    repo,
    issueNumber,
    body,
  });
  return result.comment;
}

export async function addCommentReaction(
  pat: string,
  owner: string,
  repo: string,
  commentId: number,
  reaction: ReactionContent,
): Promise<{ id: number; content: string }> {
  return postGitHubIntegration<{ reaction: { id: number; content: string } }>({
    action: 'add-comment-reaction',
    pat,
    owner,
    repo,
    commentId,
    reaction,
  }).then((r) => r.reaction);
}

export async function createIssueBranch(
  pat: string,
  owner: string,
  repo: string,
  baseBranch: string,
  issue: { number: number; title: string; labels: Array<{ name: string }> },
): Promise<{ branch: string; sha: string; created: boolean }> {
  const isBug = issue.labels.some((l) => /bug/i.test(l.name));
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  const prefix = isBug ? 'fix' : 'feat';
  const newBranchName = `${prefix}/issue-${issue.number}-${slug}`;

  return postGitHubIntegration<{ branch: string; sha: string; created: boolean }>({
    action: 'create-branch',
    pat,
    owner,
    repo,
    baseBranch,
    newBranchName,
  });
}

export interface RepoActivityData {
  days: number[];
  totalCommits: number;
  commitsCapped: boolean;
  openedIssues: number;
  openedPullRequests: number;
}

export async function getRepoActivity(
  pat: string,
  owner: string,
  repo: string,
): Promise<RepoActivityData> {
  return postGitHubIntegration<RepoActivityData>({
    action: 'repo-activity',
    pat,
    owner,
    repo,
  });
}

export async function listLinkedPRs(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<LinkedPR[]> {
  const result = await postGitHubIntegration<{ prs: LinkedPR[] }>({
    action: 'list-linked-prs',
    pat,
    owner,
    repo,
    issueNumber,
  });
  return result.prs || [];
}

export async function translateText(
  provider: string,
  apiKey: string,
  model: string,
  text: string,
  targetLanguage = 'English',
): Promise<string> {
  const res = await fetch(`${getApiBaseUrl()}/functions/v1/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, targetLanguage, provider, api_key: apiKey, model }),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => null);
    let errorMsg = `Translation failed (${res.status})`;
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data?.error) errorMsg = data.error;
      } catch {
        // Non-JSON error body — use default message
      }
    }
    throw new Error(errorMsg);
  }

  const data = await res.json();
  return data.translated;
}

// ─── Messaging Platforms ──────────────────────────────────────────────

export interface MessagingPlatformField {
  value: string;
  is_set: boolean;
  is_secret: boolean;
  required: boolean;
  label: string;
  placeholder?: string;
  type?: string;
}

export interface MessagingPlatform {
  id: string;
  name: string;
  description: string;
  icon: string;
  features: string[];
  docs_url: string;
  setup_note?: string;
  configured_fields: number;
  total_required: number;
  is_connected: boolean;
  gateway_active: boolean;
  gateway_running: boolean;
  has_secrets: boolean;
  fields: Record<string, MessagingPlatformField>;
}

export async function fetchMessagingPlatforms(): Promise<MessagingPlatform[]> {
  const res = await fetch(`${getApiBaseUrl()}/api/hermes/messaging/platforms`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to fetch platforms (${res.status})`);
  }
  const data = await res.json();
  return data.platforms;
}

export async function fetchMessagingPlatform(id: string): Promise<MessagingPlatform> {
  const res = await fetch(`${getApiBaseUrl()}/api/hermes/messaging/platforms/${encodeURIComponent(id)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to fetch platform (${res.status})`);
  }
  const data = await res.json();
  return data.platform;
}

export async function updatePlatformEnv(
  id: string,
  env: Record<string, string>,
): Promise<MessagingPlatform> {
  const res = await fetch(
    `${getApiBaseUrl()}/api/hermes/messaging/platforms/${encodeURIComponent(id)}/env`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env }),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to update platform (${res.status})`);
  }
  const data = await res.json();
  return data.platform;
}

export async function updatePlatformConfig(
  id: string,
  config: Record<string, unknown>,
): Promise<MessagingPlatform> {
  const res = await fetch(
    `${getApiBaseUrl()}/api/hermes/messaging/platforms/${encodeURIComponent(id)}/config`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to update config (${res.status})`);
  }
  const data = await res.json();
  return data.platform;
}

export async function disconnectPlatform(id: string): Promise<MessagingPlatform> {
  const res = await fetch(
    `${getApiBaseUrl()}/api/hermes/messaging/platforms/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to disconnect platform (${res.status})`);
  }
  const data = await res.json();
  return data.platform;
}

export async function testPlatformConnection(id: string): Promise<{
  success: boolean;
  message?: string;
  error?: string;
  status?: Record<string, unknown>;
}> {
  const res = await fetch(
    `${getApiBaseUrl()}/api/hermes/messaging/platforms/${encodeURIComponent(id)}/test`,
    { method: 'POST' },
  );
  const data = await res.json();
  if (!res.ok) {
    return { success: false, error: data.error || `Test failed (${res.status})` };
  }
  return data;
}

export async function restartPlatformGateway(id: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(
    `${getApiBaseUrl()}/api/hermes/messaging/platforms/${encodeURIComponent(id)}/restart-gateway`,
    { method: 'POST' },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { success: false, error: data.error || `Restart failed (${res.status})` };
  }
  return { success: true };
}

export interface OAuthStatus {
  available: boolean;
  auth_url?: string;
  platform?: string;
  error?: string;
}

export async function getOAuthStatus(platformId: string): Promise<OAuthStatus> {
  const res = await fetch(
    `${getApiBaseUrl()}/api/hermes/messaging/platforms/${encodeURIComponent(platformId)}/oauth`,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { available: false, error: data.error || `Failed (${res.status})` };
  }
  return data as OAuthStatus;
}

export async function completeOAuth(
  platformId: string,
  code: string,
): Promise<{ success: boolean; message?: string; error?: string }> {
  const res = await fetch(
    `${getApiBaseUrl()}/api/hermes/messaging/platforms/${encodeURIComponent(platformId)}/oauth/complete`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { success: false, error: data.error || `OAuth failed (${res.status})` };
  }
  return data as { success: boolean; message?: string; error?: string };
}
