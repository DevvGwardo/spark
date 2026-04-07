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

describe('chat route abort handling', () => {
  beforeEach(() => {
    providerConfigMocks.createProviderModel.mockReturnValue({ id: 'openrouter-model' })
    aiMocks.generateText.mockResolvedValue({ text: 'ok' })
    aiMocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      expect(options.abortSignal).toBeInstanceOf(AbortSignal)

      return {
        pipeDataStreamToResponse(
          res: {
            writeHead: (statusCode: number, headers: Record<string, string>) => void
            end: (body?: string) => void
          },
          streamOptions: { headers: Record<string, string> },
        ) {
          res.writeHead(200, {
            ...streamOptions.headers,
            'x-vercel-ai-data-stream': 'v1',
          })
          res.end('')
        },
      }
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('passes a request-scoped abort signal into streamText for tool-capable repo turns', async () => {
    // Stub fetch so the repo validation HEAD request returns 200
    // and normal server requests pass through
    const actualFetch = global.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }
      return actualFetch(input, init)
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openrouter',
          model: 'openai/gpt-4.1-mini',
          api_key: 'or-key',
          github_pat: 'ghp_test',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
            default_branch: 'main',
          },
          repo_edit_intent: true,
          repo_file_tree: ['src/App.tsx'],
          messages: [{ role: 'user', content: 'Update src/App.tsx' }],
        }),
      })

      expect(response.ok).toBe(true)
      expect(aiMocks.streamText).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })
})
