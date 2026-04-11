// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCloudChatServerRunning } from './server'

describe('isCloudChatServerRunning', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts a server that advertises the required chat-store routes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      routes: [
        '/functions/v1/chat',
        '/functions/v1/chat-store/conversations',
        '/functions/v1/chat-store/messages',
        '/functions/v1/validate-key',
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(isCloudChatServerRunning(3001)).resolves.toBe(true)
  })

  it('rejects a server that is missing required chat-store routes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      routes: [
        '/functions/v1/chat',
        '/functions/v1/github-integration',
        '/functions/v1/validate-key',
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(isCloudChatServerRunning(3001)).resolves.toBe(false)
  })
})
