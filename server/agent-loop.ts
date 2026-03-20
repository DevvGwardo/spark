import { tool, type CoreTool } from 'ai';
import { z } from 'zod';
import {
  normalizeBatchEditRepoFilesArgs,
  normalizeCreateRepoFileArgs,
  normalizeDeleteRepoFileArgs,
  normalizeEditRepoFileArgs,
  normalizeProposeChangesArgs,
} from '../src/lib/repo-tool-args';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RepoContext {
  owner: string;
  name: string;
  defaultBranch: string;
  githubPAT: string;
  repoFileTree: string[];
  repoFileCache: Record<string, string>;
  repoEditIntent: boolean;
}

export interface ServerToolEvent {
  type: string;
  [key: string]: unknown;
}

type EmitEvent = (event: ServerToolEvent) => void;

// ─── Constants ───────────────────────────────────────────────────────────────


const GITHUB_API_BASE = 'https://api.github.com';

function encodeGitHubContentPath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

// ─── GitHub file reader ──────────────────────────────────────────────────────

async function readFileFromGitHub(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  pat: string,
): Promise<{ content: string | null; error: string | null }> {
  try {
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeGitHubContentPath(path)}?ref=${encodeURIComponent(ref)}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github.v3.raw',
        'User-Agent': 'CloudChat-Hub',
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { content: null, error: `GitHub returned ${response.status}${text ? ` — ${text.slice(0, 200)}` : ''}` };
    }
    const content = await response.text();
    return { content, error: null };
  } catch (err) {
    return { content: null, error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function normalizeRepoPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

function resolveRepoWriteAction(
  requestedAction: 'create' | 'edit' | 'delete',
  path: string,
  existingPaths: Set<string>,
): 'create' | 'edit' | 'delete' {
  if (requestedAction === 'create' && existingPaths.has(path)) {
    return 'edit';
  }
  return requestedAction;
}

function isInvalidRepoReadPath(path: string): boolean {
  return !path || path === '.' || path === '/' || path.endsWith('/');
}

function getRepoPathSuggestions(paths: string[], requestedPath: string, limit = 6): string[] {
  const normalized = normalizeRepoPath(requestedPath).toLowerCase();
  const basename = normalized.split('/').at(-1) || normalized;

  return paths
    .map((candidate) => {
      const candidateLower = candidate.toLowerCase();
      const candidateBase = candidateLower.split('/').at(-1) || candidateLower;
      let score = 0;
      if (candidateLower === normalized) score += 100;
      if (candidateBase === basename) score += 60;
      if (basename && candidateBase.includes(basename)) score += 30;
      if (basename && candidateLower.includes(basename)) score += 20;
      if (normalized && candidateLower.includes(normalized)) score += 10;
      return { candidate, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((e) => e.candidate);
}

// ─── Tool builder ────────────────────────────────────────────────────────────

/**
 * Build repo tools with server-side `execute` handlers so the AI SDK
 * runs the tool loop without round-tripping to the client.
 *
 * File creation tools (artifacts) are NOT included — those still execute
 * client-side since they write to the preview store.
 */
export function buildServerRepoTools(repo: RepoContext, emit: EmitEvent) {
  // Per-session file cache seeded from the request's repo_file_cache
  const sessionCache: Record<string, string> = { ...repo.repoFileCache };
  const existingPaths = new Set<string>([
    ...repo.repoFileTree,
    ...Object.keys(repo.repoFileCache),
  ]);
  const proposalPlanItemSchema = z.object({
    path: z.string().describe('The file path'),
    action: z.enum(['create', 'edit', 'delete']).describe('The type of change: "create", "edit", or "delete"'),
    description: z.string().describe('Description of this change'),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, CoreTool<any, any>> = {};

  // ── read_repo_file ─────────────────────────────────────────────────────
  tools.read_repo_file = tool({
    description: 'Read a file from the active GitHub repository. Returns the file content.',
    parameters: z.object({
      path: z.string().describe('The path to the file within the repository'),
    }),
    execute: async ({ path }) => {
      const normalizedPath = normalizeRepoPath(path);

      if (isInvalidRepoReadPath(normalizedPath)) {
        return 'Error: Choose a concrete file path from the loaded repository tree, not `.`, `/`, or a directory path.';
      }

      if (repo.repoFileTree.length > 0 && !repo.repoFileTree.includes(normalizedPath)) {
        const suggestions = getRepoPathSuggestions(repo.repoFileTree, normalizedPath);
        if (suggestions.length > 0) {
          return `Error: \`${normalizedPath}\` is not present in the selected repository. Choose a real path from the loaded repo tree instead. Possible matches:\n${suggestions.map((p) => `- ${p}`).join('\n')}`;
        }
        const samplePaths = repo.repoFileTree.slice(0, 8);
        return `Error: \`${normalizedPath}\` is not present in the selected repository. Choose a real path from the loaded repo tree instead.${samplePaths.length > 0 ? ` Example paths:\n${samplePaths.map((p) => `- ${p}`).join('\n')}` : ''}`;
      }

      // Return cached content if available
      if (sessionCache[normalizedPath] !== undefined) {
        emit({ type: 'repo_file_read', path: normalizedPath, content: sessionCache[normalizedPath] });
        return sessionCache[normalizedPath];
      }

      const { content, error } = await readFileFromGitHub(
        repo.owner,
        repo.name,
        normalizedPath,
        repo.defaultBranch,
        repo.githubPAT,
      );

      if (error || content === null) {
        return `Error reading file: ${error || 'unknown error'}`;
      }

      sessionCache[normalizedPath] = content;
      emit({ type: 'repo_file_read', path: normalizedPath, content });
      return content;
    },
  });

  if (!repo.repoEditIntent) {
    return tools;
  }

  tools.propose_changes = tool({
    description: 'Propose a plan of changes to the repository before editing files.',
    parameters: z.preprocess(
      (value) => normalizeProposeChangesArgs(value, { existingPaths }),
      z.object({
        summary: z.string().describe('A brief summary of what will change'),
        plan: z.array(proposalPlanItemSchema).describe('List of planned file changes'),
      }),
    ),
    execute: async ({ summary, plan }) => {
      emit({
        type: 'repo_proposal',
        summary,
        plan,
      });
      return 'Proposal ready for review. Pause for approval before editing repo files.';
    },
  });

  // ── edit_repo_file ─────────────────────────────────────────────────────
  tools.edit_repo_file = tool({
    description:
      'Edit an existing file in the active GitHub repository. The change will be staged for a PR.',
    parameters: z.preprocess(
      normalizeEditRepoFileArgs,
      z.object({
        path: z.string().describe('The path to the file to edit'),
        content: z.string().describe('The new full content of the file'),
        description: z.string().describe('A description of what was changed and why'),
      }),
    ),
    execute: async ({ path, content, description }) => {
      const normalizedPath = normalizeRepoPath(path);
      if (!existingPaths.has(normalizedPath)) {
        return `Error: edit_repo_file can only modify existing repo files. \`${normalizedPath}\` is not in the indexed repo tree or staged changes.`;
      }
      const originalContent = sessionCache[normalizedPath] || '';
      sessionCache[normalizedPath] = content;
      emit({
        type: 'repo_file_edit',
        path: normalizedPath,
        content,
        originalContent,
        description,
      });
      return `Staged edit to ${normalizedPath}`;
    },
  });

  // ── create_repo_file ───────────────────────────────────────────────────
  tools.create_repo_file = tool({
    description:
      'Create a new file in the active GitHub repository. The file will be staged for a PR.',
    parameters: z.preprocess(
      normalizeCreateRepoFileArgs,
      z.object({
        path: z.string().describe('The path for the new file'),
        content: z.string().describe('The content of the new file'),
        description: z.string().describe('A description of the file and its purpose'),
      }),
    ),
    execute: async ({ path, content, description }) => {
      const normalizedPath = normalizeRepoPath(path);
      const action = resolveRepoWriteAction('create', normalizedPath, existingPaths);
      const originalContent = sessionCache[normalizedPath] || '';
      sessionCache[normalizedPath] = content;
      existingPaths.add(normalizedPath);
      if (action === 'edit') {
        emit({
          type: 'repo_file_edit',
          path: normalizedPath,
          content,
          originalContent,
          description,
        });
        return `Staged edit to ${normalizedPath}`;
      }
      emit({
        type: 'repo_file_create',
        path: normalizedPath,
        content,
        description,
      });
      return `Staged new file ${normalizedPath}`;
    },
  });

  // ── delete_repo_file ───────────────────────────────────────────────────
  tools.delete_repo_file = tool({
    description:
      'Delete a file from the active GitHub repository. The deletion will be staged for a PR.',
    parameters: z.preprocess(
      normalizeDeleteRepoFileArgs,
      z.object({
        path: z.string().describe('The path to the file to delete'),
        reason: z.string().describe('The reason for deleting this file'),
      }),
    ),
    execute: async ({ path, reason }) => {
      const normalizedPath = normalizeRepoPath(path);
      const originalContent = sessionCache[normalizedPath] || '';
      delete sessionCache[normalizedPath];
      existingPaths.delete(normalizedPath);
      emit({
        type: 'repo_file_delete',
        path: normalizedPath,
        originalContent,
        reason,
      });
      return `Staged deletion of ${normalizedPath}`;
    },
  });

  // ── batch_edit_repo_files ──────────────────────────────────────────────
  tools.batch_edit_repo_files = tool({
    description:
      'Apply multiple file changes at once. Use this when you need to create, edit, or delete multiple files. Preferred over calling edit_repo_file multiple times.',
    parameters: z.preprocess(
      (value) => normalizeBatchEditRepoFilesArgs(value, { existingPaths }),
      z.object({
        changes: z.array(
          z.object({
            path: z.string().describe('The file path'),
            action: z.enum(['create', 'edit', 'delete']).describe('The type of change: "create", "edit", or "delete"'),
            content: z.string().describe('The new file content (empty string for deletions)'),
            description: z.string().describe('Description of this change'),
          }),
        ).describe('Array of file changes to apply'),
      }),
    ),
    execute: async ({ changes }) => {
      const results: string[] = [];
      const batchChanges: Array<{
        path: string;
        action: string;
        content: string;
        originalContent: string;
        description: string;
      }> = [];

      for (const change of changes) {
        const normalizedPath = normalizeRepoPath(change.path);
        const action = resolveRepoWriteAction(change.action, normalizedPath, existingPaths);
        if (action === 'edit' && !existingPaths.has(normalizedPath)) {
          return `Error: batch_edit_repo_files cannot edit missing file \`${normalizedPath}\`. Use create only for genuinely new files and edit only for existing repo paths.`;
        }
        const originalContent = sessionCache[normalizedPath] || '';

        if (action === 'delete') {
          delete sessionCache[normalizedPath];
          existingPaths.delete(normalizedPath);
        } else {
          sessionCache[normalizedPath] = change.content;
          existingPaths.add(normalizedPath);
        }

        batchChanges.push({
          path: normalizedPath,
          action,
          content: change.content || '',
          originalContent,
          description: change.description,
        });
        results.push(`Staged ${action} on ${normalizedPath}`);
      }

      emit({ type: 'repo_batch_edit', changes: batchChanges });
      return results.join('\n');
    },
  });

  return tools;
}
