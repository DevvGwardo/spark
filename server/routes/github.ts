import type { Express } from 'express';
import { sendJson } from '../lib/helpers';
import {
  buildGitHubContentsUrl,
  fetchGitHubRepoTree,
  fetchRecentRepoActivity,
  getUnknownErrorMessage,
  isValidGitHubPAT,
  toGitHubIssue,
  withLocalClone,
} from '../lib/github-utils';
import { ensureRepoClone, forkRepository } from '../repo-clone-manager';
import { verifyRepoChanges, generatePrMetadata, type VerificationFileChange } from '../repo-verifier';
import { normalizeChatMessages } from '../message-normalization';

// ─── GitHub route helper types and functions ─────────────────────────────────

interface FileChange {
  path: string;
  content: string;
  action?: 'create' | 'edit' | 'delete';
}

type GitHubCheckState = 'success' | 'failure' | 'pending';

interface PullRequestCheck {
  name: string;
  provider: string;
  status: GitHubCheckState;
  detailsUrl: string | null;
  summary: string | null;
}

function getCheckState(status?: string | null, conclusion?: string | null): GitHubCheckState {
  if (status === 'queued' || status === 'in_progress' || status === 'waiting' || status === 'requested' || status === 'pending') {
    return 'pending';
  }

  if (status === 'completed') {
    if (!conclusion || conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
      return 'success';
    }
    return 'failure';
  }

  if (status === 'success') return 'success';
  if (status === 'failure' || status === 'error') return 'failure';
  return 'pending';
}

function getLegacyStatusProvider(context: string): { provider: string; name: string } {
  const separators = [' / ', ': ', ' - '];
  for (const separator of separators) {
    const index = context.indexOf(separator);
    if (index > 0) {
      return {
        provider: context.slice(0, index),
        name: context.slice(index + separator.length),
      };
    }
  }

  return {
    provider: 'Commit statuses',
    name: context,
  };
}

function summarizeChecks(checks: PullRequestCheck[]) {
  const summary = {
    total: checks.length,
    passed: 0,
    failed: 0,
    pending: 0,
  };

  const providers = new Map<string, {
    name: string;
    total: number;
    passed: number;
    failed: number;
    pending: number;
    checks: PullRequestCheck[];
  }>();

  for (const check of checks) {
    if (check.status === 'success') summary.passed += 1;
    if (check.status === 'failure') summary.failed += 1;
    if (check.status === 'pending') summary.pending += 1;

    const existing = providers.get(check.provider) || {
      name: check.provider,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      checks: [],
    };

    existing.total += 1;
    if (check.status === 'success') existing.passed += 1;
    if (check.status === 'failure') existing.failed += 1;
    if (check.status === 'pending') existing.pending += 1;
    existing.checks.push(check);
    providers.set(check.provider, existing);
  }

  const overall =
    summary.failed > 0
      ? 'failing'
      : summary.pending > 0
        ? 'pending'
        : summary.total > 0
          ? 'passing'
          : 'none';

  return {
    summary,
    overall,
    providers: [...providers.values()].sort((left, right) => {
      if (left.failed !== right.failed) return right.failed - left.failed;
      if (left.pending !== right.pending) return right.pending - left.pending;
      return left.name.localeCompare(right.name);
    }),
  };
}

