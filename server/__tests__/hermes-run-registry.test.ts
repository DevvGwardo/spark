// @vitest-environment node
// Swarm + loop runs must register in the background-run map so UI Stop
// (cancelHermesRun) can abort them — previously Stop reported
// { cancelled: false } while the bridge kept running.
import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'

class MockReq extends EventEmitter {
  headers: Record<string, string> = {}
}

class MockRes extends EventEmitter {
  writableEnded = false
  statusCode = 200
  headers: Record<string, string> = {}
  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status
    Object.assign(this.headers, headers)
  }
  write() {
    return true
  }
  end() {
    this.writableEnded = true
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function freshHermes() {
  return import('../lib/hermes')
}

describe('swarm run registration', () => {
  it('registers the run so cancelHermesRun aborts it mid-flight', async () => {
    const { proxyHermesSwarmToDataStream, cancelHermesRun } = await freshHermes()

    // Upstream that never produces data: the proxy stays parked in read().
    let controller!: ReadableStreamDefaultController
    const stream = new ReadableStream({
      start(c) {
        controller = c
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })),
    )

    const req = new MockReq() as never
    const res = new MockRes() as never
    const run = proxyHermesSwarmToDataStream({
      req,
      res,
      apiKey: '',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      conversationId: 'conv-swarm-cancel-1',
    })
    const settled = run.then(
      () => 'resolved',
      () => 'rejected',
    )

    await sleep(150)
    // Still in flight and registered → Stop works.
    expect(cancelHermesRun('conv-swarm-cancel-1')).toBe(true)
    // Already gone → second Stop reports false.
    expect(cancelHermesRun('conv-swarm-cancel-1')).toBe(false)

    // Release the parked upstream so the run can settle.
    controller.close()
    await settled
  }, 10000)
})

describe('loop run registration', () => {
  it('registers the run so cancelHermesRun aborts it mid-iteration', async () => {
    const { proxyHermesLoopToDataStream, cancelHermesRun } = await freshHermes()

    let controller!: ReadableStreamDefaultController
    const parked = new ReadableStream({
      start(c) {
        controller = c
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { headers?: Record<string, string> }) => {
        // The judge is a plain JSON completion — answer met:true so the loop
        // settles after the cancelled iteration ends.
        if (init?.headers?.['X-Hermes-Execution-Mode'] === 'passthrough') {
          return new Response(
            JSON.stringify({ choices: [{ message: { content: '{"met": true, "feedback": "done"}' } }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(parked, { headers: { 'Content-Type': 'text/event-stream' } })
      }),
    )

    const req = new MockReq() as never
    const res = new MockRes() as never
    const run = proxyHermesLoopToDataStream({
      req,
      res,
      apiKey: '',
      model: 'test-model',
      messages: [{ role: 'user', content: 'goal' }],
      loop: { maxIterations: 1, timeBudgetMinutes: null },
      conversationId: 'conv-loop-cancel-1',
    })
    const settled = run.then(
      () => 'resolved',
      () => 'rejected',
    )

    await sleep(150)
    expect(cancelHermesRun('conv-loop-cancel-1')).toBe(true)

    // Release the parked iteration; the judge verdict ends the loop.
    controller.close()
    await settled
    expect(cancelHermesRun('conv-loop-cancel-1')).toBe(false)
  }, 10000)
})

describe('bridgeRepoRootHeaders', () => {
  it('sends the local checkout path to loopback bridges', async () => {
    const { bridgeRepoRootHeaders } = await freshHermes()
    expect(bridgeRepoRootHeaders('/repo/a')).toEqual({ 'X-Hermes-Repo-Root': '/repo/a' })
    expect(bridgeRepoRootHeaders(undefined)).toEqual({})
    expect(bridgeRepoRootHeaders(null)).toEqual({})
  })

  it('omits the server-local path for remote bridges', async () => {
    vi.stubEnv('HERMES_BRIDGE_URL', 'http://192.168.1.10:3002/v1')
    vi.resetModules()
    const { bridgeRepoRootHeaders } = await import('../lib/hermes')
    expect(bridgeRepoRootHeaders('/repo/a')).toEqual({})
  })
})
