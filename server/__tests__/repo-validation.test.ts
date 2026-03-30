// @vitest-environment node
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  tool: vi.fn((config: unknown) => config),
}))

const providerConfigMocks = vi.hoisted(() => ({
  createProviderModel: vi.fn(),
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

describe('Server-side repo validation', () => {
  const actualFetch = global.fetch

  beforeEach(() => {
    providerConfigMocks.createProviderModel.mockReturnValue({ id: 'test-model' })
    aiMocks.streamText.mockImplementation(() => ({
      pipeDataStreamToResponse(res: {
        writeHead: (statusCode: number, headers: Record<string, string>) => void
        end: (body?: string) => void
      }, options: { headers: Record<string, string> }) {
        res.writeHead(200, {
          ...options.headers,
          'x-vercel-ai-data-stream': 'v1',
        })
        res.end('')
      },
    }))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  // Use Hermes provider for validation tests since its fetch-stub interception
  // is proven by existing tests. The validation runs before any provider-specific
  // code path, so the provider choice doesn't affect validation behavior.

  it('returns 422 when the active repo returns 404 from GitHub', async () => {
    const capturedUrls: string[] = []

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
      capturedUrls.push(url)

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      // GitHub repo validation HEAD request — repo not found
      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 404 })
      }

      return new Response('', { status: 200 })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_validtokenformat1234567890abcdef12345',
          activeRepo: {
            owner: 'MisterGuy420',
            name: 'nonexistent-repo',
            default_branch: 'main',
          },
          messages: [{ role: 'user', content: 'Analyze the codebase' }],
        }),
      })

      expect(response.status).toBe(422)
      const body = await response.json() as { error: string }
      expect(body.error).toContain('MisterGuy420/nonexistent-repo')
      expect(body.error).toContain('not found')

      // Verify a GitHub API call was made
      const githubCalls = capturedUrls.filter(u => u.includes('api.github.com/repos/'))
      expect(githubCalls.length).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })

  it('returns 422 when the GitHub token lacks access (403)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 403 })
      }

      return new Response('', { status: 200 })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_validtokenformat1234567890abcdef12345',
          activeRepo: {
            owner: 'private-org',
            name: 'private-repo',
            default_branch: 'main',
          },
          messages: [{ role: 'user', content: 'Analyze the codebase' }],
        }),
      })

      expect(response.status).toBe(422)
      const body = await response.json() as { error: string }
      expect(body.error).toContain('does not have access')
      expect(body.error).toContain('private-org/private-repo')
    } finally {
      await server.close()
    }
  })

  it('returns 422 when the GitHub token is expired (401)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 401 })
      }

      return new Response('', { status: 200 })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_validtokenformat1234567890abcdef12345',
          activeRepo: {
            owner: 'user',
            name: 'repo',
            default_branch: 'main',
          },
          messages: [{ role: 'user', content: 'Analyze the codebase' }],
        }),
      })

      expect(response.status).toBe(422)
      const body = await response.json() as { error: string }
      expect(body.error).toContain('does not have access')
    } finally {
      await server.close()
    }
  })

  it('proceeds normally when the repo is accessible (200)', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Analysis"}}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      // GitHub repo validation — repo exists
      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }

      // Hermes bridge
      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_validtokenformat1234567890abcdef12345',
          activeRepo: {
            owner: 'user',
            name: 'valid-repo',
            default_branch: 'main',
          },
          repo_file_tree: ['README.md', 'src/index.ts'],
          messages: [{ role: 'user', content: 'Analyze the codebase' }],
        }),
      })

      expect(response.ok).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('skips validation when no activeRepo is provided', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-norepo","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-norepo","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"chatcmpl-norepo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    vi.stubGlobal('fetch', fetchSpy)

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      })

      // Should not return 422 — no repo to validate
      expect(response.status).not.toBe(422)
      // Verify no GitHub API call was made
      const githubCalls = fetchSpy.mock.calls.filter(([input]: [RequestInfo | URL]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
        return url.includes('api.github.com/repos/')
      })
      expect(githubCalls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('skips validation when github_pat has invalid format', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-badpat","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-badpat","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n',
      'data: {"id":"chatcmpl-badpat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    vi.stubGlobal('fetch', fetchSpy)

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'not-a-valid-token',
          activeRepo: {
            owner: 'user',
            name: 'repo',
            default_branch: 'main',
          },
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      })

      // Invalid PATs now fail closed for Hermes repo turns unless a verified
      // local clone is attached. Validation still skips the GitHub HEAD check.
      expect(response.status).toBe(422)
      const body = await response.json() as { error: string }
      expect(body.error).toContain('Hermes needs either a GitHub token')
      // Verify no GitHub API call was made
      const githubCalls = fetchSpy.mock.calls.filter(([input]: [RequestInfo | URL]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
        return url.includes('api.github.com/repos/')
      })
      expect(githubCalls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('does not block when the GitHub validation request throws', async () => {
    const bridgeStream = [
      'data: {"id":"chatcmpl-timeout","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-timeout","choices":[{"index":0,"delta":{"content":"Working"}}]}\n\n',
      'data: {"id":"chatcmpl-timeout","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      // Simulate network failure on GitHub validation
      if (url.includes('api.github.com/repos/')) {
        throw new Error('Network error')
      }

      // Hermes bridge
      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_validtokenformat1234567890abcdef12345',
          activeRepo: {
            owner: 'user',
            name: 'repo',
            default_branch: 'main',
          },
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      })

      // Should NOT return 422 — network error is non-blocking
      expect(response.ok).toBe(true)
    } finally {
      await server.close()
    }
  })
})
