import express from 'express';
import cors from 'cors';
import { streamText, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import {
  startPreview,
  stopPreview,
  applyChanges,
  getPreviewStatus,
  getAllPreviews,
} from './preview-manager';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Shared helpers ──────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type',
};

function sendJson(res: express.Response, status: number, body: unknown) {
  res.status(status).json(body);
}

// ─── /functions/v1/chat ──────────────────────────────────────────────────────

const OPENAI_COMPATIBLE: Record<string, string> = {
  lovable: 'https://ai.gateway.lovable.dev/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  xai: 'https://api.x.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  'minimax-payg': 'https://api.minimax.chat/v1',
  minimax: 'https://api.minimax.io/v1',
  kimi: 'https://api.moonshot.cn/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  sambanova: 'https://api.sambanova.ai/v1',
};

const ANTHROPIC_COMPATIBLE: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
};

const webDevTools = {
  create_html_file: tool({
    description: 'Create an HTML file with specified content',
    parameters: z.object({
      filename: z.string().describe('The name of the HTML file'),
      content: z.string().describe('The HTML content'),
    }),
    execute: async ({ filename, content }) => ({
      success: true,
      filename,
      content,
      message: `Created HTML file: ${filename}`,
    }),
  }),

  create_css_file: tool({
    description: 'Create a CSS file with specified styles',
    parameters: z.object({
      filename: z.string().describe('The name of the CSS file'),
      content: z.string().describe('The CSS content'),
    }),
    execute: async ({ filename, content }) => ({
      success: true,
      filename,
      content,
      message: `Created CSS file: ${filename}`,
    }),
  }),

  create_js_file: tool({
    description: 'Create a JavaScript file with specified code',
    parameters: z.object({
      filename: z.string().describe('The name of the JavaScript file'),
      content: z.string().describe('The JavaScript content'),
    }),
    execute: async ({ filename, content }) => ({
      success: true,
      filename,
      content,
      message: `Created JavaScript file: ${filename}`,
    }),
  }),

  create_react_component: tool({
    description: 'Create a React component file with JSX/TSX',
    parameters: z.object({
      filename: z
        .string()
        .describe('The name of the React component file (e.g., Button.jsx, App.tsx)'),
      content: z.string().describe('The React component code with JSX/TSX'),
    }),
    execute: async ({ filename, content }) => ({
      success: true,
      filename,
      content,
      message: `Created React component: ${filename}`,
    }),
  }),

  create_nextjs_page: tool({
    description: 'Create a Next.js page component',
    parameters: z.object({
      filename: z
        .string()
        .describe('The name of the Next.js page file (e.g., pages/index.jsx, app/page.tsx)'),
      content: z.string().describe('The Next.js page component code'),
    }),
    execute: async ({ filename, content }) => ({
      success: true,
      filename,
      content,
      message: `Created Next.js page: ${filename}`,
    }),
  }),

  update_file: tool({
    description: 'Update an existing file with new content',
    parameters: z.object({
      filename: z.string().describe('The name of the file to update'),
      content: z.string().describe('The new content'),
    }),
    execute: async ({ filename, content }) => ({
      success: true,
      filename,
      content,
      message: `Updated file: ${filename}`,
    }),
  }),

  web_search: tool({
    description: 'Search the web for information',
    parameters: z.object({
      query: z.string().describe('The search query'),
    }),
    execute: async ({ query }) => ({
      success: true,
      query,
      results: `Mock search results for: ${query}`,
      message: `Searched for: ${query}`,
    }),
  }),
};

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
      const repoContext = `You are working on the GitHub repository ${activeRepo.owner}/${activeRepo.name}. You have tools to read, edit, create, and delete files in this repo. When asked to make changes, use read_repo_file to read files first, then use edit_repo_file or create_repo_file to make changes. Do not ask the user which file to edit — explore the repo yourself. All changes are staged for a PR.`;
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${effectiveSystemPrompt}\n\n${repoContext}`
        : repoContext;
    }

    // Prepend system prompt
    const allMessages = effectiveSystemPrompt
      ? [{ role: 'system' as const, content: effectiveSystemPrompt }, ...messages]
      : messages;

    // Repo tools (only included when activeRepo is present)
    const repoTools = activeRepo
      ? {
          read_repo_file: tool({
            description:
              'Read a file from the active GitHub repository. Returns the file content.',
            parameters: z.object({
              path: z.string().describe('The path to the file within the repository'),
            }),
          }),

          edit_repo_file: tool({
            description:
              'Propose an edit to an existing file in the active GitHub repository. The change will be staged for a PR.',
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
        }
      : {};

    // Create the appropriate provider model
    let aiModel;

    if (ANTHROPIC_COMPATIBLE[provider]) {
      const baseURL = ANTHROPIC_COMPATIBLE[provider];
      const anthropic = createAnthropic({ baseURL, apiKey });
      aiModel = anthropic(model);
    } else {
      const baseURL = OPENAI_COMPATIBLE[provider];
      if (!baseURL) {
        return sendJson(res, 400, { error: `Unknown provider: ${provider}` });
      }
      const headers: Record<string, string> = {};
      if (provider === 'openrouter') {
        const origin = req.headers.origin || 'https://lovable.app';
        headers['HTTP-Referer'] = origin;
        headers['X-Title'] = 'CloudChat';
      }
      const openai = createOpenAI({ baseURL, apiKey, compatibility: 'compatible', headers });
      aiModel = openai(model);
    }

    const result = await streamText({
      model: aiModel,
      messages: allMessages,
      temperature: temperature ?? 0.7,
      topP: top_p ?? 0.9,
      maxOutputTokens: max_tokens ?? 4096,
      tools: { ...webDevTools, ...repoTools },
    });

    const response = result.toDataStreamResponse({ headers: corsHeaders });

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
      const errors = (err as any).errors;
      const innerError =
        Array.isArray(errors) && errors.length > 0 ? errors[errors.length - 1] : err;

      const statusCode = (innerError as any).statusCode || (innerError as any).status;
      if (statusCode) status = statusCode;

      const responseBody = (innerError as any).responseBody;
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
}

async function fetchRepoContents(
  owner: string,
  repo: string,
  path: string,
  headers: Record<string, string>
): Promise<any[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    return [
      {
        path: data.path,
        type: 'file',
        size: data.size,
        sha: data.sha,
      },
    ];
  }

  const contents: any[] = [];
  for (const item of data) {
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
        size: item.size,
        sha: item.sha,
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

        // 3. Create/update files on the new branch
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

          const updateRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${file.path}`,
            {
              method: 'PUT',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: `Update ${file.path}`,
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
  } catch (error: any) {
    console.error('GitHub integration error:', error);
    sendJson(res, 500, { error: error.message });
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

async function analyzeCode(files: FileContent[]): Promise<any[]> {
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
  } catch (error: any) {
    console.error('AI analysis error:', error);
    throw new Error(`AI analysis failed: ${error.message}`);
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
  } catch (error: any) {
    console.error('GitHub analyzer error:', error);
    sendJson(res, 500, { error: error.message });
  }
});

