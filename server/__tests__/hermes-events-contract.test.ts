// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  HERMES_EVENT_SCHEMAS,
  hermesCustomDeltaSchema,
  type HermesEventKey,
} from '../lib/hermes-events.gen'

const EVENT_KEYS = Object.keys(HERMES_EVENT_SCHEMAS) as HermesEventKey[]

describe('generated hermes event contract', () => {
  it('covers every custom event key the bridge emits', () => {
    // The 9 modelled in bridge_events.py, plus the 6 legacy constructors that
    // predate the contract. All 15 appear in the wire.
    expect(EVENT_KEYS).toHaveLength(15)
    for (const key of [
      'tool_activity',
      'agent_status',
      'computer_use_frame',
      'agent_notice',
      'agent_notice_clear',
      'server_tool_event',
      'fallback_switch',
      'transport_status',
      'usage',
      'tool_call_begin',
      'tool_call_delta',
      'tool_call_end',
      'stream_retry',
      'plan_update',
      'approval_request',
    ]) {
      expect(EVENT_KEYS).toContain(key)
    }
  })

  it('actually validates, rather than collapsing everything to any', () => {
    // This is the failure mode that motivated dereferencing $refs in the
    // generator: with unresolved refs every validator was z.any() and this
    // assertion could not fail.
    const result = HERMES_EVENT_SCHEMAS.usage.safeParse({ prompt_tokens: 'not-a-number' })
    expect(result.success).toBe(false)
  })

  it('accepts a well-formed usage payload', () => {
    const result = HERMES_EVENT_SCHEMAS.usage.safeParse({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    })
    expect(result.success).toBe(true)
  })

  it('defaults missing usage counters rather than rejecting them', () => {
    // UsageEvent declares all three counters with a default of 0, so a partial
    // payload is valid and the gap is filled. The bridge's own usage_event()
    // always sends all three, but the contract tolerates a sparse payload rather
    // than dropping the whole event over a missing counter.
    const result = HERMES_EVENT_SCHEMAS.usage.safeParse({ prompt_tokens: 1 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.completion_tokens).toBe(0)
      expect(result.data.total_tokens).toBe(0)
    }
  })

  it('rejects a usage payload with a wrongly typed counter', () => {
    expect(HERMES_EVENT_SCHEMAS.usage.safeParse({ prompt_tokens: {} }).success).toBe(false)
  })

  it('validates a real agent_status payload', () => {
    const result = HERMES_EVENT_SCHEMAS.agent_status.safeParse({
      phase: 'thinking',
      label: 'agent-loop',
      elapsed_ms: 12,
      source: 'hermes-bridge',
    })
    expect(result.success).toBe(true)
  })

  it('rejects agent_status with a non-numeric elapsed_ms', () => {
    const result = HERMES_EVENT_SCHEMAS.agent_status.safeParse({
      phase: 'thinking',
      label: 'x',
      elapsed_ms: 'soon',
      source: 'hermes-bridge',
    })
    expect(result.success).toBe(false)
  })

  it('requires the tool name on tool_activity', () => {
    expect(HERMES_EVENT_SCHEMAS.tool_activity.safeParse({ status: 'running' }).success).toBe(
      false,
    )
    expect(
      HERMES_EVENT_SCHEMAS.tool_activity.safeParse({ tool: 'web', status: 'running' }).success,
    ).toBe(true)
  })

  it('keeps adapter-owned payloads open', () => {
    // hermes-agent adds notice fields without a bridge release, so unknown keys
    // must survive. A closed object here would strip them silently.
    const result = HERMES_EVENT_SCHEMAS.agent_notice.parse({
      key: 'credits',
      level: 'warn',
      brand_new_field_from_upstream: 42,
    })
    expect(result).toHaveProperty('brand_new_field_from_upstream', 42)
  })

  it('keeps server_tool_event open and requires its discriminant', () => {
    expect(HERMES_EVENT_SCHEMAS.server_tool_event.safeParse({}).success).toBe(false)
    const result = HERMES_EVENT_SCHEMAS.server_tool_event.parse({
      type: 'hermes_run',
      run_id: 'run-1',
      conversation_id: 'conv-1',
      unexpected_extra: true,
    })
    expect(result).toHaveProperty('unexpected_extra', true)
  })

  it('passes standard OpenAI delta fields through untouched', () => {
    // A delta also carries content/reasoning/role, which are not part of this
    // contract. They must survive, or every text token would be dropped.
    const parsed = hermesCustomDeltaSchema.parse({
      role: 'assistant',
      content: 'hello',
      reasoning: 'thinking',
    })
    expect(parsed).toMatchObject({ role: 'assistant', content: 'hello', reasoning: 'thinking' })
  })

  it('validates a mixed delta carrying several custom keys at once', () => {
    const parsed = hermesCustomDeltaSchema.parse({
      content: 'working',
      tool_activity: { tool: 'web', status: 'running', input: {}, output: null },
      agent_status: { phase: 'thinking', label: 'acp', elapsed_ms: 3, source: 'hermes-bridge' },
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })
    expect(parsed.tool_activity).toMatchObject({ tool: 'web' })
    expect(parsed.agent_status).toMatchObject({ phase: 'thinking' })
    expect(parsed.usage).toMatchObject({ total_tokens: 3 })
  })

  it('rejects a delta whose custom payload violates the contract', () => {
    const result = hermesCustomDeltaSchema.safeParse({
      tool_activity: { status: 'running' }, // missing `tool`
    })
    expect(result.success).toBe(false)
  })

  it('rejects an agent_notice_clear with no key', () => {
    expect(HERMES_EVENT_SCHEMAS.agent_notice_clear.safeParse({}).success).toBe(false)
  })
})
