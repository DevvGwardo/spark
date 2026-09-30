// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AddressInfo } from 'net'
import { createServer, type Server } from 'node:http'
import { Writable } from 'node:stream'

const readiness = vi.hoisted(() => ({ reset: null as null | (() => void) }))

vi.mock('../lib/hermes-bridge-url', () => ({
  getHermesBridgeRoot: () => process.env.HERMES_BRIDGE_URL || 'http://127.0.0.1:3002',
}))

vi.mock('../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  bridge,
  bridgeErrorEnvelope,
  invalidateBridgeReadCache,
  isLikelyBridgeConnectionError,
  resetBridgeReadiness,
  setBridgeCacheEnabled,
} from '../lib/bridge-client'
import { isHermesErrorEnvelope } from '../lib/hermes-errors.gen'

/**
 * A real HTTP server stands in for the bridge, so the tests exercise real fetch
 * semantics — abort, timeouts, status codes — rather than a mock's idea of them.
 */
interface Recorded {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

let server: Server
let baseUrl: string
let recorded: Recorded[] = []
let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void

beforeEach(async () => {
  recorded = []
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  }
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      recorded.push({
        method: req.method || 'GET',
        url: req.url || '',
        headers: req.headers,
        body,
      })
      handler(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
  process.env.HERMES_BRIDGE_URL = baseUrl
  process.env.HERMES_BRIDGE_TOKEN = 'test-token'
  invalidateBridgeReadCache()
  resetBridgeReadiness()
  void readiness
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  delete process.env.HERMES_BRIDGE_URL
  delete process.env.HERMES_BRIDGE_TOKEN
})

/**
 * Assert that a bridge call rejects with a contract-shaped envelope carrying
 * `code`. Written as an explicit catch rather than `rejects.toMatchObject`
 * because the envelope is an own property on the thrown Error, which
 * toMatchObject does not traverse.
 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  expect(error, 'expected the call to reject').toBeInstanceOf(Error)
  const envelope = (error as { hermesError?: unknown }).hermesError
  expect(isHermesErrorEnvelope(envelope), `not a contract envelope: ${JSON.stringify(envelope)}`).toBe(
    true,
  )
  expect((envelope as { error: { code: string } }).error.code).toBe(code)
}

/** The raw envelope from a rejected call, for assertions on its other fields. */
async function rejectedEnvelope(promise: Promise<unknown>): Promise<any> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  return (error as { hermesError?: unknown })?.hermesError
}

describe('bridge client: token and profile headers', () => {
  it('always attaches the bridge token', async () => {
    await bridge.json('/health')
    expect(recorded[0]?.headers['x-hermes-bridge-token']).toBe('test-token')
  })

  it('attaches the token on every verb, not just GET', async () => {
    await bridge.json('/v1/chat/completions', { method: 'POST', body: '{}' })
    expect(recorded[0]?.method).toBe('POST')
    expect(recorded[0]?.headers['x-hermes-bridge-token']).toBe('test-token')
  })

  it('attaches the requested profile', async () => {
    await bridge.json('/workspace/overview', {}, { profile: 'work' })
    expect(recorded[0]?.headers['x-hermes-profile']).toBe('work')
  })

  it('omits the token header when no token is configured', async () => {
    delete process.env.HERMES_BRIDGE_TOKEN
    await bridge.json('/health')
    expect(recorded[0]?.headers['x-hermes-bridge-token']).toBeUndefined()
  })
})

