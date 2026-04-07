import { describe, expect, it } from 'vitest'
import {
  getModelDiscoveryHeaders,
  HERMES_TOOL_CAPABLE_MODELS,
  OPENAI_COMPATIBLE,
  MODEL_DISCOVERY_URLS,
  VALIDATION_MODELS,
  resolveHermesExecutionMode,
  resolveReviewCapableProvider,
  resolveRuntimeProvider,
  sanitizeCompatibleSseLine,
  sanitizeCompatibleStream,
  usesFirstPartyProviderSdk,
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
    expect(MODEL_DISCOVERY_URLS.hermes).toBe(OPENAI_COMPATIBLE.hermes)
  })

  it('uses a tool-capable Hermes validation model', () => {
    expect(VALIDATION_MODELS.hermes).toBe(HERMES_TOOL_CAPABLE_MODELS[0])
  })

  it('validates OpenAI keys against the default GPT-5.4 model', () => {
    expect(VALIDATION_MODELS.openai).toBe('gpt-5.4')
  })

  it('routes supported providers through first-party SDK factories', () => {
    expect(usesFirstPartyProviderSdk('google')).toBe(true)
    expect(usesFirstPartyProviderSdk('xai')).toBe(true)
    expect(usesFirstPartyProviderSdk('groq')).toBe(true)
    expect(usesFirstPartyProviderSdk('deepseek')).toBe(true)
    expect(usesFirstPartyProviderSdk('mistral')).toBe(true)
    expect(usesFirstPartyProviderSdk('together')).toBe(true)
    expect(usesFirstPartyProviderSdk('cerebras')).toBe(true)
    expect(usesFirstPartyProviderSdk('minimax')).toBe(false)
    expect(usesFirstPartyProviderSdk('hermes')).toBe(false)
  })

  it('uses provider-appropriate headers for model discovery', () => {
    expect(getModelDiscoveryHeaders('google', 'google-key')).toEqual({
      'x-goog-api-key': 'google-key',
    })
    expect(getModelDiscoveryHeaders('openai', 'openai-key')).toEqual({
      Authorization: 'Bearer openai-key',
    })
  })

  it('keeps Hermes on the local bridge while editing a repo', () => {
    expect(resolveRuntimeProvider('hermes', { activeRepo: { owner: 'octo', name: 'repo' } })).toBe('hermes')
    expect(resolveRuntimeProvider('hermes')).toBe('hermes')
  })

  it('always uses agent-loop mode for Hermes regardless of repo context', () => {
    expect(resolveHermesExecutionMode({
      activeRepo: { owner: 'octo', name: 'repo' },
      githubPAT: 'ghp_test',
    })).toBe('agent-loop')
    expect(resolveHermesExecutionMode({
      activeRepo: { owner: 'octo', name: 'repo' },
      githubPAT: '',
    })).toBe('agent-loop')
    expect(resolveHermesExecutionMode()).toBe('agent-loop')
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

  describe('resolveReviewCapableProvider', () => {
    it('uses the active provider and model directly', () => {
      const result = resolveReviewCapableProvider('openai', 'gpt-5.4', 'sk-key')
      expect(result).toEqual({ provider: 'openai', model: 'gpt-5.4', apiKey: 'sk-key' })
    })

    it('uses hermes directly with the selected model', () => {
      const result = resolveReviewCapableProvider('hermes', 'meta-llama/llama-4-maverick', 'or-key')
      expect(result).toEqual({ provider: 'hermes', model: 'meta-llama/llama-4-maverick', apiKey: 'or-key' })
    })

    it('uses minimax directly with the selected model', () => {
      const result = resolveReviewCapableProvider('minimax', 'MiniMax-M2.7', 'mm-key')
      expect(result).toEqual({ provider: 'minimax', model: 'MiniMax-M2.7', apiKey: 'mm-key' })
    })

    it('returns null when no provider is set', () => {
      expect(resolveReviewCapableProvider('', '', '')).toBeNull()
    })

    it('returns null when provider has no API key', () => {
      expect(resolveReviewCapableProvider('hermes', 'llama-4', '')).toBeNull()
    })
  })
})
