import { logger } from './lib/logger';
/**
 * mesh-bridge.ts — Agentic-Mesh integration for team context sharing
 *
 * Bridges the team context store with the external agentic-mesh CLI
 * (~/.local/bin/mesh) so team agents can share findings and status
 * with external agents (Claude Code, OpenClaw, DAD supervisor, etc.).
 *
 * All operations shell out to the `mesh` binary which reads/writes
 * the shared file store at ~/.hermes/mesh.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TeamEvent {
  type: 'team_formed' | 'subtask_assigned' | 'subtask_completed' | 'team_synthesized' | 'agent_blocked';
  agentId?: string;
  subtaskId?: string;
  payload?: Record<string, unknown>;
}

export interface MeshQueryResult {
  findings: Array<{ source: string; content: string; confidence: number }>;
  delegations: MeshDelegation[];
}

export interface MeshDelegation {
  id: string;
  from: string;
  to: string;
  task: string;
  status: string;
}

// ─── Agent Info (mirrors shape used by team-coordinator) ───────────────────

interface AgentInfo {
  profileName: string;
  displayName: string;
  expertise: string[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const MESH_BIN = path.join(os.homedir(), '.local/bin', 'mesh');
const CCH_AGENT_ID_PREFIX = 'hermes-';
const MESH_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

// ─── Helpers ───────────────────────────────────────────────────────────────

function meshEnv(agentId?: string, agentName?: string): Record<string, string> {
  return {
    ...process.env,
    MESH_AGENT_ID: agentId || `${CCH_AGENT_ID_PREFIX}bridge`,
    MESH_AGENT_NAME: agentName || 'CloudChat-Hub',
    MESH_RUNTIME: 'hermes',
  } as Record<string, string>;
}

/**
 * Shell out to the mesh binary. Returns stdout on success, logs and
 * re-throws on failure so callers can handle gracefully.
 */
async function meshExec(
  args: string[],
  envOverrides?: Record<string, string>,
): Promise<string> {
  const env = envOverrides ? { ...process.env, ...envOverrides } : undefined;
  const { stdout } = await execFileAsync(MESH_BIN, args, {
    env,
    timeout: MESH_TIMEOUT_MS,
  });
  return stdout.trim();
}

// Cache mesh availability with 60s TTL to avoid per-call shell overhead
let meshAvailable: boolean | null = null;
let meshCheckedAt = 0;
const MESH_CACHE_TTL_MS = 60_000;

/** Reset the mesh availability cache (for testing). */
export function resetMeshCache(): void {
  meshAvailable = null;
  meshCheckedAt = 0;
}

/**
 * Check if the mesh CLI is available. Returns false if not found,
 * so callers can degrade gracefully. Results cached for 60s.
 */
