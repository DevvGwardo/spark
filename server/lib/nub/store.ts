/**
 * The nub sign-in, kept server-side (never in the renderer's localStorage):
 * the `nub_desk_…` session that can reach the user's nub agent, the token
 * the Hermes MCP entry presents to /api/nub/mcp, and display-only key info.
 * The model key itself goes to the renderer like any provider key.
 *
 * Stored at `<spark data dir>/nub/auth.json`, owner-only on Unix.
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface NubInstance {
  id: string;
  publicUrl: string;
  status: string;
}

export interface NubAuth {
  origin: string;
  desktopToken: string;
  /** Bearer the Hermes `nub` MCP entry sends to /api/nub/mcp. */
  mcpToken: string;
  keyPrefix: string | null;
  /** Unix seconds. */
  keyExpiresAt: number | null;
  instance: NubInstance | null;
  linkedAt: number;
}

export function nubDataDir(): string {
  if (process.env.CLOUDCHAT_USER_DATA_DIR) return join(process.env.CLOUDCHAT_USER_DATA_DIR, 'nub');
  // Like chat-store's in-memory DB under vitest: never touch the real sign-in.
  if (process.env.VITEST) return join(tmpdir(), `spark-vitest-nub-${process.pid}`);
  return join(homedir(), '.cloudchat', 'nub');
}

function authPath(): string {
  return join(nubDataDir(), 'auth.json');
}

export function newMcpToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function loadNubAuth(): Promise<NubAuth | null> {
  try {
    const parsed = JSON.parse(await readFile(authPath(), 'utf8')) as Partial<NubAuth>;
    if (typeof parsed.desktopToken !== 'string' || typeof parsed.origin !== 'string') return null;
    return {
      origin: parsed.origin,
      desktopToken: parsed.desktopToken,
      mcpToken: typeof parsed.mcpToken === 'string' ? parsed.mcpToken : newMcpToken(),
      keyPrefix: parsed.keyPrefix ?? null,
      keyExpiresAt: parsed.keyExpiresAt ?? null,
      instance: parsed.instance ?? null,
      linkedAt: parsed.linkedAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}

export async function saveNubAuth(auth: NubAuth): Promise<void> {
  await mkdir(nubDataDir(), { recursive: true, mode: 0o700 });
  await writeFile(authPath(), `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies on create; tighten an older file too.
  await chmod(authPath(), 0o600).catch(() => {});
}

export async function clearNubAuth(): Promise<void> {
  await rm(authPath(), { force: true });
}
