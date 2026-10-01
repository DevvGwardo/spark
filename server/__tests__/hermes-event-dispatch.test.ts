// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const warn = vi.fn()
const error = vi.fn()

vi.mock('../lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => warn(...args),
    error: (...args: unknown[]) => error(...args),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

// The once-per-process dedup for unknown keys and contract violations is
// module-level state, so the module is re-imported per test. Without this, the
// first test to trigger a given key silences every later assertion about it —
// which is exactly what happened on the first run of this file.
async function freshNormalizer() {
  vi.resetModules()
  return (await import('../lib/hermes')).normalizeHermesAgentLoopPayload
}

function payloadWithDelta(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })
}

async function normalizeDelta(
  delta: Record<string, unknown>,
  extra?: Record<string, unknown>,
) {
  const normalize = await freshNormalizer()
  const result = normalize(payloadWithDelta(delta, extra))
  if (!result) throw new Error('expected a normalized event')
  return result
}

async function dataFor(delta: Record<string, unknown>, extra?: Record<string, unknown>) {
  return (await normalizeDelta(delta, extra)).data as Array<Record<string, unknown>>
}

describe('contracted event dispatch', () => {
  beforeEach(() => {
    warn.mockClear()
    error.mockClear()
  })

  it('wraps tool_activity as hermes_tool_activity with the payload nested', async () => {
    // The client matches on this exact shape.
    const data = await dataFor({
      tool_activity: { tool: 'web', status: 'running', input: {}, output: null },
    })
    expect(data).toEqual([
      {
        type: 'hermes_tool_activity',
        activity: { tool: 'web', status: 'running', input: {}, output: null },
      },
    ])
  })

  it('wraps agent_status as agent_status with the payload under status', async () => {
    const data = await dataFor({
      agent_status: { phase: 'thinking', label: 'acp', elapsed_ms: 4, source: 'hermes-bridge' },
    })
    expect(data[0]?.type).toBe('agent_status')
    expect(data[0]?.status).toMatchObject({ phase: 'thinking' })
  })

  it('emits only provider and model for fallback_switch', async () => {
    // The contract also carries an optional reason, but the client consumes only
    // provider/model. Encoding that narrowing is the point of the dispatch table.
    const data = await dataFor({
      fallback_switch: { provider: 'openrouter', model: 'gpt-x', reason: '429' },
    })
    expect(data[0]).toEqual({ type: 'fallback_switch', provider: 'openrouter', model: 'gpt-x' })
  })

  it('spreads server_tool_event raw so its own type survives', async () => {
    const data = await dataFor({
      server_tool_event: { type: 'hermes_run', run_id: 'run-9', conversation_id: 'conv-9' },
    })
    expect(data[0]).toEqual({ type: 'hermes_run', run_id: 'run-9', conversation_id: 'conv-9' })
  })

  it('flattens transport_status onto the data entry', async () => {
    const data = await dataFor({
      transport_status: { requested: 'agent-loop', actual: 'acp', reason: 'hdr' },
    })
    expect(data[0]).toEqual({
      type: 'transport_status',
      requested: 'agent-loop',
      actual: 'acp',
      reason: 'hdr',
    })
  })

  it('carries the capability row on transport_status (spec 4.8)', async () => {
    const capabilities = {
      approvals: true,
      cancel: true,
      stops_on_client_disconnect: true,
      usage_in_stream: true,
      session_resume: true,
    }
    const data = await dataFor({
      transport_status: { requested: 'acp', actual: 'acp', capabilities },
    })
    expect(data[0]).toEqual({ type: 'transport_status', requested: 'acp', actual: 'acp', capabilities })
    expect(error).not.toHaveBeenCalled()
  })

  it('reads the bridge-priced turn cost from the final usage block (spec 4.5)', async () => {
    const normalize = await freshNormalizer()
    const result = normalize(JSON.stringify({
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 350,
        total_tokens: 2350,
        cached_input_tokens: 800,
        estimated_cost_usd: 0.00909,
        cost_source: 'pricing',
      },
    }))
    expect(result?.usage).toEqual({
      promptTokens: 2000,
      completionTokens: 350,
      totalTokens: 2350,
      cachedInputTokens: 800,
      costUsd: 0.00909,
    })
    expect(error).not.toHaveBeenCalled()
  })

  it('logs a usage block that violates the contract but still forwards its tokens', async () => {
    const normalize = await freshNormalizer()
    const result = normalize(JSON.stringify({
      id: 'chunk-1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost_source: 7 },
    }))
    expect(result?.usage?.totalTokens).toBe(4)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"usage"'))
  })

  it('keeps reading the payload root as well as the delta', async () => {
    const data = await dataFor(
      { content: 'hi' },
      { tool_activity: { tool: 'web', status: 'completed', input: '', output: 'done' } },
    )
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ type: 'hermes_tool_activity' })
  })

  it('does not treat standard OpenAI delta fields as custom events', async () => {
    const data = await dataFor({ role: 'assistant', content: 'text', reasoning: 'because' })
    expect(data).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('recognises adapter-owned events without warning or double-delivering', async () => {
    // computer_use_frame / agent_notice / agent_notice_clear reach the client by
    // direct SSE passthrough, so they are deliberately not added to `data`. They
    // are part of the contract, so they must not be reported as unknown either.
    const data = await dataFor({
      computer_use_frame: { type: 'computer_use_frame', data: 'base64' },
      agent_notice: { key: 'credits', level: 'warn' },
      agent_notice_clear: { key: 'credits' },
    })
    expect(data).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})

describe('unknown events are dropped, not cast', () => {
  beforeEach(() => {
    warn.mockClear()
  })

  it('drops an event key that is not in the contract', async () => {
    const data = await dataFor({ some_future_event: { anything: true } })
    expect(data).toEqual([])
  })

  it('logs the unknown key once, not once per frame', async () => {
    const normalize = await freshNormalizer()
    for (let i = 0; i < 50; i += 1) {
      normalize(payloadWithDelta({ some_future_event: { n: i } }))
    }
    const calls = warn.mock.calls.filter((c) => String(c[0]).includes('some_future_event'))
    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.[0])).toContain('bridge_events.py')
  })

  it('still forwards known events alongside an unknown one', async () => {
    const data = await dataFor({
      some_future_event: { x: 1 },
      tool_activity: { tool: 'web', status: 'running' },
    })
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ type: 'hermes_tool_activity' })
  })
})

