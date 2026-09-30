// @vitest-environment node
import express from 'express'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerHermesAdminRoute } from '../routes/hermes-admin'

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

describe('Hermes admin route', () => {
  const actualFetch = global.fetch

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('forwards the active Hermes profile to bridge workspace requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/hermes/workspace/overview')) {
        return actualFetch(input, init)
      }

      const headers = init?.headers as Record<string, string> ?? {}
      expect(headers['X-Hermes-Profile']).toBe('agent-two')

      return new Response(JSON.stringify({
        hermes_home: '/Users/test/.hermes/profiles/agent-two',
        session_source: { kind: 'sqlite', path: '/tmp/state.db', available: true },
        cron_backend: 'bridge-local',
        counts: {
          tracked_sessions: 1,
          messages: 2,
          input_tokens: 3,
          output_tokens: 4,
          live_sessions: 0,
          cron_jobs: 0,
          skills: 1,
        },
        last_session_started_at: null,
        files: [],
        top_models: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/api/hermes/workspace/overview`, {
        headers: { 'X-Hermes-Profile': 'agent-two' },
      })
      const data = await response.json()

      expect(response.ok).toBe(true)
      expect(data.hermes_home).toContain('/profiles/agent-two')
    } finally {
      await server.close()
    }
  })

  it('forwards the active Hermes profile to skills hub requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/hermes/workspace/skills/hub')) {
        return actualFetch(input, init)
      }

      const headers = init?.headers as Record<string, string> ?? {}
      expect(headers['X-Hermes-Profile']).toBe('agent-two')

      return new Response(JSON.stringify({
        skills: [
          {
            name: 'duckduckgo-search',
            description: 'Search skill',
            category: 'research',
            source: 'optional',
            installed: false,
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/api/hermes/workspace/skills/hub`, {
        headers: { 'X-Hermes-Profile': 'agent-two' },
      })
      const data = await response.json()

      expect(response.ok).toBe(true)
      expect(data.skills).toHaveLength(1)
      expect(data.skills[0]?.name).toBe('duckduckgo-search')
    } finally {
      await server.close()
    }
  })

  it('falls back to default when no X-Hermes-Profile header is sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/hermes/workspace/overview')) {
        return actualFetch(input, init)
      }

      const headers = init?.headers as Record<string, string> ?? {}
      expect(headers['X-Hermes-Profile']).toBe('default')

      return new Response(JSON.stringify({
        hermes_home: '/Users/test/.hermes',
        session_source: { kind: 'sqlite', path: '/tmp/state.db', available: true },
        cron_backend: 'bridge-local',
        counts: {
          tracked_sessions: 0,
          messages: 0,
          input_tokens: 0,
          output_tokens: 0,
          live_sessions: 0,
          cron_jobs: 0,
          skills: 0,
        },
        last_session_started_at: null,
        files: [],
        top_models: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/api/hermes/workspace/overview`)
      expect(response.ok).toBe(true)
    } finally {
      await server.close()
    }
  })

  // These two used to assert the legacy `{ error: "<string>" }` shape was passed
  // through verbatim. Phase 1.4 replaced that: every bridge failure now leaves as
  // the contract envelope, whatever the bridge actually sent, so the UI can switch
  // on `code` instead of pattern-matching a message. The status is still mirrored.
  it('wraps a legacy JSON bridge error in the contract envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/hermes/workspace/overview')) {
        return actualFetch(input, init)
      }

      return new Response(JSON.stringify({ error: 'Bridge workspace failed' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/api/hermes/workspace/overview`)
      const data = await response.json()

      expect(response.status).toBe(502)
      expect(data.error.code).toBe('PROVIDER_ERROR')
      expect(data.error.message).toBe('Bridge workspace failed')
      expect(data.error.retryable).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('wraps a plain-text bridge error in the contract envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/hermes/workspace/overview')) {
        return actualFetch(input, init)
      }

      return new Response('Bridge exploded badly', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/api/hermes/workspace/overview`)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error.code).toBe('PROVIDER_ERROR')
      expect(data.error.message).toBe('Bridge exploded badly')
    } finally {
      await server.close()
    }
  })

  // ─── Local-only gate for destructive ops ───────────────────────────────────

  function makeFakeRes() {
    const res: Record<string, unknown> & {
      statusCode: number
      body?: unknown
      status: (code: number) => typeof res
      json: (body: unknown) => typeof res
      send: (body: unknown) => typeof res
      type: () => typeof res
      setHeader: () => typeof res
      writeHead: () => typeof res
      write: () => boolean
      end: () => typeof res
    } = {
      statusCode: 200,
      status(code) {
        res.statusCode = code
        return res
      },
      json(body) {
        res.body = body
        return res
      },
      send(body) {
        res.body = body
        return res
      },
      type() {
        return res
      },
      setHeader() {
        return res
      },
      writeHead() {
        return res
      },
      write() {
        return true
      },
      end() {
        return res
      },
    }
    return res
  }

  function makeFakeReq(remoteAddress: string) {
    return {
      method: 'POST',
      url: '/api/hermes/kanban/swarm/',
      originalUrl: '/api/hermes/kanban/swarm/',
      headers: {},
      query: {},
      params: {},
      body: {},
      socket: { remoteAddress },
    }
  }

  /**
   * Drive a request through the middleware chain. The gate/route send the
   * response without calling next(), so resolve on a timer tick instead of
   * the router's done callback.
   */
  function handle(app: express.Express, req: ReturnType<typeof makeFakeReq>, res: ReturnType<typeof makeFakeRes>) {
    return new Promise<void>((resolve) => {
      // app.handle exists at runtime but is not declared in the express types.
      (app as unknown as { handle: (r: unknown, s: unknown, cb: () => void) => void })
        .handle(req, res, () => resolve())
      setTimeout(resolve, 0)
    })
  }

  it('blocks trailing-slash destructive ops from non-local clients', async () => {
    // Express 4 (strict routing off) matches `/api/hermes/kanban/swarm/`
    // against the swarm route with a trailing slash in req.path — the gate
    // must normalize it or the exact-match set is bypassed.
    const app = express()
    registerHermesAdminRoute(app)

    const res = makeFakeRes()
    await handle(app, makeFakeReq('192.168.1.50'), res)

    expect(res.statusCode).toBe(403)
    expect((res.body as { error?: string }).error).toContain('only available from the local app')
  })

  it('allows trailing-slash destructive ops from loopback clients', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    const app = express()
    registerHermesAdminRoute(app)

    const res = makeFakeRes()
    await handle(app, makeFakeReq('127.0.0.1'), res)

    expect(res.statusCode).toBe(200)
  })

  it('proxies /api/hermes/providers to the bridge /v1/providers catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/hermes/providers')) {
        return actualFetch(input, init)
      }

      // The proxy must target the bridge's OpenAI-style /v1/providers endpoint.
      expect(url).toContain('/v1/providers')

      return new Response(JSON.stringify({
        object: 'list',
        default_provider: 'openrouter',
        data: [
          { id: 'anthropic', name: 'Anthropic', base_url: 'https://api.anthropic.com', is_aggregator: false, credentialed: false, models: ['claude-opus-4-8'] },
          { id: 'openrouter', name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', is_aggregator: true, credentialed: true, models: ['anthropic/claude-sonnet-4'] },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/api/hermes/providers`)
      const data = await response.json()

      expect(response.ok).toBe(true)
      expect(data.default_provider).toBe('openrouter')
      expect(data.data).toHaveLength(2)
      expect(data.data[0]?.id).toBe('anthropic')
    } finally {
      await server.close()
    }
  })

  it('proxies a synthetic custom CLI provider row and default_provider from the bridge', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/hermes/providers')) {
        return actualFetch(input, init)
      }

      expect(url).toContain('/v1/providers')
      return new Response(JSON.stringify({
        object: 'list',
        default_provider: 'custom:api.bullinf.fun',
        default_model: 'deepseek-v4-flash',
        data: [
          {
            id: 'custom:api.bullinf.fun',
            name: 'api.bullinf.fun',
            base_url: 'https://api.bullinf.fun/v1',
            is_aggregator: true,
            credentialed: true,
            models: ['deepseek-v4-flash', 'mimo-v2.5'],
            default_model: 'deepseek-v4-flash',
          },
          { id: 'openrouter', name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', is_aggregator: true, credentialed: false, models: [] },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/api/hermes/providers`)
      const data = await response.json()

      expect(response.ok).toBe(true)
      expect(data.default_provider).toBe('custom:api.bullinf.fun')
      expect(data.default_model).toBe('deepseek-v4-flash')
      expect(data.data[0]?.id).toBe('custom:api.bullinf.fun')
      expect(data.data[0]?.credentialed).toBe(true)
      expect(data.data[0]?.models).toContain('deepseek-v4-flash')
    } finally {
      await server.close()
    }
  })

})
