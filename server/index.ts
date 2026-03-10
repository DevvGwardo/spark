import express from 'express';
import cors from 'cors';
import { generateText, streamText, tool } from 'ai';
import { z } from 'zod';
import { createOrchestrateHandler } from './orchestrator';
import {
  createProviderModel,
  getProviderHeaders,
  OPENAI_COMPATIBLE,
  VALIDATION_MODELS,
} from './provider-config';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type',
};

function sendJson(res: express.Response, status: number, body: unknown) {
  res.status(status).json(body);
}

function getUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── /functions/v1/chat ──────────────────────────────────────────────────────

// Filter out problematic stream lines (e.g. empty error entries from some providers)
function createFilteredStream(
  original: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  return new ReadableStream({
    async start(controller) {
      const reader = original.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              controller.enqueue(encoder.encode(buffer));
            }
            controller.close();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.trim() === '3:""' || line.trim() === "3:''") {
              continue;
            }
            controller.enqueue(encoder.encode(line + '\n'));
          }
        }
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

app.post('/functions/v1/chat', async (req, res) => {
  try {
    const {
      provider = 'lovable',
      model,
      messages,
      temperature,
      top_p,
      max_tokens,
      api_key,
      system_prompt,
      activeRepo,
    } = req.body;

    // Resolve API key
    let apiKey: string;
    if (provider === 'lovable') {
      apiKey = process.env.LOVABLE_API_KEY || '';
      if (!apiKey) {
        return sendJson(res, 500, { error: 'Lovable AI is not configured' });
      }
    } else {
      apiKey = api_key;
      if (!apiKey) {
        return sendJson(res, 400, { error: `API key is required for ${provider}` });
      }
    }

    // Build system prompt, appending repo context if activeRepo is present
    let effectiveSystemPrompt = system_prompt || '';
    if (activeRepo) {
      const repoContext = `You are working on the GitHub repository ${activeRepo.owner}/${activeRepo.name}. You have tools to read, edit, create, and delete files in this repo.

WORKFLOW — ALWAYS FOLLOW THIS:
1. When the user asks you to make changes, FIRST use propose_changes to present a plan of ALL files you intend to modify. Wait for user approval before proceeding.
2. After the user approves, use read_repo_file to read the files you need to modify.
3. Then use batch_edit_repo_files to apply ALL changes at once (preferred for multiple files), or edit_repo_file / create_repo_file individually.
4. Do NOT ask the user which file to edit — explore the repo yourself.
5. When the user asks you to update multiple things, make sure you update ALL of them, not just one.
6. IMPORTANT: If you need to edit many large files, split batch_edit_repo_files into multiple calls (max 3-4 files per batch) to avoid output truncation. For very large files, use individual edit_repo_file calls instead.

All changes are staged for a PR — they are not applied directly to the repo.`;
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${effectiveSystemPrompt}\n\n${repoContext}`
        : repoContext;
    }

    // Prepend system prompt
    const allMessages = effectiveSystemPrompt
      ? [{ role: 'system' as const, content: effectiveSystemPrompt }, ...messages]
      : messages;

    // File creation tools (always available for artifact/preview support)
    const fileTools = {
      create_html_file: tool({
        description:
          'Create an HTML file. Use this when the user asks you to create an HTML page, website, or web component. The file will be available for live preview.',
        parameters: z.object({
          filename: z.string().describe('The filename (e.g. "index.html")'),
          content: z.string().describe('The full HTML content'),
        }),
      }),
      create_css_file: tool({
        description:
          'Create a CSS stylesheet file. Use this when the user asks you to create CSS styles.',
        parameters: z.object({
          filename: z.string().describe('The filename (e.g. "styles.css")'),
          content: z.string().describe('The full CSS content'),
        }),
      }),
      create_js_file: tool({
        description:
          'Create a JavaScript file. Use this when the user asks you to create JS code for a web page.',
        parameters: z.object({
          filename: z.string().describe('The filename (e.g. "app.js")'),
          content: z.string().describe('The full JavaScript content'),
        }),
      }),
      create_react_component: tool({
        description:
          'Create a React component file (JSX/TSX). Use this when the user asks you to create a React component.',
        parameters: z.object({
          filename: z.string().describe('The filename (e.g. "App.jsx" or "Component.tsx")'),
          content: z.string().describe('The full JSX/TSX content (no import/export needed, just the component function)'),
        }),
      }),
      create_markdown_file: tool({
        description:
          'Create a Markdown file. Use this when the user asks you to create documentation, READMEs, notes, or any markdown content.',
        parameters: z.object({
          filename: z.string().describe('The filename (e.g. "README.md")'),
          content: z.string().describe('The full Markdown content'),
        }),
      }),
    };

    // Repo tools — always included so the model doesn't error on conversations
    // that previously used repo tools. Client-side onToolCall handles the case
    // where activeRepo is missing by returning a graceful error.
    const repoTools = {
          propose_changes: tool({
            description:
              'Present a plan of proposed changes to the user BEFORE making any edits. Always call this first when the user asks for changes. The user will review and approve the plan before you proceed.',
            parameters: z.object({
              summary: z.string().describe('A brief summary of the overall change'),
              plan: z.array(
                z.object({
                  path: z.string().describe('The file path'),
                  action: z.string().describe('The type of change: "create", "edit", or "delete"'),
                  description: z.string().describe('What will be changed in this file and why'),
                })
              ).describe('The list of all files that will be modified'),
            }),
          }),

          read_repo_file: tool({
            description:
              'Read a file from the active GitHub repository. Returns the file content.',
            parameters: z.object({
              path: z.string().describe('The path to the file within the repository'),
            }),
          }),

          edit_repo_file: tool({
            description:
              'Edit an existing file in the active GitHub repository. The change will be staged for a PR.',
            parameters: z.object({
              path: z.string().describe('The path to the file to edit'),
              content: z.string().describe('The new full content of the file'),
              description: z.string().describe('A description of what was changed and why'),
            }),
          }),

          create_repo_file: tool({
            description:
              'Create a new file in the active GitHub repository. The file will be staged for a PR.',
            parameters: z.object({
              path: z.string().describe('The path for the new file'),
              content: z.string().describe('The content of the new file'),
              description: z.string().describe('A description of the file and its purpose'),
            }),
          }),

          delete_repo_file: tool({
            description:
              'Delete a file from the active GitHub repository. The deletion will be staged for a PR.',
            parameters: z.object({
              path: z.string().describe('The path to the file to delete'),
              reason: z.string().describe('The reason for deleting this file'),
            }),
          }),

          batch_edit_repo_files: tool({
            description:
              'Apply multiple file changes at once. Use this when you need to create, edit, or delete multiple files. Preferred over calling edit_repo_file multiple times.',
            parameters: z.object({
              changes: z.array(
                z.object({
                  path: z.string().describe('The file path'),
                  action: z.string().describe('The type of change: "create", "edit", or "delete"'),
                  content: z.string().describe('The new file content (empty string for deletions)'),
                  description: z.string().describe('Description of this change'),
                })
              ).describe('Array of file changes to apply'),
            }),
          }),
        };

    let aiModel;
    try {
      aiModel = createProviderModel(provider, model, apiKey, {
        origin: req.headers.origin as string | undefined,
      });
    } catch (error) {
      return sendJson(
        res,
        400,
        { error: error instanceof Error ? error.message : `Unknown provider: ${provider}` }
      );
    }

    // Use a higher token limit when repo tools are active to avoid truncated tool calls
    const defaultMaxTokens = activeRepo ? 64000 : 16384;

    const result = await streamText({
      model: aiModel,
      messages: allMessages,
      temperature: temperature ?? 0.7,
      topP: top_p ?? 0.9,
      maxOutputTokens: max_tokens ?? defaultMaxTokens,
      tools: { ...fileTools, ...repoTools },
      toolCallStreaming: true,
    });

    const response = result.toDataStreamResponse({
      headers: corsHeaders,
      sendReasoning: true,
      getErrorMessage: (error: unknown) => {
        if (error instanceof Error) return error.message;
        return String(error);
      },
    });

    // Set response headers
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.status(response.status);

    if (!response.body) {
      res.end();
      return;
    }

    // For providers that may emit problematic stream entries, filter them
    let body: ReadableStream<Uint8Array> = response.body;
    if (provider === 'minimax' || provider === 'minimax-payg') {
      body = createFilteredStream(body);
    }

    // Pipe the web ReadableStream to the Node.js response
    const reader = body.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            break;
          }
          const ok = res.write(Buffer.from(value));
          if (!ok) {
            await new Promise<void>((resolve) => res.once('drain', resolve));
          }
        }
      } catch (err) {
        console.error('Stream pipe error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error' });
        } else {
          res.end();
        }
      }
    };

    // Handle client disconnect
    req.on('close', () => {
      reader.cancel().catch(() => {});
    });

    await pump();
  } catch (err: unknown) {
    console.error('chat error:', err);

    let status = 500;
    let errorMessage = 'Unknown error';

    if (err && typeof err === 'object') {
      const errRecord = err as {
        errors?: unknown[];
        statusCode?: number;
        status?: number;
        responseBody?: string;
      };
      const errors = errRecord.errors;
      const innerError =
        Array.isArray(errors) && errors.length > 0 ? errors[errors.length - 1] : err;
      const innerErrorRecord = innerError as {
        statusCode?: number;
        status?: number;
        responseBody?: string;
      };

      const statusCode = innerErrorRecord.statusCode || innerErrorRecord.status;
      if (statusCode) status = statusCode;

      const responseBody = innerErrorRecord.responseBody;
      if (responseBody) {
        try {
          const parsed = JSON.parse(responseBody);
          const meta = parsed?.error?.metadata?.raw;
          errorMessage =
            meta || parsed?.error?.message || (err instanceof Error ? err.message : 'Provider error');
        } catch {
          errorMessage = err instanceof Error ? err.message : 'Provider error';
        }
      } else {
        errorMessage = err instanceof Error ? err.message : 'Provider error';
      }
    }

    const lower = errorMessage.toLowerCase();
    if (lower.includes('data policy') || lower.includes('settings/privacy')) {
      status = 400;
      errorMessage =
        'OpenRouter blocked this free model due to your privacy settings. Enable free model publication in https://openrouter.ai/settings/privacy and try again.';
    }

    if (!res.headersSent) {
      sendJson(res, status, { error: errorMessage });
    }
  }
});

// ─── /functions/v1/github-integration ────────────────────────────────────────

interface FileChange {
  path: string;
  content: string;
  action?: 'create' | 'edit' | 'delete';
}

async function fetchRepoContents(
  owner: string,
  repo: string,
  path: string,
  headers: Record<string, string>
): Promise<Array<{ path: string; type: 'dir'; children: [] } | { path: string; type: 'file'; size: number; sha: string }>> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
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

app.post('/functions/v1/github-integration', async (req, res) => {
  try {
    const { action, pat, ...params } = req.body;

    if (!pat) {
      return sendJson(res, 400, { error: 'GitHub PAT is required' });
    }

    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CloudChat-App',
    };

    switch (action) {
      case 'list-repos': {
        const response = await fetch(
          'https://api.github.com/user/repos?sort=updated&per_page=100',
          { headers }
        );
        if (!response.ok) {
          const error = await response.text();
          return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
        }
        const repos = await response.json();
        return sendJson(res, 200, { repos });
      }

      case 'read-repo': {
        const { owner, repo, path = '' } = params;
        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }
        const contents = await fetchRepoContents(owner, repo, path, headers);
        return sendJson(res, 200, { contents });
      }

      case 'read-file': {
        const { owner, repo, path } = params;
        if (!owner || !repo || !path) {
          return sendJson(res, 400, { error: 'owner, repo, and path are required' });
        }

        const response = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
          { headers }
        );

        if (!response.ok) {
          return sendJson(res, response.status, {
            error: 'File not found or inaccessible',
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
        const { owner, repo, title, body, branch, baseBranch, files } = params as {
          owner: string;
          repo: string;
          title: string;
          body: string;
          branch: string;
          baseBranch: string;
          files: FileChange[];
        };

        if (!owner || !repo || !title || !branch || !baseBranch || !files?.length) {
          return sendJson(res, 400, {
            error: 'Missing required parameters for PR creation',
          });
        }

        // 1. Get the base branch's latest commit SHA
        const baseRefRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`,
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
          `https://api.github.com/repos/${owner}/${repo}/git/refs`,
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
            `https://api.github.com/repos/${owner}/${repo}/contents/${file.path}?ref=${branch}`,
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
              `https://api.github.com/repos/${owner}/${repo}/contents/${file.path}`,
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
              `https://api.github.com/repos/${owner}/${repo}/contents/${file.path}`,
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
          `https://api.github.com/repos/${owner}/${repo}/pulls`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              body,
              head: branch,
              base: baseBranch,
            }),
          }
        );

        if (!prRes.ok) {
          return sendJson(res, prRes.status, {
            error: `Failed to create PR: ${await prRes.text()}`,
          });
        }

        const pr = await prRes.json();
        return sendJson(res, 200, { pr: { number: pr.number, url: pr.html_url } });
      }

      default:
        return sendJson(res, 400, { error: 'Unknown action' });
    }
  } catch (error: unknown) {
    console.error('GitHub integration error:', error);
    sendJson(res, 500, { error: getUnknownErrorMessage(error) });
  }
});

