import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
}))

const providerConfigMocks = vi.hoisted(() => ({
  createProviderModel: vi.fn(() => 'mock-model'),
  getReasoningProviderOptions: vi.fn(() => undefined),
}))

vi.mock('ai', () => ({
  streamText: aiMocks.streamText,
}))

vi.mock('../provider-config', () => ({
  createProviderModel: providerConfigMocks.createProviderModel,
  getReasoningProviderOptions: providerConfigMocks.getReasoningProviderOptions,
}))

function abortError() {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function waitWithAbort(delayMs: number, abortSignal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)

    const onAbort = () => {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }

    if (!abortSignal) {
      return
    }

    if (abortSignal.aborted) {
      onAbort()
      return
    }

    abortSignal.addEventListener('abort', onAbort, { once: true })
  })
}

function makeStream(
  chunks: Array<{ delayMs?: number; text: string }>,
  abortSignal?: AbortSignal,
) {
  return {
    textStream: (async function* () {
      for (const chunk of chunks) {
        if (chunk.delayMs) {
          await waitWithAbort(chunk.delayMs, abortSignal)
        }
        yield chunk.text
      }
    })(),
  }
}

function createRequest(body: Record<string, unknown>) {
  const req = new EventEmitter() as Request & EventEmitter
  req.body = body
  req.headers = {}
  return req
}

function createResponse() {
  const writes: string[] = []
  const res = {
    setHeader: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(String(chunk))
      return true
    }),
    end: vi.fn(),
  } as unknown as Response

  return { res, writes }
}

describe('createOrchestrateHandler', () => {
  const originalHeartbeat = process.env.ORCHESTRATOR_HEARTBEAT_MS
  const originalSubtaskTimeout = process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS

  beforeEach(() => {
    vi.useFakeTimers()
    aiMocks.streamText.mockReset()
    providerConfigMocks.createProviderModel.mockClear()
    providerConfigMocks.getReasoningProviderOptions.mockClear()
    delete process.env.ORCHESTRATOR_HEARTBEAT_MS
    delete process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS
  })

  afterEach(() => {
    vi.useRealTimers()

    if (originalHeartbeat === undefined) {
      delete process.env.ORCHESTRATOR_HEARTBEAT_MS
    } else {
      process.env.ORCHESTRATOR_HEARTBEAT_MS = originalHeartbeat
    }

    if (originalSubtaskTimeout === undefined) {
      delete process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS
    } else {
      process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS = originalSubtaskTimeout
    }
  })

  it('emits heartbeat events while planning and synthesizing are idle', async () => {
    process.env.ORCHESTRATOR_HEARTBEAT_MS = '10'

    aiMocks.streamText
      .mockImplementationOnce((options: { abortSignal?: AbortSignal }) =>
        makeStream(
          [
            {
              delayMs: 25,
              text: JSON.stringify({
                plan: 'Plan',
                tasks: [{ id: '1', description: 'Write code' }],
              }),
            },
          ],
          options.abortSignal,
        ),
      )
      .mockImplementationOnce((options: { abortSignal?: AbortSignal }) =>
        makeStream([{ text: 'Subtask complete' }], options.abortSignal),
      )
      .mockImplementationOnce((options: { abortSignal?: AbortSignal }) =>
        makeStream([{ delayMs: 25, text: 'Final response' }], options.abortSignal),
      )

    const { createOrchestrateHandler } = await import('../orchestrator')
    const handler = createOrchestrateHandler()
    const req = createRequest({
      orchestrator_provider: 'openai',
      orchestrator_model: 'gpt-test',
      orchestrator_api_key: 'plan-key',
      sub_agent_provider: 'openai',
      sub_agent_model: 'gpt-test',
      sub_agent_api_key: 'code-key',
      messages: [{ role: 'user', content: 'Do a large refactor' }],
    })
    const { res, writes } = createResponse()

    const pending = handler(req, res)
    await vi.advanceTimersByTimeAsync(12)

    expect(writes.join('')).toContain('event: heartbeat')

    await vi.runAllTimersAsync()
    await pending

    const output = writes.join('')
    expect(output).toContain('event: plan')
    expect(output).toContain('event: token')
    expect(output).toContain('event: done')
  })

  it('uses the configured subtask timeout instead of a fixed 60-second limit', async () => {
    process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS = '15000'
    process.env.ORCHESTRATOR_HEARTBEAT_MS = '10'

    aiMocks.streamText
      .mockImplementationOnce((options: { abortSignal?: AbortSignal }) =>
        makeStream(
          [
            {
              text: JSON.stringify({
                plan: 'Plan',
                tasks: [{ id: '1', description: 'Long running task' }],
              }),
            },
          ],
          options.abortSignal,
        ),
      )
      .mockImplementationOnce((options: { abortSignal?: AbortSignal }) =>
        makeStream([{ delayMs: 20000, text: 'Too late' }], options.abortSignal),
      )
      .mockImplementationOnce((options: { abortSignal?: AbortSignal }) =>
        makeStream([{ text: 'Final response' }], options.abortSignal),
      )

    const { createOrchestrateHandler } = await import('../orchestrator')
    const handler = createOrchestrateHandler()
    const req = createRequest({
      orchestrator_provider: 'openai',
      orchestrator_model: 'gpt-test',
      orchestrator_api_key: 'plan-key',
      sub_agent_provider: 'openai',
      sub_agent_model: 'gpt-test',
      sub_agent_api_key: 'code-key',
      messages: [{ role: 'user', content: 'Run a long coding task' }],
    })
    const { res, writes } = createResponse()

    const pending = handler(req, res)
    await vi.runAllTimersAsync()
    await pending

    expect(writes.join('')).toContain('Error: Sub-task timed out after 15s')
  })
})