describe('contract violations are loud but not lossy', () => {
  beforeEach(() => {
    error.mockClear()
  })

  it('logs a violation when a payload breaks the contract', async () => {
    await dataFor({ tool_activity: { status: 'running' } }) // missing required `tool`
    const calls = error.mock.calls.filter((c) => String(c[0]).includes('tool_activity'))
    expect(calls.length).toBeGreaterThan(0)
    expect(String(calls[0]?.[0])).toContain('does not match the generated contract')
  })

  it('forwards the offending payload anyway so the UI does not silently lose it', async () => {
    const data = await dataFor({ tool_activity: { status: 'running' } })
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ type: 'hermes_tool_activity' })
  })

  it('logs a violation once per key, not once per frame', async () => {
    const normalize = await freshNormalizer()
    for (let i = 0; i < 20; i += 1) {
      normalize(payloadWithDelta({ tool_activity: { status: 'running' } }))
    }
    const calls = error.mock.calls.filter((c) => String(c[0]).includes('tool_activity'))
    expect(calls).toHaveLength(1)
  })

  it('treats a non-object custom payload as a violation rather than crashing', async () => {
    const data = await dataFor({ tool_activity: 'nope' })
    expect(data).toEqual([])
    expect(error.mock.calls.some((c) => String(c[0]).includes('not an object'))).toBe(true)
  })
})

describe('standard fields survive the rewrite', () => {
  it('still extracts text, reasoning, usage and finish reason', async () => {
    const normalize = await freshNormalizer()
    const result = normalize(
      JSON.stringify({
        choices: [
          { index: 0, delta: { content: 'hello', reasoning: 'think' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    )
    expect(result?.text).toBe('hello')
    expect(result?.reasoning).toBe('think')
    expect(result?.finishReason).toBe('stop')
    // normalizeHermesUsage camel-cases, which is pre-existing behavior.
    expect(result?.usage).toMatchObject({ promptTokens: 10, totalTokens: 15 })
  })

  it('returns null on malformed JSON', async () => {
    const normalize = await freshNormalizer()
    expect(normalize('{not json')).toBeNull()
  })
})
