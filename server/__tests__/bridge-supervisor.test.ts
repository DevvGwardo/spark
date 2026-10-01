// @vitest-environment node
/**
 * shared/bridge-supervisor.ts — lifecycle, respawn, ownership, readiness.
 *
 * No real Python: spawn is injected with a fake child and fetch with a fake
 * bridge whose /health and /diag the test controls.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BridgeSupervisor,
  getActiveBridgeSupervisor,
  setActiveBridgeSupervisor,
  type BridgeSupervisorOptions,
} from '../../shared/bridge-supervisor'
import type { BridgeReadiness } from '../../shared/bridge-readiness'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  pid = 4242
  ignoreSigint = false
  kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === 'SIGINT' && this.ignoreSigint) return true
    this.exit(null, signal ?? 'SIGTERM')
    return true
  })
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    bridge.up = false
    this.emit('exit', code, signal)
  }
}

/** The fake bridge HTTP surface. */
const bridge = {
  up: false,
  diagToken: undefined as string | undefined,
  healthOk: true,
  healthDelayMs: 0,
}

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (!bridge.up) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  if (url.endsWith('/health')) {
    if (bridge.healthDelayMs) vi.setSystemTime(Date.now() + bridge.healthDelayMs)
    return new Response('{}', { status: bridge.healthOk ? 200 : 503 })
  }
  if (url.endsWith('/diag')) {
    // Mirrors main.py /diag: never echoes the token, only whether ours matched.
    const presented = new Headers(init?.headers).get('X-Hermes-Bridge-Token')
    const tokenMatches = bridge.diagToken !== undefined && presented === bridge.diagToken
    return new Response(JSON.stringify({ pid: 1, launch_token_present: bridge.diagToken !== undefined, token_matches: tokenMatches }), {
      status: 200,
    })
  }
  return new Response('not found', { status: 404 })
}) as unknown as typeof fetch

type SpawnMode = 'healthy' | 'crash'
let spawnMode: SpawnMode = 'healthy'
let children: FakeChild[] = []
let spawnTimes: number[] = []

const fakeSpawn = vi.fn((_cmd: string, _args: string[], opts: SpawnOptions) => {
  const child = new FakeChild()
  children.push(child)
  spawnTimes.push(Date.now())
  if (spawnMode === 'healthy') {
    bridge.up = true
    bridge.diagToken = (opts.env as Record<string, string>).HERMES_BRIDGE_TOKEN
  } else {
    void Promise.resolve().then(() => {
      child.stderr.write('Traceback: boom\n')
      child.exit(1)
    })
  }
  return child as unknown as ChildProcess
})

function makeSupervisor(overrides: Partial<BridgeSupervisorOptions> = {}): BridgeSupervisor {
  return new BridgeSupervisor({
    port: 39999,
    token: 'tok-ours',
    resolvePython: () => '/usr/bin/python3',
    resolveSource: () => '/tmp/hermes-bridge',
    onUnowned: 'refuse',
    install: { env: () => ({}), install: async () => ({ ok: true }) },
    logger: { info: () => {}, warn: () => {} },
    logFile: null,
    echo: false,
    spawn: fakeSpawn,
    fetch: fakeFetch,
    checkDeps: async () => true,
    listeningPids: () => (bridge.up ? [999] : []),
    killPid: () => {
      bridge.up = false
    },
    timing: { healthPollMs: 50, healthTimeoutMs: 2_000 },
    ...overrides,
  })
}

/** Run start() to completion under fake timers. */
async function startAndSettle(sup: BridgeSupervisor) {
  const p = sup.start()
  await vi.advanceTimersByTimeAsync(0)
  return p
}

const savedToken = process.env.HERMES_BRIDGE_TOKEN

beforeEach(() => {
  vi.useFakeTimers()
  bridge.up = false
  bridge.diagToken = undefined
  bridge.healthOk = true
  bridge.healthDelayMs = 0
  spawnMode = 'healthy'
  children = []
  spawnTimes = []
  fakeSpawn.mockClear()
  setActiveBridgeSupervisor(null)
})

afterEach(() => {
  vi.useRealTimers()
  setActiveBridgeSupervisor(null)
  if (savedToken === undefined) delete process.env.HERMES_BRIDGE_TOKEN
  else process.env.HERMES_BRIDGE_TOKEN = savedToken
})

