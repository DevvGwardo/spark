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

describe('Hermes file tree proxy', () => {
  const actualFetch = global.fetch

  beforeEach(() => {
    providerConfigMocks.createProviderModel.mockReturnValue({ id: 'hermes-model' })
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

  it('includes repo_file_tree in the Hermes bridge request body', async () => {
    let capturedBody: Record<string, unknown> | null = null

    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-tree","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-tree","choices":[{"index":0,"delta":{"content":"Reading files..."}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-tree","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      // GitHub repo validation
      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }

      // Hermes bridge — capture the request body
      if (url.includes('/v1/chat/completions') && init?.body) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()
    const fileTree = ['README.md', 'src/index.ts', 'src/components/App.tsx', 'package.json']

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
            owner: 'octo',
            name: 'project',
            default_branch: 'main',
          },
          repo_file_tree: fileTree,
          repo_edit_intent: false,
          messages: [{ role: 'user', content: 'Analyze the codebase' }],
        }),
      })

      expect(response.ok).toBe(true)
      expect(capturedBody).not.toBeNull()
      expect(capturedBody!.repo_file_tree).toEqual(fileTree)
    } finally {
      await server.close()
    }
  })

  it('omits repo_file_tree from bridge body when the tree is empty', async () => {
    let capturedBody: Record<string, unknown> | null = null

    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-notree","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-notree","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-notree","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }

      if (url.includes('/v1/chat/completions') && init?.body) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_validtokenformat1234567890abcdef12345',
          activeRepo: {
            owner: 'octo',
            name: 'project',
            default_branch: 'main',
          },
          repo_file_tree: [],
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      })

      expect(response.ok).toBe(true)
      expect(capturedBody).not.toBeNull()
      // Empty tree should NOT be included in the body
      expect(capturedBody!.repo_file_tree).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('filters non-string entries from repo_file_tree before sending to bridge', async () => {
    let capturedBody: Record<string, unknown> | null = null

    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-filter","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-filter","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-filter","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }

      if (url.includes('/v1/chat/completions') && init?.body) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_validtokenformat1234567890abcdef12345',
          activeRepo: {
            owner: 'octo',
            name: 'project',
            default_branch: 'main',
          },
          // Mixed valid and invalid entries
          repo_file_tree: ['README.md', null, 42, '', 'src/index.ts', '   '],
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      })

      expect(capturedBody).not.toBeNull()
      // Only valid non-empty string paths should survive
      expect(capturedBody!.repo_file_tree).toEqual(['README.md', 'src/index.ts'])
    } finally {
      await server.close()
    }
  })

  it('sends repo headers alongside file tree in the bridge request', async () => {
    let capturedHeaders: Record<string, string> = {}

    const bridgeStream = [
      'data: {"id":"chatcmpl-hermes-hdrs","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-hdrs","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n',
      'data: {"id":"chatcmpl-hermes-hdrs","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url

      if (url.includes('/functions/v1/')) {
        return actualFetch(input, init)
      }

      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }

      if (url.includes('/v1/chat/completions')) {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      }

      return new Response(bridgeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }))

    const server = await createTestServer()

    try {
      await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          model: 'meta-llama/llama-4-maverick',
          api_key: 'or-key',
          github_pat: 'ghp_validtokenformat1234567890abcdef12345',
          activeRepo: {
            owner: 'octo',
            name: 'project',
            default_branch: 'main',
          },
          repo_file_tree: ['README.md'],
          repo_edit_intent: true,
          messages: [{ role: 'user', content: 'Edit README' }],
        }),
      })

      // Verify both repo headers AND file tree in body are sent together
      expect(capturedHeaders['X-Hermes-Repo-Owner']).toBe('octo')
      expect(capturedHeaders['X-Hermes-Repo-Name']).toBe('project')
      expect(capturedHeaders['X-Hermes-Github-PAT']).toBe('ghp_validtokenformat1234567890abcdef12345')
      expect(capturedHeaders['X-Hermes-Repo-Edit-Intent']).toBe('1')
      expect(capturedHeaders['X-Hermes-Execution-Mode']).toBe('agent-loop')
    } finally {
      await server.close()
    }
  })
})
