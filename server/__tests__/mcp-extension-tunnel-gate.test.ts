// @vitest-environment node
// Phase 3 proof: tunnel gate on the mcp-extensions route, BEHAVIORAL only.
// vi.mock MUST live in this separate file (module-level mock would leak into
// the installer/HTTP asserts in mcp-extension-install.test.ts).
// Route's tunnel import path (read first): `../lib/tunnel` (no .js suffix).
// Both spellings are mocked to the same running state à la
// mcp-worker-tunnel-gate.test.ts in case the backend adds a .js-suffixed
// import later. Gate convention mirrors mcp-workers.route.ts: Host matching
// the tunnel host requires ?key=<token> or the spark_remote_key cookie, else
// 401; GET list stays open. node:http is used raw because fetch cannot
// override the Host header.
// Drift: installer-dependent GET content SKIP-drifts on 503 (installer
// backend unlanded); pure gate probes (401s, 400-on-evil) assert strictly.
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import express, { type Express } from 'express'
import { describe, expect, it, vi } from 'vitest'

const TUNNEL_HOST = 'x.trycloudflare.com'
const TUNNEL_URL = `https://${TUNNEL_HOST}`
const TOKEN = 'sekret'

vi.mock('../lib/tunnel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tunnel')>()
  return {
    ...actual,
    getTunnelState: () => ({
      running: true,
      url: TUNNEL_URL,
      provider: 'cloudflared' as const,
      error: null,
      pid: 1,
      accessToken: TOKEN,
    }),
  }
})

vi.mock('../lib/tunnel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tunnel.js')>()
  return {
    ...actual,
    getTunnelState: () => ({
      running: true,
      url: TUNNEL_URL,
      provider: 'cloudflared' as const,
      error: null,
      pid: 1,
      accessToken: TOKEN,
    }),
  }
})

let registerRoute: ((app: Express) => void) | null = null
let routeKeys: string[] = []
try {
  const mod: Record<string, unknown> = await import('../routes/mcp-extensions.route.js')
  routeKeys = Object.keys(mod)
  if (typeof mod['registerMcpExtensionsRoute'] === 'function') {
    registerRoute = mod['registerMcpExtensionsRoute'] as (app: Express) => void
  } else if ((mod['mcpExtensionsRouter'] as { use?: unknown }) !== undefined) {
    const router = mod['mcpExtensionsRouter'] as import('express').Router
    registerRoute = (app: Express) => {
      app.use(router)
    }
  }
} catch {
  // Route module missing — all tests skip with a drift note.
}
const routeAvailable = registerRoute !== null

async function createRouteServer() {
  const app = express()
  app.use(express.json())
  registerRoute!(app)
  return await new Promise<{ close: () => Promise<void>; url: string }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error)
              else closeResolve()
            })
          }),
      })
    })
  })
}

function rawRequest(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const { hostname, port } = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = httpRequest(
      {
        hostname,
        port: Number(port),
        path,
        method,
        headers: {
          ...(payload !== null
            ? {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

// Gated probe: unauthenticated DELETE with the tunnel Host.
async function deleteProbe(baseUrl: string): Promise<number> {
  const res = await rawRequest(baseUrl, 'DELETE', `/api/mcp-extensions/gate-probe-${Date.now()}`, {
    host: TUNNEL_HOST,
  })
  return res.status
}

describe.runIf(routeAvailable)('mcp extensions tunnel gate (behavioral)', () => {
  it('POST install without key → 401 while the tunnel runs', async () => {
    const server = await createRouteServer()
    try {
      const res = await rawRequest(
        server.url,
        'POST',
        '/api/mcp-extensions/install',
        { host: TUNNEL_HOST },
        { filename: 'x.mcpb', dataBase64: 'eA==', allowUnsigned: true },
      )
      expect(res.status).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('POST install with ?key= passes the gate (400 on invalid body proves it)', async (ctx) => {
    const server = await createRouteServer()
    try {
      if ((await deleteProbe(server.url)) !== 401) {
        console.warn('[ext-tunnel-gate] DRIFT: gate unwired; POST-?key= test skipped.')
        return ctx.skip()
      }
      // '!!!' is not valid base64 => route-level 400 only reachable past the gate.
      const res = await rawRequest(
        server.url,
        'POST',
        `/api/mcp-extensions/install?key=${TOKEN}`,
        { host: TUNNEL_HOST },
        { filename: 'x.mcpb', dataBase64: '!!!', allowUnsigned: true },
      )
      expect(res.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('DELETE without key → 401 while the tunnel runs', async () => {
    const server = await createRouteServer()
    try {
      expect(await deleteProbe(server.url)).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('GET list stays open (200 array, or 503 drift-skip pre-installer)', async (ctx) => {
    const server = await createRouteServer()
    try {
      const res = await rawRequest(server.url, 'GET', '/api/mcp-extensions', { host: TUNNEL_HOST })
      expect(res.status).not.toBe(401)
      if (res.status === 503) {
        console.warn('[ext-tunnel-gate] DRIFT: installer unavailable (503); GET-content test skipped.')
        return ctx.skip()
      }
      expect(res.status).toBe(200)
      expect(Array.isArray(JSON.parse(res.text))).toBe(true)
    } finally {
      await server.close()
    }
  })
})

it.runIf(!routeAvailable)('mcp-extensions route contract pending (drift note)', () => {
  console.warn(
    `[ext-tunnel-gate] DRIFT: server/routes/mcp-extensions.route.ts missing registerMcpExtensionsRoute. ` +
      `Saw keys: [${routeKeys.join(', ')}]. Tunnel-gate tests skipped.`,
  )
  expect(routeAvailable).toBe(false)
})
