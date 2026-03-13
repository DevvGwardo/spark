import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openclawMocks = vi.hoisted(() => ({
  getOpenClawModels: vi.fn(),
  runOpenClawTurn: vi.fn(),
}))

vi.mock('../openclaw', () => ({
  getOpenClawModels: openclawMocks.getOpenClawModels,
  runOpenClawTurn: openclawMocks.runOpenClawTurn,
}))

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

describe('OpenClaw provider chat route', () => {
  beforeEach(() => {
    openclawMocks.runOpenClawTurn.mockResolvedValue({
      text: 'ok',
      model: 'kimi-coding/k2p5',
      usage: {
        input: 12,
        output: 2,
        total: 14,
      },
      durationMs: 1500,
    })

    openclawMocks.getOpenClawModels.mockResolvedValue({
      defaultModel: 'kimi-coding/k2p5',
      models: ['kimi-coding/k2p5', 'google/gemini-2.5-pro'],
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('routes chat requests through OpenClaw and emits an AI SDK data stream', async () => {
    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'openclaw',
          model: 'default',
          conversation_id: 'conv-123',
          system_prompt: 'Be concise.',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
          },
          repo_edit_intent: false,
          repo_file_tree: ['src/App.tsx', 'src/hooks/useChat.ts'],
          messages: [
            { role: 'user', content: 'Reply with exactly: ok' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(response.headers.get('x-vercel-ai-data-stream')).toBe('v1')
      expect(body).toContain('0:"ok"')
      expect(body).toContain('finishReason')
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Reply with exactly: ok',
          model: 'default',
          sessionId: 'conv-123',
        }),
      )
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('You are working on the GitHub repository octo/cloudchat.'),
        }),
      )
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('read-only repository help'),
        }),
      )
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('src/App.tsx'),
        }),
      )
    } finally {
      await server.close()
    }
  })

  it('validates OpenClaw without requiring an API key', async () => {
    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/validate-key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'openclaw',
          api_key: '',
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body).toEqual({
        valid: true,
        defaultModel: 'kimi-coding/k2p5',
        models: ['kimi-coding/k2p5', 'google/gemini-2.5-pro'],
      })
      expect(openclawMocks.getOpenClawModels).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })
})