// ─── /functions/v1/github-analyzer ───────────────────────────────────────────

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
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
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
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          {
            role: 'system',
            content:
              'You are an expert code reviewer specializing in finding bugs, security issues, and improvement opportunities. Always respond with valid JSON.',
          },
          {
            role: 'user',
            content: analysisPrompt,
          },
        ],
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

app.post('/functions/v1/github-analyzer', async (req, res) => {
  try {
    const { owner, repo, pat } = req.body;

    if (!owner || !repo || !pat) {
      return sendJson(res, 400, { error: 'owner, repo, and PAT are required' });
    }

    console.log(`Fetching files for ${owner}/${repo}...`);
    const files = await fetchAnalyzerRepoFiles(owner, repo, pat);

    if (files.length === 0) {
      return sendJson(res, 400, { error: 'No code files found in repository' });
    }

    console.log(`Analyzing ${files.length} files...`);
    const analysis = await analyzeCode(files);

    return sendJson(res, 200, {
      analysis,
      filesAnalyzed: files.length,
      repository: `${owner}/${repo}`,
    });
  } catch (error: unknown) {
    console.error('GitHub analyzer error:', error);
    sendJson(res, 500, { error: getUnknownErrorMessage(error) });
  }
});

// ─── /functions/v1/validate-key ──────────────────────────────────────────────

