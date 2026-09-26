import { tool } from 'ai';
import { z } from 'zod';
import { exec, execFile } from 'child_process';
import { readFile, writeFile, mkdir, realpath } from 'fs/promises';
import { dirname, resolve, join, basename } from 'path';
import { existsSync, readdirSync } from 'fs';

// ─── Config ─────────────────────────────────────────────────────────────────

const RUN_COMMAND_TIMEOUT_MS = 90_000; // 90 seconds
const EXECUTE_PYTHON_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_LENGTH = 15_000;
const MAX_FILE_READ_LENGTH = 20_000;

// ─── Sensitive path blocklist ───────────────────────────────────────────────

const BLOCKED_PATH_PATTERNS = [
  /(?:^|\/)\.env(?:\.|$)/,      // .env, .env.local, etc.
  /(?:^|\/)\.ssh\//,             // ~/.ssh/*
  /(?:^|\/)\.gnupg\//,           // ~/.gnupg/*
  /(?:^|\/)\.aws\/credentials/,  // AWS credentials
  /(?:^|\/)\.npmrc$/,            // npm auth tokens
  /(?:^|\/)\.netrc$/,            // netrc credentials
  /^\/etc\/shadow$/,
  /^\/etc\/passwd$/,
];

function isBlockedPath(normalizedPath: string): boolean {
  return BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

/**
 * Canonicalize a path, resolving symlinks even when the final component(s)
 * don't exist yet: realpath the deepest existing ancestor and re-append the
 * missing tail. Returns the original path if nothing can be resolved.
 */
async function canonicalize(p: string): Promise<string> {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return p; // reached the root — give up
      tail.push(basename(current));
      current = parent;
    }
  }
}

async function resolveSafePath(path: string): Promise<{ resolved: string; error?: string }> {
  const resolved = resolve(path);
  if (isBlockedPath(resolved)) {
    return { resolved, error: `Access denied: '${path}' is a restricted path.` };
  }
  // readFile/writeFile follow symlinks, so a workspace symlink could point
  // at a restricted target (~/.ssh/id_rsa, /etc/shadow, …) that the regex
  // above misses. Canonicalize and re-run the blocklist before any IO.
  const canonical = await canonicalize(resolved);
  if (canonical !== resolved && isBlockedPath(canonical)) {
    return { resolved, error: `Access denied: '${path}' resolves to a restricted path.` };
  }
  return { resolved };
}

// ─── Shared exec helper ────────────────────────────────────────────────────

export interface ExecResultInfo {
  output: string;
  /** Process exit code (null when the tool is not a shell command). */
  exitCode: number | null;
  outputTruncated: boolean;
  outputTruncatedLines: number;
}

/** Result of a server-executed tool call, reported for `tool_call_end`. */
export interface ToolExecutionInfo {
  toolCallId: string;
  toolName: string;
  exitCode: number | null;
  outputTruncated: boolean;
  outputTruncatedLines: number;
}

export type ApprovalOutcome = 'approved' | 'denied' | 'timed_out' | 'abort';

export interface LocalToolHooks {
  /**
   * Ask the approval engine whether a tool call may proceed. The engine
   * classifies safe commands and consults policy rules internally; when a
   * decision is required it parks the execution and emits an
   * `approval_request` custom field to the client.
   */
  requestApproval?: (input: {
    tool: string;
    command?: string;
    cwd?: string;
    reason: string;
  }) => Promise<ApprovalOutcome>;
  /** Reports structured execution info (exit code, truncation) for events. */
  onExecuted?: (info: ToolExecutionInfo) => void;
}

function truncateOutput(output: string): { output: string; truncated: boolean; truncatedLines: number } {
  if (output.length > MAX_OUTPUT_LENGTH) {
    const kept = output.slice(0, MAX_OUTPUT_LENGTH);
    const droppedLines = output.split('\n').length - kept.split('\n').length;
    return {
      output: kept + `\n\n[Output truncated at ${MAX_OUTPUT_LENGTH.toLocaleString()} chars]`,
      truncated: true,
      truncatedLines: Math.max(0, droppedLines - 1),
    };
  }
  return { output, truncated: false, truncatedLines: 0 };
}

function formatExecOutput(stdout: string, stderr: string): string {
  let output = '';
  if (stdout) output += stdout;
  if (stderr) output += (output ? '\n' : '') + stderr;
  return output;
}