async function fetchPullRequestStatus(
  owner: string,
  repo: string,
  number: number,
  headers: Record<string, string>,
) {
  const prRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    { headers },
  );

  if (!prRes.ok) {
    throw new Error(`Failed to fetch PR: ${await prRes.text()}`);
  }

  const pr = await prRes.json();
  const headSha = pr?.head?.sha as string | undefined;
  const checks: PullRequestCheck[] = [];

  if (headSha) {
    const [checkRunsRes, statusesRes] = await Promise.all([
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
        { headers },
      ),
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/status`,
        { headers },
      ),
    ]);

    if (checkRunsRes.ok) {
      const data = await checkRunsRes.json();
      const runs = Array.isArray(data?.check_runs) ? data.check_runs : [];
      for (const run of runs) {
        checks.push({
          name: typeof run?.name === 'string' ? run.name : 'Unnamed check',
          provider: typeof run?.app?.name === 'string' ? run.app.name : 'Checks',
          status: getCheckState(run?.status, run?.conclusion),
          detailsUrl: typeof run?.html_url === 'string' ? run.html_url : null,
          summary: typeof run?.output?.title === 'string'
            ? run.output.title
            : typeof run?.conclusion === 'string'
              ? run.conclusion
              : null,
        });
      }
    }

    if (statusesRes.ok) {
      const data = await statusesRes.json();
      const statuses = Array.isArray(data?.statuses) ? data.statuses : [];
      for (const status of statuses) {
        const { provider, name } = getLegacyStatusProvider(
          typeof status?.context === 'string' ? status.context : 'Status',
        );
        checks.push({
          name,
          provider,
          status: getCheckState(status?.state, null),
          detailsUrl: typeof status?.target_url === 'string' ? status.target_url : null,
          summary: typeof status?.description === 'string' ? status.description : null,
        });
      }
    }
  }

  return {
    pr: {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      url: pr.html_url,
      state: pr.state,
      draft: !!pr.draft,
      merged: !!pr.merged,
      mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
      mergeableState: typeof pr.mergeable_state === 'string' ? pr.mergeable_state : null,
      headBranch: pr?.head?.ref || '',
      baseBranch: pr?.base?.ref || '',
    },
    checks: summarizeChecks(checks),
  };
}

async function fetchRepoContents(
  owner: string,
  repo: string,
  path: string,
  headers: Record<string, string>
): Promise<Array<{ path: string; type: 'dir'; children: [] } | { path: string; type: 'file'; size: number; sha: string }>> {
  const url = buildGitHubContentsUrl(owner, repo, path);
  const response = await fetch(url, { headers });

  if (!response.ok) {
    return [];
  }

  const data = await response.json() as unknown;

  if (!Array.isArray(data)) {
    const file = data as { path: string; size: number; sha: string };
    return [
      {
        path: file.path,
        type: 'file',
        size: file.size,
        sha: file.sha,
      },
    ];
  }

  const contents: Array<{ path: string; type: 'dir'; children: [] } | { path: string; type: 'file'; size: number; sha: string }> = [];
  for (const item of data as Array<{ type: string; path: string; size?: number; sha?: string }>) {
    if (item.type === 'dir') {
      contents.push({
        path: item.path,
        type: 'dir',
        children: [],
      });
    } else if (item.type === 'file') {
      contents.push({
        path: item.path,
        type: 'file',
        size: item.size || 0,
        sha: item.sha || '',
      });
    }
  }

  return contents;
}

// ─── GitHub Analyzer helpers ─────────────────────────────────────────────────

interface FileContent {
  path: string;
  content: string;
  language: string;
}

const getFileLanguage = (filePath: string): string => {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    c: 'c',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
  };
  return langMap[ext || ''] || 'text';
};

const isCodeFile = (filePath: string): boolean => {
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'cs', 'php', 'rb',
    'swift', 'kt', 'vue', 'svelte',
  ];
  const ext = filePath.split('.').pop()?.toLowerCase();
  return codeExtensions.includes(ext || '');
};

async function fetchAnalyzerRepoFiles(
  owner: string,
  repo: string,
  pat: string
): Promise<FileContent[]> {
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitHub-Analyzer',
  };

  async function fetchContentsRecursive(path = ''): Promise<FileContent[]> {
    const url = buildGitHubContentsUrl(owner, repo, path);
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch contents: ${response.status}`);
    }

    const data = await response.json();
    const files: FileContent[] = [];

    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.type === 'file' && isCodeFile(item.path) && item.size < 100000) {
          try {
            const fileResponse = await fetch(item.download_url, {
              headers: { 'User-Agent': 'GitHub-Analyzer' },
            });
            if (fileResponse.ok) {
              const content = await fileResponse.text();
              files.push({
                path: item.path,
                content,
                language: getFileLanguage(item.path),
              });
            }
          } catch (error) {
            console.warn(`Failed to fetch file ${item.path}:`, error);
          }
        } else if (
          item.type === 'dir' &&
          !item.path.includes('node_modules') &&
          !item.path.includes('.git') &&
          files.length < 50
        ) {
          const subFiles = await fetchContentsRecursive(item.path);
          files.push(...subFiles);
        }
      }
    }

    return files;
  }

  return await fetchContentsRecursive();
}

