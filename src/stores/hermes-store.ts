import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ApprovalPolicy } from '@/lib/approval-policy';

export interface HermesToolsets {
  web: boolean;
  browser: boolean;
  vision: boolean;
  computer: boolean;
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
/** Transport type for an MCP server connection. */
export type MCPTransportType = 'http' | 'stdio';

/** Connection health for an MCP server. */
export type MCPConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface MCPServer {
  id: string;
  name: string;
  url: string;
  apiKey?: string;
  enabled: boolean;
  tools: MCPTool[];
  /** Transport protocol used to connect. */
  transportType: MCPTransportType;
  /** Current connection health. */
  connectionStatus: MCPConnectionStatus;
  /** Number of consecutive errors (circuit breaker). */
  errorCount: number;
  /** Timestamp of last successful connection (ISO string). */
  lastConnectedAt?: string;
  /** Last error message, if any. */
  lastError?: string;
  /** Stdio command (for stdio transport). */
  command?: string;
  /** Stdio args (for stdio transport). */
  args?: string[];
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

/** Loop mode phase tracker. */
export type LoopPhase = 'idle' | 'agent' | 'judge' | 'done' | 'stopped' | 'error';

export interface LoopConfig {
  /** Hard cap on agent iterations (always enforced). */
  maxIterations: number;
  /** Optional wall-clock budget in minutes; null = no time limit. */
  timeBudgetMinutes: number | null;
}

export interface LoopState {
  enabled: boolean;
  config: LoopConfig;
  phase: LoopPhase;
  iteration: number;
  /** Why the loop stopped ('verdict-met', 'max-iterations', 'time-budget'). */
  stopReason: string | null;
}

/** Reasoning effort levels accepted by the Hermes agent (hermes_constants.parse_reasoning_effort). */
export type HermesReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export const HERMES_REASONING_EFFORTS: HermesReasoningEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
];

interface HermesState {
  toolsets: HermesToolsets;
  mcpServers: MCPServer[];
  swarm: SwarmState;
  /** Loop mode state, keyed by panel id so each chat loops independently. */
  loops: Record<string, LoopState>;
  sessionApprovalPolicies: ApprovalPolicy[];
  /**
   * The underlying provider the Hermes agent should route to (e.g. 'anthropic',
   * 'deepseek', 'openrouter'). Empty string means 'auto' — let the bridge route
   * by model-name prefix / config. Sent to the bridge as the hermes_provider field.
   */
  underlyingProvider: string;

  /**
   * When true (default), Spark's hermes model tracks the agent's CLI-configured
   * default (config.yaml `model.default`) and updates when it changes in the
   * terminal. Picking a specific model in the in-app picker sets this false so
   * the pick sticks; choosing "Agent default" sets it back to true.
   */
  followAgentModel: boolean;

  setToolset: (key: keyof HermesToolsets, enabled: boolean) => void;
  getEnabledToolsets: () => string[];

  /** Set the underlying provider for the Hermes agent ('' = auto). */
  setUnderlyingProvider: (provider: string) => void;

  /** Toggle whether the hermes model follows the agent's CLI default. */
  setFollowAgentModel: (follow: boolean) => void;

  /** Reasoning effort sent to the Hermes agent (Faster ↔ Smarter slider). */
  reasoningEffort: HermesReasoningEffort;
  setReasoningEffort: (effort: HermesReasoningEffort) => void;

  addMCPServer: (server: MCPServer) => void;
  removeMCPServer: (id: string) => void;
  updateMCPServer: (id: string, patch: Partial<Omit<MCPServer, 'id'>>) => void;
  toggleMCPServer: (id: string) => void;
  setMCPServerTools: (id: string, tools: MCPTool[]) => void;
  setMCPServerConnectionStatus: (id: string, status: MCPConnectionStatus, error?: string) => void;
  bumpMCPServerError: (id: string, error: string) => void;
  resetMCPServerErrors: (id: string) => void;

  /** Build the custom tool definitions for all enabled MCP servers. */
  getCustomToolDefinitions: () => CustomToolDefinition[];

  /** Loop mode controls — scoped per panel id. */
  getLoop: (panelId: string) => LoopState;
  setLoopEnabled: (panelId: string, enabled: boolean) => void;
  setLoopConfig: (panelId: string, config: Partial<LoopConfig>) => void;
  setLoopStatus: (panelId: string, status: { phase: LoopPhase; iteration: number; stopReason?: string | null }) => void;
  resetLoop: (panelId: string) => void;

  /** Swarm mode controls. */
  setSwarmEnabled: (enabled: boolean) => void;
  setSwarmPhase: (phase: SwarmPhase) => void;
  setSwarmResult: (result: { verdict: string; reviewNotes: string; stagedFiles: string[]; elapsedMs: number }) => void;
  resetSwarm: () => void;