function execWithTimeout(
  command: string,
  args: string[] | null,
  options: { timeoutMs: number; shell?: string },
): Promise<ExecResultInfo> {
  return new Promise<ExecResultInfo>((resolve) => {
    const execOptions = {
      encoding: 'utf8' as const,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024 * 5,
      ...(options.shell ? { shell: options.shell } : {}),
    };

    const callback = (error: Error & { killed?: boolean; code?: number } | null, stdout: string, stderr: string) => {
      if (error?.killed) {
        resolve({
          output: `Error: Command timed out after ${options.timeoutMs / 1000} seconds.`,
          exitCode: null,
          outputTruncated: false,
          outputTruncatedLines: 0,
        });
        return;
      }

      let output = formatExecOutput(stdout, stderr);
      const exitCode = error?.code ?? 0;

      if (error?.code) {
        output += `\n[Exit code: ${error.code}]`;
        if (error.code === 127) {
          output += '\nHint: Command not found. Check if the program is installed and in PATH.';
        } else if (error.code === 126) {
          output += '\nHint: Permission denied. The file may not be executable.';
        }
      }

      const { output: truncatedOutput, truncated, truncatedLines } = truncateOutput(output);
      resolve({
        output: truncatedOutput || '(no output)',
        exitCode,
        outputTruncated: truncated,
        outputTruncatedLines: truncatedLines,
      });
    };

    if (args !== null) {
      // Use execFile (no shell) — safer for passing untrusted arguments
      const ef = execFile as (
        command: string,
        args: readonly string[] | null,
        options: Record<string, unknown>,
        callback: (error: Error & { killed?: boolean; code?: number } | null, stdout: string, stderr: string) => void,
      ) => ReturnType<typeof execFile>;
      ef(command, args, execOptions, callback);
    } else {
      // Use exec (with shell) — needed for pipes, redirects, chained commands
      const ex = exec as (
        command: string,
        options: Record<string, unknown>,
        callback: (error: Error & { killed?: boolean; code?: number } | null, stdout: string, stderr: string) => void,
      ) => ReturnType<typeof exec>;
      ex(command, { ...execOptions, shell: options.shell || '/bin/sh' }, callback);
    }
  });
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LocalToolsets {
  terminal: boolean;
  files: boolean;
  code_execution: boolean;
}

// ─── Tool builder ───────────────────────────────────────────────────────────

/**
 * Build local execution tools that run on the Node.js server.
 * These tools give any AI provider terminal, file I/O, and Python execution
 * capabilities — the same tools that were previously Hermes-only.
 *
 * `hooks.requestApproval` gates run_command / execute_python through the
 * server-side approval engine (safe commands and matching policy rules are
 * allowed silently; anything else parks the execution on an approval_request).
 * `hooks.onExecuted` reports structured execution info for `tool_call_end`.
 */
export function buildLocalExecutionTools(toolsets: LocalToolsets, hooks?: LocalToolHooks) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  /** Gate a tool call through the approval engine; true when it may proceed. */
  async function approved(
    tool: string,
    command: string,
    reason: string,
  ): Promise<boolean> {
    if (!hooks?.requestApproval) {
      return true;
    }
    const outcome = await hooks.requestApproval({
      tool,
      command,
      cwd: process.cwd(),
      reason,
    });
    return outcome === 'approved';
  }

  if (toolsets.terminal) {
    tools.run_command = tool({
      description:
        'Execute a shell command on the local machine. Returns stdout, stderr, and exit code. Supports pipes, redirects, and chained commands.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
      }),
      execute: async ({ command }, options) => {
        if (!(await approved('run_command', command, `Run shell command: ${command}`))) {
          return `error: run_command was denied: the command "${command.slice(0, 200)}" was not approved. Read-only commands (cat, ls, grep, head, tail, pwd, wc, find, rg, git status/log/diff/show/branch) run without approval.`;
        }
        const result = await execWithTimeout(command, null, {
          timeoutMs: RUN_COMMAND_TIMEOUT_MS,
          shell: '/bin/sh',
        });
        hooks?.onExecuted?.({
          toolCallId: options.toolCallId,
          toolName: 'run_command',
          exitCode: result.exitCode,
          outputTruncated: result.outputTruncated,
          outputTruncatedLines: result.outputTruncatedLines,
        });
        return result.output;
      },
    });
  }

  if (toolsets.code_execution) {
    tools.execute_python = tool({
      description:
        'Execute Python code on the local machine. Returns stdout and stderr.',
      inputSchema: z.object({
        code: z.string().describe('The Python code to execute'),
      }),
      execute: async ({ code }, options) => {
        const preview = code.length > 200 ? `${code.slice(0, 200)}…` : code;
        if (!(await approved('execute_python', `python3 -c "${preview.replace(/"/g, '\\"')}"`, 'Execute Python code on the local machine'))) {
          return 'error: execute_python was denied: the code execution was not approved.';
        }
        // Use execFile (no shell) to avoid shell injection via code content
        const result = await execWithTimeout('python3', ['-c', code], {
          timeoutMs: EXECUTE_PYTHON_TIMEOUT_MS,
        });
        hooks?.onExecuted?.({
          toolCallId: options.toolCallId,
          toolName: 'execute_python',
          exitCode: result.exitCode,
          outputTruncated: result.outputTruncated,
          outputTruncatedLines: result.outputTruncatedLines,
        });
        return result.output;
      },
    });
  }

  if (toolsets.files) {
    tools.read_file = tool({
      description: 'Read a file from the local filesystem. Returns the file content as text.',
      inputSchema: z.object({
        path: z.string().describe('The absolute or relative path to the file to read'),
      }),
      execute: async ({ path }) => {
        const { resolved, error: pathError } = await resolveSafePath(path);
        if (pathError) return pathError;

        if (!existsSync(resolved)) {
          const parent = dirname(resolved);
          let hint = '';
          if (existsSync(parent)) {
            try {
              const siblings = readdirSync(parent).sort().slice(0, 20);
              if (siblings.length > 0) {
                hint = ` Available files in '${parent}': ${siblings.join(', ')}`;
                const total = readdirSync(parent).length;
                if (total > 20) hint += ` (+${total - 20} more)`;
              }
            } catch { /* ignore */ }
          }
          return `Error: File not found at '${path}'.${hint}`;
        }

        try {
          const content = await readFile(resolved, 'utf-8');
          if (content.length > MAX_FILE_READ_LENGTH) {
            return content.slice(0, MAX_FILE_READ_LENGTH) + '\n\n[Content truncated at 20,000 chars]';
          }
          return content;
        } catch (err) {
          if (err instanceof Error && err.message.includes('EACCES')) {
            return `Error: Permission denied reading '${path}'. Check file permissions.`;
          }
          if (err instanceof Error && (err.message.includes('EISDIR') || err.message.includes('is a directory'))) {
            return `Error: '${path}' is a directory, not a file. Use run_command with ls to list directory contents.`;
          }
          return `Error: Failed to read file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    tools.write_file = tool({
      description:
        'Write content to a file on the local filesystem. Creates parent directories if needed. Overwrites existing files.',
      inputSchema: z.object({
        path: z.string().describe('The absolute or relative path to the file to write'),
        content: z.string().describe('The content to write to the file'),
      }),
      execute: async ({ path, content }) => {
        const { resolved, error: pathError } = await resolveSafePath(path);
        if (pathError) return pathError;

        const dir = dirname(resolved);
        if (dir && dir !== '.') {
          try {
            await mkdir(dir, { recursive: true });
          } catch (err) {
            if (err instanceof Error && err.message.includes('EACCES')) {
              return `Error: Permission denied creating directory '${dir}'.`;
            }
          }
        }

        try {
          await writeFile(resolved, content, 'utf-8');
          return `Written ${content.length} bytes to ${path}`;
        } catch (err) {
          if (err instanceof Error && err.message.includes('EACCES')) {
            return `Error: Permission denied writing to '${path}'. Check file permissions.`;
          }
          return `Error: Failed to write file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  }

  return tools;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function parseAgentToolsets(raw: unknown): LocalToolsets {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { terminal: false, files: false, code_execution: false };
  }
  const enabled = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return {
    terminal: enabled.has('terminal'),
    files: enabled.has('files'),
    code_execution: enabled.has('code_execution'),
  };
}

export function getLocalToolsSystemPromptFragment(toolsets: LocalToolsets): string {
  const available: string[] = [];
  if (toolsets.terminal) available.push('run_command — execute shell commands on the local machine');
  if (toolsets.files) available.push('read_file / write_file — read and write files on the local filesystem');
  if (toolsets.code_execution) available.push('execute_python — run Python code on the local machine');

  if (available.length === 0) return '';

  return `\n\nYou have access to local execution tools:\n${available.map((t) => `- ${t}`).join('\n')}\n\nUse these tools to help the user with tasks that require running commands, reading/writing files, or executing code on their machine. Always show the user what you're doing and explain the results.`;
}
