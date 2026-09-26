// @vitest-environment node
import type { AddressInfo } from 'net'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  tool: vi.fn((config: unknown) => config),
}))

const providerConfigMocks = vi.hoisted(() => ({
  createProviderModel: vi.fn(),
}))

const hermesProfileMocks = vi.hoisted(() => ({
  getHubSelectedProfileName: vi.fn(() => 'agent-two'),
}))

const repoCloneMocks = vi.hoisted(() => ({
  ensureRepoClone: vi.fn(),
  getManagedRepoClone: vi.fn(),
}))

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    streamText: aiMocks.streamText,
    generateText: aiMocks.generateText,
    tool: aiMocks.tool,
  }
})

vi.mock('../provider-config', async () => {
  const actual = await vi.importActual<typeof import('../provider-config')>('../provider-config')
  return {
    ...actual,
    createProviderModel: providerConfigMocks.createProviderModel,
  }
})

vi.mock('../lib/hermes-profiles', async () => {
  const actual = await vi.importActual<typeof import('../lib/hermes-profiles')>('../lib/hermes-profiles')
  return {
    ...actual,
    getHubSelectedProfileName: hermesProfileMocks.getHubSelectedProfileName,
  }
})

// Managed clones must never hit the real filesystem/network in tests.
vi.mock('../repo-clone-manager', async () => {
  const actual = await vi.importActual<typeof import('../repo-clone-manager')>('../repo-clone-manager')
  return {
    ...actual,
    ensureRepoClone: repoCloneMocks.ensureRepoClone,
    getManagedRepoClone: repoCloneMocks.getManagedRepoClone,
  }
})

async function createTestServer() {
  const { createApp } = await import('../index')
  const app = createApp()

  return await new Promise<{
    close: () => Promise<void>
    url: string
  }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error)
                return
              }
              closeResolve()
            })
          }),
      })
    })
  })
}

