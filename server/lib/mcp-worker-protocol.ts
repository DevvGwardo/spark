// Clean-room schema; no vendor content copied.
import { z } from 'zod';

export const WorkerSpawnRequestSchema = z.object({
  serverId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).optional(),
  envAllowlist: z.array(z.string().min(1)).optional(),
});

export type WorkerSpawnRequest = z.infer<typeof WorkerSpawnRequestSchema>;

export const WorkerStatusSchema = z.object({
  serverId: z.string().min(1),
  state: z.enum(['starting', 'ready', 'failed', 'stopped']),
  pid: z.number().int().positive().optional(),
  restarts: z.number().int().nonnegative(),
});

export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const WorkerRpcMessageSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type WorkerRpcMessage = z.infer<typeof WorkerRpcMessageSchema>;
