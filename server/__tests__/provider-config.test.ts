import { describe, expect, it } from 'vitest'
import {
  OPENAI_COMPATIBLE,
  VALIDATION_MODELS,
  resolveRuntimeProvider,
  sanitizeCompatibleSseLine,
  sanitizeCompatibleStream,
} from '../provider-config'

async function readStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let result = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }

  result += decoder.decode()
  return result
}

describe('provider-config', () => {
  it('keeps Hermes pointed at the local bridge default port', () => {
    expect(OPENAI_COMPATIBLE.hermes).toBe(process.env.HERMES_BRIDGE_URL || 'http://localhost:3002/v1')
  })

  it('uses a tool-capable Hermes validation model', () => {
    expect(VALIDATION_MODELS.hermes).toBe('meta-llama/llama-4-maverick')
  })

  it('keeps Hermes on the local bridge while editing a repo', () => {
    expect(resolveRuntimeProvider('hermes', { activeRepo: { owner: 'octo', name: 'repo' } })).toBe('hermes')
    expect(resolveRuntimeProvider('hermes')).toBe('hermes')
  })

  it('normalizes MiniMax SSE chunks that emit an empty assistant role', () => {
    const line = 'data: {"id":"1","choices":[{"index":0,"delta":{"content":"<think>","role":""}}]}'

    expect(sanitizeCompatibleSseLine('minimax', line)).toBe(
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"<think>","role":"assistant"}}]}',
    )
  })

  it('leaves non-MiniMax SSE chunks untouched', () => {
    const line = 'data: {"id":"1","choices":[{"index":0,"delta":{"content":"hello","role":""}}]}'

    expect(sanitizeCompatibleSseLine('openai', line)).toBe(line)
  })

  it('sanitizes MiniMax stream chunks even when SSE lines are split across reads', async () => {
    const encoder = new TextEncoder()
    const original = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"1","choices":[{"index":0,'))
        controller.enqueue(encoder.encode('"delta":{"content":"<think>","role":""}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })

    const output = await readStream(sanitizeCompatibleStream('minimax', original))

    expect(output).toContain('"role":"assistant"')
    expect(output).toContain('data: [DONE]')
  })
})