async function analyzeCode(files: FileContent[]): Promise<unknown[]> {
  const lovableApiKey = process.env.LOVABLE_API_KEY;

  if (!lovableApiKey) {
    throw new Error('Lovable API key not configured');
  }

  const codebaseContext = files.map((file) => ({
    path: file.path,
    language: file.language,
    lines: file.content.split('\n').length,
    preview: file.content.slice(0, 1000),
  }));

  const analysisPrompt = `
Analyze the following codebase for bugs, security issues, performance problems, and improvement opportunities.

Codebase Overview:
${JSON.stringify(codebaseContext, null, 2)}

Full file contents:
${files.map((file) => `=== ${file.path} (${file.language}) ===\n${file.content}\n`).join('\n')}

Please provide a detailed analysis in JSON format with the following structure:
{
  "analysis": [
    {
      "type": "bug|improvement|security|performance",
      "severity": "low|medium|high",
      "title": "Brief title describing the issue",
      "description": "Detailed description of the issue or improvement opportunity",
      "file": "path/to/file.ext",
      "line": 123,
      "suggestion": "Detailed suggestion on how to fix or improve this"
    }
  ]
}

Focus on:
1. Common programming bugs (null pointer exceptions, logic errors, etc.)
2. Security vulnerabilities (XSS, injection attacks, exposed secrets)
3. Performance issues (inefficient algorithms, memory leaks)
4. Code quality improvements (best practices, maintainability)
5. Missing error handling
6. Potential race conditions
7. Dependency vulnerabilities

Be specific about file names and line numbers when possible. Provide actionable suggestions.
`;

  try {
    const analysisMessages = normalizeChatMessages(
      [{ role: 'user', content: analysisPrompt }],
      'You are an expert code reviewer specializing in finding bugs, security issues, and improvement opportunities. Always respond with valid JSON.',
    ).messages;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: analysisMessages,
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      throw new Error(`AI analysis failed: ${response.status}`);
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices[0]?.message?.content;

    if (!content) {
      throw new Error('No analysis content received from AI');
    }

    try {
      const parsed = JSON.parse(content);
      return parsed.analysis || [];
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.analysis || [];
      }
      throw new Error('Invalid JSON response from AI');
    }
  } catch (error: unknown) {
    console.error('AI analysis error:', error);
    throw new Error(`AI analysis failed: ${getUnknownErrorMessage(error)}`);
  }
}

// ─── Route registration ──────────────────────────────────────────────────────

