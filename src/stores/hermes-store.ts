import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ApprovalPolicy } from '@/lib/approval-policy';
import type { AcpApprovalRequest } from '@/lib/hermes-api';

export interface HermesToolsets {
  web: boolean;
  browser: boolean;
  vision: boolean;
  computer: boolean;
  terminal: boolean;
  files: boolean;
  code_execution: boolean;
  /** Hermes in-process subagents via delegate_task */
  delegation: boolean;
  /** Ask clarifying questions before acting */
  clarify: boolean;
  /** Hermes context-engine toolset (advanced context compaction) */
  context_engine?: boolean;
  /** Analyze video files (video_analyze) */
  video?: boolean;
  /** Generate video via external providers */
  video_gen?: boolean;
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

// ─── Structured tool-call records (frontend) ────────────────────────────────
// Per-call execution state reduced from the tool_call_begin/delta/end custom
// fields the bridge and server emit. Keyed by call_id. Mirrored into this
// store (per panel) so chat components can render enriched cards without
// prop-drilling through the panel runtime.

export type ToolCallStatus = 'running' | 'completed' | 'failed';

export interface ToolCallRecord {
  callId: string;
  name: string;
  status: ToolCallStatus;
  /** Append-only output chunks, in arrival order. */
  outputChunks: string[];
  /** Joined output so far. */
  output: string;
  exitCode: number | null;
  durationMs: number | null;
  outputTruncated: boolean;
  outputTruncatedLines: number;
}

export type ToolCallRecords = Record<string, ToolCallRecord>;

/** Per-message tool-call records: 'current' while streaming, message id after
 *  the stream finishes (mirrors the toolActivityRef shape in useChat). */
export type ToolCallRecordsByMessage = Record<string, ToolCallRecords>;

/** One-shot UI → useChat runtime action (panel-scoped). The chat components
 *  (tool cards, edit affordance, approval banner) enqueue these; the active
 *  useChat instance consumes them through an effect, like pendingPanelPrompts. */
export type ChatActionRequest =
  | { kind: 'retry_tool'; toolName: string; callId?: string }
  | { kind: 'edit_message'; content: string }
  | { kind: 'approval_audit'; tool: string; command?: string; approved: boolean };

/** Reasoning effort levels accepted by the Hermes agent (hermes_constants.parse_reasoning_effort). */
export type HermesReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';

export const HERMES_REASONING_EFFORTS: HermesReasoningEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
];

interface HermesState {
  toolsets: HermesToolsets;
  /** Legacy Spark-side MCP list (Settings modal). Hermes chat uses config.yaml via the bridge. */
  mcpServers: MCPServer[];
  swarm: SwarmState;
  /** Loop mode state, keyed by panel id so each chat loops independently. */
  loops: Record<string, LoopState>;
  sessionApprovalPolicies: ApprovalPolicy[];
  /**
   * Pending ACP permission requests from the real hermes-agent (approval mode
   * 'acp'), keyed by approval_id. Concurrent prompts can each park a request;
   * the UI resolves the oldest first. Cleared on decision and when the stream
   * reaches a terminal state (finish/error/stop), since a parked request whose
   * stream is gone can no longer be delivered.
   */
  pendingAcpApprovals: Record<string, AcpApprovalRequest>;
  setPendingAcpApproval: (approval: AcpApprovalRequest) => void;
  clearPendingAcpApproval: (approvalId: string) => void;
  clearPendingAcpApprovals: () => void;
  /**
   * The underlying provider the Hermes agent should route to (e.g. 'anthropic',
   * 'deepseek', 'openrouter', or a synthetic CLI id like 'custom:api.bullinf.fun').
   * Empty string means 'auto' — let the bridge route by model-name prefix /
   * config.yaml (including custom base_url). Sent as hermes_provider only when
   * followAgentModel is false.
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

  /**
   * Build custom tool definitions from the legacy Spark zustand MCP list (Settings modal).
   * Hermes chat uses config.yaml MCP via the bridge — not this path.
   */
  getCustomToolDefinitions: () => CustomToolDefinition[];

  /** When true, Hermes chat runs in an isolated git worktree (local repo required). */
  useWorktree: boolean;
  setUseWorktree: (enabled: boolean) => void;

  /** Phase 7: opt-in gateway /v1/runs transport (default off). */
  useRuns: boolean;
  setUseRuns: (enabled: boolean) => void;

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

  /** Structured tool-call records per panel (non-persisted runtime mirror). */
  toolCallRecordsByPanel: Record<string, ToolCallRecordsByMessage>;
  setToolCallRecords: (panelId: string, records: ToolCallRecordsByMessage) => void;

  /**
   * What the transport serving each panel's current turn can honor, from the
   * bridge's transport_status event (hardening spec 4.8). Absent means
   * unknown (not a Hermes turn, or an older bridge): affordances stay as-is.
   * Non-persisted.
   */
  transportCapabilitiesByPanel: Record<string, HermesTransportCapabilities>;
  setTransportCapabilities: (panelId: string, capabilities: HermesTransportCapabilities | null) => void;

  /** One-shot chat UI → useChat action requests per panel (non-persisted). */
  pendingChatActions: Record<string, ChatActionRequest[]>;
  requestChatAction: (panelId: string, action: ChatActionRequest) => void;
  setPendingChatActions: (panelId: string, actions: ChatActionRequest[]) => void;
}

