import { describe, expect, it } from 'vitest'
import {
  getModelDiscoveryHeaders,
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
    expect(OPENAI_COMPATIBLE.hermes).toBe(process.env.HERMES_BRIDGE_URL || 'http://localhost:3003/v1')
    expect(MODEL_DISCOVERY_URLS.hermes).toBe(OPENAI_COMPATIBLE.hermes)
  })

  it('uses a tool-capable Hermes validation model', () => {
    expect(VALIDATION_MODELS.hermes).toBe('meta-llama/llama-4-maverick')
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
    it('uses the active provider directly when it is not hermes', () => {
      const result = resolveReviewCapableProvider('openai', 'gpt-5.4', 'sk-key')
      expect(result).toEqual({ provider: 'openai', model: 'gpt-5.4', apiKey: 'sk-key' })
    })

    it('routes hermes to openrouter with the same API key', () => {
      const result = resolveReviewCapableProvider('hermes', 'llama-4', 'or-key')
      expect(result).toEqual({
        provider: 'openrouter',
        model: VALIDATION_MODELS['openrouter'],
        apiKey: 'or-key',
      })
    })

    it('returns null when no provider and no allProviders are available', () => {
      const result = resolveReviewCapableProvider('', '', '')
      expect(result).toBeNull()
    })

    it('returns null when hermes is active but has no API key and no fallbacks', () => {
      const result = resolveReviewCapableProvider('hermes', 'llama-4', '')
      expect(result).toBeNull()
    })

    it('falls back to allProviders ranked by priority when active has no key', () => {
      const result = resolveReviewCapableProvider('hermes', 'llama-4', '', {
        groq: { apiKey: 'groq-key', model: 'llama-3.3-70b-versatile' },
        anthropic: { apiKey: 'ant-key', model: 'claude-sonnet-4-5' },
      })
      expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'ant-key' })
    })

    it('skips allProviders entries without an API key', () => {
      const result = resolveReviewCapableProvider('hermes', 'llama-4', '', {
        anthropic: { apiKey: '', model: 'claude-sonnet-4-5' },
        openai: { apiKey: 'openai-key', model: 'gpt-5.4' },
      })
      expect(result).toEqual({ provider: 'openai', model: 'gpt-5.4', apiKey: 'openai-key' })
    })

    it('skips hermes entries in allProviders since it cannot do generateObject', () => {
      const result = resolveReviewCapableProvider('', '', '', {
        hermes: { apiKey: 'hermes-key', model: 'llama-4-maverick' },
        groq: { apiKey: 'groq-key', model: 'llama-3.3-70b-versatile' },
      })
      expect(result).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'groq-key' })
    })

    it('falls back to VALIDATION_MODELS when allProviders entry has no model', () => {
      const result = resolveReviewCapableProvider('', '', '', {
        anthropic: { apiKey: 'ant-key', model: '' },
      })
      expect(result).toEqual({ provider: 'anthropic', model: VALIDATION_MODELS['anthropic'], apiKey: 'ant-key' })
    })

    it('falls back from non-hermes provider without key to allProviders', () => {
      const result = resolveReviewCapableProvider('openai', 'gpt-5.4', '', {
        google: { apiKey: 'google-key', model: 'gemini-2.5-flash' },
      })
      expect(result).toEqual({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'google-key' })
    })
  })
})
