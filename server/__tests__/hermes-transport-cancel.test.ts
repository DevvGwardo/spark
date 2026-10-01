// @vitest-environment node
// Hardening spec 4.4 on the Node side of the Hermes chat path:
//  - desktop chat requests with a conversation ask the bridge for
//    `background: true`, keeping today's persist-on-disconnect behavior explicit;
//  - Stop (POST /api/hermes/chat/cancel) reaches the bridge's any-transport
//    cancel, not just the gateway-runs one.
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const providerConfigMocks = vi.hoisted(() => ({
  createProviderModel: vi.fn(),
}))

const repoCloneMocks = vi.hoisted(() => ({
  ensureRepoClone: vi.fn(),
  getManagedRepoClone: vi.fn(),
}))

vi.mock('../provider-config', async () => {
  const actual = await vi.importActual<typeof import('../provider-config')>('../provider-config')
  return { ...actual, createProviderModel: providerConfigMocks.createProviderModel }
})

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
  return await new Promise<{ close: () => Promise<void>; url: string }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections?.()
            server.close((error) => (error ? fail(error) : done()))
          }),
      })
    })
  })
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
}

/** A bridge SSE stream that sends one chunk and then stays open until aborted. */
function openBridgeStream(signal: AbortSignal | null | undefined): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"id":"chatcmpl-x","choices":[{"index":0,"delta":{"content":"working"}}]}\n\n',
      ))
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('aborted', 'AbortError'))
        } catch {
          // already closed
        }
      })
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('Hermes chat cancel and background mode (spec 4.4)', () => {
  const actualFetch = global.fetch
  let bridgeBodies: Array<Record<string, unknown>>
  let cancelBodies: Array<{ url: string; body: Record<string, unknown> }>

  beforeEach(() => {
    providerConfigMocks.createProviderModel.mockReturnValue({ id: 'hermes-model' })
    repoCloneMocks.ensureRepoClone.mockRejectedValue(new Error('clone unavailable'))
    bridgeBodies = []
    cancelBodies = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      if (url.includes('/functions/v1/chat') || url.includes('/api/hermes/chat/cancel')) {
        return actualFetch(input, init)
      }
      if (url.includes('/chat/completions')) {
        bridgeBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return openBridgeStream(init?.signal)
      }
      if (url.includes('/v1/chat/cancel') || url.includes('/v1/runs/cancel')) {
        cancelBodies.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(JSON.stringify({ cancelled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected upstream fetch: ${url}`)
    }))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  async function startChat(serverUrl: string, conversationId?: string) {
    const controller = new AbortController()
    const response = await actualFetch(`${serverUrl}/functions/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        provider: 'hermes',
        model: 'meta-llama/llama-4-maverick',
        api_key: 'or-key',
        ...(conversationId ? { conversation_id: conversationId } : {}),
        messages: [{ role: 'user', content: 'Do a long thing.' }],
      }),
    })
    expect(response.ok).toBe(true)
    const reader = response.body!.getReader()
    // Wait for the first streamed chunk so the run is registered.
    await reader.read()
    return { controller, reader }
  }

  it('asks the bridge for background mode when the turn can be persisted', async () => {
    const server = await createTestServer()
    try {
      const { controller } = await startChat(server.url, 'conv-bg')
      expect(bridgeBodies[0]?.background).toBe(true)
      expect(bridgeBodies[0]?.conversation_id).toBe('conv-bg')
      controller.abort()
    } finally {
      await server.close()
    }
  })

  it('sends no background flag without a conversation (disconnect then cancels on the bridge)', async () => {
    const server = await createTestServer()
    try {
      const { controller } = await startChat(server.url)
      expect(bridgeBodies[0]).not.toHaveProperty('background')
      controller.abort()
    } finally {
      await server.close()
    }
  })

  it('Stop cancels the turn on the bridge for an agent-loop run, not only for gateway runs', async () => {
    const server = await createTestServer()
    try {
      const { controller } = await startChat(server.url, 'conv-stop')
      const res = await actualFetch(`${server.url}/api/hermes/chat/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'conv-stop' }),
      })
      expect(await res.json()).toEqual({ cancelled: true })
      await vi.waitFor(() => expect(cancelBodies).toHaveLength(1))
      expect(cancelBodies[0]?.url).toContain('/v1/chat/cancel')
      expect(cancelBodies[0]?.body).toEqual({ conversation_id: 'conv-stop' })
      controller.abort()
    } finally {
      await server.close()
    }
  })

  it('a newer turn on the same conversation cancels the older one on the bridge first', async () => {
    const server = await createTestServer()
    try {
      const first = await startChat(server.url, 'conv-supersede')
      const second = await startChat(server.url, 'conv-supersede')
      expect(cancelBodies.map((c) => c.body)).toEqual([{ conversation_id: 'conv-supersede' }])
      expect(bridgeBodies).toHaveLength(2)
      first.controller.abort()
      second.controller.abort()
    } finally {
      await server.close()
    }
  })
})
