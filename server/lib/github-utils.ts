import { formatDataStreamPart } from 'ai';
import { getManagedRepoClone } from '../repo-clone-manager';
import { OPENAI_COMPATIBLE } from '../provider-config';

// ─── Input Validation ───────────────────────────────────────────────────────

const GITHUB_IDENTIFIER_RE = /^[a-zA-Z0-9._-]+$/;

export function validateGitHubIdentifier(name: string, label: string): void {
  if (!name || !GITHUB_IDENTIFIER_RE.test(name)) {
    throw new Error(`Invalid GitHub ${label}: "${name}". Must match ${GITHUB_IDENTIFIER_RE.source}`);
  }
}

const GITHUB_API_BASE = 'https://api.github.com/';

function assertGitHubApiUrl(url: string): void {
  if (!url.startsWith(GITHUB_API_BASE)) {
    throw new Error(`Refusing to fetch non-GitHub API URL: ${url}`);
  }
}

function checkRateLimitResponse(response: Response): void {
  if (response.status === 403) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const resetEpoch = response.headers.get('x-ratelimit-reset');
      const resetTime = resetEpoch
        ? new Date(Number(resetEpoch) * 1000).toISOString()
        : 'unknown';
      throw new Error(`GitHub API rate limit exceeded. Resets at ${resetTime}.`);
    }
  }
}

// ─── GitHub PAT Validation ───────────────────────────────────────────────────

export function isValidGitHubPAT(pat: unknown): pat is string {
  if (typeof pat !== 'string') return false;
  // GitHub PATs: ghp_, github_pat_, gho_, ghs_, ghr_ prefixes
  // Fine-grained tokens (github_pat_) can exceed 255 chars, so no upper bound
  // Token body accepts alphanumeric, dots, underscores, and hyphens
  return /^(ghp_|github_pat_|gho_|ghs_|ghr_)[a-zA-Z0-9._-]+$/.test(pat.trim());
}

export interface GitHubRepoPayload {
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

export interface GitHubIssuePayload {
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

export function getUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function encodeGitHubContentPath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function buildGitHubContentsUrl(
  owner: string,
  repo: string,
  path = '',
  ref?: string,
): string {
  validateGitHubIdentifier(owner, 'owner');
  validateGitHubIdentifier(repo, 'repo');
  const suffix = (() => {
    const encodedPath = encodeGitHubContentPath(path);
    return encodedPath ? `/${encodedPath}` : '';
  })();
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${suffix}`,
  );
  if (ref) {
    url.searchParams.set('ref', ref);
  }
  return url.toString();
}

export async function withLocalClone(repo: {
  id?: number;
  name?: string;
  full_name?: string;
  private?: boolean;
  description?: string | null;
  default_branch?: string;
  html_url?: string;
  fork?: boolean;
  owner?: { login?: string; avatar_url?: string | null };
  permissions?: { pull?: boolean; push?: boolean; admin?: boolean };
  stargazers_count?: number;
  forks_count?: number;
  language?: string | null;
}): Promise<GitHubRepoPayload> {
  const owner = repo.owner?.login || repo.full_name?.split('/')[0] || '';
  const name = repo.name || repo.full_name?.split('/')[1] || '';
  const localClone = owner && name
    ? await getManagedRepoClone(owner, name)
    : { exists: false, path: null };

  return {
    id: repo.id || 0,
    name,
    full_name: repo.full_name || `${owner}/${name}`,
    private: !!repo.private,
    description: repo.description || null,
    default_branch: repo.default_branch || 'main',
    html_url: repo.html_url || `https://github.com/${owner}/${name}`,
    fork: !!repo.fork,
    owner: {
      login: owner,
      avatar_url: repo.owner?.avatar_url || null,
    },
    permissions: repo.permissions,
    stargazers_count: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : undefined,
    forks_count: typeof repo.forks_count === 'number' ? repo.forks_count : undefined,
    language: repo.language ?? null,
    localClone,
  };
}

export function toGitHubIssue(issue: {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string; avatar_url?: string | null };
  labels?: Array<{ id?: number; name?: string; color?: string; description?: string | null }>;
}): GitHubIssuePayload {
  return {
    id: issue.id || 0,
    number: issue.number || 0,
    title: issue.title || 'Untitled issue',
    body: issue.body || '',
    html_url: issue.html_url || '',
    state: issue.state || 'open',
    comments: issue.comments || 0,
    created_at: issue.created_at || new Date(0).toISOString(),
    updated_at: issue.updated_at || new Date(0).toISOString(),
    user: {
      login: issue.user?.login || 'unknown',
      avatar_url: issue.user?.avatar_url || null,
    },
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((label) => ({
          id: label.id || 0,
          name: label.name || '',
          color: label.color || '94a3b8',
          description: label.description || null,
        }))
      : [],
  };
}

