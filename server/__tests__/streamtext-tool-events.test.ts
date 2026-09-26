// @vitest-environment node
// Proves the streamText tool-event fix: server tool execute handlers run
// LAZILY — during piping, not before it — so tool events must be appended to
// the StreamData in real time (not drained into a pre-built StreamData before
// pipeTextStreamToResponse). This test simulates the ai@4.3.19 lazy-piping
// contract with a fake model run: streaming starts, THEN tool execution
// happens, THEN onFinish fires with usage. All events emitted in that window
// must reach the client as `data` parts, in order, with usage last.
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
}))

const providerConfigMocks = vi.hoisted(() => ({
  createProviderModel: vi.fn(),
}))

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    streamText: aiMocks.streamText,
  }
})

vi.mock('../provider-config', async () => {
  const actual = await vi.importActual<typeof import('../provider-config')>('../provider-config')
  return {
    ...actual,
    createProviderModel: providerConfigMocks.createProviderModel,
  }
})

import { approvalPolicyStore } from '../approval-engine'

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
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error)
                return
              }
              resolveClose()
            })
          }),
      })
    })
  })
}

interface CapturedStreamTextOptions {
  tools?: Record<string, { execute?: (...args: unknown[]) => unknown }>
  onFinish?: (result: { usage: { inputTokens: number; outputTokens: number; totalTokens: number } }) => Promise<void> | void
}

/**
 * Fake streamText result whose `fullStream` faithfully simulates the ai@7
 * contract: the server merges it through `toUIMessageStream`, the model "run"
 * lazily executes server tools, and onFinish finally fires (which appends the
 * usage event). Tool execute handlers run lazily — during piping — so tool
 * events must reach the client in real time.
 */
function installLazyStreamTextMock() {
  aiMocks.streamText.mockImplementation((options: CapturedStreamTextOptions) => {
    const fullStream = new ReadableStream({
      async start(controller) {
        // 1. Streaming begins (model text). ai@7 requires text-start before deltas.
        controller.enqueue({ type: 'text-start', id: 'txt-1' })
        controller.enqueue({ type: 'text-delta', id: 'txt-1', text: 'Hello from model' })
        // 2. The model "runs" and lazily executes a server tool — this is
        //    exactly when tool events are emitted in production. The old code
        //    drained an empty array before piping and lost them.
        const runCommand = options.tools?.run_command as
          | { execute?: (args: Record<string, unknown>, opts: { toolCallId: string }) => Promise<string> }
          | undefined
        if (!runCommand?.execute) {
          throw new Error('run_command tool not found in streamText tools')
        }
        await runCommand.execute({ command: 'ls -la' }, { toolCallId: 'call-1' })
        // 3. The run finishes; onFinish appends the usage event.
        controller.enqueue({ type: 'text-end', id: 'txt-1' })
        await options.onFinish?.({
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        })
        controller.close()
      },
    })
    return { fullStream }
  })
}

describe('streamText tool-event timing fix', () => {
  const actualFetch = global.fetch

  beforeEach(() => {
    approvalPolicyStore.resetForTests()
    providerConfigMocks.createProviderModel.mockReturnValue({ id: 'test-model' })
    installLazyStreamTextMock()
  })

  afterEach(() => {
    approvalPolicyStore.resetForTests()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('delivers tool_call_begin/delta/end and the usage event after lazy tool execution', async () => {
    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.2',
          api_key: 'openai-key',
          agent_toolsets: 'terminal',
          messages: [{ role: 'user', content: 'List files.' }],
        }),
      })

      expect(response.ok).toBe(true)
      const body = await response.text()

      // Streaming text arrived first (streaming was not regressed).
      expect(body).toContain('"type":"text-delta"')
      expect(body).toContain('Hello from model')
      // Tool events emitted DURING execution reached the client as data parts.
      expect(body).toContain('"type":"tool_call_begin"')
      expect(body).toContain('"call_id":"call-1"')
      expect(body).toContain('"type":"tool_call_delta"')
      expect(body).toContain('"type":"tool_call_end"')
      expect(body).toContain('"exit_code":0')
      expect(body).toContain('"duration_ms":')
      // Usage event emitted once at stream end, after the tool events.
      expect(body).toContain('"type":"usage"')
      expect(body).toContain('"input_tokens":10')
      expect(body).toContain('"output_tokens":5')
      expect(body.indexOf('"type":"tool_call_begin"')).toBeLessThan(body.indexOf('"type":"usage"'))
      expect(body.indexOf('"type":"tool_call_end"')).toBeLessThan(body.indexOf('"type":"usage"'))
    } finally {
      await server.close()
    }
  })

  it('delivers legacy server_tool_event parts (repo_file_read) after server-side repo tools run', async () => {
    const actualFetchLocal = global.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetchLocal(input, init)
      }
      if (url.includes('api.github.com/repos/')) {
        return new Response(null, { status: 200 })
      }
      throw new Error(`Unexpected upstream fetch: ${url}`)
    }))

    // Also execute read_repo_file during the fake run.
    aiMocks.streamText.mockImplementation((options: CapturedStreamTextOptions) => {
      const fullStream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'text-start', id: 'txt-1' })
          controller.enqueue({ type: 'text-delta', id: 'txt-1', text: 'Repo analysis' })
          const readRepoFile = options.tools?.read_repo_file as
            | { execute?: (args: Record<string, unknown>, opts: { toolCallId: string }) => Promise<string> }
            | undefined
          if (!readRepoFile?.execute) {
            throw new Error('read_repo_file tool not found')
          }
          const result = await readRepoFile.execute({ path: 'src/App.tsx' }, { toolCallId: 'repo-1' })
          expect(result).toContain('export default function App')
          controller.enqueue({ type: 'text-end', id: 'txt-1' })
          await options.onFinish?.({
            usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
          })
          controller.close()
        },
      })
      return { fullStream }
    })

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.2',
          api_key: 'openai-key',
          github_pat: 'ghp_test_token',
          activeRepo: { owner: 'octo', name: 'cloudchat', default_branch: 'main' },
          repo_file_tree: ['src/App.tsx'],
          repo_file_cache: { 'src/App.tsx': 'export default function App() { return null }' },
          messages: [{ role: 'user', content: 'Analyze the repo.' }],
        }),
      })

      expect(response.ok).toBe(true)
      const body = await response.text()
      // Legacy server_tool_event channel still works after the fix.
      expect(body).toContain('"type":"repo_file_read"')
      expect(body).toContain('"path":"src/App.tsx"')
      // New tool_call_* synthesis for repo tools as well.
      expect(body).toContain('"type":"tool_call_begin"')
      expect(body).toContain('"name":"read_repo_file"')
      expect(body).toContain('"type":"tool_call_end"')
      expect(body).toContain('"type":"usage"')
    } finally {
      await server.close()
    }
  })
})
