/**
 * A tools-only MCP server (streamable HTTP, JSON responses) that Hermes is
 * pointed at through its config.yaml `mcp_servers.nub` entry. This is how the
 * nub tools reach every Hermes transport, including ACP, which ignores
 * Spark's per-request custom tools.
 */

import { NUB_ASK_DESCRIPTION, askNubAgent, nubAgentStatus } from './agent';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
export const ASK_TOOL = 'nub_agent_ask';
export const STATUS_TOOL = 'nub_agent_status';

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export const NUB_MCP_TOOLS = [
  {
    name: ASK_TOOL,
    description: NUB_ASK_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'What to ask or tell the nub agent.' } },
      required: ['message'],
    },
  },
  {
    name: STATUS_TOOL,
    description: 'Check whether Spark is linked to the user\'s nub agent and whether it is running.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

/** One JSON-RPC message in, the response out (null for notifications). */
export async function handleNubMcpMessage(message: unknown): Promise<Record<string, unknown> | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'invalid request');
  }
  const request = message as JsonRpcRequest;
  if (request.id === undefined) return null;
  const id = request.id ?? null;
  const params = request.params ?? {};

  switch (request.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'nub', version: '1.0.0' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: NUB_MCP_TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return rpcResult(id, await callTool(name, args));
    }
    default:
      return rpcError(id, -32601, `method not found: ${String(request.method)}`);
  }
}

async function callTool(name: string, args: Record<string, unknown>) {
  try {
    let text: string;
    if (name === ASK_TOOL) {
      if (typeof args.message !== 'string') throw new Error('`message` is required');
      text = await askNubAgent(args.message);
    } else if (name === STATUS_TOOL) {
      text = await nubAgentStatus();
    } else {
      throw new Error(`unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text }], isError: false };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
