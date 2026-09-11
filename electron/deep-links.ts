// Pure parser for spark:// deep links (Phase 4 plan).
// Zero electron imports — the Vitest node suite imports this module directly,
// so it must stay side-effect free and dependency free.

export type SparkDeepLink =
  | { kind: 'capture'; text: string }
  | { kind: 'chat'; id: string }
  | { kind: 'skill'; name: string }
  | { kind: 'oauth'; code?: string; state?: string }

const MAX_URL_LENGTH = 4096
const MAX_TEXT_LENGTH = 4000
const MAX_OAUTH_PARAM_LENGTH = 2048
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function isEmptyPath(pathname: string): boolean {
  return pathname === '' || pathname === '/'
}

export function parseSparkUrl(raw: string): SparkDeepLink | null {
  if (typeof raw !== 'string') return null
  if (!raw.startsWith('spark://')) return null
  if (raw.length > MAX_URL_LENGTH) return null
  // WHATWG URL silently resolves `..` (`spark://skill/../../etc` → `/etc`),
  // laundering traversal before we see it. Fail closed on the raw string.
  if (raw.includes('..')) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'spark:') return null

  const host = parsed.hostname
  if (host !== 'capture' && host !== 'chat' && host !== 'skill' && host !== 'oauth') {
    return null
  }

  if (host === 'capture') {
    if (!isEmptyPath(parsed.pathname)) return null
    const text = (parsed.searchParams.get('text') ?? '').trim()
    if (text.length < 1 || text.length > MAX_TEXT_LENGTH) return null
    return { kind: 'capture', text }
  }

  if (host === 'oauth') {
    // Plan form is spark://oauth/callback — also accept the bare host.
    if (!isEmptyPath(parsed.pathname) && parsed.pathname !== '/callback') return null
    const code = parsed.searchParams.get('code')
    const state = parsed.searchParams.get('state')
    if (code !== null && code.length > MAX_OAUTH_PARAM_LENGTH) return null
    if (state !== null && state.length > MAX_OAUTH_PARAM_LENGTH) return null
    return {
      kind: 'oauth',
      ...(code !== null ? { code } : {}),
      ...(state !== null ? { state } : {}),
    }
  }

  // chat | skill: exactly one path segment carries the id/name.
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0)
  if (segments.length !== 1) return null
  let segment: string
  try {
    segment = decodeURIComponent(segments[0] as string)
  } catch {
    return null
  }
  if (!ID_RE.test(segment)) return null
  if (host === 'chat') return { kind: 'chat', id: segment }
  return { kind: 'skill', name: segment }
}