export function normalizeLocalProviderError(provider: string | undefined, message: string) {
  const lower = message.toLowerCase();

  if (
    provider === 'hermes'
    && (lower.includes('cannot connect to api') || lower.includes('hermes bridge is not reachable'))
  ) {
    return {
      status: 503,
      error:
        `Hermes bridge is not reachable at ${OPENAI_COMPATIBLE.hermes}. ` +
        'Start hermes-bridge/main.py and try again.',
    };
  }

  if (provider === 'openclaw' && lower.includes('openclaw cli not found')) {
    return {
      status: 503,
      error:
        'OpenClaw agent is not available. Ensure the OpenClaw CLI is installed and accessible, then try again.',
    };
  }

  return null;
}

export const REPO_ACTIVITY_DAYS = 30;
export const REPO_ACTIVITY_COMMITS_PER_PAGE = 100;
export const REPO_ACTIVITY_MAX_PAGES = 20;

export function formatUtcDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function hasGitHubNextPage(linkHeader: string | null): boolean {
  return typeof linkHeader === 'string' && /rel="next"/.test(linkHeader);
}

export async function fetchRecentRepoActivity(
  owner: string,
  repo: string,
  headers: Record<string, string>,
): Promise<{ days: number[]; totalCommits: number; commitsCapped: boolean; openedIssues: number; openedPullRequests: number }> {
  validateGitHubIdentifier(owner, 'owner');
  validateGitHubIdentifier(repo, 'repo');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const bucketDates = Array.from({ length: REPO_ACTIVITY_DAYS }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (REPO_ACTIVITY_DAYS - 1 - index));
    return date;
  });
  const bucketKeys = bucketDates.map(formatUtcDateKey);
  const dayCounts = new Map(bucketKeys.map((key) => [key, 0]));
  const since = new Date(bucketDates[0] ?? today);
  const until = new Date(today);
  until.setUTCHours(23, 59, 59, 999);
  const createdSince = formatUtcDateKey(since);

  const safeFetchCount = async (query: string): Promise<number> => {
    try {
      return await fetchGitHubSearchTotalCount(query, headers);
    } catch {
      return 0;
    }
  };

  // Fetch commits (paginated) and search counts in parallel so that
  // the search API calls aren't blocked behind 20 pages of commit requests
  const commitsFetcher = async () => {
    let capped = false;
    for (let page = 1; page <= REPO_ACTIVITY_MAX_PAGES; page += 1) {
      const commitsUrl = new URL(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
      );
      commitsUrl.searchParams.set('since', since.toISOString());
      commitsUrl.searchParams.set('until', until.toISOString());
      commitsUrl.searchParams.set('per_page', String(REPO_ACTIVITY_COMMITS_PER_PAGE));
      commitsUrl.searchParams.set('page', String(page));

      const commitsUrlStr = commitsUrl.toString();
      assertGitHubApiUrl(commitsUrlStr);
      const commitsResponse = await fetch(commitsUrlStr, { headers });

      if (commitsResponse.status === 409) {
        return { capped: false };
      }

      checkRateLimitResponse(commitsResponse);

      if (!commitsResponse.ok) {
        const error = await commitsResponse.text();
        throw new Error(`GitHub API error: ${error}`);
      }

      const commits = (await commitsResponse.json()) as Array<{
        commit?: { committer?: { date?: string | null } | null; author?: { date?: string | null } | null } | null;
      }>;

      for (const entry of commits) {
        const rawDate = entry.commit?.committer?.date || entry.commit?.author?.date;
        if (!rawDate) {
          continue;
        }
        const date = new Date(rawDate);
        if (Number.isNaN(date.getTime())) {
          continue;
        }
        const key = formatUtcDateKey(date);
        if (dayCounts.has(key)) {
          dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
        }
      }

      if (commits.length < REPO_ACTIVITY_COMMITS_PER_PAGE || !hasGitHubNextPage(commitsResponse.headers.get('link'))) {
        break;
      }
      if (page === REPO_ACTIVITY_MAX_PAGES) {
        capped = true;
      }
    }
    return { capped };
  };

  const [commitsResult, openedIssues, openedPullRequests] = await Promise.all([
    commitsFetcher(),
    safeFetchCount(`repo:${owner}/${repo} is:issue created:>=${createdSince}`),
    safeFetchCount(`repo:${owner}/${repo} is:pr created:>=${createdSince}`),
  ]);

  const days = bucketKeys.map((key) => dayCounts.get(key) ?? 0);
  const totalCommits = days.reduce((sum, count) => sum + count, 0);

  return { days, totalCommits, commitsCapped: commitsResult.capped, openedIssues, openedPullRequests };
}

