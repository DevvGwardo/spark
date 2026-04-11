// @vitest-environment node
import type { AddressInfo } from 'net'
import { describe, expect, it } from 'vitest'

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

describe('health route', () => {
  it('advertises the chat-store routes needed by the Electron reuse check', async () => {
    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/health`)
      const body = await response.json() as {
        ok: boolean
        routes: string[]
      }

      expect(response.ok).toBe(true)
      expect(body.ok).toBe(true)
      expect(body.routes).toContain('/functions/v1/chat-store/conversations')
      expect(body.routes).toContain('/functions/v1/chat-store/messages')
    } finally {
      await server.close()
    }
  })
})