describe('Hermes chat route', () => {
  const actualFetch = global.fetch
  const tempDirs: string[] = []

  beforeEach(() => {
    providerConfigMocks.createProviderModel.mockReturnValue({ id: 'hermes-model' })
    aiMocks.generateText.mockResolvedValue({ text: 'ok' })
    aiMocks.streamText.mockImplementation(() => ({
      pipeTextStreamToResponse(res: {
        writeHead: (statusCode: number, headers: Record<string, string>) => void
        end: (body?: string) => void
      }, options: { headers: Record<string, string> }) {
        res.writeHead(200, {
          ...options.headers,
          'x-vercel-ai-ui-message-stream': 'v1',
        })
        res.end('')
      },
    }))
    // Hermes auto-provisioning of a managed clone fails by default; tests that
    // need a checkout opt in by resolving ensureRepoClone.
    repoCloneMocks.ensureRepoClone.mockRejectedValue(new Error('clone unavailable'))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  })

  function createLocalRepoClone() {
    const repoDir = mkdtempSync(join(tmpdir(), 'cloudchat-hermes-'))
    mkdirSync(join(repoDir, '.git'))
    tempDirs.push(repoDir)
    return repoDir
  }

  it('uses ACP transport for Hermes repo turns — the bridge drives the real agent', async () => {
    // Stub fetch so the ACP proxy can reach a fake hermes bridge
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-repo","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-repo","choices":[{"index":0,"delta":{"content":"Updating src/App.tsx via repo tools"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-repo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    const actualFetchLocal = global.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
      if (url.includes('/functions/v1/chat')) {
        return actualFetchLocal(input, init)
      }

      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }

      // Verify the ACP proxy sends repo headers
      const headers = init?.headers as Record<string, string> ?? {}
      expect(headers['X-Hermes-Execution-Mode']).toBe('acp')
      expect(headers['X-Hermes-Profile']).toBe('agent-two')
      expect(headers['X-Hermes-Repo-Owner']).toBe('octo')
      expect(headers['X-Hermes-Repo-Name']).toBe('cloudchat')
      expect(headers['X-Hermes-Github-PAT']).toBe('ghp_test')
      expect(headers['X-Hermes-Repo-Edit-Intent']).toBe('1')

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetchLocal(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hermes-Profile': 'agent-two',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_test',
          conversation_id: 'conv-1',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
            default_branch: 'main',
          },
          repo_edit_intent: true,
          repo_file_tree: ['src/App.tsx'],
          repo_file_cache: {
            'src/App.tsx': 'export default function App() { return null }',
          },
          messages: [
            { role: 'user', content: 'Update src/App.tsx' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
      expect(body).toContain('Updating src/App.tsx via repo tools')
      expect(body).toContain('finishReason":"stop"')

      // Agent-loop mode: streamText/createProviderModel should NOT be called
      // because the proxy handles everything directly
      expect(providerConfigMocks.createProviderModel).not.toHaveBeenCalled()
      expect(aiMocks.streamText).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('rewraps Hermes agent-loop SSE into an AI SDK data stream and normalizes content blocks', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-1","choices":[{"index":0,"delta":{"agent_status":{"label":"Analyzing repository context...","phase":"thinking","iteration":1}}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-1","choices":[{"index":0,"delta":{"content":[{"type":"text","text":"Hello from Hermes"}]}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-1","choices":[{"index":0,"delta":{"tool_activity":{"tool":"web_search","status":"running","input":"architecture","output":null}}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-1","choices":[{"index":0,"delta":{"server_tool_event":{"type":"repo_file_read","path":"README.md","content":"# CloudChat"}}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          hermes_toolsets: 'web,browser,vision',
          messages: [
            { role: 'user', content: 'Explain the architecture.' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
      expect(body).toContain('"delta":"Hello from Hermes"')
      expect(body).toContain('agent_status')
      expect(body).toContain('Analyzing repository context...')
      expect(body).toContain('hermes_tool_activity')
      expect(body).toContain('repo_file_read')
      expect(body).toContain('finishReason":"stop"')
      expect(providerConfigMocks.createProviderModel).not.toHaveBeenCalled()
      expect(aiMocks.streamText).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('falls back to a verified local clone for Hermes when GitHub access is unavailable', async () => {
    const repoDir = createLocalRepoClone()
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-local","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-local","choices":[{"index":0,"delta":{"content":"Inspecting the local checkout"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-local","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      const headers = init?.headers as Record<string, string> ?? {}
      expect(headers['X-Hermes-Execution-Mode']).toBe('acp')
      expect(headers['X-Hermes-Profile']).toBe('agent-two')
      expect(headers['X-Hermes-Repo-Owner']).toBeUndefined()
      expect(headers['X-Hermes-Repo-Name']).toBeUndefined()
      expect(headers['X-Hermes-Github-PAT']).toBeUndefined()
      // Attached local checkout → worktree headers so the bridge re-enables
      // terminal/files tools on the checkout (build/audit capability).
      expect(headers['X-Hermes-Worktree']).toBe('1')
      expect(headers['X-Hermes-Repo-Root']).toBe(repoDir)

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hermes-Profile': 'agent-two',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          hermes_toolsets: 'files,terminal',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
            localPath: repoDir,
          },
          messages: [
            { role: 'user', content: 'Analyze the codebase' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(body).toContain('Inspecting the local checkout')
      expect(providerConfigMocks.createProviderModel).not.toHaveBeenCalled()
      expect(aiMocks.streamText).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('auto-provisions a managed local checkout for Hermes repo mode and forwards worktree headers', async () => {
    repoCloneMocks.ensureRepoClone.mockResolvedValue({
      exists: true,
      path: '/tmp/cloudchat-managed/octo/cloudchat',
    })

    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-clone","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-clone","choices":[{"index":0,"delta":{"content":"Running npm run build on the checkout"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-clone","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":5,"total_tokens":11}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    let capturedHeaders: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }

      const raw = init?.headers
      capturedHeaders = raw instanceof Headers
        ? Object.fromEntries(raw.entries())
        : { ...(raw as Record<string, string> | undefined) }

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_test',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
            default_branch: 'main',
          },
          messages: [
            { role: 'user', content: 'Run a type-safety audit' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(body).toContain('Running npm run build on the checkout')

      // The bridge gets worktree headers pointing at the auto-provisioned clone
      expect(capturedHeaders['X-Hermes-Worktree']).toBe('1')
      expect(capturedHeaders['X-Hermes-Repo-Root']).toBe('/tmp/cloudchat-managed/octo/cloudchat')

      expect(repoCloneMocks.ensureRepoClone).toHaveBeenCalledWith({
        owner: 'octo',
        repo: 'cloudchat',
        pat: 'ghp_test',
        branch: 'main',
      })
      expect(providerConfigMocks.createProviderModel).not.toHaveBeenCalled()
      expect(aiMocks.streamText).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('tells the agent it has no build tools when Hermes repo mode has no local checkout', async () => {
    // ensureRepoClone rejects (default) — repo mode falls back to GitHub-API tools.
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-noclone","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-noclone","choices":[{"index":0,"delta":{"content":"Static review only"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-noclone","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    let capturedBody: Record<string, unknown> = {}
    let capturedHeaders: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }

      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      const raw = init?.headers
      capturedHeaders = raw instanceof Headers
        ? Object.fromEntries(raw.entries())
        : { ...(raw as Record<string, string> | undefined) }
      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_test',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
            default_branch: 'main',
          },
          messages: [
            { role: 'user', content: 'Run a type-safety audit' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(body).toContain('Static review only')

      // No checkout → no worktree headers, and the system prompt tells the
      // agent to fall back to a static review instead of "can't run a build".
      // (The prompt rides in the normalized "Application instructions" message.)
      expect(capturedHeaders['X-Hermes-Worktree']).toBeUndefined()
      expect(capturedHeaders['X-Hermes-Repo-Root']).toBeUndefined()
      const allText = (capturedBody.messages as Array<{ role: string; content: string }>)
        .map((m) => typeof m.content === 'string' ? m.content : '')
        .join('\n')
      expect(allText).toContain('no terminal or build tools')
      expect(allText).toContain('static review')
    } finally {
      await server.close()
    }
  })

  it('returns 422 when Hermes repo mode has neither GitHub access nor a verified local clone', async () => {
    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
          },
          messages: [
            { role: 'user', content: 'Analyze the codebase' },
          ],
        }),
      })

      expect(response.status).toBe(422)
      await expect(response.json()).resolves.toEqual({
        error: expect.stringContaining('Your GitHub token is missing or invalid'),
      })
    } finally {
      await server.close()
    }
  })

  it('returns a friendly 503 when the Hermes bridge is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }
      // Simulate the bridge being permanently down: /health claims to be up
      // (so the readiness retry exits quickly), but the actual chat fetch still
      // fails — this verifies the 503 path without waiting 15s.
      if (url.includes('/health')) {
        return new Response(null, { status: 200 })
      }
      throw new TypeError('fetch failed')
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          messages: [
            { role: 'user', content: 'Explain the architecture.' },
          ],
        }),
      })

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({
        error: 'Hermes bridge is not reachable at http://127.0.0.1:3002/v1. Start hermes-bridge/main.py and try again.',
      })
    } finally {
      await server.close()
    }
  })

  it('preserves Hermes bridge status and message instead of collapsing to a generic 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      return new Response(JSON.stringify({
        error: {
          message: 'No API key provided. Set HERMES_OPENROUTER_KEY, pass Authorization: Bearer <key> header, or run the local OpenClaw gateway.',
        },
      }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'xiaomi/mimo-v2-pro',
          messages: [
            { role: 'user', content: 'Hello' },
          ],
        }),
      })

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: 'No API key provided. Set HERMES_OPENROUTER_KEY, pass Authorization: Bearer <key> header, or run the local OpenClaw gateway.',
      })
      expect(providerConfigMocks.createProviderModel).not.toHaveBeenCalled()
      expect(aiMocks.streamText).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('waits for delayed Hermes bridge headers instead of aborting the proxy request early', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-delayed","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-delayed","choices":[{"index":0,"delta":{"content":"Hello after delayed bridge headers"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-delayed","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":5,"total_tokens":11}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response(bridgeStream, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
            },
          }))
        }, 25)

        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('This operation was aborted', 'AbortError'))
        }, { once: true })
      })
    }))

    const server = await createTestServer()

    try {
      const response = await Promise.race([
        actualFetch(`${server.url}/functions/v1/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            provider: 'hermes',
            model: 'meta-llama/llama-4-maverick',
            api_key: 'or-key',
            hermes_toolsets: 'web,browser,vision',
            messages: [
              { role: 'user', content: 'Explain the architecture.' },
            ],
          }),
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Timed out waiting for Hermes proxy response')), 1000)
        }),
      ])

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
      expect(body).toContain('"delta":"Hello after delayed bridge headers"')
      expect(body).toContain('finishReason":"stop"')
    } finally {
      await server.close()
    }
  })

  it('normalizes Hermes agent-loop streams to stop when visible output arrives without an explicit finish reason', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-2","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-2","choices":[{"index":0,"delta":{"content":"Repo summary in progress"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-2","choices":[{"index":0,"delta":{"server_tool_event":{"type":"repo_file_read","path":"README.md","content":"# CloudChat"}}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          hermes_toolsets: 'web,browser,vision',
          messages: [
            { role: 'user', content: 'Explain the architecture.' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(body).toContain('Repo summary in progress')
      expect(body).toContain('finishReason":"stop"')
      expect(body).not.toContain('finishReason":"unknown"')
    } finally {
      await server.close()
    }
  })

  it('surfaces a fallback assistant reply and stop finish when Hermes returns an empty stream', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-empty","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          hermes_toolsets: 'web,browser,vision',
          messages: [
            { role: 'user', content: 'Explain the architecture.' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(body).toContain('Hermes returned an empty response for this turn')
      expect(body).toContain('finishReason":"stop"')
      expect(body).not.toContain('finishReason":"unknown"')
    } finally {
      await server.close()
    }
  })

  it('omits empty Authorization and uncredentialed openrouter pin when proxying to the bridge', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-empty-auth","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-empty-auth","choices":[{"index":0,"delta":{"content":"routed via CLI custom"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-empty-auth","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    let capturedHeaders: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      const raw = init?.headers
      if (raw instanceof Headers) {
        capturedHeaders = Object.fromEntries(raw.entries())
      } else if (Array.isArray(raw)) {
        capturedHeaders = Object.fromEntries(raw)
      } else {
        capturedHeaders = { ...(raw as Record<string, string> | undefined) }
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'auto',
          api_key: '',
          hermes_provider: 'openrouter',
          messages: [
            { role: 'user', content: 'hello' },
          ],
        }),
      })

      const body = await response.text()
      expect(response.ok).toBe(true)
      expect(body).toContain('routed via CLI custom')

      const headerKeys = Object.keys(capturedHeaders).map((k) => k.toLowerCase())
      expect(headerKeys).not.toContain('authorization')
      expect(headerKeys).not.toContain('x-hermes-provider')
    } finally {
      await server.close()
    }
  })

  it('forwards usable Authorization and an explicit custom provider pin to the bridge', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-custom-pin","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-custom-pin","choices":[{"index":0,"delta":{"content":"custom pin ok"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-custom-pin","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    let capturedHeaders: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      const raw = init?.headers
      if (raw instanceof Headers) {
        capturedHeaders = Object.fromEntries(raw.entries())
      } else if (Array.isArray(raw)) {
        capturedHeaders = Object.fromEntries(raw)
      } else {
        capturedHeaders = { ...(raw as Record<string, string> | undefined) }
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'deepseek-v4-flash',
          api_key: 'inf_test_key',
          hermes_provider: 'custom:api.bullinf.fun',
          messages: [
            { role: 'user', content: 'hello' },
          ],
        }),
      })

      const body = await response.text()
      expect(response.ok).toBe(true)
      expect(body).toContain('custom pin ok')

      const auth = capturedHeaders['Authorization'] ?? capturedHeaders['authorization']
      const pin = capturedHeaders['X-Hermes-Provider'] ?? capturedHeaders['x-hermes-provider']
      expect(auth).toBe('Bearer inf_test_key')
      expect(pin).toBe('custom:api.bullinf.fun')
    } finally {
      await server.close()
    }
  })

  it('suppresses placeholder-string API keys ("none"/"null"/"undefined") and whitespace-only keys like empty ones', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-placeholder","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-placeholder","choices":[{"index":0,"delta":{"content":"placeholder suppressed"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-placeholder","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    for (const badKey of ['none', 'null', 'undefined', '   ']) {
      let capturedHeaders: Record<string, string> = {}
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
        if (url.includes('/functions/v1/chat')) {
          return actualFetch(input, init)
        }

        const raw = init?.headers
        if (raw instanceof Headers) {
          capturedHeaders = Object.fromEntries(raw.entries())
        } else if (Array.isArray(raw)) {
          capturedHeaders = Object.fromEntries(raw)
        } else {
          capturedHeaders = { ...(raw as Record<string, string> | undefined) }
        }

        return new Response(bridgeStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }))

      const server = await createTestServer()

      try {
        const response = await actualFetch(`${server.url}/functions/v1/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            provider: 'hermes',
            model: 'auto',
            api_key: badKey,
            hermes_provider: 'openrouter',
            messages: [
              { role: 'user', content: 'hello' },
            ],
          }),
        })

        const body = await response.text()
        expect(response.ok).toBe(true)
        expect(body).toContain('placeholder suppressed')

        // Placeholder key must not become an Authorization header — an empty or
        // placeholder auth confuses OpenRouter key detection on the bridge side.
        const headerKeys = Object.keys(capturedHeaders).map((k) => k.toLowerCase())
        expect(headerKeys).not.toContain('authorization')
        // And the uncredentialed openrouter pin must be dropped with it.
        expect(headerKeys).not.toContain('x-hermes-provider')
      } finally {
        await server.close()
        vi.unstubAllGlobals()
      }
    }
  })

  it('keeps an explicit non-openrouter custom pin even when no usable key is present', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-keyless-pin","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-keyless-pin","choices":[{"index":0,"delta":{"content":"keyless custom pin kept"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-keyless-pin","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    let capturedHeaders: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      const raw = init?.headers
      if (raw instanceof Headers) {
        capturedHeaders = Object.fromEntries(raw.entries())
      } else if (Array.isArray(raw)) {
        capturedHeaders = Object.fromEntries(raw)
      } else {
        capturedHeaders = { ...(raw as Record<string, string> | undefined) }
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'auto',
          api_key: '',
          hermes_provider: 'custom:api.bullinf.fun',
          messages: [
            { role: 'user', content: 'hello' },
          ],
        }),
      })

      const body = await response.text()
      expect(response.ok).toBe(true)
      expect(body).toContain('keyless custom pin kept')

      // Keyless: no Authorization. But a custom base_url provider pin is exactly
      // what routes the request — it must survive without a client key.
      const headerKeys = Object.keys(capturedHeaders).map((k) => k.toLowerCase())
      expect(headerKeys).not.toContain('authorization')
      const pin = capturedHeaders['X-Hermes-Provider'] ?? capturedHeaders['x-hermes-provider']
      expect(pin).toBe('custom:api.bullinf.fun')
    } finally {
      await server.close()
      vi.unstubAllGlobals()
    }
  })

})