app.post('/functions/v1/validate-key', async (req, res) => {
  try {
    const { provider, api_key } = req.body;

    if (!api_key || !provider) {
      return sendJson(res, 400, { valid: false, error: 'Missing provider or api_key' });
    }

    const validationModel = VALIDATION_MODELS[provider];
    if (!validationModel) {
      return sendJson(res, 400, { valid: false, error: `Unknown provider: ${provider}` });
    }

    const origin = req.headers.origin as string | undefined;
    const listModelsUrl = OPENAI_COMPATIBLE[provider]
      ? `${OPENAI_COMPATIBLE[provider]}/models`
      : null;

    if (listModelsUrl) {
      const modelListResponse = await fetch(listModelsUrl, {
        headers: {
          Authorization: `Bearer ${api_key}`,
          ...getProviderHeaders(provider, origin),
        },
      });

      if (modelListResponse.ok) {
        const data = await modelListResponse.json();
        const models = Array.isArray(data?.data)
          ? (data.data as Array<{ id?: string }>)
              .map((model) => model?.id)
              .filter((modelId: string | undefined): modelId is string => !!modelId)
          : undefined;

        return sendJson(res, 200, { valid: true, models });
      }
    }

    const model = createProviderModel(provider, validationModel, api_key, {
      origin,
    });

    await generateText({
      model,
      prompt: 'ping',
      maxOutputTokens: 1,
      temperature: 0,
    });

    return sendJson(res, 200, { valid: true });
  } catch (err: unknown) {
    const message = getUnknownErrorMessage(err) || 'Provider validation failed';
    const status = /401|403|authentication|unauthorized|invalid api key/i.test(message) ? 401 : 500;
    sendJson(res, status, { valid: false, error: message });
  }
});

