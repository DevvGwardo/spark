// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildServeCommand,
  parseServeInfo,
  parseTailscaleStatus,
  DEFAULT_TAILNET_HTTPS_PORT,
} from '../lib/tailscale'

// Real shapes captured from `tailscale status --json` and
// `tailscale serve status --json` on macOS.

describe('parseTailscaleStatus', () => {
  it('reads the MagicDNS name and strips its trailing dot', () => {
    const parsed = parseTailscaleStatus({
      BackendState: 'Running',
      AuthURL: '',
      Self: { DNSName: 'torreys-macbook-pro.tail87c430.ts.net.' },
    })
    expect(parsed.running).toBe(true)
    expect(parsed.needsLogin).toBe(false)
    expect(parsed.hostname).toBe('torreys-macbook-pro.tail87c430.ts.net')
    expect(parsed.url).toBe('https://torreys-macbook-pro.tail87c430.ts.net')
  })

  it('reports a stopped daemon as not running but still exposes the hostname', () => {
    // `status --json` exits 0 while stopped, so this is the common offline case.
    const parsed = parseTailscaleStatus({
      BackendState: 'Stopped',
      Self: { DNSName: 'host.tailnet.ts.net.' },
    })
    expect(parsed.running).toBe(false)
    expect(parsed.url).toBe('https://host.tailnet.ts.net')
  })

  it('flags NeedsLogin and surfaces the auth URL', () => {
    const parsed = parseTailscaleStatus({
      BackendState: 'NeedsLogin',
      AuthURL: 'https://login.tailscale.com/a/abc123',
      Self: {},
    })
    expect(parsed.needsLogin).toBe(true)
    expect(parsed.authUrl).toBe('https://login.tailscale.com/a/abc123')
    expect(parsed.hostname).toBeNull()
    expect(parsed.url).toBeNull()
  })

  it('tolerates a malformed payload without throwing', () => {
    const parsed = parseTailscaleStatus(null)
    expect(parsed.running).toBe(false)
    expect(parsed.hostname).toBeNull()
    expect(parsed.url).toBeNull()
  })
})

describe('parseServeInfo', () => {
  const servePayload = {
    TCP: { '443': { HTTPS: true } },
    Web: {
      'torreys-macbook-pro.tail87c430.ts.net:443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:8793' } },
      },
    },
  }

  it('finds a mapping for the app port and builds the tailnet URL', () => {
    const info = parseServeInfo(servePayload, 8793)
    expect(info.configured).toBe(true)
    expect(info.url).toBe('https://torreys-macbook-pro.tail87c430.ts.net')
  })

  it('does not claim a mapping that serves a different port', () => {
    // The user's own unrelated serve mapping must never be reported as ours.
    const info = parseServeInfo(servePayload, 3001)
    expect(info.configured).toBe(false)
    expect(info.url).toBeNull()
  })

  it('keeps a non-default HTTPS port in the URL', () => {
    const info = parseServeInfo(
      {
        Web: {
          'host.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://localhost:3001' } } },
        },
      },
      3001,
    )
    expect(info.configured).toBe(true)
    expect(info.url).toBe('https://host.tailnet.ts.net:8443')
  })

  it('appends a set-path to the URL', () => {
    const info = parseServeInfo(
      {
        Web: {
          'host.tailnet.ts.net:443': { Handlers: { '/spark': { Proxy: 'http://127.0.0.1:3001' } } },
        },
      },
      3001,
    )
    expect(info.configured).toBe(true)
    expect(info.url).toBe('https://host.tailnet.ts.net/spark')
  })

  it('returns not-configured for an empty or malformed payload', () => {
    expect(parseServeInfo({}, 3001).configured).toBe(false)
    expect(parseServeInfo(null, 3001).configured).toBe(false)
    expect(parseServeInfo({ Web: {} }, 3001).configured).toBe(false)
  })
})

describe('buildServeCommand', () => {
  it('targets a non-443 HTTPS port so it cannot clobber the default mapping', () => {
    const cmd = buildServeCommand(3001)
    expect(cmd).toBe('tailscale serve --bg --https=8443 http://localhost:3001')
    expect(cmd).toContain(`--https=${DEFAULT_TAILNET_HTTPS_PORT}`)
  })

  it('honours a caller-supplied port', () => {
    expect(buildServeCommand(3001, 9443)).toContain('--https=9443')
  })
})
