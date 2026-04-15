// @vitest-environment node
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hermesProfileMocks = vi.hoisted(() => ({
  getActiveProfileName: vi.fn(() => 'agent-two'),
}))

vi.mock('../lib/hermes-profiles', async () => {
  const actual = await vi.importActual<typeof import('../lib/hermes-profiles')>('../lib/hermes-profiles')
  return {
    ...actual,
    getActiveProfileName: hermesProfileMocks.getActiveProfileName,
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
      const response = await actualFetch(`${server.url}/api/hermes/workspace/overview`)
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
      const response = await actualFetch(`${server.url}/api/hermes/workspace/skills/hub`)
      const data = await response.json()

      expect(response.ok).toBe(true)
      expect(data.skills).toHaveLength(1)
      expect(data.skills[0]?.name).toBe('duckduckgo-search')
    } finally {
      await server.close()
    }
  })
})
