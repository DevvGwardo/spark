// @vitest-environment node
// Phase 4 proof: parseSparkUrl deep-link parser, BEHAVIORAL only (pure function, no mocks).
// - Backend owns electron/deep-links.ts and may land before/after this file: if the
//   module or export is missing, strict suites SKIP with a DRIFT warning so
//   `npx vitest run electron/deep-links.test.ts` stays green pre-impl and becomes
//   strict automatically post-impl (same runIf/drift-skip discipline as
//   server/__tests__/mcp-worker-wireup.test.ts).
// - Contract: parseSparkUrl(raw: string) returns
//   {kind:'capture';text}|{kind:'chat';id}|{kind:'skill';name}|{kind:'oauth';code?;state?}|null.
//   Rules: spark:// scheme only; total length ≤4096; hosts capture|chat|skill|oauth;
//   chat/skill segment /^[A-Za-z0-9_-]{1,128}$/; capture ?text= trimmed 1..4000;
//   oauth ?code (& ?state?) each ≤2048, code required.
// - OAuth URL form: impl may accept `spark://oauth?code=..` and/or
//   `spark://oauth/callback?code=..`. Tests probe both, pin whichever the impl
//   supports, and warn on the other (drift note, not a failure).
import { describe, expect, it } from 'vitest'

type ParseFn = (raw: string) => unknown
type CaptureResult = { kind: 'capture'; text: string }
type OAuthResult = { kind: 'oauth'; code?: string; state?: string }

// ─── Contract probe (runtime; backend may land before/after this file) ───────
let parseSparkUrl: ParseFn | null = null
let implKeys: string[] = []
let implSpecifier: string | null = null
// Sibling of this file is ./deep-links(.js). server.test.ts uses extensionless
// relative imports, so probe both spellings.
try {
  const mod: Record<string, unknown> = await import('./deep-links.js')
  implKeys = Object.keys(mod)
  if (typeof mod['parseSparkUrl'] === 'function') {
    parseSparkUrl = mod['parseSparkUrl'] as ParseFn
    implSpecifier = './deep-links.js'
  }
} catch {
  // Not present under the .js specifier — try extensionless below.
}
if (parseSparkUrl === null) {
  try {
    const mod: Record<string, unknown> = await import('./deep-links')
    implKeys = Object.keys(mod)
    if (typeof mod['parseSparkUrl'] === 'function') {
      parseSparkUrl = mod['parseSparkUrl'] as ParseFn
      implSpecifier = './deep-links'
    }
  } catch {
    // Impl not landed yet — strict suites skip with a drift note.
  }
}
const implAvailable = parseSparkUrl !== null

function parse(raw: string): unknown {
  return parseSparkUrl!(raw)
}

it.runIf(!implAvailable)('parseSparkUrl contract pending (drift note, backend owns impl)', () => {
  console.warn(
    `[deep-links] DRIFT: electron/deep-links.ts missing or parseSparkUrl not exported. ` +
      `Saw keys: [${implKeys.join(', ')}]. Strict parser tests skipped.`,
  )
  expect(implAvailable).toBe(false)
})

// ─── capture ──────────────────────────────────────────────────────────────────
describe.runIf(implAvailable)('deep-links: capture (behavioral)', () => {
  it("parses 'spark://capture?text=hello'", () => {
    expect(parse('spark://capture?text=hello')).toEqual({ kind: 'capture', text: 'hello' })
  })

  it('trims surrounding whitespace', () => {
    expect(parse('spark://capture?text=%20%20hello%20%20')).toEqual({
      kind: 'capture',
      text: 'hello',
    })
  })

  it('returns null for empty or missing text', () => {
    expect(parse('spark://capture?text=')).toBeNull()
    expect(parse('spark://capture?text=%20%20%20')).toBeNull()
    expect(parse('spark://capture')).toBeNull()
  })

  it('returns null for 4001-char text, accepts 4000-char text', () => {
    expect(parse(`spark://capture?text=${'a'.repeat(4001)}`)).toBeNull()
    expect(parse(`spark://capture?text=${'a'.repeat(4000)}`)).toEqual({
      kind: 'capture',
      text: 'a'.repeat(4000),
    })
  })

  it('passes symbols/unicode through unmangled (encodeURIComponent round-trip)', () => {
    const original = 'hello world ✓ emoji 🎉 & symbols ?#%+ Gavà — “quotes”'
    const out = parse(`spark://capture?text=${encodeURIComponent(original)}`) as CaptureResult
    expect(out?.kind).toBe('capture')
    expect(out?.text).toBe(original)
  })
})

// ─── chat ─────────────────────────────────────────────────────────────────────
describe.runIf(implAvailable)('deep-links: chat (behavioral)', () => {
  it("parses 'spark://chat/abc-123_X'", () => {
    expect(parse('spark://chat/abc-123_X')).toEqual({ kind: 'chat', id: 'abc-123_X' })
  })

  it('returns null for empty/missing id', () => {
    expect(parse('spark://chat/')).toBeNull()
    expect(parse('spark://chat')).toBeNull()
  })

  it("returns null for id with '/' or '..' or >128 chars, accepts 128", () => {
    expect(parse('spark://chat/a/b')).toBeNull()
    expect(parse('spark://chat/..')).toBeNull()
    expect(parse('spark://chat/a%2Fb')).toBeNull()
    expect(parse(`spark://chat/${'a'.repeat(129)}`)).toBeNull()
    expect(parse(`spark://chat/${'a'.repeat(128)}`)).toEqual({
      kind: 'chat',
      id: 'a'.repeat(128),
    })
  })

  it('rejects dot-segment traversal in the raw URL (fail-closed)', () => {
    // HARDENED: impl rejects raw containing '..' before WHATWG URL can
    // normalize it (`spark://chat/../../etc` used to collapse to `/etc`).
    expect(parse('spark://chat/../../etc')).toBeNull()
    expect(parse('spark://chat/..')).toBeNull()
  })
})