describe('bridge supervisor: start and readiness transitions', () => {
  it('spawns, waits for an owned healthy bridge, and reports ready', async () => {
    const sup = makeSupervisor()
    const seen: BridgeReadiness[] = []
    sup.onReadiness((r) => seen.push(r))

    expect(sup.readiness().state).toBe('stopped')
    const result = await startAndSettle(sup)

    expect(result).toEqual({ status: 'started' })
    expect(fakeSpawn).toHaveBeenCalledTimes(1)
    expect(seen.map((r) => r.state)).toEqual(['starting', 'ready'])
    const r = sup.readiness()
    expect(r).toMatchObject({ state: 'ready', attempt: 0, lastError: null, stderrTail: [] })
    expect(typeof r.since).toBe('number')
    // Registered so the Express readiness route and bridge-client see it.
    expect(getActiveBridgeSupervisor()).toBe(sup)
    // The token is shared with the in-process server.
    expect(process.env.HERMES_BRIDGE_TOKEN).toBe('tok-ours')
    await sup.stop()
  })

  it('goes degraded when health probes fail or are slow, and back to ready', async () => {
    const sup = makeSupervisor({ timing: { healthPollMs: 50, probeIntervalMs: 1_000, slowProbeMs: 2_000 } })
    await startAndSettle(sup)

    bridge.healthOk = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sup.readiness().state).toBe('degraded')
    expect(sup.readiness().lastError).toMatch(/Health probe failed/)

    bridge.healthOk = true
    bridge.healthDelayMs = 2_500
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sup.readiness().state).toBe('degraded')
    expect(sup.readiness().lastError).toMatch(/slow/)

    bridge.healthDelayMs = 0
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sup.readiness()).toMatchObject({ state: 'ready', lastError: null })
    await sup.stop()
  })

  it('fails a start whose preconditions are missing without spawning', async () => {
    const sup = makeSupervisor({ checkDeps: async () => false })
    const result = await startAndSettle(sup)
    expect(result.status).toBe('failed')
    expect(fakeSpawn).not.toHaveBeenCalled()
    expect(sup.readiness()).toMatchObject({ state: 'stopped', lastError: expect.stringMatching(/dependencies/) })
  })
})

describe('bridge supervisor: ownership check via /diag', () => {
  it('refuses (does not adopt) a running bridge whose token does not match', async () => {
    bridge.up = true
    bridge.diagToken = 'someone-else'
    const sup = makeSupervisor({ onUnowned: 'refuse' })
    const result = await startAndSettle(sup)

    expect(result.status).toBe('failed')
    expect(result.message).toMatch(/not started by this server/)
    expect(fakeSpawn).not.toHaveBeenCalled()
    expect(sup.readiness().state).toBe('stopped')
    expect(sup.isRunning()).toBe(false)
  })

  it('treats a bridge launched without a token as unowned', async () => {
    bridge.up = true
    bridge.diagToken = undefined
    const sup = makeSupervisor()
    expect(await sup.isOwned()).toBe(false)
    expect((await startAndSettle(sup)).status).toBe('failed')
  })

  it('adopts a running bridge that reports our token', async () => {
    bridge.up = true
    bridge.diagToken = 'tok-ours'
    const sup = makeSupervisor()
    const result = await startAndSettle(sup)

    expect(result).toEqual({ status: 'reused-existing' })
    expect(fakeSpawn).not.toHaveBeenCalled()
    expect(sup.readiness().state).toBe('ready')
    expect(sup.isRunning()).toBe(true)
    await sup.stop()
  })

  it("replace policy kills the unowned bridge and spawns its own", async () => {
    bridge.up = true
    bridge.diagToken = 'stale'
    const killPid = vi.fn(() => {
      bridge.up = false
    })
    const sup = makeSupervisor({ onUnowned: 'replace', killPid })
    const result = await startAndSettle(sup)

    expect(killPid).toHaveBeenCalledWith(999)
    expect(result).toEqual({ status: 'started' })
    expect(fakeSpawn).toHaveBeenCalledTimes(1)
    await sup.stop()
  })
})

