// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type express from 'express'
import { csrfProtection } from '../lib/helpers'

function run(headers: Record<string, string>, method = 'POST') {
  const req = { method, headers } as unknown as express.Request
  let status: number | null = null
  const res = {
    status(code: number) { status = code; return this },
    json() { return this },
  } as unknown as express.Response
  const next = vi.fn()
  csrfProtection(req, res, next)
  return { allowed: next.mock.calls.length > 0, status }
}

describe('csrfProtection', () => {
  it('allows non-mutating methods', () => {
    expect(run({ origin: 'https://evil.example.com', host: 'app.local' }, 'GET').allowed).toBe(true)
  })

  it('allows requests with no Origin/Referer (same-origin)', () => {
    expect(run({ host: 'whatever.trycloudflare.com' }).allowed).toBe(true)
  })

  it('allows same-origin requests over a tunnel/LAN host', () => {
    // The key remote-access case: Origin host == the host the request hit.
    expect(run({
      origin: 'https://shy-fox-1234.trycloudflare.com',
      host: 'shy-fox-1234.trycloudflare.com',
    }).allowed).toBe(true)
    expect(run({ origin: 'http://192.168.1.50:3001', host: '192.168.1.50:3001' }).allowed).toBe(true)
  })

  it('allows same-origin via X-Forwarded-Host when a proxy rewrites Host', () => {
    expect(run({
      origin: 'https://shy-fox-1234.trycloudflare.com',
      host: 'localhost:3001',
      'x-forwarded-host': 'shy-fox-1234.trycloudflare.com',
    }).allowed).toBe(true)
  })

  it('allows configured dev origins (Vite on a different port)', () => {
    expect(run({ origin: 'http://localhost:5173', host: 'localhost:3001' }).allowed).toBe(true)
  })

  it('blocks a genuine cross-site request', () => {
    const r = run({ origin: 'https://evil.example.com', host: 'shy-fox-1234.trycloudflare.com' })
    expect(r.allowed).toBe(false)
    expect(r.status).toBe(403)
  })
})