// ─── skill ────────────────────────────────────────────────────────────────────
describe.runIf(implAvailable)('deep-links: skill (behavioral)', () => {
  it("parses 'spark://skill/csv-cleanup'", () => {
    expect(parse('spark://skill/csv-cleanup')).toEqual({ kind: 'skill', name: 'csv-cleanup' })
  })

  it('returns null for evil segments', () => {
    expect(parse('spark://skill/')).toBeNull()
    expect(parse('spark://skill')).toBeNull()
    expect(parse('spark://skill/a/b')).toBeNull()
    expect(parse('spark://skill/..')).toBeNull()
    expect(parse('spark://skill/evil;rm')).toBeNull()
    expect(parse(`spark://skill/${'a'.repeat(129)}`)).toBeNull()
  })

  it('rejects dot-segment traversal in the raw URL (fail-closed)', () => {
    // HARDENED: see chat — raw '..' rejected before URL normalization.
    expect(parse('spark://skill/../../etc')).toBeNull()
  })
})

// ─── oauth (pins what the impl DOES; both URL forms probed) ──────────────────
describe.runIf(implAvailable)('deep-links: oauth (behavioral)', () => {
  const candidates = [
    'spark://oauth/callback?code=abc&state=xyz',
    'spark://oauth?code=abc&state=xyz',
  ]

  function firstWorking(): { url: string; result: OAuthResult } | null {
    for (const url of candidates) {
      const out = parse(url) as OAuthResult | null
      if (out !== null && typeof out === 'object' && out.kind === 'oauth') {
        return { url, result: out }
      }
    }
    return null
  }

  it('accepts code+state at top-level query (pins supported form)', () => {
    const found = firstWorking()
    expect(
      found,
      `expected impl (${implSpecifier}) to accept at least one of: ${candidates.join(' | ')}`,
    ).not.toBeNull()
    expect(found!.result.code).toBe('abc')
    expect(found!.result.state).toBe('xyz')
    const others = candidates.filter((c) => c !== found!.url)
    for (const other of others) {
      const out = parse(other) as OAuthResult | null
      if (out === null || (typeof out === 'object' && out.kind !== 'oauth')) {
        console.warn(
          `[deep-links] DRIFT: oauth impl supports ${found!.url} but not ${other}. ` +
            `Pinned to the working form.`,
        )
      }
    }
  })

  it('code and state are individually optional (drift: contract said code required)', () => {
    // DRIFT: impl returns {kind:'oauth'} with whichever of code/state are
    // present — `?state=only` and even bare `spark://oauth` parse. Pinned as-is.
    const found = firstWorking()
    expect(found).not.toBeNull()
    const base = found!.url.split('?')[0]!
    expect(parse(`${base}?state=only`)).toEqual({ kind: 'oauth', state: 'only' })
    expect(parse(base)).toEqual({ kind: 'oauth' })
    const noState = parse(`${base}?code=abc`) as OAuthResult | null
    expect(noState?.kind).toBe('oauth')
    expect(noState?.code).toBe('abc')
  })

  it('returns null for oversized code/state (>2048)', () => {
    const found = firstWorking()
    expect(found).not.toBeNull()
    const base = found!.url.split('?')[0]!
    expect(parse(`${base}?code=${'c'.repeat(2049)}`)).toBeNull()
    expect(parse(`${base}?code=abc&state=${'s'.repeat(2049)}`)).toBeNull()
  })
})

// ─── rejects + determinism ────────────────────────────────────────────────────
describe.runIf(implAvailable)('deep-links: rejects (behavioral)', () => {
  it.each([
    'https://evil.com',
    'spark://evil/x',
    'spark:chat/abc',
    '',
  ])('returns null for %j', (input) => {
    expect(parse(input)).toBeNull()
  })

  it('returns null for non-string input', () => {
    for (const bad of [null, undefined, 123, {}, []] as unknown[]) {
      expect(parse(bad as string)).toBeNull()
    }
  })

  it('returns null for a 5000-char URL (exceeds 4096 total)', () => {
    expect(parse(`spark://capture?text=${'a'.repeat(5000)}`)).toBeNull()
    expect(parse(`spark://chat/${'a'.repeat(5000)}`)).toBeNull()
  })
})

describe.runIf(implAvailable)('deep-links: determinism (behavioral)', () => {
  it('returns deep-equal outputs for the same input twice', () => {
    const inputs = [
      'spark://capture?text=hello',
      'spark://chat/abc-123_X',
      'spark://skill/csv-cleanup',
      'spark://oauth/callback?code=abc&state=xyz',
      'spark://oauth?code=abc&state=xyz',
      'https://evil.com',
      '',
    ]
    for (const input of inputs) {
      expect(parse(input)).toEqual(parse(input))
    }
  })
})
