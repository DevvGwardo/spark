// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCloudChatServerRunning } from './server'
import { HEALTH_ROUTES } from '../server/index'

describe('isCloudChatServerRunning', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts a server that advertises the current API surface', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      routes: HEALTH_ROUTES,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(isCloudChatServerRunning(3001)).resolves.toBe(true)
  })

  it('rejects a server that is missing the Hermes profiles route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      routes: HEALTH_ROUTES.filter((route) => route !== '/api/hermes/profiles'),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(isCloudChatServerRunning(3001)).resolves.toBe(false)
  })
})
