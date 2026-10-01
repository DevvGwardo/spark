import { hermesFetch } from './core';

// ─── MCP servers (hermes-agent config.yaml) ─────────────────────────────────

/** An MCP server installed in the hermes-agent's config.yaml. Secrets are
 *  redacted by the bridge (env_keys lists names only). */
export interface HermesMcpServerInfo {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  env_keys: string[];
  tool_count: number;
  /** Non-null when this server came from the curated store catalog (removable). */
  catalog_id: string | null;
}

/** A curated, one-click-installable MCP server. */
export interface HermesMcpCatalogEntry {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  runtime: string;
  requires_param: { key: string; label: string; placeholder: string; default: string } | null;
  docs_url: string;
}

/** MCP servers currently installed for the hermes-agent (read from config.yaml). */
export async function fetchHermesMcpServers(): Promise<HermesMcpServerInfo[]> {
  const data = await hermesFetch<{ servers: HermesMcpServerInfo[] }>('/workspace/mcp-servers');
  return data.servers ?? [];
}

/** The curated catalog of MCP servers a user can install with one click. */
export async function fetchHermesMcpCatalog(): Promise<HermesMcpCatalogEntry[]> {
  const data = await hermesFetch<{ catalog: HermesMcpCatalogEntry[] }>('/workspace/mcp-catalog');
  return data.catalog ?? [];
}

/** Install a curated MCP server into the agent's config.yaml and reload it. */
export async function installHermesMcpServer(
  id: string,
  param?: string,
): Promise<{ ok: boolean; installed: string; reloaded: boolean }> {
  return hermesFetch('/workspace/mcp-servers/install', {
    method: 'POST',
    body: JSON.stringify(param ? { id, param } : { id }),
  });
}

/** Remove a store-installed MCP server (agent-managed servers stay read-only). */
export async function uninstallHermesMcpServer(
  name: string,
): Promise<{ ok: boolean; removed: string; reloaded: boolean }> {
  return hermesFetch(`/workspace/mcp-servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** One entry in the searchable MCP tool index (from the agent registry). */
export interface HermesMcpToolIndexEntry {
  server: string;
  name: string;
  description: string;
}

/** Context threshold above which we warn that MCP tools may bloat agent context. */
export const MCP_TOOL_CONTEXT_THRESHOLD = 40;

/** Fetch flattened MCP tools (name + description) for the searchable index. */
export async function fetchHermesMcpToolIndex(): Promise<{
  tools: HermesMcpToolIndexEntry[];
  total: number;
}> {
  const data = await hermesFetch<{ tools?: HermesMcpToolIndexEntry[]; total?: number }>(
    '/workspace/mcp-tool-index',
  );
  const tools = data.tools ?? [];
  return { tools, total: data.total ?? tools.length };
}

/** Hermes progressive tool disclosure config (`tools.tool_search` in config.yaml). */
export interface ToolSearchConfig {
  /** `auto` defers when over threshold; `on` always defers; `off` disables. */
  enabled: 'auto' | 'on' | 'off';
  /** Convenience mirror of enabled !== 'off'. */
  defer: boolean;
  threshold_pct: number;
  search_default_limit: number;
  max_search_limit: number;
}

export async function fetchToolSearchConfig(): Promise<ToolSearchConfig> {
  const data = await hermesFetch<Partial<ToolSearchConfig>>('/tool-search');
  return {
    enabled: (data.enabled as ToolSearchConfig['enabled']) ?? 'auto',
    defer: data.defer ?? data.enabled !== 'off',
    threshold_pct: data.threshold_pct ?? 10,
    search_default_limit: data.search_default_limit ?? 5,
    max_search_limit: data.max_search_limit ?? 20,
  };
}

export async function updateToolSearchConfig(
  body: Partial<Pick<ToolSearchConfig, 'defer' | 'enabled' | 'threshold_pct'>>,
): Promise<ToolSearchConfig> {
  const data = await hermesFetch<Partial<ToolSearchConfig>>('/tool-search', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return {
    enabled: (data.enabled as ToolSearchConfig['enabled']) ?? 'auto',
    defer: data.defer ?? data.enabled !== 'off',
    threshold_pct: data.threshold_pct ?? 10,
    search_default_limit: data.search_default_limit ?? 5,
    max_search_limit: data.max_search_limit ?? 20,
  };
}

// ─── MCP live telemetry (dashboard) ─────────────────────────────────────────

/** Live connection status for one MCP server (from the agent's in-process MCP layer). */
export interface HermesMcpLiveStatus {
  name: string;
  transport: 'stdio' | 'http';
  tools: number;
  connected: boolean;
  disabled: boolean;
  status: 'connected' | 'connecting' | 'disabled' | 'failed' | 'configured' | string;
  error?: string;
}

/** A single recorded MCP tool call. */
export interface HermesMcpCall {
  server: string;
  tool: string;
  ts: number;
  latency_ms: number | null;
  ok: boolean;
  input: string;
  output: string;
}

/** Per-server tool-call metrics. ``buckets`` are [epochMinute, calls, errors]. */
export interface HermesMcpServerStats {
  calls: number;
  errors: number;
  avg_latency_ms: number | null;
  last_call_at: number | null;
  last_tool: string | null;
  last_error: string | null;
  recent: HermesMcpCall[];
  buckets: [number, number, number][];
}

/** Full live telemetry snapshot powering the MCP dashboard. */
export interface HermesMcpTelemetry {
  generated_at: number;
  tracking_since: number;
  status: HermesMcpLiveStatus[];
  tools: Record<string, string[]>;
  servers: Record<string, HermesMcpServerStats>;
  recent: HermesMcpCall[];
}

/** Fetch the live MCP telemetry snapshot (status + per-server metrics + activity). */
export async function fetchHermesMcpTelemetry(): Promise<HermesMcpTelemetry> {
  return hermesFetch<HermesMcpTelemetry>('/workspace/mcp-telemetry');
}

/** A single tailed MCP stderr log line for one server. */
export interface HermesMcpLogLine {
  ts: string | null;
  line: string;
  marker: boolean;
}

/** Tail a single MCP server's stderr log (most recent lines). */
export async function fetchHermesMcpServerLogs(
  name: string,
  limit = 200,
): Promise<HermesMcpLogLine[]> {
  const data = await hermesFetch<{ server: string; lines: HermesMcpLogLine[] }>(
    `/workspace/mcp-servers/${encodeURIComponent(name)}/logs?limit=${limit}`,
  );
  return data.lines ?? [];
}
