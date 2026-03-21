import { tool, type CoreTool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { existsSync, readdirSync } from 'fs';

// ─── Config ─────────────────────────────────────────────────────────────────

const RUN_COMMAND_TIMEOUT_MS = 90_000; // 90 seconds
const EXECUTE_PYTHON_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_LENGTH = 15_000;
const MAX_FILE_READ_LENGTH = 20_000;

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
 */
export function buildLocalExecutionTools(toolsets: LocalToolsets) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, CoreTool<any, any>> = {};

  if (toolsets.terminal) {
    tools.run_command = tool({
      description:
        'Execute a shell command on the local machine. Returns stdout, stderr, and exit code. Supports pipes, redirects, and chained commands.',
      parameters: z.object({
        command: z.string().describe('The shell command to execute'),
      }),
      execute: async ({ command }) => {
        return new Promise<string>((resolve) => {
          exec(command, {
            timeout: RUN_COMMAND_TIMEOUT_MS,
            maxBuffer: 1024 * 1024 * 5,
            shell: '/bin/sh',
          }, (error, stdout, stderr) => {
            let output = '';
            if (stdout) output += stdout;
            if (stderr) output += (output ? '\n' : '') + stderr;

            if (error && 'killed' in error && error.killed) {
              resolve(
                `Error: Command timed out after ${RUN_COMMAND_TIMEOUT_MS / 1000} seconds.\nCommand: ${command}\nTry breaking the command into smaller steps.`,
              );
              return;
            }

            if (error && error.code) {
              output += `\n[Exit code: ${error.code}]`;
              if (error.code === 127) {
                output += '\nHint: Command not found. Check if the program is installed and in PATH.';
              } else if (error.code === 126) {
                output += '\nHint: Permission denied. The file may not be executable.';
              }
            }

            if (output.length > MAX_OUTPUT_LENGTH) {
              output = output.slice(0, MAX_OUTPUT_LENGTH) + '\n\n[Output truncated at 15,000 chars]';
            }

            resolve(output || '(no output)');
          });
        });
      },
    });
  }

  if (toolsets.code_execution) {
    tools.execute_python = tool({
      description:
        'Execute Python code on the local machine. Returns stdout and stderr.',
      parameters: z.object({
        code: z.string().describe('The Python code to execute'),
      }),
      execute: async ({ code }) => {
        return new Promise<string>((resolve) => {
          exec(`python3 -c ${JSON.stringify(code)}`, {
            timeout: EXECUTE_PYTHON_TIMEOUT_MS,
            maxBuffer: 1024 * 1024 * 5,
            shell: '/bin/sh',
          }, (error, stdout, stderr) => {
            let output = '';
            if (stdout) output += stdout;
            if (stderr) output += (output ? '\n' : '') + stderr;

            if (error && 'killed' in error && error.killed) {
              resolve(`Error: Python execution timed out after ${EXECUTE_PYTHON_TIMEOUT_MS / 1000} seconds.`);
              return;
            }

            if (output.length > MAX_OUTPUT_LENGTH) {
              output = output.slice(0, MAX_OUTPUT_LENGTH) + '\n\n[Output truncated at 15,000 chars]';
            }

            resolve(output || '(no output)');
          });
        });
      },
    });
  }

  if (toolsets.files) {
    tools.read_file = tool({
      description: 'Read a file from the local filesystem. Returns the file content as text.',
      parameters: z.object({
        path: z.string().describe('The absolute or relative path to the file to read'),
      }),
      execute: async ({ path }) => {
        if (!existsSync(path)) {
          const parent = dirname(path) || '.';
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
          const content = await readFile(path, 'utf-8');
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
      parameters: z.object({
        path: z.string().describe('The absolute or relative path to the file to write'),
        content: z.string().describe('The content to write to the file'),
      }),
      execute: async ({ path, content }) => {
        const dir = dirname(path);
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
          await writeFile(path, content, 'utf-8');
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
