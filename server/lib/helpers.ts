import type express from 'express';

// ─── Shared helpers ──────────────────────────────────────────────────────────

export const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:3000',
  'app://.',  // Electron custom protocol
]);

export function getCorsOrigin(requestOrigin: string | undefined): string {
  if (requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)) {
    return requestOrigin;
  }
  // For Electron file:// or same-origin requests
  return 'http://localhost:5173';
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

// ─── Rate Limiter ────────────────────────────────────────────────────────────

export class RateLimiter {
  private requests = new Map<string, number[]>();

  constructor(private windowMs: number, private maxRequests: number) {}

  isAllowed(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const filtered = timestamps.filter(t => now - t < this.windowMs);
    if (filtered.length >= this.maxRequests) return false;
    filtered.push(now);
    this.requests.set(key, filtered);
    return true;
  }
}

export const chatRateLimiter = new RateLimiter(60_000, 30);       // 30 requests per minute
export const validateKeyRateLimiter = new RateLimiter(60_000, 10); // 10 requests per minute

export function getClientIp(req: express.Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
}
