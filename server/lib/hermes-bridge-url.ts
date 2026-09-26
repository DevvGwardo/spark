/**
 * Hermes bridge URL resolution.
 *
 * The Python bridge binds 127.0.0.1 (IPv4 loopback) by default. Node's
 * `fetch('http://localhost:3002')` can prefer ::1 on macOS and immediately
 * ECONNREFUSED, which Express surfaces as 502 on /api/hermes/providers and
 * /api/hermes/workspace/commands. Always rewrite loopback `localhost` to
 * 127.0.0.1 so the proxy hits the socket that actually exists.
 */

export const DEFAULT_HERMES_BRIDGE_ORIGIN = 'http://127.0.0.1:3002';

export function normalizeHermesBridgeUrl(raw: string): string {
  return raw
    .trim()
    .replace(/^http:\/\/localhost(?=[:/?]|$)/i, 'http://127.0.0.1')
    .replace(/^https:\/\/localhost(?=[:/?]|$)/i, 'https://127.0.0.1');
}

/** Bridge origin without a trailing /v1 (admin + health + workspace). */
export function getHermesBridgeRoot(): string {
  const raw = process.env.HERMES_BRIDGE_URL || DEFAULT_HERMES_BRIDGE_ORIGIN;
  return normalizeHermesBridgeUrl(raw).replace(/\/v1\/?$/, '');
}

/** OpenAI-compatible /v1 base used for chat completions + provider catalog. */
export function getHermesBridgeV1(): string {
  return `${getHermesBridgeRoot()}/v1`;
}