describe('bridge supervisor: respawn', () => {
  it('respawns with 1s, 2s, 4s, 8s, 16s backoff, then crashes keeping the stderr tail', async () => {
    const sup = makeSupervisor()
    await startAndSettle(sup)
    const states: string[] = []
    sup.onReadiness((r) => states.push(`${r.state}:${r.attempt}`))

    // Every respawn dies right away.
    spawnMode = 'crash'
    for (let i = 0; i < 60; i++) children[0]!.stderr.write(`line ${i}\n`)
    await vi.advanceTimersByTimeAsync(0)
    const crashAt = Date.now()
    children[0]!.exit(1)

    await vi.advanceTimersByTimeAsync(60_000)

    const delays = spawnTimes.slice(1).map((t, i) => t - (i === 0 ? crashAt : spawnTimes[i]!))
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect(fakeSpawn).toHaveBeenCalledTimes(6)

    const r = sup.readiness()
    expect(r.state).toBe('crashed')
    expect(r.attempt).toBe(5)
    expect(r.lastError).toMatch(/Gave up after 5 restarts/)
    expect(r.stderrTail.length).toBe(50)
    expect(r.stderrTail.at(-1)).toBe('Traceback: boom')
    expect(states).toContain('restarting:1')
    expect(states).toContain('restarting:5')
    expect(states.at(-1)).toBe('crashed:5')

    // No more attempts once crashed.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fakeSpawn).toHaveBeenCalledTimes(6)
  })

  it('caps the backoff at 30s', async () => {
    const sup = makeSupervisor({ timing: { healthPollMs: 50, maxAttempts: 8, attemptWindowMs: 10 * 60_000 } })
    await startAndSettle(sup)
    spawnMode = 'crash'
    const crashAt = Date.now()
    children[0]!.exit(1)
    await vi.advanceTimersByTimeAsync(300_000)
    const delays = spawnTimes.slice(1).map((t, i) => t - (i === 0 ? crashAt : spawnTimes[i]!))
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
    expect(sup.readiness().state).toBe('crashed')
  })

  it('recovers to ready after a single crash and reports attempt 0 again', async () => {
    const sup = makeSupervisor()
    await startAndSettle(sup)
    children[0]!.exit(null, 'SIGKILL')
    expect(sup.readiness()).toMatchObject({ state: 'restarting', attempt: 1 })
    expect(sup.readiness().lastError).toMatch(/exited unexpectedly/)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fakeSpawn).toHaveBeenCalledTimes(2)
    expect(sup.readiness()).toMatchObject({ state: 'ready', attempt: 0, lastError: null })
    await sup.stop()
  })

  it('only counts attempts inside the 5-minute window', async () => {
    const sup = makeSupervisor()
    await startAndSettle(sup)
    for (let i = 0; i < 5; i++) {
      children.at(-1)!.exit(1)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(sup.readiness().state).toBe('ready')
      await vi.advanceTimersByTimeAsync(70_000)
    }
    // Five crashes spread over > 5 minutes: the oldest fell out of the window.
    children.at(-1)!.exit(1)
    expect(sup.readiness().state).toBe('restarting')
    await sup.stop()
  })

  it('an intentional stop sends SIGINT and never respawns', async () => {
    const sup = makeSupervisor()
    await startAndSettle(sup)
    const child = children[0]!

    await sup.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGINT')
    expect(sup.readiness()).toMatchObject({ state: 'stopped', attempt: 0, lastError: null })

    await vi.advanceTimersByTimeAsync(120_000)
    expect(fakeSpawn).toHaveBeenCalledTimes(1)
    expect(sup.readiness().state).toBe('stopped')
  })

  it('escalates to SIGKILL when SIGINT is ignored for 5s, and the stop is awaited', async () => {
    const sup = makeSupervisor()
    await startAndSettle(sup)
    const child = children[0]!
    child.ignoreSigint = true

    let done = false
    const stopping = sup.stop().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(done).toBe(false)
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')

    await vi.advanceTimersByTimeAsync(1)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    await stopping
    expect(done).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fakeSpawn).toHaveBeenCalledTimes(1)
  })

  it('a manual start after a crash opens a fresh attempt window', async () => {
    const sup = makeSupervisor({ timing: { healthPollMs: 50, maxAttempts: 1 } })
    await startAndSettle(sup)
    spawnMode = 'crash'
    children[0]!.exit(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sup.readiness().state).toBe('crashed')

    spawnMode = 'healthy'
    const result = await startAndSettle(sup)
    expect(result.status).toBe('started')
    expect(sup.readiness()).toMatchObject({ state: 'ready', attempt: 0, stderrTail: [] })
    await sup.stop()
  })
})

describe('bridge supervisor: restart', () => {
  it('awaits the stop, spawns a fresh child, and does not count it as a crash', async () => {
    const sup = makeSupervisor({ timing: { healthPollMs: 50, maxAttempts: 1 } })
    await startAndSettle(sup)
    const first = children[0]!
    const seen: string[] = []
    sup.onReadiness((r) => seen.push(r.state))

    const p = sup.restart()
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ status: 'started' })

    expect(first.kill).toHaveBeenCalledWith('SIGINT')
    expect(fakeSpawn).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(['stopped', 'starting', 'ready'])
    expect(sup.readiness()).toMatchObject({ state: 'ready', attempt: 0, lastError: null })

    // The restart consumed no respawn attempt: one real crash still respawns
    // even with maxAttempts = 1.
    children[1]!.exit(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fakeSpawn).toHaveBeenCalledTimes(3)
    await sup.stop()
  })

  it('restarts an adopted owned bridge by evicting it, and exposes /diag', async () => {
    bridge.up = true
    bridge.diagToken = 'tok-ours'
    const killed: number[] = []
    const sup = makeSupervisor({
      killPid: (pid) => {
        killed.push(pid)
        bridge.up = false
      },
    })
    expect(await startAndSettle(sup)).toEqual({ status: 'reused-existing' })
    expect(await sup.diag()).toMatchObject({ token_matches: true })

    const p = sup.restart()
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ status: 'started' })
    expect(killed).toEqual([999])
    expect(fakeSpawn).toHaveBeenCalledTimes(1)
    await sup.stop()
  })
})

describe('bridge supervisor: waitForReady', () => {
  it('resolves true on ready and false on crashed', async () => {
    const sup = makeSupervisor({ timing: { healthPollMs: 50, maxAttempts: 1 } })
    await startAndSettle(sup)
    await expect(sup.waitForReady(1_000)).resolves.toBe(true)

    spawnMode = 'crash'
    children[0]!.exit(1)
    const waiting = sup.waitForReady(60_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(waiting).resolves.toBe(false)
  })
})
