// @vitest-environment node
import type { AddressInfo } from 'net'
import { describe, expect, it } from 'vitest'

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

describe('remote access endpoint gating', () => {
  // The Electron desktop app relies on serveFrontend turning these on so
  // non-technical users get the QR + tunnel without running npm.
  it('exposes /api/remote/info when the frontend is served', async () => {
    const server = await createTestServer({ serveFrontend: true })
    try {
      const res = await fetch(`${server.url}/api/remote/info`)
      expect(res.ok).toBe(true)
      const body = (await res.json()) as { url: string; qrSvg: string }
      expect(typeof body.url).toBe('string')
      expect(body.qrSvg).toContain('data:image/svg+xml')
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
})
