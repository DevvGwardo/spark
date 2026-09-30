import type { NextFunction, Request, Response } from 'express';
import { isSocketLoopback, sendJson } from './helpers';
import { logger } from './logger';

export const DESTRUCTIVE_PREFIXES = [
  '/api/hermes/moa',
  '/api/hermes/fallback',
  '/api/hermes/goals',
  '/api/hermes/tool-search',
  '/api/hermes/checkpoints',
  '/api/hermes/curator',
  '/api/hermes/computer-use',
  '/api/hermes/pets',
  '/api/hermes/bundles',
  '/api/hermes/plugins',
  '/api/hermes/claw',
  '/api/hermes/kanban',
  '/api/hermes/projects',
  '/api/hermes/auth',
  '/api/hermes/portal',
  '/api/hermes/workspace/skills',
  '/api/hermes/workspace/mcp-servers',
  '/api/hermes/workspace/files',
  '/api/hermes/messaging/platforms',
  '/api/hermes/sessions',
  '/api/hermes/cron',
  '/api/hermes/update',
  '/api/bridge/start',
  '/api/bridge/install-deps',
];

export function isDestructiveHermesOp(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return false;
  }
  return DESTRUCTIVE_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

export function requireLocalHermesMutation(req: Request, res: Response, next: NextFunction): void {
  // Express 4 has strict routing off, so `POST /api/hermes/kanban/swarm/`
  // (trailing slash) matches the route but yields a req.path with the slash,
  // which would bypass the exact-match set below. Normalize before lookup.
  const normalizedPath = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
  if (!isDestructiveHermesOp(req.method, normalizedPath)) {
    next();
    return;
  }
  // Tunnel traffic terminates on loopback after the Host-based token gate in
  // createApp. LAN clients connecting directly have a non-loopback socket.
  if (isSocketLoopback(req)) {
    next();
    return;
  }
  logger.warn(`[hermes-admin] blocked non-local mutating request: ${req.method} ${normalizedPath}`);
  sendJson(res, 403, { error: 'This Hermes operation is only available from the local app or an authenticated tunnel.' });
}