export async function isMeshAvailable(): Promise<boolean> {
  const now = Date.now();
  if (meshAvailable !== null && (now - meshCheckedAt) < MESH_CACHE_TTL_MS) {
    return meshAvailable;
  }
  try {
    await execFileAsync(MESH_BIN, ['--help'], { timeout: 3000 });
    meshAvailable = true;
  } catch {
    meshAvailable = false;
  }
  meshCheckedAt = now;
  return meshAvailable;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Publish a team milestone event to the mesh.
 * Other agents on the mesh can discover and act on these events.
 */
export async function publishToMesh(
  teamId: string,
  event: TeamEvent,
): Promise<void> {
  try {
    if (!(await isMeshAvailable())) {
      logger.warn('[mesh-bridge] mesh CLI not available — skipping publish');
      return;
    }

    const payload = JSON.stringify({ ...(event.payload || {}), teamId, type: event.type, agentId: event.agentId, subtaskId: event.subtaskId });
    const tags = ['team', teamId, event.type].join(',');

    await meshExec(
      ['publish', '--type', 'finding', '--content', payload, '--tags', tags, '--importance', '2'],
      meshEnv(`hermes-team-${teamId.slice(0, 8)}`, `Team-${teamId.slice(0, 8)}`),
    );

    logger.info(`[mesh-bridge] Published ${event.type} for team ${teamId.slice(0, 12)}...`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[mesh-bridge] Failed to publish to mesh: ${msg}`);
  }
}

/**
 * Query the mesh for team-relevant findings and delegations.
 * Returns structured results from external agents.
 */
export async function queryMeshForTeam(
  teamId: string,
  _query: string,
): Promise<MeshQueryResult> {
  try {
    if (!(await isMeshAvailable())) {
      logger.warn('[mesh-bridge] mesh CLI not available — returning empty query');
      return { findings: [], delegations: [] };
    }

    // Query for team-tagged contexts
    const stdout = await meshExec(
      ['query', '--since', '24h', '--json'],
      meshEnv(`hermes-team-${teamId.slice(0, 8)}`, `Team-${teamId.slice(0, 8)}`),
    );

    let contexts: Array<{
      id: string;
      type: string;
      agentId: string;
      agentName: string;
      content: string;
      tags?: string[];
      createdAt: number;
    }> = [];
    try {
      if (stdout.length > 0 && stdout.length < 1_000_000) {
        contexts = JSON.parse(stdout);
      }
    } catch {
      logger.warn('[mesh-bridge] Failed to parse mesh query JSON output');
    }

    // Filter to team-relevant contexts
    const teamTag = `team:${teamId}`;
    const relevant = contexts.filter(
      (c) => c.tags?.some((t) => t === teamId || t === teamTag),
    );

    const findings = relevant
      .filter((c) => c.type === 'finding')
      .map((c) => ({
        source: c.agentName || c.agentId,
        content: c.content,
        confidence: 2 as const,
      }));

    const delegations: MeshDelegation[] = relevant
      .filter((c) => c.type === 'task')
      .map((c) => {
        // Delegate commands format: "[to:agent] instruction"
        const toMatch = c.content.match(/^\[to:([^\]]+)\]\s*(.*)/);
        return {
          id: c.id,
          from: c.agentName || c.agentId,
          to: toMatch?.[1] || 'unknown',
          task: toMatch?.[2] || c.content,
          status: 'pending',
        };
      });

    return { findings, delegations };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[mesh-bridge] Query failed: ${msg}`);
    return { findings: [], delegations: [] };
  }
}

/**
 * Poll the mesh for incoming delegations targeting CloudChat Hub agents.
 * Returns delegations that were queued for hermes agents.
 */
export async function pollMeshDelegations(): Promise<MeshDelegation[]> {
  try {
    if (!(await isMeshAvailable())) {
      return [];
    }

    const stdout = await meshExec(
      ['query', '--type', 'task', '--since', '1h', '--json'],
      meshEnv(),
    );

    let contexts: Array<{
      id: string;
      type: string;
      agentId: string;
      agentName: string;
      content: string;
      createdAt: number;
    }> = [];
    try {
      if (stdout.length > 0 && stdout.length < 1_000_000) {
        contexts = JSON.parse(stdout);
      }
    } catch {
      logger.warn('[mesh-bridge] Failed to parse delegation query JSON');
    }

    // Filter for tasks targeting hermes agents
    return contexts
      .filter((c) => {
        const toMatch = c.content.match(/^\[to:([^\]]+)\]/);
        if (!toMatch) return false;
        const target = toMatch[1].toLowerCase();
        return (
          target === 'hermes' ||
          target.startsWith('hermes-') ||
          target.startsWith('cloudchat')
        );
      })
      .map((c) => {
        const toMatch = c.content.match(/^\[to:([^\]]+)\]\s*(.*)/);
        return {
          id: c.id,
          from: c.agentName || c.agentId,
          to: toMatch?.[1] || 'hermes',
          task: toMatch?.[2] || c.content,
          status: 'pending' as const,
        };
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[mesh-bridge] Poll delegations failed: ${msg}`);
    return [];
  }
}

/**
 * Register a team agent as a mesh peer by publishing a presence context.
 * The mesh auto-registers agents in its storage when they interact;
 * this publishes an explicit presence marker with agent metadata.
 */
export async function registerMeshPeer(agent: AgentInfo): Promise<void> {
  try {
    if (!(await isMeshAvailable())) {
      return;
    }

    const agentId = `hermes-${agent.profileName}`;
    const content = JSON.stringify({
      agentId: agent.profileName,
      displayName: agent.displayName,
      expertise: agent.expertise,
      runtime: 'hermes',
    });

    await meshExec(
      ['publish', '--type', 'log', '--content', content, '--tags', 'peer,hermes', '--importance', '1'],
      meshEnv(agentId, agent.displayName),
    );

    logger.info(`[mesh-bridge] Registered mesh peer: ${agent.displayName} (${agentId})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[mesh-bridge] Failed to register peer: ${msg}`);
  }
}
