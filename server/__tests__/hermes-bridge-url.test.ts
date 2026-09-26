import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HERMES_BRIDGE_ORIGIN,
  getHermesBridgeRoot,
  getHermesBridgeV1,
  normalizeHermesBridgeUrl,
} from '../lib/hermes-bridge-url'

describe('hermes-bridge-url', () => {
  const previous = process.env.HERMES_BRIDGE_URL

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.HERMES_BRIDGE_URL
    } else {
      process.env.HERMES_BRIDGE_URL = previous
    }
  })

  it('rewrites localhost to 127.0.0.1 so Node fetch does not hit ::1', () => {
    expect(normalizeHermesBridgeUrl('http://localhost:3002')).toBe('http://127.0.0.1:3002')
    expect(normalizeHermesBridgeUrl('http://localhost:3002/v1')).toBe('http://127.0.0.1:3002/v1')
    expect(normalizeHermesBridgeUrl('http://127.0.0.1:3002')).toBe('http://127.0.0.1:3002')
  })

  it('defaults the admin root to IPv4 loopback without /v1', () => {
    delete process.env.HERMES_BRIDGE_URL
    expect(getHermesBridgeRoot()).toBe(DEFAULT_HERMES_BRIDGE_ORIGIN)
    expect(getHermesBridgeV1()).toBe(`${DEFAULT_HERMES_BRIDGE_ORIGIN}/v1`)
  })

  it('strips a trailing /v1 from HERMES_BRIDGE_URL and still prefers IPv4', () => {
    process.env.HERMES_BRIDGE_URL = 'http://localhost:3002/v1'
    expect(getHermesBridgeRoot()).toBe('http://127.0.0.1:3002')
    expect(getHermesBridgeV1()).toBe('http://127.0.0.1:3002/v1')
  })
})
