import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

export const logger = pino({
  level,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

/**
 * Request ID middleware — attaches a unique ID to each request
 * and includes it in all log lines via child logger.
 */
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction) {
  const requestId = randomUUID();
  (req as any).requestId = requestId;
  (req as any).log = logger.child({ requestId });
  next();
}