export function registerGitHubRoutes(app: Express) {

app.post('/functions/v1/github-integration', async (req, res) => {
  try {
    const { action, pat, ...params } = req.body;

    if (!pat || !isValidGitHubPAT(pat)) {
      return sendJson(res, 400, { error: 'A valid GitHub PAT is required' });
    }

    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CloudChat-App',
    };

    switch (action) {
      case 'list-repos': {
        let allRepos: Record<string, unknown>[] = [];
        let url: string | null = 'https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member';
        while (url) {
          const response: Response = await fetch(url, { headers });
          if (!response.ok) {
            const error = await response.text();
            return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
          }
          const page = await response.json();
          if (Array.isArray(page)) {
            allRepos = allRepos.concat(page);
          }
          // Parse Link header for next page
          const linkHeader: string = response.headers.get('Link') || '';
          const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          url = nextMatch ? nextMatch[1] : null;
        }
        const normalized = await Promise.all(allRepos.map((repo) => withLocalClone(repo as Parameters<typeof withLocalClone>[0])));
        return sendJson(res, 200, { repos: normalized });
      }

      case 'search-repos': {
        const { query, page = 1 } = params as { query?: string; page?: number };
        if (!query || !query.trim()) {
          return sendJson(res, 400, { error: 'query is required' });
        }

        const response = await fetch(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(query.trim())}&per_page=25&page=${Number(page) || 1}`,
          { headers },
        );
        if (!response.ok) {
          const error = await response.text();
          return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
        }

        const result = await response.json() as {
          total_count?: number;
          incomplete_results?: boolean;
          items?: Array<Record<string, unknown>>;
        };
        const repos = await Promise.all((result.items || []).map((repo) => withLocalClone(repo as Parameters<typeof withLocalClone>[0])));
        return sendJson(res, 200, {
          repos,
          totalCount: result.total_count || 0,
          incompleteResults: !!result.incomplete_results,
          page: Number(page) || 1,
          perPage: 25,
        });
      }

      case 'list-issues': {
        const {
          owner,
          repo,
          page = 1,
          sort = 'updated',
          direction = 'desc',
          state = 'open',
          query = '',
          labels = [],
        } = params as {
          owner?: string;
          repo?: string;
          page?: number;
          sort?: 'created' | 'updated' | 'comments';
          direction?: 'asc' | 'desc';
          state?: 'open' | 'closed' | 'all';
          query?: string;
          labels?: string[];
        };

        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }

        const searchTerms = [
          `repo:${owner}/${repo}`,
          'is:issue',
          state !== 'all' ? `state:${state}` : '',
          ...(Array.isArray(labels) ? labels.map((l) => `label:"${String(l).replace(/"/g, '')}"`) : []),
          typeof query === 'string' ? query.trim() : '',
        ].filter(Boolean).join(' ');

        const response = await fetch(
          `https://api.github.com/search/issues?q=${encodeURIComponent(searchTerms)}&sort=${encodeURIComponent(sort)}&order=${encodeURIComponent(direction)}&per_page=25&page=${Number(page) || 1}`,
          { headers },
        );
        if (!response.ok) {
          const error = await response.text();
          return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
        }

        const result = await response.json() as {
          total_count?: number;
          incomplete_results?: boolean;
          items?: Array<Record<string, unknown>>;
        };
        const totalCount = result.total_count || 0;
        const totalPages = Math.max(1, Math.min(Math.ceil(totalCount / 25), 40));
        const currentPage = Math.min(Math.max(Number(page) || 1, 1), totalPages);

        return sendJson(res, 200, {
          issues: (result.items || []).map((issue) => toGitHubIssue(issue as Parameters<typeof toGitHubIssue>[0])),
          totalCount,
          incompleteResults: !!result.incomplete_results,
          page: currentPage,
          perPage: 25,
          totalPages,
          hasPreviousPage: currentPage > 1,
          hasNextPage: currentPage < totalPages,
        });
      }

      case 'repo-activity': {
        const { owner, repo } = params as { owner?: string; repo?: string };
        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }

        try {
          const activity = await fetchRecentRepoActivity(owner, repo, headers);
          return sendJson(res, 200, activity);
        } catch (error) {
          return sendJson(res, 502, { error: getUnknownErrorMessage(error) });
        }
      }

      case 'create-issue': {
        const { owner, repo, title, body } = params as {
          owner?: string;
          repo?: string;
          title?: string;
          body?: string;
        };

        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }

        if (typeof title !== 'string' || title.trim().length === 0) {
          return sendJson(res, 400, { error: 'title is required' });
        }

        const issueResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: title.trim(),
              ...(typeof body === 'string' && body.trim().length > 0 ? { body: body.trim() } : {}),
            }),
          },
        );
        if (!issueResponse.ok) {
          const error = await issueResponse.text();
          return sendJson(res, issueResponse.status, { error: `GitHub API error: ${error}` });
        }

        const issue = await issueResponse.json() as Parameters<typeof toGitHubIssue>[0];
        return sendJson(res, 200, {
          issue: toGitHubIssue(issue),
        });
      }

      case 'clone-repo': {
        const { owner, repo, branch } = params as { owner?: string; repo?: string; branch?: string };
        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }

        const clone = await ensureRepoClone({ owner, repo, pat, branch });
        return sendJson(res, 200, {
          clone,
          repo: await withLocalClone({
            owner: { login: owner },
            name: repo,
            full_name: `${owner}/${repo}`,
            default_branch: branch || 'main',
          }),
        });
      }

      case 'fork-repo': {
        const { owner, repo, branch } = params as { owner?: string; repo?: string; branch?: string };
        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }

        const fork = await forkRepository({ owner, repo, pat, branch });
        return sendJson(res, 200, {
          repo: await withLocalClone({
            owner: { login: fork.owner },
            name: fork.repo,
            full_name: fork.fullName,
            default_branch: fork.defaultBranch,
            html_url: fork.htmlUrl,
            fork: true,
          }),
          sourceRepo: {
            owner,
            repo,
            fullName: `${owner}/${repo}`,
          },
        });
      }

      case 'list-issue-comments': {
        const { owner, repo, issueNumber } = params as { owner?: string; repo?: string; issueNumber?: number };
        if (!owner || !repo || !issueNumber) {
          return sendJson(res, 400, { error: 'owner, repo, and issueNumber are required' });
        }

        const response = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${Number(issueNumber)}/comments?per_page=50`,
          { headers: { ...headers, Accept: 'application/vnd.github.squirrel-girl-preview+json' } },
        );
        if (!response.ok) {
          const error = await response.text();
          return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
        }

        const rawComments = await response.json() as Array<{
          id?: number;
          user?: { login?: string; avatar_url?: string | null };
          body?: string;
          created_at?: string;
          updated_at?: string;
          reactions?: Record<string, number>;
        }>;

        return sendJson(res, 200, {
          comments: (rawComments || []).map((c) => ({
            id: c.id || 0,
            user: { login: c.user?.login || 'unknown', avatar_url: c.user?.avatar_url || null },
            body: c.body || '',
            created_at: c.created_at || new Date(0).toISOString(),
            updated_at: c.updated_at || new Date(0).toISOString(),
            reactions: {
              '+1': c.reactions?.['+1'] || 0,
              '-1': c.reactions?.['-1'] || 0,
              laugh: c.reactions?.laugh || 0,
              hooray: c.reactions?.hooray || 0,
              confused: c.reactions?.confused || 0,
              heart: c.reactions?.heart || 0,
              rocket: c.reactions?.rocket || 0,
              eyes: c.reactions?.eyes || 0,
            },
          })),
        });
      }

      case 'add-comment-reaction': {
        const { owner, repo, commentId, reaction } = params as {
          owner?: string; repo?: string; commentId?: number; reaction?: string;
        };
        if (!owner || !repo || !commentId || !reaction) {
          return sendJson(res, 400, { error: 'owner, repo, commentId, and reaction are required' });
        }

        const validReactions = ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'];
        if (!validReactions.includes(reaction)) {
          return sendJson(res, 400, { error: `Invalid reaction. Must be one of: ${validReactions.join(', ')}` });
        }

        const reactionResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${Number(commentId)}/reactions`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/vnd.github.squirrel-girl-preview+json' },
            body: JSON.stringify({ content: reaction }),
          },
        );
        if (!reactionResponse.ok) {
          const error = await reactionResponse.text();
          return sendJson(res, reactionResponse.status, { error: `GitHub API error: ${error}` });
        }

        const reactionData = await reactionResponse.json() as { id?: number; content?: string };
        return sendJson(res, 200, { reaction: { id: reactionData.id || 0, content: reactionData.content || reaction } });
      }

      case 'create-issue-comment': {
        const { owner, repo, issueNumber, body: commentBody } = params as {
          owner?: string; repo?: string; issueNumber?: number; body?: string;
        };
        if (!owner || !repo || !issueNumber || !commentBody) {
          return sendJson(res, 400, { error: 'owner, repo, issueNumber, and body are required' });
        }

        const commentResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${Number(issueNumber)}/comments`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: commentBody }),
          },
        );
        if (!commentResponse.ok) {
          const error = await commentResponse.text();
          return sendJson(res, commentResponse.status, { error: `GitHub API error: ${error}` });
        }

        const rawComment = await commentResponse.json() as {
          id?: number;
          user?: { login?: string; avatar_url?: string | null };
          body?: string;
          created_at?: string;
          updated_at?: string;
        };

        return sendJson(res, 200, {
          comment: {
            id: rawComment.id || 0,
            user: { login: rawComment.user?.login || 'unknown', avatar_url: rawComment.user?.avatar_url || null },
            body: rawComment.body || '',
            created_at: rawComment.created_at || new Date(0).toISOString(),
            updated_at: rawComment.updated_at || new Date(0).toISOString(),
          },
        });
      }

      case 'create-branch': {
        const { owner, repo, baseBranch, newBranchName } = params as {
          owner?: string; repo?: string; baseBranch?: string; newBranchName?: string;
        };
        if (!owner || !repo || !baseBranch || !newBranchName) {
          return sendJson(res, 400, { error: 'owner, repo, baseBranch, and newBranchName are required' });
        }

        // Get the SHA of the base branch
        const refResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
          { headers },
        );
        if (!refResponse.ok) {
          const error = await refResponse.text();
          return sendJson(res, refResponse.status, { error: `Failed to resolve base branch: ${error}` });
        }
        const refData = await refResponse.json() as { object?: { sha?: string } };
        const sha = refData.object?.sha;
        if (!sha) {
          return sendJson(res, 500, { error: 'Could not resolve base branch SHA' });
        }

        // Create the new branch
        const createResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: `refs/heads/${newBranchName}`, sha }),
          },
        );

        if (!createResponse.ok) {
          if (createResponse.status === 422) {
            return sendJson(res, 200, { branch: newBranchName, sha, created: false });
          }
          const error = await createResponse.text();
          return sendJson(res, createResponse.status, { error: `Failed to create branch: ${error}` });
        }

        return sendJson(res, 200, { branch: newBranchName, sha, created: true });
      }

      case 'list-linked-prs': {
        const { owner, repo, issueNumber } = params as { owner?: string; repo?: string; issueNumber?: number };
        if (!owner || !repo || !issueNumber) {
          return sendJson(res, 400, { error: 'owner, repo, and issueNumber are required' });
        }

        const q = `repo:${owner}/${repo} is:pr is:open ${issueNumber} in:body`;
        const response = await fetch(
          `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=10`,
          { headers },
        );
        if (!response.ok) {
          const error = await response.text();
          return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
        }

        const result = await response.json() as {
          items?: Array<{
            number?: number;
            title?: string;
            html_url?: string;
            state?: string;
            draft?: boolean;
            pull_request?: { html_url?: string };
            user?: { login?: string };
            created_at?: string;
          }>;
        };

        return sendJson(res, 200, {
          prs: (result.items || []).map((pr) => ({
            number: pr.number || 0,
            title: pr.title || '',
            html_url: pr.html_url || '',
            state: pr.state || 'open',
            draft: pr.draft ?? false,
            user: { login: pr.user?.login || 'unknown' },
            created_at: pr.created_at || new Date(0).toISOString(),
          })),
        });
      }

      case 'read-repo': {
        const { owner, repo, path = '' } = params;
        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }
        const contents = await fetchRepoContents(owner, repo, path, headers);
        return sendJson(res, 200, { contents });
      }

      case 'read-tree': {
        const { owner, repo, branch } = params;
        if (!owner || !repo || !branch) {
          return sendJson(res, 400, { error: 'owner, repo, and branch are required' });
        }
        const treeResult = await fetchGitHubRepoTree(owner, repo, branch, headers);
        if (!treeResult.ok) {
          return sendJson(res, treeResult.status, { error: treeResult.error });
        }
        return sendJson(res, 200, { items: treeResult.items, truncated: treeResult.truncated });
      }

      case 'read-file': {
        const { owner, repo, path, ref } = params;
        if (!owner || !repo || !path) {
          return sendJson(res, 400, { error: 'owner, repo, and path are required' });
        }

        const response = await fetch(
          buildGitHubContentsUrl(owner, repo, path, typeof ref === 'string' && ref ? ref : undefined),
          { headers }
        );

        if (!response.ok) {
          const error = await response.text().catch(() => '');
          return sendJson(res, response.status, {
            error: response.status === 404
              ? `File \`${path}\` was not found${typeof ref === 'string' && ref ? ` on branch \`${ref}\`` : ''}.`
              : `GitHub API error: ${error || 'File not found or inaccessible'}`,
          });
        }

        const data = await response.json();
        if (!data.content) {
          return sendJson(res, 400, {
            error: Array.isArray(data) ? 'Path is a directory, not a file' : 'File content unavailable',
          });
        }
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return sendJson(res, 200, { content, sha: data.sha });
      }

      case 'create-pr': {
        const { owner, repo, title, body, branch, baseBranch, baseOwner, baseRepo, draft, files } = params as {
          owner: string;
          repo: string;
          title: string;
          body: string;
          branch: string;
          baseBranch: string;
          baseOwner?: string;
          baseRepo?: string;
          draft?: boolean;
          files: FileChange[];
        };

        if (!owner || !repo || !title || !branch || !baseBranch || !files?.length) {
          return sendJson(res, 400, {
            error: 'Missing required parameters for PR creation',
          });
        }

        const headOwner = owner;
        const headRepo = repo;
        const pullRequestBaseOwner = baseOwner || owner;
        const pullRequestBaseRepo = baseRepo || repo;

        // 1. Get the base branch's latest commit SHA
        const baseRefRes = await fetch(
          `https://api.github.com/repos/${headOwner}/${headRepo}/git/ref/heads/${baseBranch}`,
          { headers }
        );
        if (!baseRefRes.ok) {
          return sendJson(res, baseRefRes.status, {
            error: `Failed to get base branch: ${await baseRefRes.text()}`,
          });
        }
        const baseRef = await baseRefRes.json();
        const baseSha = baseRef.object.sha;

        // 2. Create a new branch from the base
        const createBranchRes = await fetch(
          `https://api.github.com/repos/${headOwner}/${headRepo}/git/refs`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ref: `refs/heads/${branch}`,
              sha: baseSha,
            }),
          }
        );

        if (!createBranchRes.ok && createBranchRes.status !== 422) {
          return sendJson(res, createBranchRes.status, {
            error: `Failed to create branch: ${await createBranchRes.text()}`,
          });
        }

        // 3. Create/update/delete files on the new branch
        for (const file of files) {
          let fileSha: string | undefined;
          const existingFileRes = await fetch(
            buildGitHubContentsUrl(headOwner, headRepo, file.path, branch),
            { headers }
          );
          if (existingFileRes.ok) {
            const existingFile = await existingFileRes.json();
            fileSha = existingFile.sha;
          }

          if (file.action === 'delete') {
            // Only delete if the file actually exists in the repo
            if (!fileSha) continue;
            const deleteRes = await fetch(
              buildGitHubContentsUrl(headOwner, headRepo, file.path),
              {
                method: 'DELETE',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  message: `Delete ${file.path}`,
                  branch,
                  sha: fileSha,
                }),
              }
            );
            if (!deleteRes.ok) {
              return sendJson(res, deleteRes.status, {
                error: `Failed to delete ${file.path}: ${await deleteRes.text()}`,
              });
            }
          } else {
            const updateRes = await fetch(
              buildGitHubContentsUrl(headOwner, headRepo, file.path),
              {
                method: 'PUT',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  message: `${file.action === 'create' ? 'Create' : 'Update'} ${file.path}`,
                  content: Buffer.from(file.content, 'utf-8').toString('base64'),
                  branch,
                  ...(fileSha && { sha: fileSha }),
                }),
              }
            );

            if (!updateRes.ok) {
              return sendJson(res, updateRes.status, {
                error: `Failed to update ${file.path}: ${await updateRes.text()}`,
              });
            }
          }
        }

        // 4. Create the PR
        const prRes = await fetch(
          `https://api.github.com/repos/${pullRequestBaseOwner}/${pullRequestBaseRepo}/pulls`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              body,
              head: pullRequestBaseOwner === headOwner && pullRequestBaseRepo === headRepo
                ? branch
                : `${headOwner}:${branch}`,
              base: baseBranch,
              ...(draft ? { draft: true } : {}),
            }),
          }
        );

        if (!prRes.ok) {
          return sendJson(res, prRes.status, {
            error: `Failed to create PR: ${await prRes.text()}`,
          });
        }

        const pr = await prRes.json();
        return sendJson(res, 200, {
          pr: {
            number: pr.number,
            url: pr.html_url,
            title: pr.title,
            body: pr.body || '',
            state: pr.state,
            draft: !!pr.draft,
            headBranch: pr?.head?.ref || branch,
            baseBranch: pr?.base?.ref || baseBranch,
            headRepo: `${headOwner}/${headRepo}`,
            baseRepo: `${pullRequestBaseOwner}/${pullRequestBaseRepo}`,
          },
        });
      }

      case 'verify-changes': {
        const {
          owner,
          repo,
          baseBranch,
          files,
          provider,
          model,
          apiKey,
          allProviders,
          stream: wantsStream,
        } = params as {
          owner: string;
          repo: string;
          baseBranch: string;
          files: VerificationFileChange[];
          provider?: string;
          model?: string;
          apiKey?: string;
          allProviders?: Record<string, { apiKey: string; model: string }>;
          stream?: boolean;
        };

        if (!owner || !repo || !baseBranch || !Array.isArray(files) || files.length === 0) {
          return sendJson(res, 400, {
            error: 'owner, repo, baseBranch, and files are required',
          });
        }

        if (wantsStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const onProgress: import('../repo-verifier').OnVerificationProgress = (event) => {
            res.write(`data: ${JSON.stringify({ type: 'progress', ...event })}\n\n`);
          };

          try {
            const verification = await verifyRepoChanges({
              owner,
              repo,
              pat,
              baseBranch,
              files,
              provider,
              model,
              apiKey,
              origin: req.headers.origin as string | undefined,
              allProviders,
              onProgress,
            });

            res.write(`data: ${JSON.stringify({ type: 'result', ...verification })}\n\n`);
          } catch (error) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: getUnknownErrorMessage(error) })}\n\n`);
          }

          res.end();
          return;
        }

        const verification = await verifyRepoChanges({
          owner,
          repo,
          pat,
          baseBranch,
          files,
          provider,
          model,
          apiKey,
          origin: req.headers.origin as string | undefined,
          allProviders,
        });

        return sendJson(res, 200, verification);
      }

      case 'generate-pr-metadata': {
        const {
          files,
          provider,
          model,
          apiKey,
          allProviders,
          owner,
          repo,
        } = params as {
          files: VerificationFileChange[];
          provider?: string;
          model?: string;
          apiKey?: string;
          allProviders?: Record<string, { apiKey: string; model: string }>;
          owner?: string;
          repo?: string;
        };

        if (!Array.isArray(files) || files.length === 0) {
          return sendJson(res, 400, { error: 'files are required' });
        }

        try {
          const metadata = await generatePrMetadata({
            files,
            provider,
            model,
            apiKey,
            allProviders,
            origin: req.headers.origin as string | undefined,
            owner,
            repo,
          });
          return sendJson(res, 200, metadata);
        } catch (error) {
          return sendJson(res, 500, {
            error: error instanceof Error ? error.message : 'Failed to generate PR metadata',
          });
        }
      }

      case 'get-pr-status': {
        const { owner, repo, number, baseOwner, baseRepo } = params as {
          owner: string;
          repo: string;
          number: number;
          baseOwner?: string;
          baseRepo?: string;
        };

        if (!owner || !repo || !number) {
          return sendJson(res, 400, { error: 'owner, repo, and number are required' });
        }

        const status = await fetchPullRequestStatus(baseOwner || owner, baseRepo || repo, Number(number), headers);
        return sendJson(res, 200, status);
      }

      case 'merge-pr': {
        const {
          owner,
          repo,
          number,
          baseOwner,
          baseRepo,
          method,
          commitTitle,
          commitMessage,
        } = params as {
          owner: string;
          repo: string;
          number: number;
          baseOwner?: string;
          baseRepo?: string;
          method?: 'merge' | 'squash' | 'rebase';
          commitTitle?: string;
          commitMessage?: string;
        };

        if (!owner || !repo || !number) {
          return sendJson(res, 400, { error: 'owner, repo, and number are required' });
        }

        const mergeRes = await fetch(
          `https://api.github.com/repos/${baseOwner || owner}/${baseRepo || repo}/pulls/${number}/merge`,
          {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              merge_method: method || 'squash',
              ...(commitTitle ? { commit_title: commitTitle } : {}),
              ...(commitMessage ? { commit_message: commitMessage } : {}),
            }),
          }
        );

        if (!mergeRes.ok) {
          return sendJson(res, mergeRes.status, {
            error: `Failed to merge PR: ${await mergeRes.text()}`,
          });
        }

        const merged = await mergeRes.json();
        return sendJson(res, 200, {
          merged: {
            sha: merged.sha,
            merged: !!merged.merged,
            message: merged.message,
          },
        });
      }

      default:
        return sendJson(res, 400, { error: 'Unknown action' });
    }
  } catch (error: unknown) {
    console.error('GitHub integration error:', error);
    return sendJson(res, 500, { error: getUnknownErrorMessage(error) });
  }
});

// ─── /functions/v1/github-analyzer ───────────────────────────────────────────

app.post('/functions/v1/github-analyzer', async (req, res) => {
  try {
    const { owner, repo, pat } = req.body;

    if (!owner || !repo || !isValidGitHubPAT(pat)) {
      return sendJson(res, 400, { error: 'owner, repo, and a valid GitHub PAT are required' });
    }

    // Fetch repository files for analysis
    const files = await fetchAnalyzerRepoFiles(owner, repo, pat);

    if (files.length === 0) {
      return sendJson(res, 400, { error: 'No code files found in repository' });
    }

    // Analyze fetched files
    const analysis = await analyzeCode(files);

    return sendJson(res, 200, {
      analysis,
      filesAnalyzed: files.length,
      repository: `${owner}/${repo}`,
    });
  } catch (error: unknown) {
    console.error('GitHub analyzer error:', error);
    return sendJson(res, 500, { error: getUnknownErrorMessage(error) });
  }
});

}