// ─── /functions/v1/chat-proxy ────────────────────────────────────────────────

interface ChatProxyRequest {
  provider: 'minimax' | 'minimax-payg' | 'kimi' | 'kimi-coding';
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  api_key: string;
  system_prompt?: string;
}

const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const KIMI_CODING_API_URL = 'https://api.kimi.com/coding/v1/chat/completions';

async function proxyMiniMax(body: ChatProxyRequest): Promise<Response> {
  const messages = body.system_prompt
    ? [{ role: 'system', content: body.system_prompt }, ...body.messages]
    : body.messages;

  const payload = {
    model: body.model,
    messages,
    temperature: body.temperature ?? 0.7,
    top_p: body.top_p ?? 0.9,
    max_tokens: body.max_tokens ?? 4096,
    stream: true,
  };

  const response = await fetch(`${OPENAI_COMPATIBLE[body.provider]}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${body.api_key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MiniMax API error (${response.status}): ${errorText}`);
  }

  return response;
}

async function proxyKimi(body: ChatProxyRequest): Promise<Response> {
  const messages = body.system_prompt
    ? [{ role: 'system', content: body.system_prompt }, ...body.messages]
    : body.messages;

  const payload = {
    model: body.model,
    messages,
    temperature: body.temperature ?? 0.7,
    top_p: body.top_p ?? 0.9,
    max_tokens: body.max_tokens ?? 4096,
    stream: true,
  };

  const response = await fetch(KIMI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${body.api_key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kimi API error (${response.status}): ${errorText}`);
  }

  return response;
}

async function proxyKimiCoding(body: ChatProxyRequest): Promise<Response> {
  const messages = body.system_prompt
    ? [{ role: 'system', content: body.system_prompt }, ...body.messages]
    : body.messages;

  const payload = {
    model: body.model,
    messages,
    temperature: body.temperature ?? 0.7,
    top_p: body.top_p ?? 0.9,
    max_tokens: body.max_tokens ?? 32768,
    stream: true,
  };

  const response = await fetch(KIMI_CODING_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${body.api_key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kimi Coding API error (${response.status}): ${errorText}`);
  }

  return response;
}

