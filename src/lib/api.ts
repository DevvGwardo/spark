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
  } catch {
    // Ignore storage access failures.
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
  // URL param is the most reliable source — Electron main process sets it
  // on every launch with the current port, so check it first.
  const apiPort = getApiPortFromUrl(window.location.href);
  if (apiPort) {
    storeApiPort(apiPort);
    return `http://localhost:${apiPort}`;
  }

  // Electron preload-injected port
  if (window.electronAPI?.apiPort) {
    storeApiPort(window.electronAPI.apiPort);
    return `http://localhost:${window.electronAPI.apiPort}`;
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
      data = {};
    }

    if (!response.ok) {
      return {
        paths: [],
        error: typeof data.error === 'string' && data.error
          ? data.error
          : `Server returned ${response.status}`,
      };
    }

    const items: Array<{ path: string; type: string }> = data.items || [];
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
    data = {};
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