export async function fetchGitHubSearchTotalCount(
  query: string,
  headers: Record<string, string>,
): Promise<number> {
  const url = new URL('https://api.github.com/search/issues');
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', '1');

  const urlStr = url.toString();
  assertGitHubApiUrl(urlStr);
  const response = await fetch(urlStr, { headers });
  checkRateLimitResponse(response);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${error}`);
  }

  const result = await response.json() as { total_count?: number };
  return typeof result.total_count === 'number' ? result.total_count : 0;
}

export async function fetchGitHubRepoTree(
  owner: string,
  repo: string,
  branch: string,
  headers: Record<string, string>,
) {
  validateGitHubIdentifier(owner, 'owner');
  validateGitHubIdentifier(repo, 'repo');
  const encodedBranch = encodeURIComponent(branch);
  const branchUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodedBranch}`;
  assertGitHubApiUrl(branchUrl);
  const branchResponse = await fetch(branchUrl, { headers });
  checkRateLimitResponse(branchResponse);

  let treeSha: string | null = null;
  if (branchResponse.ok) {
    const branchData = await branchResponse.json() as {
      commit?: { commit?: { tree?: { sha?: string } } }
    };
    treeSha = branchData.commit?.commit?.tree?.sha ?? null;
  }

  const treeTarget = treeSha ?? encodedBranch;
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${treeTarget}?recursive=1`;
  assertGitHubApiUrl(treeUrl);
  const treeResponse = await fetch(treeUrl, { headers });
  checkRateLimitResponse(treeResponse);

  if (!treeResponse.ok) {
    const error = await treeResponse.text();
    return {
      ok: false as const,
      status: treeResponse.status,
      error: `GitHub API error: ${error}`,
    };
  }

  const treeData = await treeResponse.json() as {
    tree: Array<{ path: string; type: string; size?: number; sha: string }>;
    truncated: boolean;
  };

  const items = treeData.tree
    .filter((item: { type: string }) => item.type === 'blob' || item.type === 'tree')
    .map((item: { path: string; type: string; size?: number; sha: string }) => ({
      path: item.path,
      type: item.type === 'tree' ? 'dir' : 'file',
      size: item.size || 0,
      sha: item.sha,
    }));

  return {
    ok: true as const,
    items,
    truncated: treeData.truncated,
  };
}

export function createSingleMessageDataStream(text: string, usage?: { input?: number; output?: number; total?: number }) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(formatDataStreamPart('text', text)));
      controller.enqueue(
        encoder.encode(
          formatDataStreamPart('finish_message', {
            finishReason: 'stop',
            usage: {
              promptTokens: usage?.input ?? 0,
              completionTokens: usage?.output ?? 0,
            },
          }),
        ),
      );
      controller.close();
    },
  });
}