app.post('/functions/v1/chat-proxy', async (req, res) => {
  try {
    const body: ChatProxyRequest = req.body;

    if (!body.api_key) {
      return sendJson(res, 400, { error: 'API key is required' });
    }

    if (!body.provider || !['minimax', 'minimax-payg', 'kimi', 'kimi-coding'].includes(body.provider)) {
      return sendJson(res, 400, {
        error: 'Invalid provider. Use "minimax", "minimax-payg", "kimi", or "kimi-coding".',
      });
    }

    let upstreamResponse: Response;
    if (body.provider === 'minimax' || body.provider === 'minimax-payg') {
      upstreamResponse = await proxyMiniMax(body);
    } else if (body.provider === 'kimi-coding') {
      upstreamResponse = await proxyKimiCoding(body);
    } else {
      upstreamResponse = await proxyKimi(body);
    }

    console.log('Upstream status:', upstreamResponse.status);

    if (!upstreamResponse.body) {
      const text = await upstreamResponse.text();
      console.log('Upstream body (no stream):', text);
      return sendJson(res, 502, {
        error: 'No response body from provider',
        details: text,
      });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Parse and re-emit SSE stream
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedAnyContent = false;
    let rawAccumulator = '';

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!receivedAnyContent && rawAccumulator.trim()) {
              console.log('No SSE content received. Raw response:', rawAccumulator);
              try {
                const errorJson = JSON.parse(rawAccumulator);
                const errorMsg =
                  errorJson.base_resp?.status_msg ||
                  errorJson.error?.message ||
                  errorJson.message ||
                  'Unknown API error';
                res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
              } catch {
                res.write(
                  `data: ${JSON.stringify({ error: `API returned non-streaming response: ${rawAccumulator.slice(0, 200)}` })}\n\n`
                );
              }
            }
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          const chunk = decoder.decode(value, { stream: true });
          rawAccumulator += chunk;
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);

            if (data === '[DONE]') {
              res.write('data: [DONE]\n\n');
              continue;
            }

            try {
              const json = JSON.parse(data);

              if (json.base_resp?.status_code && json.base_resp.status_code !== 0) {
                const errorMsg = json.base_resp.status_msg || 'API error';
                console.log('MiniMax inline error:', errorMsg);
                res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
                receivedAnyContent = true;
                continue;
              }

              let content = '';
              if (body.provider === 'minimax' || body.provider === 'minimax-payg') {
                content = json.choices?.[0]?.delta?.content || '';
              } else if (body.provider === 'kimi' || body.provider === 'kimi-coding') {
                content = json.choices?.[0]?.delta?.content || '';
              }

              if (content) {
                receivedAnyContent = true;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      } catch (err) {
        console.error('SSE stream error:', err);
        res.end();
      }
    };

    req.on('close', () => {
      reader.cancel().catch(() => {});
    });

    await pump();
  } catch (err: unknown) {
    const message = getUnknownErrorMessage(err) || 'Internal server error';
    const status = message.includes('401') ? 401 : message.includes('429') ? 429 : 500;

    if (!res.headersSent) {
      sendJson(res, status, { error: message });
    }
  }
});

// ─── /functions/v1/orchestrate ────────────────────────────────────────────────

app.post(
  '/functions/v1/orchestrate',
  createOrchestrateHandler()
);

  return app;
}

// ─── Start server ────────────────────────────────────────────────────────────

export function startServer(port?: number) {
  const resolvedPort = port || process.env.PORT || 3001;
  const app = createApp();
  return new Promise<{ app: typeof app; port: number }>((resolve) => {
    app.listen(resolvedPort, () => {
      console.log(`Local API server running on http://localhost:${resolvedPort}`);
      console.log('Routes:');
      console.log('  POST /functions/v1/chat');
      console.log('  POST /functions/v1/orchestrate');
      console.log('  POST /functions/v1/github-integration');
      console.log('  POST /functions/v1/github-analyzer');
      console.log('  POST /functions/v1/validate-key');
      console.log('  POST /functions/v1/chat-proxy');
      resolve({ app, port: Number(resolvedPort) });
    });
  });
}

// Auto-start when run directly (npm run server), not when imported by Electron
const isElectron = typeof process !== 'undefined' && !!process.versions?.electron;
if (!isElectron) {
  const isEntry = process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'));
  if (isEntry) {
    startServer();
  }
}
