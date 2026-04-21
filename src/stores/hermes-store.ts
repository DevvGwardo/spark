import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface HermesToolsets {
  web: boolean;
  browser: boolean;
  vision: boolean;
  terminal: boolean;
  files: boolean;
  code_execution: boolean;
}

/** A single tool exposed by an MCP server. */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** An MCP server configured by the user. */
export interface MCPServer {
  id: string;
  name: string;
  url: string;
  apiKey?: string;
  enabled: boolean;
  tools: MCPTool[];
}

/** Wire format sent to hermes-bridge for each custom tool. */
export interface CustomToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  /** Which MCP server owns this tool (for execution routing). */
  mcp_server_id: string;
  mcp_server_url: string;
  mcp_server_api_key?: string;
}

/** Swarm pipeline phase tracker. */
export type SwarmPhase = 'idle' | 'architect' | 'implementor' | 'reviewer' | 'done' | 'error';

export interface SwarmState {
  enabled: boolean;
  phase: SwarmPhase;
  verdict: string | null;
  reviewNotes: string | null;
  stagedFiles: string[];
  elapsedMs: number | null;
}

interface HermesState {
  toolsets: HermesToolsets;
  mcpServers: MCPServer[];
  swarm: SwarmState;

  setToolset: (key: keyof HermesToolsets, enabled: boolean) => void;
  getEnabledToolsets: () => string[];

  addMCPServer: (server: MCPServer) => void;
  removeMCPServer: (id: string) => void;
  updateMCPServer: (id: string, patch: Partial<Omit<MCPServer, 'id'>>) => void;
  toggleMCPServer: (id: string) => void;
  setMCPServerTools: (id: string, tools: MCPTool[]) => void;

  /** Build the custom tool definitions for all enabled MCP servers. */
  getCustomToolDefinitions: () => CustomToolDefinition[];

  /** Swarm mode controls. */
  setSwarmEnabled: (enabled: boolean) => void;
  setSwarmPhase: (phase: SwarmPhase) => void;
  setSwarmResult: (result: { verdict: string; reviewNotes: string; stagedFiles: string[]; elapsedMs: number }) => void;
  resetSwarm: () => void;
}

const defaultToolsets: HermesToolsets = {
  web: true,
  browser: true,
  vision: true,
  terminal: true,
  files: true,
  code_execution: true,
};

const defaultSwarm: SwarmState = {
  enabled: false,
  phase: 'idle',
  verdict: null,
  reviewNotes: null,
  stagedFiles: [],
  elapsedMs: null,
};

export const useHermesStore = create<HermesState>()(
  persist(
    (set, get) => ({
      toolsets: { ...defaultToolsets },
      mcpServers: [],
      swarm: { ...defaultSwarm },

      setToolset: (key, enabled) =>
        set((state) => ({
          toolsets: { ...state.toolsets, [key]: enabled },
        })),

      getEnabledToolsets: () => {
        const ts = get().toolsets;
        return Object.entries(ts)
          .filter(([, v]) => v)
          .map(([k]) => k);
      },

      addMCPServer: (server) =>
        set((state) => ({
          mcpServers: [...state.mcpServers, server],
        })),

      removeMCPServer: (id) =>
        set((state) => ({
          mcpServers: state.mcpServers.filter((s) => s.id !== id),
        })),

      updateMCPServer: (id, patch) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) =>
            s.id === id ? { ...s, ...patch } : s
          ),
        })),

      toggleMCPServer: (id) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) =>
            s.id === id ? { ...s, enabled: !s.enabled } : s
          ),
        })),

      setMCPServerTools: (id, tools) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) =>
            s.id === id ? { ...s, tools } : s
          ),
        })),

      getCustomToolDefinitions: () => {
        const servers = get().mcpServers.filter((s) => s.enabled && s.tools.length > 0);
        const defs: CustomToolDefinition[] = [];
        for (const server of servers) {
          for (const tool of server.tools) {
            defs.push({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
              mcp_server_id: server.id,
              mcp_server_url: server.url,
              mcp_server_api_key: server.apiKey,
            });
          }
        }
        return defs;
      },

      setSwarmEnabled: (enabled) =>
        set((state) => ({
          swarm: { ...state.swarm, enabled, ...(enabled ? {} : defaultSwarm) },
        })),

      setSwarmPhase: (phase) =>
        set((state) => ({
          swarm: { ...state.swarm, phase },
        })),

      setSwarmResult: (result) =>
        set((state) => ({
          swarm: {
            ...state.swarm,
            phase: 'done',
            verdict: result.verdict,
            reviewNotes: result.reviewNotes,
            stagedFiles: result.stagedFiles,
            elapsedMs: result.elapsedMs,
          },
        })),

      resetSwarm: () =>
        set(() => ({
          swarm: { ...defaultSwarm, enabled: get().swarm.enabled },
        })),
    }),
    { name: 'cloudchat-hermes' }
  )
);