  /** Session-scope approval policies — in-memory only, cleared on panel close. */
  addSessionApprovalPolicy: (policy: ApprovalPolicy) => void;
  clearSessionApprovalPolicies: () => void;
}

const defaultToolsets: HermesToolsets = {
  web: true,
  browser: true,
  vision: true,
  computer: true,
  terminal: true,
  files: true,
  code_execution: true,
};

export const DEFAULT_LOOP_STATE: LoopState = {
  enabled: false,
  config: { maxIterations: 5, timeBudgetMinutes: null },
  phase: 'idle',
  iteration: 0,
  stopReason: null,
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
      loops: {},
      sessionApprovalPolicies: [],
      underlyingProvider: '',
      followAgentModel: true,
      reasoningEffort: 'medium',

      setToolset: (key, enabled) =>
        set((state) => ({
          toolsets: { ...state.toolsets, [key]: enabled },
        })),

      setUnderlyingProvider: (provider) =>
        set(() => ({ underlyingProvider: provider })),

      setFollowAgentModel: (follow) =>
        set(() => ({ followAgentModel: follow })),

      setReasoningEffort: (effort) =>
        set(() => ({ reasoningEffort: effort })),

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

      setMCPServerConnectionStatus: (id, status, error) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) =>
            s.id === id ? {
              ...s,
              connectionStatus: status,
              ...(status === 'connected' ? { lastConnectedAt: new Date().toISOString(), errorCount: 0, lastError: undefined } : {}),
              ...(status === 'error' && error ? { lastError: error } : {}),
            } : s
          ),
        })),

      bumpMCPServerError: (id, error) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) =>
            s.id === id ? {
              ...s,
              errorCount: s.errorCount + 1,
              lastError: error,
              connectionStatus: (s.errorCount + 1) >= 3 ? 'error' as MCPConnectionStatus : s.connectionStatus,
            } : s
          ),
        })),

      resetMCPServerErrors: (id) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) =>
            s.id === id ? { ...s, errorCount: 0, lastError: undefined, connectionStatus: 'connected' as MCPConnectionStatus } : s
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

      getLoop: (panelId) => get().loops[panelId] ?? DEFAULT_LOOP_STATE,

      setLoopEnabled: (panelId, enabled) =>
        set((state) => {
          const loop = state.loops[panelId] ?? DEFAULT_LOOP_STATE;
          return {
            loops: {
              ...state.loops,
              [panelId]: enabled
                ? { ...loop, enabled, phase: 'idle', iteration: 0, stopReason: null }
                : { ...DEFAULT_LOOP_STATE, config: loop.config },
            },
          };
        }),

      setLoopConfig: (panelId, config) =>
        set((state) => {
          const loop = state.loops[panelId] ?? DEFAULT_LOOP_STATE;
          return {
            loops: {
              ...state.loops,
              [panelId]: { ...loop, config: { ...loop.config, ...config } },
            },
          };
        }),

      setLoopStatus: (panelId, { phase, iteration, stopReason }) =>
        set((state) => {
          const loop = state.loops[panelId] ?? DEFAULT_LOOP_STATE;
          return {
            loops: {
              ...state.loops,
              [panelId]: { ...loop, phase, iteration, stopReason: stopReason ?? loop.stopReason },
            },
          };
        }),

      resetLoop: (panelId) =>
        set((state) => {
          const loop = state.loops[panelId] ?? DEFAULT_LOOP_STATE;
          return {
            loops: {
              ...state.loops,
              [panelId]: { ...DEFAULT_LOOP_STATE, enabled: loop.enabled, config: loop.config },
            },
          };
        }),

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

      addSessionApprovalPolicy: (policy) =>
        set((state) => ({
          sessionApprovalPolicies: [
            ...state.sessionApprovalPolicies.filter((p) => p.key !== policy.key),
            policy,
          ],
        })),

      clearSessionApprovalPolicies: () =>
        set(() => ({ sessionApprovalPolicies: [] })),
    }),
    {
      name: 'cloudchat-hermes',
      partialize: (state) => ({
        toolsets: state.toolsets,
        mcpServers: state.mcpServers,
        swarm: state.swarm,
        loops: Object.fromEntries(
          Object.entries(state.loops).map(([panelId, loop]) => [
            panelId,
            { ...loop, phase: 'idle' as LoopPhase, iteration: 0, stopReason: null },
          ])
        ),
        underlyingProvider: state.underlyingProvider,
        followAgentModel: state.followAgentModel,
        reasoningEffort: state.reasoningEffort,
      }),
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<HermesState>) };
        // Backward compatibility: drop the legacy global `loop` slice (loop
        // state is now per-panel under `loops`).
        delete (merged as Record<string, unknown>).loop;
        if (!merged.loops) merged.loops = {};
        // Backward compatibility: ensure MCP servers have new required fields
        if (merged.mcpServers) {
          merged.mcpServers = merged.mcpServers.map((s) => ({
            ...s,
            transportType: s.transportType ?? ('http' as MCPTransportType),
            connectionStatus: s.connectionStatus ?? ('disconnected' as MCPConnectionStatus),
            errorCount: s.errorCount ?? 0,
          }));
        }
        return merged;
      },
    }
  )
);