/** One row of the bridge's transport capability matrix (spec 4.8). */
export interface HermesTransportCapabilities {
  approvals: boolean;
  cancel: boolean;
  stopsOnClientDisconnect: boolean;
  usageInStream: boolean;
  sessionResume: boolean;
}

const defaultToolsets: HermesToolsets = {
  web: true,
  browser: true,
  vision: true,
  computer: true,
  terminal: true,
  files: true,
  code_execution: true,
  delegation: true,
  clarify: true,
  context_engine: false,
  video: false,
  video_gen: false,
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
      pendingAcpApprovals: {},
      toolCallRecordsByPanel: {},
      transportCapabilitiesByPanel: {},
      pendingChatActions: {},
      underlyingProvider: '',
      followAgentModel: true,
      reasoningEffort: 'medium',
      useWorktree: false,
      useRuns: false,

      setToolset: (key, enabled) =>
        set((state) => {
          const toolsets = { ...state.toolsets, [key]: enabled };
          // Computer Use has no screenshot payloads on /v1/runs — turning it on
          // while Runs is enabled would silently force agent-loop. Drop Runs so
          // the transport toggle matches what chat actually does.
          const useRuns =
            key === 'computer' && enabled && state.useRuns ? false : state.useRuns;
          return { toolsets, useRuns };
        }),

      setUnderlyingProvider: (provider) =>
        set(() => ({ underlyingProvider: provider })),

      setFollowAgentModel: (follow) =>
        set(() => ({ followAgentModel: follow })),

      setReasoningEffort: (effort) =>
        set(() => ({ reasoningEffort: effort })),

      setUseWorktree: (enabled) =>
        set(() => ({ useWorktree: enabled })),

      setUseRuns: (enabled) =>
        set((state) => {
          if (!enabled) return { useRuns: false };
          // Gateway /v1/runs cannot stream Computer Use screenshots. Auto-disable
          // CU so enabling Runs actually routes via the gateway when other gates pass.
          if (state.toolsets.computer) {
            return {
              useRuns: true,
              toolsets: { ...state.toolsets, computer: false },
            };
          }
          return { useRuns: true };
        }),

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

      setPendingAcpApproval: (approval) =>
        set((state) => ({
          pendingAcpApprovals: {
            ...state.pendingAcpApprovals,
            [approval.approval_id]: approval,
          },
        })),

      clearPendingAcpApproval: (approvalId) =>
        set((state) => {
          if (!(approvalId in state.pendingAcpApprovals)) return state;
          const next = { ...state.pendingAcpApprovals };
          delete next[approvalId];
          return { pendingAcpApprovals: next };
        }),

      clearPendingAcpApprovals: () =>
        set(() => ({ pendingAcpApprovals: {} })),

      setTransportCapabilities: (panelId, capabilities) =>
        set((state) => {
          const prev = state.transportCapabilitiesByPanel[panelId];
          if (!capabilities) {
            if (!prev) return state;
            const next = { ...state.transportCapabilitiesByPanel };
            delete next[panelId];
            return { transportCapabilitiesByPanel: next };
          }
          if (
            prev &&
            prev.approvals === capabilities.approvals &&
            prev.cancel === capabilities.cancel &&
            prev.stopsOnClientDisconnect === capabilities.stopsOnClientDisconnect &&
            prev.usageInStream === capabilities.usageInStream &&
            prev.sessionResume === capabilities.sessionResume
          ) {
            return state;
          }
          return {
            transportCapabilitiesByPanel: {
              ...state.transportCapabilitiesByPanel,
              [panelId]: capabilities,
            },
          };
        }),

      setToolCallRecords: (panelId, records) =>
        set((state) => {
          const prev = state.toolCallRecordsByPanel[panelId];
          if (prev === records) return state;
          return {
            toolCallRecordsByPanel: {
              ...state.toolCallRecordsByPanel,
              [panelId]: records,
            },
          };
        }),

      requestChatAction: (panelId, action) =>
        set((state) => ({
          pendingChatActions: {
            ...state.pendingChatActions,
            [panelId]: [...(state.pendingChatActions[panelId] ?? []), action],
          },
        })),

      setPendingChatActions: (panelId, actions) =>
        set((state) => ({
          pendingChatActions: {
            ...state.pendingChatActions,
            [panelId]: actions,
          },
        })),
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
        useWorktree: state.useWorktree,
        useRuns: state.useRuns,
      }),
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<HermesState>) };
        // Backward compatibility: drop the legacy global `loop` slice (loop
        // state is now per-panel under `loops`).
        delete (merged as Record<string, unknown>).loop;
        if (!merged.loops) merged.loops = {};
        // Transient runtime slices — never persisted, but ensure they exist
        // when rehydrating from an older persisted snapshot.
        if (!merged.toolCallRecordsByPanel) merged.toolCallRecordsByPanel = {};
        if (!merged.transportCapabilitiesByPanel) merged.transportCapabilitiesByPanel = {};
        if (!merged.pendingChatActions) merged.pendingChatActions = {};
        // Ensure new toolset keys default on for existing installs
        merged.toolsets = { ...defaultToolsets, ...(merged.toolsets || {}) };
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
