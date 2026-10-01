// @vitest-environment node
import express from 'express'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeMocks = vi.hoisted(() => ({ json: vi.fn() }))
vi.mock('../lib/bridge-client', () => ({ bridge: { json: bridgeMocks.json } }))

import { registerNubRoutes } from '../routes/nub'
import { NubClient } from '../lib/nub/client'
import { clearNubAuth, loadNubAuth } from '../lib/nub/store'

const ORIGIN = 'https://maiavm.test'

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown }

/** A fake maiavm: records calls and answers the handful of routes Spark uses. */
function fakeMaiavm(overrides: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const routes: Record<string, (call: Call) => Response> = {
    'POST /api/nub/desktop/auth/start': () =>
      json({ code: 'ABCD-EFGH', telegramUrl: 'https://t.me/nub?start=desk_X', pairingUrl: null, pollInterval: 2 }),
    'GET /api/nub/desktop/auth/poll': () =>
      json({ status: 'ready', desktopToken: 'nub_desk_tok', instance: { id: 'inst_1', publicUrl: 'https://a', status: 'running' } }),
    'POST /api/nub/cli/key': () =>
      json({ rawKey: 'hermes_pk_raw', keyPrefix: 'hermes_pk_R', expiresAt: 1800000000, baseUrl: `${ORIGIN}/api/v1`, models: [{ id: 'glm-5.3-flash' }] }),
    'GET /api/nub/desktop/me': () => json({ instance: { id: 'inst_1', publicUrl: 'https://a', status: 'running' }, gatewayToken: 'gw' }),
    'POST /api/nub/desktop/me': () => json({ ok: true }),
    'POST /api/chat': () => json({ choices: [{ message: { role: 'assistant', content: 'Europe/Lisbon' } }] }),
    ...overrides,
  }
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    const handler = routes[`${call.method} ${call.path}`]
    return handler ? handler(call) : json({ error: 'not found' }, 404)
  })
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

async function serve(fetchImpl: typeof fetch) {
  const app = express()
  app.use(express.json())
  registerNubRoutes(app, (origin) => new NubClient(origin ?? ORIGIN, fetchImpl))
  return await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}

async function signIn(url: string) {
  const start = await (await fetch(`${url}/api/nub/auth/start`, { method: 'POST' })).json()
  return { start, poll: await (await fetch(`${url}/api/nub/auth/poll?code=${start.code}`)).json() }
}

