// @vitest-environment node
import type { AddressInfo } from 'net'
import { describe, expect, it } from 'vitest'

async function createTestServer() {
  const { createApp } = await import('../index')
  const app = createApp()

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

describe('team list routes', () => {
  // The literal /active and /completed routes must win over /:id — otherwise
  // the Teams sidebar gets a 404 because "active" is matched as a team id.
  it('lists active teams without being shadowed by /:id', async () => {
    const server = await createTestServer()
    try {
      const res = await fetch(`${server.url}/api/hermes/team/active`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { teams: unknown[]; total: number }
      expect(Array.isArray(body.teams)).toBe(true)
      expect(typeof body.total).toBe('number')
    } finally {
      await server.close()
    }
  })

  it('lists completed teams without being shadowed by /:id', async () => {
    const server = await createTestServer()
    try {
      const res = await fetch(`${server.url}/api/hermes/team/completed`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { teams: unknown[] }
      expect(Array.isArray(body.teams)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('still 404s for an unknown team id', async () => {
    const server = await createTestServer()
    try {
      const res = await fetch(`${server.url}/api/hermes/team/does-not-exist`)
      expect(res.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
