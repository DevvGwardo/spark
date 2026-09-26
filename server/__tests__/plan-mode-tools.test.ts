// @vitest-environment node
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
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

describe('plan mode tool routing', () => {
  const actualFetch = global.fetch

  beforeEach(() => {
    providerConfigMocks.createProviderModel.mockReturnValue({ id: 'test-model' })
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
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps compatible providers on the read-only direct-proxy path in plan mode so create_html_file remains available', async () => {
    const actualFetchLocal = global.fetch
    let upstreamBody: { tools?: unknown[]; tool_choice?: unknown } | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetchLocal(input, init)
      }

      if (url.includes('api.minimax.io/v1/chat/completions')) {
        upstreamBody = JSON.parse(String(init?.body)) as { tools?: unknown[]; tool_choice?: unknown }
        const upstreamSse = [
          'data: {"id":"mm-1","choices":[{"index":0,"delta":{"role":"","content":"Plan: inspect the repo and draft the HTML artifact."}}]}\n\n',
          'data: {"id":"mm-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}}\n\n',
          'data: [DONE]\n\n',
        ].join('')
        return new Response(upstreamSse, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }

      throw new Error(`Unexpected upstream fetch during plan mode: ${url}`)
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'minimax',
          model: 'MiniMax-M2.5',
          api_key: 'minimax-key',
          planMode: true,
          messages: [
            { role: 'user', content: 'Draft the implementation plan as an HTML artifact.' },
          ],
        }),
      })

      expect(response.ok).toBe(true)
      // Plan mode routes compatible providers through the read-only direct
      // proxy instead of the server tool loop.
      expect(aiMocks.streamText).not.toHaveBeenCalled()

      // The upstream tool definitions are filtered to read-only tools only —
      // create_html_file is kept, every write/terminal tool is dropped.
      const capturedUpstreamBody = upstreamBody as { tools?: unknown[]; tool_choice?: unknown } | null
      const toolNames = (capturedUpstreamBody?.tools ?? []).map(
        (toolDef) => (toolDef as { function?: { name?: string } }).function?.name,
      )
      expect(toolNames).toContain('create_html_file')
      expect(toolNames).not.toContain('create_css_file')
      expect(toolNames).not.toContain('create_js_file')
      expect(toolNames).not.toContain('create_react_component')
      expect(toolNames).not.toContain('create_markdown_file')
      expect(toolNames).not.toContain('run_command')
      expect(toolNames).not.toContain('execute_python')
      expect(toolNames).not.toContain('write_file')
      expect(toolNames).not.toContain('edit_repo_file')
      expect(capturedUpstreamBody?.tool_choice).toBe('auto')

      const body = await response.text()
      expect(body).toContain('Plan: inspect the repo')
      // The trailing usage event is emitted on the direct-proxy path too.
      expect(body).toContain('"type":"usage"')
      expect(body).toContain('"input_tokens":12')
      expect(body).toContain('"model":"MiniMax-M2.5"')
    } finally {
      await server.close()
    }
  })

  it('filters mutating repo and local tools in plan mode while keeping read access', async () => {
    const actualFetchLocal = global.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetchLocal(input, init)
      }

      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }

      throw new Error(`Unexpected upstream fetch during plan mode repo test: ${url}`)
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.2',
          api_key: 'openai-key',
          github_pat: 'ghp_test_token',
          planMode: true,
          agent_toolsets: 'terminal,files,code_execution',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
            default_branch: 'main',
          },
          repo_file_tree: ['src/App.tsx'],
          repo_file_cache: {
            'src/App.tsx': 'export default function App() { return null }',
          },
          messages: [
            { role: 'user', content: 'Inspect the repo and draft the plan as HTML.' },
          ],
        }),
      })

      expect(response.ok).toBe(true)
      expect(aiMocks.streamText).toHaveBeenCalledTimes(1)

      const tools = (aiMocks.streamText.mock.calls.at(-1)?.[0] as { tools?: Record<string, unknown> })?.tools ?? {}
      const toolNames = Object.keys(tools)

      expect(toolNames).toEqual(expect.arrayContaining(['create_html_file', 'read_repo_file', 'read_file']))
      expect(toolNames).not.toContain('run_command')
      expect(toolNames).not.toContain('execute_python')
      expect(toolNames).not.toContain('write_file')
      expect(toolNames).not.toContain('edit_repo_file')
      expect(toolNames).not.toContain('create_repo_file')
      expect(toolNames).not.toContain('delete_repo_file')
      expect(toolNames).not.toContain('batch_edit_repo_files')
    } finally {
      await server.close()
    }
  })
})
