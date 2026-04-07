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

describe('Hermes validate-key route', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('returns the curated Hermes model shortlist after the bridge validates', async () => {
    const server = await createTestServer()
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      if (url.startsWith(server.url)) {
        return realFetch(input, init)
      }

      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [
            { id: 'random/model-from-bridge' },
          ],
        }),
      } as unknown as Response)
    }))

    try {
      const response = await fetch(`${server.url}/functions/v1/validate-key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'hermes',
          api_key: 'openrouter-key',
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body).toEqual({
        valid: true,
        defaultModel: 'anthropic/claude-sonnet-4',
        models: [
          'anthropic/claude-sonnet-4',
          'google/gemini-3.1-flash-lite-preview',
          'MiniMax-M2.7',
          'MiniMax-M2.7-highspeed',
          'deepseek/deepseek-v3.2',
          'meta-llama/llama-4-maverick',
          'openai/gpt-4.1-mini',
          'google/gemini-2.5-flash',
          'deepseek/deepseek-chat-v3.1',
          'meta-llama/llama-4-scout',
        ],
      })
    } finally {
      await server.close()
    }
  })
})