// ─── /functions/v1/validate-key ──────────────────────────────────────────────

const MINIMAX_API_URL = 'https://api.minimax.chat/v1/text/chatcompletion_v2';
const KIMI_MODELS_URL = 'https://api.moonshot.cn/v1/models';

app.post('/functions/v1/validate-key', async (req, res) => {
  try {
    const { provider, api_key } = req.body;

    if (!api_key || !provider) {
      return sendJson(res, 400, { valid: false, error: 'Missing provider or api_key' });
    }

    if (provider === 'minimax') {
      const response = await fetch(MINIMAX_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${api_key}`,
        },
        body: JSON.stringify({
          model: 'MiniMax-M2.5',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 1,
        }),
      });

      if (response.ok) {
        return sendJson(res, 200, {
          valid: true,
          models: [
            'MiniMax-M2.5',
            'MiniMax-M2.5-highspeed',
            'MiniMax-M2.1',
            'MiniMax-M2.1-highspeed',
            'MiniMax-M2',
          ],
        });
      } else {
        const errorText = await response.text();
        return sendJson(res, 401, {
          valid: false,
          error: `Authentication failed: ${errorText}`,
        });
      }
    } else if (provider === 'kimi') {
      const response = await fetch(KIMI_MODELS_URL, {
        headers: { Authorization: `Bearer ${api_key}` },
      });

      if (response.ok) {
        const data = await response.json();
        const models = data.data?.map((m: any) => m.id) || [
          'kimi-k2-0711-preview',
          'moonshot-v1-128k',
          'moonshot-v1-32k',
          'moonshot-v1-8k',
        ];
        return sendJson(res, 200, { valid: true, models });
      } else {
        const errorText = await response.text();
        return sendJson(res, 401, {
          valid: false,
          error: `Authentication failed: ${errorText}`,
        });
      }
    }

    return sendJson(res, 400, { valid: false, error: 'Unknown provider' });
  } catch (err: any) {
    sendJson(res, 500, { valid: false, error: err.message });
  }
});

// ─── /functions/v1/chat-proxy ────────────────────────────────────────────────

interface ChatProxyRequest {
  provider: 'minimax' | 'kimi';
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  api_key: string;
  system_prompt?: string;
}

const MINIMAX_CHAT_API_URL = 'https://api.minimax.chat/v1/text/chatcompletion_v2';
const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';

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

  const response = await fetch(MINIMAX_CHAT_API_URL, {
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

app.post('/functions/v1/chat-proxy', async (req, res) => {
  try {
    const body: ChatProxyRequest = req.body;

    if (!body.api_key) {
      return sendJson(res, 400, { error: 'API key is required' });
    }

    if (!body.provider || !['minimax', 'kimi'].includes(body.provider)) {
      return sendJson(res, 400, {
        error: 'Invalid provider. Use "minimax" or "kimi".',
      });
    }

    let upstreamResponse: Response;
    if (body.provider === 'minimax') {
      upstreamResponse = await proxyMiniMax(body);
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
              if (body.provider === 'minimax') {
                content = json.choices?.[0]?.delta?.content || '';
              } else if (body.provider === 'kimi') {
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
  } catch (err: any) {
    const message = err.message || 'Internal server error';
    const status = message.includes('401') ? 401 : message.includes('429') ? 429 : 500;

    if (!res.headersSent) {
      sendJson(res, status, { error: message });
    }
  }
});

// ─── /functions/v1/preview ────────────────────────────────────────────────────

app.post('/functions/v1/preview/start', async (req, res) => {
  try {
    const { owner, repo, pat, branch } = req.body;
    if (!owner || !repo || !pat) {
      return sendJson(res, 400, { error: 'owner, repo, and pat are required' });
    }

    console.log(`Starting preview for ${owner}/${repo}...`);
    const result = await startPreview(owner, repo, pat, branch);
    console.log(`Preview running at ${result.url}`);
    return sendJson(res, 200, result);
  } catch (err: any) {
    console.error('Preview start error:', err);
    // Return the status with error details
    const status = getPreviewStatus(req.body.owner, req.body.repo);
    sendJson(res, 500, {
      error: err.message,
      ...(status && { logs: status.logs }),
    });
  }
});

app.post('/functions/v1/preview/stop', async (req, res) => {
  try {
    const { owner, repo } = req.body;
    if (!owner || !repo) {
      return sendJson(res, 400, { error: 'owner and repo are required' });
    }
    await stopPreview(owner, repo);
    return sendJson(res, 200, { success: true });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

app.post('/functions/v1/preview/apply-changes', async (req, res) => {
  try {
    const { owner, repo, changes } = req.body;
    if (!owner || !repo || !changes?.length) {
      return sendJson(res, 400, { error: 'owner, repo, and changes are required' });
    }
    await applyChanges(owner, repo, changes);
    return sendJson(res, 200, { success: true });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

app.get('/functions/v1/preview/status/:owner/:repo', (req, res) => {
  const status = getPreviewStatus(req.params.owner, req.params.repo);
  if (!status) {
    return sendJson(res, 404, { error: 'No active preview' });
  }
  return sendJson(res, 200, status);
});

app.get('/functions/v1/preview/list', (_req, res) => {
  return sendJson(res, 200, { previews: getAllPreviews() });
});

// ─── Start server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Local API server running on http://localhost:${PORT}`);
  console.log('Routes:');
  console.log('  POST /functions/v1/chat');
  console.log('  POST /functions/v1/github-integration');
  console.log('  POST /functions/v1/github-analyzer');
  console.log('  POST /functions/v1/validate-key');
  console.log('  POST /functions/v1/chat-proxy');
  console.log('  POST /functions/v1/preview/start');
  console.log('  POST /functions/v1/preview/stop');
  console.log('  POST /functions/v1/preview/apply-changes');
  console.log('  GET  /functions/v1/preview/status/:owner/:repo');
  console.log('  GET  /functions/v1/preview/list');
});
