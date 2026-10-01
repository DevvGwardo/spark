import { hermesFetch } from './core';

export interface MemoryStatus {
  ok: boolean;
  provider: string | null;
  plugin_available: boolean | null;
  builtin: boolean;
  raw: string;
}

export async function fetchMemoryStatus(): Promise<MemoryStatus> {
  return hermesFetch<MemoryStatus>('/memory/status');
}

export interface CuratorStatus {
  ok: boolean;
  enabled: boolean | null;
  last_run: string | null;
  runs: number | null;
  raw: string;
}

export async function fetchCuratorStatus(): Promise<CuratorStatus> {
  return hermesFetch<CuratorStatus>('/curator/status');
}

export async function runCurator(): Promise<{ ok: boolean; output: string }> {
  return hermesFetch('/curator/run', { method: 'POST', body: '{}' });
}

export interface GoalsConfig {
  max_turns: number;
  enabled: boolean;
}

export async function fetchGoalsConfig(): Promise<GoalsConfig> {
  const data = await hermesFetch<Partial<GoalsConfig>>('/goals');
  return {
    max_turns: typeof data.max_turns === 'number' ? data.max_turns : 20,
    enabled: data.enabled !== false,
  };
}

export async function updateGoalsConfig(body: Partial<GoalsConfig>): Promise<GoalsConfig> {
  const data = await hermesFetch<Partial<GoalsConfig>>('/goals', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return {
    max_turns: typeof data.max_turns === 'number' ? data.max_turns : 20,
    enabled: data.enabled !== false,
  };
}

// ─── Journey / learning graph ─────────────────────────────────────────────

export interface JourneyNode {
  id: string;
  label?: string;
  kind?: string;
  timestamp?: number;
  category?: string;
  useCount?: number;
  state?: string;
  createdBy?: string | null;
  pinned?: boolean;
}

export interface JourneyGraph {
  ok: boolean;
  node_count: number;
  edge_count: number;
  nodes: JourneyNode[];
  edges: Array<Record<string, unknown>>;
  error?: string | null;
}

export async function fetchJourneyGraph(): Promise<JourneyGraph> {
  return hermesFetch<JourneyGraph>('/journey');
}
