// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  HERMES_ERROR_CODES,
  HERMES_RETRYABLE_CODES,
  hermesErrorEnvelope,
  isHermesErrorEnvelope,
  isRetryableHermesCode,
  type HermesErrorCode,
} from '../lib/hermes-errors.gen'

function envelope(code: string, overrides: Record<string, unknown> = {}) {
  return { error: { code, message: 'boom', retryable: false, ...overrides } }
}

describe('generated hermes error envelope', () => {
  it('exposes the nine contract codes', () => {
    expect(HERMES_ERROR_CODES).toHaveLength(9)
    expect([...HERMES_ERROR_CODES].sort()).toEqual([
      'APPROVAL_EXPIRED',
      'BRIDGE_AUTH',
      'BRIDGE_STARTING',
      'BRIDGE_UNREACHABLE',
      'INTERNAL',
      'MODEL_INCOMPATIBLE',
      'PROVIDER_ERROR',
      'UPSTREAM_TIMEOUT',
      'VALIDATION',
    ])
  })

  it('accepts every declared code', () => {
    for (const code of HERMES_ERROR_CODES) {
      const result = hermesErrorEnvelope.safeParse(envelope(code))
      expect(result.success, `rejected ${code}`).toBe(true)
    }
  })

  it('rejects a code outside the enum', () => {
    // The whole point of the closed enum: an undeclared code must not slip
    // through, or the UI's switch would silently fall to its default branch.
    expect(hermesErrorEnvelope.safeParse(envelope('TOTALLY_MADE_UP')).success).toBe(false)
  })

  it('requires message and a boolean retryable', () => {
    expect(hermesErrorEnvelope.safeParse({ error: { code: 'INTERNAL' } }).success).toBe(false)
    expect(
      hermesErrorEnvelope.safeParse({
        error: { code: 'INTERNAL', message: 'x', retryable: 'yes' },
      }).success,
    ).toBe(false)
  })

  it('keeps model-incompatibility details as data', () => {
    // This is what the UI regex used to scrape out of a sentence.
    const result = hermesErrorEnvelope.safeParse(
      envelope('MODEL_INCOMPATIBLE', {
        details: {
          current_model: 'nousresearch/hermes-3-llama-3.1-405b:free',
          suggested_models: ['meta-llama/llama-4-maverick', 'openai/gpt-4.1-mini'],
        },
      }),
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.error.details?.suggested_models).toEqual([
        'meta-llama/llama-4-maverick',
        'openai/gpt-4.1-mini',
      ])
    }
  })

  it('keeps details open for fields added upstream', () => {
    const result = hermesErrorEnvelope.safeParse(
      envelope('PROVIDER_ERROR', {
        details: { provider_status: 429, future_field: 'kept' },
      }),
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.error.details).toHaveProperty('future_field', 'kept')
    }
  })

  it('marks exactly the transport codes retryable', () => {
    expect([...HERMES_RETRYABLE_CODES].sort()).toEqual([
      'BRIDGE_STARTING',
      'BRIDGE_UNREACHABLE',
      'PROVIDER_ERROR',
      'UPSTREAM_TIMEOUT',
    ])
    expect(isRetryableHermesCode('UPSTREAM_TIMEOUT')).toBe(true)
    expect(isRetryableHermesCode('MODEL_INCOMPATIBLE')).toBe(false)
    expect(isRetryableHermesCode('VALIDATION')).toBe(false)
    expect(isRetryableHermesCode('nonsense')).toBe(false)
  })

  it('narrows via isHermesErrorEnvelope', () => {
    expect(isHermesErrorEnvelope(envelope('INTERNAL'))).toBe(true)
    expect(isHermesErrorEnvelope({ error: 'boom' })).toBe(false)
    expect(isHermesErrorEnvelope(null)).toBe(false)
    expect(isHermesErrorEnvelope('boom')).toBe(false)
    expect(isHermesErrorEnvelope({ detail: 'legacy shape' })).toBe(false)
  })

  it('excludes the legacy error shapes the UI used to handle', () => {
    // The pre-1.4 shapes. None of them may be mistaken for a valid envelope, or
    // the banner would still need a fallback path.
    for (const legacy of [
      { error: 'a string' },
      { error: { message: 'no code' } },
      { detail: 'fastapi default' },
      { message: 'top-level' },
      'plain string',
    ]) {
      expect(isHermesErrorEnvelope(legacy), JSON.stringify(legacy)).toBe(false)
    }
  })

  it('gives every code a distinct literal type for exhaustive switching', () => {
    // Compile-time guarantee expressed at runtime: the union really is closed.
    const codes: HermesErrorCode[] = [...HERMES_ERROR_CODES]
    expect(new Set(codes).size).toBe(codes.length)
  })
})
