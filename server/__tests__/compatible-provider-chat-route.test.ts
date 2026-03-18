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

describe('compatible provider chat route', () => {
  const actualFetch = global.fetch

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rewraps MiniMax SSE into an AI SDK data stream', async () => {
    const upstreamUrls: string[] = []
    const bridgeStream = [
      'data: {"id":"mm-1","choices":[{"index":0,"delta":{"role":"","content":"Hello from MiniMax"}}]}\n\n',
      'data: {"id":"mm-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      upstreamUrls.push(url)
      return new Response(bridgeStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'minimax',
          model: 'MiniMax-M2.5',
          api_key: 'minimax-key',
          messages: [
            { role: 'user', content: 'Say hello.' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(response.headers.get('x-vercel-ai-data-stream')).toBe('v1')
      expect(body).toContain('0:"Hello from MiniMax"')
      expect(body).toContain('finishReason":"stop"')
      expect(upstreamUrls).toContain('https://api.minimax.io/v1/chat/completions')
    } finally {
      await server.close()
    }
  })

  it('rewraps Kimi Coding SSE into an AI SDK data stream', async () => {
    const upstreamUrls: string[] = []
    const upstreamStream = [
      'data: {"id":"kimi-1","choices":[{"index":0,"delta":{"content":"Kimi coding reply"}}]}\n\n',
      'data: {"id":"kimi-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":4,"total_tokens":9}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/functions/v1/chat')) {
        return actualFetch(input, init)
      }

      upstreamUrls.push(url)
      return new Response(upstreamStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      })
    }))

    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'kimi-coding',
          model: 'kimi-for-coding',
          api_key: 'kimi-key',
          messages: [
            { role: 'user', content: 'Write a summary.' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(response.headers.get('x-vercel-ai-data-stream')).toBe('v1')
      expect(body).toContain('0:"Kimi coding reply"')
      expect(body).toContain('finishReason":"stop"')
      expect(upstreamUrls).toContain('https://api.kimi.com/coding/v1/chat/completions')
    } finally {
      await server.close()
    }
  })

  it('keeps compatible providers on the tool-capable streamText path when repo tools are available', async () => {
    const { shouldDirectProxyCompatibleProvider } = await import('../index')

    expect(shouldDirectProxyCompatibleProvider('minimax', false)).toBe(true)
    expect(shouldDirectProxyCompatibleProvider('kimi-coding', false)).toBe(true)
    expect(shouldDirectProxyCompatibleProvider('minimax', true)).toBe(false)
    expect(shouldDirectProxyCompatibleProvider('kimi-coding', true)).toBe(false)
    expect(shouldDirectProxyCompatibleProvider('openrouter', true)).toBe(false)
  })
})
