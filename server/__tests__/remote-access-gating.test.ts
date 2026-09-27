// @vitest-environment node
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function createTestServer(opts?: { serveFrontend?: boolean }) {
  const { createApp } = await import('../index')
  const app = createApp(opts)

  return await new Promise<{ close: () => Promise<void>; url: string }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()))
          }),
      })
    })
  })
}

interface RemoteInfoBody {
  url: string
  localUrl: string
  qrSvg: string
  setupCommand: string
  tailscale: {
    installed: boolean
    running: boolean
    serveConfigured: boolean
    hostname: string | null
  }
}

describe('remote access endpoint gating', () => {
  // The Electron desktop app relies on serveFrontend turning these on so
  // non-technical users get the QR + setup command without running npm.
  it('exposes /api/remote/info when the frontend is served', async () => {
    const server = await createTestServer({ serveFrontend: true })
    try {
      const res = await fetch(`${server.url}/api/remote/info`)
      expect(res.ok).toBe(true)
      const body = (await res.json()) as RemoteInfoBody

      expect(typeof body.url).toBe('string')
      expect(typeof body.localUrl).toBe('string')
      expect(typeof body.setupCommand).toBe('string')

      // The command must name the port the server actually reports, so it is
      // copy-pasteable as-is.
      const reportedPort = new URL(body.localUrl).port
      expect(body.setupCommand).toContain(`http://localhost:${reportedPort}`)
      expect(body.setupCommand).toContain('tailscale serve')
      // Never 443 — that is serve's default and may already be mapped.
      expect(body.setupCommand).not.toContain('--https=443')

      // Detection state is machine-dependent; assert the shape and the
      // invariant that ties it together.
      expect(typeof body.tailscale.installed).toBe('boolean')
      expect(typeof body.tailscale.running).toBe('boolean')
      expect(typeof body.tailscale.serveConfigured).toBe('boolean')

      // A QR is only produced once the tailnet URL is real. Encoding a
      // localhost URL would scan into a dead link on the phone.
      if (body.tailscale.serveConfigured) {
        expect(body.qrSvg).toContain('data:image/svg+xml')
      } else {
        expect(body.qrSvg).toBe('')
        expect(body.url).toBe(body.localUrl)
      }
    } finally {
      await server.close()
    }
  })

  it('does not register /api/remote/info in API-only mode', async () => {
    const server = await createTestServer()
    try {
      const res = await fetch(`${server.url}/api/remote/info`)
      expect(res.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('serves the /remote page only when the frontend is served', async () => {
    const withFrontend = await createTestServer({ serveFrontend: true })
    try {
      const res = await fetch(`${withFrontend.url}/remote`)
      expect(res.ok).toBe(true)
      expect(await res.text()).toContain('Spark Remote')
    } finally {
      await withFrontend.close()
    }

    const apiOnly = await createTestServer()
    try {
      const res = await fetch(`${apiOnly.url}/remote`)
      expect(res.status).toBe(404)
    } finally {
      await apiOnly.close()
    }
  })
})

describe('merged hermes approval route (B3)', () => {
  const actualFetch = globalThis.fetch

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Capture what the merged route forwards to the bridge. Stubbing fetch is
  // deterministic: without it the acp-* cases would depend on whether a
  // bridge happens to be listening on :3002 in this environment.
  let forwardedBodies: Array<{ url: string; body: unknown }>

  function stubBridgeOk() {
    forwardedBodies = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/v1/approvals/')) {
          let body: unknown = null
          try {
            body = init?.body ? JSON.parse(String(init.body)) : null
          } catch {
            // keep null
          }
          forwardedBodies.push({ url, body })
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return actualFetch(input, init)
      }),
    )
  }

  async function postApproval(url: string, id: string, body: unknown) {
    return actualFetch(`${url}/api/hermes/approvals/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('accepts { option_id } for acp-* ids (the shape postAcpApproval sends)', async () => {
    stubBridgeOk()
    const server = await createTestServer()
    try {
      const res = await postApproval(server.url, 'acp-test-1', { option_id: 'allow_once' })
      // Before the merge this was always 400: chat.ts won the route and
      // demanded a `decision` the caller never sent.
      expect(res.status).toBe(200)
      expect(forwardedBodies).toHaveLength(1)
      expect(forwardedBodies[0]?.body).toEqual({ option_id: 'allow_once' })
    } finally {
      await server.close()
    }
  })

  it('accepts { decision } for acp-* ids and translates it to option_id', async () => {
    stubBridgeOk()
    const server = await createTestServer()
    try {
      const res = await postApproval(server.url, 'acp-test-2', { decision: 'approved' })
      expect(res.status).toBe(200)
      expect(forwardedBodies).toHaveLength(1)
      expect(forwardedBodies[0]?.body).toEqual({ option_id: 'allow_once' })
    } finally {
      await server.close()
    }
  })

  it('rejects a body with neither decision nor option_id', async () => {
    stubBridgeOk()
    const server = await createTestServer()
    try {
      const res = await postApproval(server.url, 'acp-test-3', {})
      expect(res.status).toBe(400)
      expect(forwardedBodies).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('rejects out-of-range decision and option_id values', async () => {
    stubBridgeOk()
    const server = await createTestServer()
    try {
      const badDecision = await postApproval(server.url, 'acp-test-4', { decision: 'bogus' })
      expect(badDecision.status).toBe(400)
      const badOption = await postApproval(server.url, 'acp-test-5', { option_id: 'bogus' })
      expect(badOption.status).toBe(400)
      expect(forwardedBodies).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('resolves unknown engine-local ids as 404, not a shadowed 400', async () => {
    stubBridgeOk()
    const server = await createTestServer()
    try {
      const res = await postApproval(server.url, 'local-unknown-id', { decision: 'approved' })
      expect(res.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