describe('bridge client: error envelope', () => {
  it('wraps a non-JSON error body in the contract', async () => {
    handler = (_req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('upstream exploded')
    }
    await expect(bridge.json('/v1/providers')).rejects.toMatchObject({
      hermesError: { error: { code: 'PROVIDER_ERROR', message: 'upstream exploded' } },
    })
  })

  it('translates a legacy { error: string } shape', async () => {
    handler = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'nope' }))
    }
    await expectCode(bridge.json('/v1/providers'), 'VALIDATION')
    const envelope = await rejectedEnvelope(bridge.json('/v1/providers'))
    expect(envelope.error.message).toBe('nope')
  })

  it("translates FastAPI's { detail } shape", async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail: 'Not Found' }))
    }
    await expect(bridge.json('/v1/providers')).rejects.toMatchObject({
      hermesError: { error: { code: 'VALIDATION', message: 'Not Found' } },
    })
  })

  it('passes a contract-shaped bridge error through untouched', async () => {
    const envelope = {
      error: { code: 'MODEL_INCOMPATIBLE', message: 'bad model', retryable: false },
    }
    handler = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(envelope))
    }
    await expect(bridge.json('/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      hermesError: envelope,
    })
  })

  it('maps 401/403 to BRIDGE_AUTH and 503 to BRIDGE_STARTING', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{}')
    }
    await expectCode(bridge.json('/v1/providers'), 'BRIDGE_AUTH')

    handler = (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end('{}')
    }
    await expectCode(bridge.json('/v1/providers'), 'BRIDGE_STARTING')
  })

  it('every produced error satisfies the contract validator', () => {
    const envelope = bridgeErrorEnvelope('BRIDGE_UNREACHABLE', 'down', { bridge_url: 'x' })
    expect(isHermesErrorEnvelope(envelope)).toBe(true)
    expect(envelope.error.retryable).toBe(true)
  })
})

describe('bridge client: timeouts and abort', () => {
  it('times out a hanging request with UPSTREAM_TIMEOUT', async () => {
    handler = () => {
      /* never responds */
    }
    await expectCode(bridge.json('/slow', {}, { timeoutMs: 150 }), 'UPSTREAM_TIMEOUT')
  })

  it('honours a caller abort signal', async () => {
    handler = () => {
      /* never responds */
    }
    const controller = new AbortController()
    const promise = bridge.json('/slow', {}, { signal: controller.signal, timeoutMs: null })
    setTimeout(() => controller.abort(), 50)
    // A caller abort is a cancellation, not a timeout — telling the user to retry
    // when they deliberately stopped would be wrong.
    await expectCode(promise, 'INTERNAL')
    const envelope = await rejectedEnvelope(bridge.json('/slow', {}, {
      signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 50); return c.signal })(),
      timeoutMs: null,
    }))
    expect(envelope.error.retryable).toBe(false)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      bridge.json('/health', {}, { signal: controller.signal, timeoutMs: null }),
    ).rejects.toBeDefined()
  })

  it('does not time out a stream on a long first byte', async () => {
    handler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"ok":true}\n\n')
        res.end()
      }, 400)
    }
    const response = await bridge.stream('/v1/chat/completions', { method: 'POST', body: '{}' }, {
      timeoutMs: null,
      idleTimeoutMs: 5_000,
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('ok')
  }, 10_000)
})

describe('bridge client: readiness retry', () => {
  it('retries a GET across the bridge startup window', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls += 1
      if (calls === 1) {
        // Simulate the socket not being up: destroy it.
        res.socket?.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }
    // Shorten the wait so the test does not sit for 30s.
    const result = await bridge.json('/v1/providers', {}, { timeoutMs: 3_000 })
    expect(result).toEqual({ ok: true })
    expect(calls).toBeGreaterThan(1)
  }, 20_000)

  it('does NOT retry a POST, which may already have been received', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls += 1
      res.socket?.destroy()
    }
    await expect(
      bridge.json('/v1/chat/completions', { method: 'POST', body: '{}' }, { timeoutMs: 1_000 }),
    ).rejects.toBeDefined()
    expect(calls).toBe(1)
  })

  it('honours an explicit retryUntilReady override', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls += 1
      if (calls === 1) {
        res.socket?.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }
    await bridge.json('/v1/runs', { method: 'POST', body: '{}' }, {
      timeoutMs: 3_000,
      retryUntilReady: true,
    })
    expect(calls).toBeGreaterThan(1)
  }, 20_000)

  it('reports BRIDGE_UNREACHABLE when nothing is listening', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await expect(
      bridge.json('/health', {}, { timeoutMs: 1_000, retryUntilReady: false }),
    ).rejects.toMatchObject({
      hermesError: { error: { code: 'BRIDGE_UNREACHABLE', retryable: true } },
    })
  })
})

