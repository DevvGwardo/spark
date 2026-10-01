// @vitest-environment node
// The chat route runs flash-style harness passes: when the model stops after
// editing files without running anything, it gets one verify nudge and a
// second streamText pass, all inside a single assistant message.
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VERIFY_NUDGE } from '../lib/harness/turn-guard'

const aiMocks = vi.hoisted(() => ({ streamText: vi.fn() }))
const providerConfigMocks = vi.hoisted(() => ({ createProviderModel: vi.fn() }))

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, streamText: aiMocks.streamText }
})

vi.mock('../provider-config', async () => {
  const actual = await vi.importActual<typeof import('../provider-config')>('../provider-config')
  return { ...actual, createProviderModel: providerConfigMocks.createProviderModel }
})

import { approvalPolicyStore } from '../approval-engine'

async function createTestServer() {
  const { createApp } = await import('../index')
  const app = createApp()
  return await new Promise<{ close: () => Promise<void>; url: string }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

interface Pass {
  text: string
  steps: unknown[]
}

function fakeResult({ text, steps }: Pass) {
  const id = `txt-${text.length}`
  return {
    fullStream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'start' })
        controller.enqueue({ type: 'text-start', id })
        controller.enqueue({ type: 'text-delta', id, text })
        controller.enqueue({ type: 'text-end', id })
        controller.close()
      },
    }),
    steps: Promise.resolve(steps),
    response: Promise.resolve({ messages: [{ role: 'assistant', content: text }] }),
  }
}

const editThenStop = [
  {
    finishReason: 'tool-calls',
    text: '',
    toolCalls: [{ toolName: 'write_file', input: { path: 'a.ts', content: 'x' } }],
    content: [{ type: 'tool-result', toolName: 'write_file', input: { path: 'a.ts' }, output: 'ok' }],
  },
  { finishReason: 'stop', text: 'Fixed it.', toolCalls: [], content: [] },
]
const verifiedStop = [
  {
    finishReason: 'tool-calls',
    text: '',
    toolCalls: [{ toolName: 'run_command', input: { command: 'npm test' } }],
    content: [{ type: 'tool-result', toolName: 'run_command', input: { command: 'npm test' }, output: 'ok\n[Exit code: 0]' }],
  },
  { finishReason: 'stop', text: 'Tests pass.', toolCalls: [], content: [] },
]

describe('chat route harness continuation', () => {
  const actualFetch = global.fetch

  beforeEach(() => {
    approvalPolicyStore.resetForTests()
    providerConfigMocks.createProviderModel.mockReturnValue({ id: 'test-model' })
  })

  afterEach(() => {
    approvalPolicyStore.resetForTests()
    vi.clearAllMocks()
  })

  it('sends one verify nudge as a second pass inside one assistant message', async () => {
    aiMocks.streamText
      .mockImplementationOnce(() => fakeResult({ text: 'Fixed it.', steps: editThenStop }))
      .mockImplementationOnce(() => fakeResult({ text: 'Tests pass.', steps: verifiedStop }))
    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.2',
          api_key: 'openai-key',
          agent_toolsets: 'terminal,files',
          messages: [{ role: 'user', content: 'Fix the bug in a.ts' }],
        }),
      })
      const body = await response.text()

      expect(aiMocks.streamText).toHaveBeenCalledTimes(2)
      const first = aiMocks.streamText.mock.calls[0][0]
      expect(typeof first.prepareStep).toBe('function')
      expect(typeof first.repairToolCall).toBe('function')
      const secondMessages = aiMocks.streamText.mock.calls[1][0].messages
      expect(secondMessages.slice(-2)).toEqual([
        { role: 'assistant', content: 'Fixed it.' },
        { role: 'user', content: VERIFY_NUDGE },
      ])

      expect(body.match(/"type":"start"/g)).toHaveLength(1)
      expect(body.match(/"type":"finish"/g)).toHaveLength(1)
      expect(body).toContain('"type":"data-harness"')
      expect(body.indexOf('Tests pass.')).toBeLessThan(body.indexOf('"type":"finish"'))
      expect(body).toContain('"finishReason":"stop"')
    } finally {
      await server.close()
    }
  })

  it('does not add passes for plain chat without tools', async () => {
    aiMocks.streamText.mockImplementationOnce(() =>
      fakeResult({ text: 'Hi', steps: [{ finishReason: 'stop', text: 'Hi', toolCalls: [], content: [] }] }),
    )
    const server = await createTestServer()

    try {
      const response = await actualFetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.2',
          api_key: 'openai-key',
          messages: [{ role: 'user', content: 'Fix the bug please' }],
        }),
      })
      await response.text()

      expect(aiMocks.streamText).toHaveBeenCalledTimes(1)
      expect(aiMocks.streamText.mock.calls[0][0].prepareStep).toBeUndefined()
    } finally {
      await server.close()
    }
  })
})