describe('nub routes', () => {
  beforeEach(async () => {
    await clearNubAuth()
    bridgeMocks.json.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('signs in with a nonce-bound device code, keeps the session server-side, and returns the key once', async () => {
    const maiavm = fakeMaiavm()
    const server = await serve(maiavm.fetchImpl)
    try {
      const { start, poll } = await signIn(server.url)

      expect(start).toEqual({ code: 'ABCD-EFGH', telegramUrl: 'https://t.me/nub?start=desk_X', pairingUrl: null, expiresAt: null, pollInterval: 2 })
      const startCall = maiavm.calls[0]
      expect(startCall.headers['user-agent']).toMatch(/^Spark\//)
      const nonce = maiavm.calls[1].headers['x-nub-link-nonce']
      const { createHash } = await import('node:crypto')
      expect((startCall.body as { browserNonceHash: string }).browserNonceHash).toBe(createHash('sha256').update(nonce).digest('hex'))

      expect(poll).toEqual({
        status: 'ready',
        instance: { id: 'inst_1', publicUrl: 'https://a', status: 'running' },
        mcpRegistered: true,
        apiKey: 'hermes_pk_raw',
        keyPrefix: 'hermes_pk_R',
        keyExpiresAt: 1800000000,
        models: ['glm-5.3-flash'],
      })
      expect(maiavm.calls[2]).toMatchObject({ method: 'POST', path: '/api/nub/cli/key', body: { client: 'spark' } })

      const saved = await loadNubAuth()
      expect(saved).toMatchObject({ origin: ORIGIN, desktopToken: 'nub_desk_tok', keyPrefix: 'hermes_pk_R' })
      const [path, init, opts] = bridgeMocks.json.mock.calls[0]
      expect([path, init.method, opts]).toEqual(['/workspace/nub-mcp', 'POST', { timeoutMs: 15_000 }])
      expect(JSON.parse(init.body)).toEqual({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/nub\/mcp$/), token: saved!.mcpToken })

      // The code is single-use.
      expect((await fetch(`${server.url}/api/nub/auth/poll?code=ABCD-EFGH`)).status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('reports status and signs out (revoke on maiavm, forget locally, drop the MCP entry)', async () => {
    const maiavm = fakeMaiavm()
    const server = await serve(maiavm.fetchImpl)
    try {
      expect(await (await fetch(`${server.url}/api/nub/status`)).json()).toEqual({ linked: false })
      await signIn(server.url)

      expect(await (await fetch(`${server.url}/api/nub/status`)).json()).toEqual({
        linked: true,
        reachable: true,
        origin: ORIGIN,
        instance: { id: 'inst_1', publicUrl: 'https://a', status: 'running' },
        keyPrefix: 'hermes_pk_R',
        keyExpiresAt: 1800000000,
      })

      const out = await (await fetch(`${server.url}/api/nub/logout`, { method: 'POST' })).json()
      expect(out).toEqual({ ok: true, revoked: true })
      expect(maiavm.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/nub/desktop/me', body: { action: 'revoke' } })
      expect(await loadNubAuth()).toBeNull()
      expect(bridgeMocks.json).toHaveBeenLastCalledWith('/workspace/nub-mcp', { method: 'DELETE' }, { timeoutMs: 15_000 })
    } finally {
      await server.close()
    }
  })

  it('treats a revoked session as signed out', async () => {
    const maiavm = fakeMaiavm({
      'GET /api/nub/desktop/me': () => new Response(JSON.stringify({ error: 'revoked' }), { status: 401 }),
    })
    const server = await serve(maiavm.fetchImpl)
    try {
      await signIn(server.url)
      expect(await (await fetch(`${server.url}/api/nub/status`)).json()).toEqual({ linked: false, expired: true })
    } finally {
      await server.close()
    }
  })

  it('serves MCP only to the bearer Hermes was given, and asks the nub agent', async () => {
    const maiavm = fakeMaiavm()
    vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith(ORIGIN) ? maiavm.fetchImpl(input, init) : globalThis.fetch(input, init)) as typeof fetch)
    const realFetch = (await import('undici')).fetch as unknown as typeof fetch
    const server = await serve(maiavm.fetchImpl)
    try {
      const startRes = await realFetch(`${server.url}/api/nub/auth/start`, { method: 'POST' })
      const { code } = (await startRes.json()) as { code: string }
      await realFetch(`${server.url}/api/nub/auth/poll?code=${code}`)
      const token = (await loadNubAuth())!.mcpToken
      const call = (auth: string | null, body: unknown) =>
        realFetch(`${server.url}/api/nub/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
          body: JSON.stringify(body),
        })

      expect((await call(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401)
      expect((await call('Bearer wrong', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401)

      const list = (await (await call(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as {
        result: { tools: Array<{ name: string }> }
      }
      expect(list.result.tools.map((tool) => tool.name)).toEqual(['nub_agent_ask', 'nub_agent_status'])

      const ask = await (
        await call(`Bearer ${token}`, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'nub_agent_ask', arguments: { message: 'my timezone?' } },
        })
      ).json()
      expect(ask).toEqual({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: 'Europe/Lisbon' }], isError: false },
      })
      expect(maiavm.calls.at(-1)).toMatchObject({
        path: '/api/chat',
        body: { instanceId: 'inst_1', message: 'my timezone?', sessionId: 'spark-desktop', stream: false },
      })

      const notification = await call(`Bearer ${token}`, { jsonrpc: '2.0', method: 'notifications/initialized' })
      expect(notification.status).toBe(202)
    } finally {
      await server.close()
    }
  })
})
