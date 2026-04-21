/**
 * Message in a chat request.  Mirrors the OpenAI chat message shape.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * Toolsets the Hermes agent can use.  Anything the bridge recognises is valid;
 * this type lists the common ones for autocomplete.
 */
export type Toolset =
  | "web"
  | "browser"
  | "terminal"
  | "files"
  | "code_execution"
  | "vision"
  | (string & {});

/**
 * Execution mode requested from the bridge.
 * - `agent-loop`: full Hermes agent with tool calling (default)
 * - `passthrough`: direct provider forwarding, no agent loop
 * - `swarm`: architect → implementor → reviewer pipeline
 */
export type ExecutionMode = "agent-loop" | "passthrough" | "swarm";

export interface ChatRequest {
  /** Model ID understood by the bridge (e.g. `meta-llama/llama-4-maverick`). */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** Enabled toolsets — sent via the `x-hermes-toolsets` header. */
  toolsets?: Toolset[];
  /** Execution mode — sent via the `x-hermes-execution-mode` header. */
  executionMode?: ExecutionMode;
  /** Stable conversation ID so the bridge can keep per-session state. */
  conversationId?: string;
  /** Optional GitHub repo context for agent repo-mode. */
  repo?: {
    owner: string;
    name: string;
    /** Personal access token with repo scope — forwarded to the bridge. */
    pat?: string;
    /** Set true if the agent should be allowed to write to the repo. */
    editIntent?: boolean;
  };
  /** Bearer token forwarded via the `Authorization` header. */
  apiKey?: string;
  /** Extra arbitrary headers. */
  extraHeaders?: Record<string, string>;
  /** Abort signal to cancel the stream. */
  signal?: AbortSignal;
}

/** A running tool invocation emitted by the agent. */
export interface ToolActivity {
  tool: string;
  status: "running" | "completed" | "error";
  input: string;
  output: string | null;
}

/** Higher-level phase status from the agent loop. */
export interface AgentStatus {
  phase: "thinking" | "tool_call" | "waiting" | "error" | (string & {});
  label?: string;
  iteration?: number;
  startedAt?: number;
}

/**
 * Events emitted from the streaming chat endpoint.  The bridge sends
 * OpenAI-compatible `chat.completion.chunk` frames whose `delta` may contain
 * any of these extension fields.  This client normalises them into a single
 * discriminated union for ergonomic consumption.
 */
export type HermesEvent =
  | { type: "text"; content: string }
  | { type: "tool_activity"; activity: ToolActivity }
  | { type: "agent_status"; status: AgentStatus }
  | { type: "reasoning"; text: string }
  | { type: "server_tool_event"; event: Record<string, unknown> }
  | { type: "done"; finishReason?: string }
  | { type: "raw"; chunk: Record<string, unknown> };

export interface ModelInfo {
  id: string;
  object: "model";
  owned_by?: string;
}

export interface HealthResponse {
  status: string;
  [key: string]: unknown;
}

export interface SessionSummary {
  id: string;
  status: "active" | "completed" | "error" | (string & {});
  model?: string;
  profile?: string;
  created_at: string;
  updated_at?: string;
  messages: number;
  firstUserMessage?: string;
  repo?: string | null;
  error?: string | null;
}