describe('bridge client: connection error classification', () => {
  it('recognises ECONNREFUSED and fetch failures', () => {
    expect(isLikelyBridgeConnectionError({ code: 'ECONNREFUSED' })).toBe(true)
    expect(isLikelyBridgeConnectionError({ cause: { code: 'ECONNRESET' } })).toBe(true)
    expect(isLikelyBridgeConnectionError(new TypeError('fetch failed'))).toBe(true)
    expect(isLikelyBridgeConnectionError(new Error('some other problem'))).toBe(false)
    expect(isLikelyBridgeConnectionError(null)).toBe(false)
  })
})

describe('bridge client: read cache', () => {
  // Disabled under vitest by default so no test can observe a stale read. These
  // cases turn it on explicitly, otherwise the cache would be untested.
  beforeEach(() => setBridgeCacheEnabled(true))
  afterEach(() => setBridgeCacheEnabled(false))

  /**
   * Minimal stand-ins for the Express objects bridge.proxy touches.
   *
   * The response is backed by a real Writable because the non-cacheable path
   * pipes the upstream body straight through, which a plain object cannot accept.
   */
  function fakeExpress() {
    const state = { status: 0, body: '', contentType: '', headers: {} as Record<string, string> }
    const sink = new Writable({
      write(chunk, _enc, cb) {
        state.body += String(chunk)
        cb()
      },
    })
    const res = Object.assign(sink, {
      status(code: number) { state.status = code; return res },
      type(value: string) { state.contentType = value; return res },
      send(body: string) { state.body = body; return res },
      json(body: unknown) { state.body = JSON.stringify(body); return res },
      setHeader(key: string, value: string) { state.headers[key] = value; return res },
      // No `end()` override: shadowing Writable's own end() stops pipeline() from
      // ever completing, so the non-cacheable pipe path hangs.
      get headersSent() { return false },
    })
    const req = { on() { return req }, off() { return req } }
    return { req: req as never, res: res as never, state }
  }

  it('caches a cacheable GET and serves the second call from cache', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ n: calls }))
    }
    const first = fakeExpress()
    await bridge.proxy(first.req, first.res, '/health')
    const second = fakeExpress()
    await bridge.proxy(second.req, second.res, '/health')

    expect(JSON.parse(first.state.body)).toEqual({ n: 1 })
    expect(JSON.parse(second.state.body)).toEqual({ n: 1 })
    expect(calls).toBe(1)
  }, 10_000)

  it('keys the cache by profile, so two profiles do not share a body', async () => {
    let calls = 0
    handler = (req, res) => {
      calls += 1
      const profile = String(req.headers['x-hermes-profile'] ?? 'none')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ profile }))
    }
    const a = fakeExpress()
    await bridge.proxy(a.req, a.res, '/health', {}, { profile: 'a' })
    const b = fakeExpress()
    await bridge.proxy(b.req, b.res, '/health', {}, { profile: 'b' })

    expect(JSON.parse(a.state.body)).toEqual({ profile: 'a' })
    expect(JSON.parse(b.state.body)).toEqual({ profile: 'b' })
    expect(calls).toBe(2)
  }, 10_000)

  it('invalidates on a mutation, so a write is visible immediately', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ n: calls }))
    }
    const first = fakeExpress()
    await bridge.proxy(first.req, first.res, '/health')
    const write = fakeExpress()
    await bridge.proxy(write.req, write.res, '/workspace/commands', {
      method: 'POST',
      body: '{}',
    })
    const after = fakeExpress()
    await bridge.proxy(after.req, after.res, '/health')

    expect(JSON.parse(after.state.body)).toEqual({ n: 3 })
  }, 10_000)

  it('does not cache a non-cacheable path', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ n: calls }))
    }
    for (let i = 0; i < 2; i += 1) {
      const exchange = fakeExpress()
      await bridge.proxy(exchange.req, exchange.res, '/sessions/abc/messages')
    }
    expect(calls).toBe(2)
  }, 10_000)

  it('serves a cached read with a Cache-Control header', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }
    const exchange = fakeExpress()
    await bridge.proxy(exchange.req, exchange.res, '/health')
    expect(exchange.state.headers['Cache-Control']).toMatch(/max-age=\d+/)
  }, 10_000)
})
