// @vitest-environment node
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

  it('preserves JSON bridge errors from admin proxy routes', async () => {
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
      expect(data).toEqual({ error: 'Bridge workspace failed' })
    } finally {
      await server.close()
    }
  })

  it('preserves plain-text bridge errors from admin proxy routes', async () => {
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
      expect(data).toEqual({ error: 'Bridge exploded badly' })
    } finally {
      await server.close()
    }
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
})
