// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { HERMES_EVENT_SCHEMAS, type HermesEventKey } from '../lib/hermes-events.gen'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(HERE, '..', '..', 'hermes-bridge', 'fixtures', 'sse')

/**
 * Golden contract fixtures (spec Phase 1.5).
 *
 * The same files are replayed by hermes-bridge/test_sse_contract_fixtures.py on
 * the emit side. Editing a payload to something the contract does not allow
 * therefore breaks pytest and vitest together, rather than one runtime quietly
 * accepting what the other rejects.
 */

const STANDARD_DELTA_KEYS = new Set([
  'role', 'content', 'reasoning', 'refusal', 'tool_calls', 'function_call',
  'finish_reason', 'name', 'index', 'id', 'object', 'created', 'model',
  'choices', 'usage', 'system_fingerprint',
])

function fixtures(): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {}
  for (const name of readdirSync(FIXTURE_DIR)) {
    if (!name.endsWith('.jsonl')) continue
    out[name.replace(/\.jsonl$/, '')] = readFileSync(join(FIXTURE_DIR, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }
  return out
}

const FIXTURES = fixtures()

/** Every custom (key, payload) pair in a fixture's deltas. */
function customEvents(frames: Record<string, unknown>[]) {
  const found: Array<{ key: string; payload: Record<string, unknown> }> = []
  for (const frame of frames) {
    const sources = [
      ((frame.choices as Array<Record<string, unknown>> | undefined)?.[0]?.delta ??
        {}) as Record<string, unknown>,
      frame,
    ]
    for (const source of sources) {
      for (const [key, value] of Object.entries(source)) {
        if (STANDARD_DELTA_KEYS.has(key)) continue
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          found.push({ key, payload: value as Record<string, unknown> })
        }
      }
    }
  }
  return found
}

describe('golden SSE contract fixtures', () => {
  it('found a fixture for every transport', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(['acp', 'agent-loop', 'runs', 'swarm'])
  })

  for (const [name, frames] of Object.entries(FIXTURES)) {
    describe(name, () => {
      it('parses as JSONL', () => {
        expect(Array.isArray(frames)).toBe(true)
        expect(frames.length).toBeGreaterThan(0)
      })

      it('every custom event validates against the generated contract', () => {
        for (const { key, payload } of customEvents(frames)) {
          const validator =
            HERMES_EVENT_SCHEMAS[key as HermesEventKey] ??
            // The legacy six are in the generated map too; this guards against a
            // fixture referencing a key that is in neither.
            undefined
          expect(validator, `no contract entry for "${key}"`).toBeDefined()
          const result = validator!.safeParse(payload)
          expect(
            result.success,
            `${name}/${key} rejected: ${result.success ? '' : result.error.issues[0]?.message}`,
          ).toBe(true)
        }
      })

      it('declares no event key the contract does not know', () => {
        for (const { key } of customEvents(frames)) {
          expect(Object.keys(HERMES_EVENT_SCHEMAS), `unknown key ${key}`).toContain(key)
        }
      })
    })
  }

  it('every final-chunk usage block validates against the usage contract (spec 4.5)', () => {
    for (const [name, frames] of Object.entries(FIXTURES)) {
      const usage = frames[frames.length - 1]?.usage
      expect(usage, `${name} has no final usage`).toBeDefined()
      const result = HERMES_EVENT_SCHEMAS.usage.safeParse(usage)
      expect(result.success, `${name} usage rejected`).toBe(true)
    }
    // The agent transports report priced, non-zero usage instead of zeros.
    for (const name of ['agent-loop', 'acp']) {
      const usage = FIXTURES[name]![FIXTURES[name]!.length - 1]!.usage as Record<string, unknown>
      expect(usage.total_tokens as number).toBeGreaterThan(0)
      expect(usage.estimated_cost_usd as number).toBeGreaterThan(0)
    }
  })

  it('rejects a fixture payload that violates the contract', () => {
    // Proves the loop above is not vacuous: a deliberately broken usage counter
    // must fail.
    const result = HERMES_EVENT_SCHEMAS.usage.safeParse({ prompt_tokens: 'lots' })
    expect(result.success).toBe(false)
  })

  it('keeps upstream-only fields on adapter-owned events', () => {
    // The agent-loop fixture carries an agent_notice with a field the contract
    // does not declare. It must survive rather than be stripped.
    const frames = FIXTURES['agent-loop']
    const notices = customEvents(frames).filter((e) => e.key === 'agent_notice')
    expect(notices.length).toBeGreaterThan(0)
    const parsed = HERMES_EVENT_SCHEMAS.agent_notice.parse(notices[0]!.payload)
    expect(parsed).toHaveProperty('upstream_only', 'kept')
  })
})
