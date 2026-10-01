// @vitest-environment node
/**
 * GET /api/bridge/readiness (Phase 3.3) and bridge-client's use of the single
 * supervisor readiness state; plus the rotating bridge log (Phase 3.4).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerBridgeRoutes } from '../routes/bridge'
import { bridgeJson, bridgeReadiness, resetBridgeReadiness } from '../lib/bridge-client'
import { setActiveBridgeSupervisor, type BridgeSupervisor } from '../../shared/bridge-supervisor'
import { BRIDGE_READINESS_STATES, type BridgeReadiness } from '../../shared/bridge-readiness'
import { createRotatingLog } from '../../shared/rotating-log'

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

const close = (server: Server) => new Promise<void>((r) => server.close(() => r()))

function stubSupervisor(r: BridgeReadiness): BridgeSupervisor {
  return {
    readiness: () => r,
    waitForReady: async () => r.state === 'ready',
  } as unknown as BridgeSupervisor
}

const savedUrl = process.env.HERMES_BRIDGE_URL
let api: Server
let apiUrl: string

beforeEach(async () => {
  resetBridgeReadiness()
  setActiveBridgeSupervisor(null)
  const app = express()
  registerBridgeRoutes(app)
  api = createServer(app)
  apiUrl = await listen(api)
})

afterEach(async () => {
  setActiveBridgeSupervisor(null)
  await close(api)
  if (savedUrl === undefined) delete process.env.HERMES_BRIDGE_URL
  else process.env.HERMES_BRIDGE_URL = savedUrl
})

describe('GET /api/bridge/readiness', () => {
  it("returns the active supervisor's readiness verbatim", async () => {
    const crashed: BridgeReadiness = {
      state: 'crashed',
      since: 1_700_000_000_000,
      attempt: 5,
      lastError: 'Hermes bridge exited unexpectedly (code=1, signal=none)',
      stderrTail: ['Traceback', 'ImportError: fastapi'],
    }
    setActiveBridgeSupervisor(stubSupervisor(crashed))

    const res = await fetch(`${apiUrl}/api/bridge/readiness`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual(crashed)
    // bridge.readiness() reads the same single state.
    expect(bridgeReadiness()).toEqual(crashed)
  })

  it('is read-only and not loopback-gated (GET passes the mutation gate)', async () => {
    const { isDestructiveHermesOp } = await import('../lib/hermes-op-gate')
    expect(isDestructiveHermesOp('GET', '/api/bridge/readiness')).toBe(false)
  })

  it('unmanaged bridge: probes /health and reports ready', async () => {
    const fakeBridge = createServer((req, res) => {
      res.statusCode = req.url === '/health' ? 200 : 404
      res.end('{}')
    })
    process.env.HERMES_BRIDGE_URL = await listen(fakeBridge)
    try {
      const body = (await (await fetch(`${apiUrl}/api/bridge/readiness`)).json()) as BridgeReadiness
      expect(body).toMatchObject({ state: 'ready', attempt: 0, lastError: null, stderrTail: [] })
      expect(BRIDGE_READINESS_STATES).toContain(body.state)
      expect(typeof body.since).toBe('number')
    } finally {
      await close(fakeBridge)
    }
  })

  it('unmanaged bridge: unreachable reports stopped with an error', async () => {
    const dead = createServer()
    process.env.HERMES_BRIDGE_URL = await listen(dead)
    await close(dead) // port now refuses connections
    const body = (await (await fetch(`${apiUrl}/api/bridge/readiness`)).json()) as BridgeReadiness
    expect(body.state).toBe('stopped')
    expect(body.lastError).toMatch(/not reachable/)
  })
})

describe('bridge-client follows the supervisor state', () => {
  it('fails fast (no 30s readiness poll) when the supervised bridge has crashed', async () => {
    const dead = createServer()
    process.env.HERMES_BRIDGE_URL = await listen(dead)
    await close(dead)
    setActiveBridgeSupervisor(
      stubSupervisor({ state: 'crashed', since: Date.now(), attempt: 5, lastError: 'x', stderrTail: [] }),
    )
    const started = Date.now()
    await expect(bridgeJson('/v1/providers')).rejects.toMatchObject({
      hermesError: { error: { code: 'BRIDGE_UNREACHABLE' } },
    })
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('rotating bridge log', () => {
  it('rotates at maxBytes and keeps maxFiles files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spark-bridge-log-'))
    try {
      const path = join(dir, 'logs', 'spark-bridge.log')
      const log = createRotatingLog({ path, maxBytes: 200, maxFiles: 3 })
      for (let i = 0; i < 40; i++) log.write(`line ${String(i).padStart(3, '0')} ${'x'.repeat(20)}`)
      log.close()
      await new Promise((r) => setTimeout(r, 100))

      const files = readdirSync(join(dir, 'logs')).sort()
      expect(files).toEqual(['spark-bridge.log', 'spark-bridge.log.1', 'spark-bridge.log.2'])
      const live = readFileSync(path, 'utf8')
      expect(live).toContain('line 039')
      expect(Buffer.byteLength(live)).toBeLessThanOrEqual(200)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
