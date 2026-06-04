/**
 * Shared MCP server connection utilities.
 *
 * Centralises the JSON-RPC `tools/list` discovery flow so both the sidebar
 * panel and the settings modal use the same connection + status-tracking code.
 */

import { useHermesStore, type MCPTool } from '@/stores/hermes-store';

/**
 * Result of a successful MCP tools/list discovery.
 */
export interface MCPDiscoverResult {
  tools: MCPTool[];
}

/**
 * Options for the connect flow.
 */
export interface MCPConnectOptions {
  /** The MCPServer id in the hermes store. */
  serverId: string;
  /** The server URL (HTTP endpoint for JSON-RPC). */
  url: string;
  /** Optional bearer token for the Authorization header. */
  apiKey?: string;
}

/**
 * Send a JSON-RPC `tools/list` request to an MCP server and normalise the
 * response into `MCPTool[]`.  Updates the hermes store connection status
 * automatically (connecting → connected | error).
 *
 * Returns the discovered tools on success, or `null` on failure (the store
 * is already updated with the error status in that case).
 */
export async function discoverMCPTools(
  options: MCPConnectOptions,
): Promise<MCPTool[] | null> {
  const { serverId, url, apiKey } = options;
  const store = useHermesStore.getState();

  store.setMCPServerConnectionStatus(serverId, 'connecting');

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    const tools: MCPTool[] = (data.result?.tools ?? [])
      .filter(
        (t: unknown): t is { name: string; description?: string; inputSchema?: Record<string, unknown> } =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as { name?: unknown }).name === 'string',
      )
      .map(
        (t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        }),
      );

    store.setMCPServerTools(serverId, tools);
    // setMCPServerConnectionStatus('connected') already resets errorCount
    store.setMCPServerConnectionStatus(serverId, 'connected');
    return tools;
  } catch (e) {
    const message = `Failed to connect: ${e instanceof Error ? e.message : String(e)}`;
    store.setMCPServerConnectionStatus(serverId, 'error', message);
    return null;
  }
}

/**
 * Connect to all enabled HTTP MCP servers in parallel. Useful for a
 * "refresh all" action.
 */
export function discoverAllMCPTools(): Promise<(MCPTool[] | null)[]> {
  const servers = useHermesStore.getState().mcpServers.filter(
    (s) => s.enabled && s.transportType === 'http',
  );
  return Promise.all(
    servers.map((s) => discoverMCPTools({ serverId: s.id, url: s.url, apiKey: s.apiKey })),
  );
}
