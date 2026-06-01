import type express from 'express';

// ─── Shared helpers ──────────────────────────────────────────────────────────

export const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://localhost:3000,http://localhost:8080,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:3000,http://127.0.0.1:8080,app://.')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

export function getCorsOrigin(requestOrigin: string | undefined): string {
  if (requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)) {
    return requestOrigin;
  }
  // For Electron file:// or same-origin requests, return the first allowed origin.
  // Configure ALLOWED_ORIGINS with your production domain(s) before deploying.
  return ALLOWED_ORIGINS.values().next().value!;
}

export function buildCorsHeaders(requestOrigin: string | undefined) {
  return {
    'Access-Control-Allow-Origin': getCorsOrigin(requestOrigin),
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
}

export function sendJson(res: express.Response, status: number, body: unknown) {
  res.status(status).json(body);
}

// ─── CSRF Protection ─────────────────────────────────────────────────────────

/**
 * Middleware that checks the Origin/Referer header for mutating requests.
 * In server mode, cross-origin form submissions without a matching origin
 * are rejected to prevent CSRF attacks.
 */
export function csrfProtection(req: express.Request, res: express.Response, next: express.NextFunction) {
  const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  if (!mutatingMethods.has(req.method)) {
    return next();
  }
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) {
    // Same-origin requests (no Origin/Referer) are allowed
    return next();
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
  }

  // Same-origin: the Origin matches the host this request was actually sent to.
  // This covers remote access over LAN/tunnel where the host is the LAN IP or a
  // *.trycloudflare.com domain rather than localhost. X-Forwarded-Host handles
  // reverse proxies (e.g. cloudflared) that may rewrite the Host header.
  // A genuine cross-site CSRF attempt still fails here because the attacker's
  // Origin won't equal the server's own host, and falls through to the allowlist.
  const forwardedHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  const selfHosts = new Set([req.headers.host, forwardedHost].filter(Boolean));
  if (selfHosts.has(originHost)) {
    return next();
  }

  // Otherwise require an explicitly allowed origin (e.g. the Vite dev server on
  // a different port than the API during local development).
  const allowed = [...ALLOWED_ORIGINS].some(allowedOrigin => {
    try {
      return new URL(allowedOrigin).host === originHost;
    } catch {
      return false;
    }
  });
  if (!allowed) {
    return sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
  }
  next();
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

export class RateLimiter {
  private requests = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private windowMs: number, private maxRequests: number) {
    // Periodic cleanup every 60s to prevent unbounded memory growth
    this.cleanupTimer = setInterval(() => this.pruneExpired(), 60_000);
    // Allow the Node process to exit even if the timer is still active
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /** Remove all entries whose timestamps have fully expired. */
  private pruneExpired(): void {
    const now = Date.now();
    for (const [k, ts] of this.requests) {
      const active = ts.filter(t => now - t < this.windowMs);
      if (active.length === 0) {
        this.requests.delete(k);
      } else {
        this.requests.set(k, active);
      }
    }
  }

  isAllowed(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const filtered = timestamps.filter(t => now - t < this.windowMs);

    // Clean up keys with no recent activity
    if (filtered.length === 0) {
      this.requests.delete(key);
    }

    if (filtered.length >= this.maxRequests) return false;
    filtered.push(now);
    this.requests.set(key, filtered);

    // Inline safety net: prune if map grows unexpectedly large between intervals
    if (this.requests.size > 1000) {
      this.pruneExpired();
    }

    return true;
  }

  /** Stop the periodic cleanup timer (useful for tests). */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export const chatRateLimiter = new RateLimiter(60_000, 30);       // 30 requests per minute
export const validateKeyRateLimiter = new RateLimiter(60_000, 10); // 10 requests per minute

/**
 * Extract the client IP address from a request.
 * Uses req.ip (which respects Express "trust proxy" setting) as the primary source,
 * falling back to x-forwarded-for and then socket address.
 * NOTE: Configure `app.set('trust proxy', ...)` in production so req.ip is reliable.
 */
export function getClientIp(req: express.Request): string {
  return req.ip
    || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}
