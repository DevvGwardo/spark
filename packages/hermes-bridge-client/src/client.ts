import { HermesError } from "./errors.js";
import { parseSSE } from "./sse.js";
import type {
  ChatRequest,
  HealthResponse,
  HermesEvent,
  ModelInfo,
  SessionSummary,
} from "./types.js";

export interface HermesClientOptions {
  /**
   * Base URL of the Hermes bridge.  Defaults to `http://localhost:3002`.
   * Do not include a trailing `/v1` — the client appends paths itself.
   */
  baseUrl?: string;
  /** Default bearer token applied to every request (can be overridden per-call). */
  apiKey?: string;
  /** Default headers merged into every request. */
  defaultHeaders?: Record<string, string>;
  /** Custom `fetch` implementation.  Defaults to global `fetch` (Node 20+). */
  fetch?: typeof fetch;
}

export class HermesClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HermesClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:3002").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.fetchImpl = options.fetch ?? fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "hermes-bridge-client: no `fetch` available. Pass `{ fetch }` in options or run on Node 20+.",
      );
    }
  }

  /** GET /health — liveness check. */
  async health(): Promise<HealthResponse> {
    return this.getJSON<HealthResponse>("/health");
  }

  /** GET /v1/models — list available models advertised by the bridge. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await this.getJSON<{ data: ModelInfo[] }>("/v1/models");
    return res.data ?? [];
  }

  /** GET /sessions — list tracked chat sessions. */
  async listSessions(): Promise<SessionSummary[]> {
    const res = await this.getJSON<{ sessions: SessionSummary[] } | SessionSummary[]>(
      "/sessions",
    );
    return Array.isArray(res) ? res : (res.sessions ?? []);
  }

  /** GET /sessions/:id — fetch a single session (full chat log). */
  async getSession(id: string): Promise<SessionSummary & { chat?: unknown[] }> {
    return this.getJSON(`/sessions/${encodeURIComponent(id)}`);
  }

  /** DELETE /sessions/:id — remove a tracked session. */
  async deleteSession(id: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.buildHeaders(),
    });
    if (!res.ok) throw await this.toError(res);
  }

  /**
   * Stream a chat completion.  Yields normalised `HermesEvent`s in arrival
   * order.  The generator ends when the bridge emits `[DONE]` or the response
   * stream closes.
   *
   * ```ts
   * for await (const ev of client.chat({ model, messages: [...] })) {
   *   if (ev.type === "text") process.stdout.write(ev.content);
   * }
   * ```
   */
  async *chat(request: ChatRequest): AsyncGenerator<HermesEvent, void, unknown> {
    const headers = this.buildHeaders({
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(request.apiKey
        ? { authorization: `Bearer ${request.apiKey}` }
        : this.apiKey
          ? { authorization: `Bearer ${this.apiKey}` }
          : {}),
      ...(request.toolsets?.length
        ? { "x-hermes-toolsets": request.toolsets.join(",") }
        : {}),
      ...(request.executionMode
        ? { "x-hermes-execution-mode": request.executionMode }
        : {}),
      ...(request.conversationId
        ? { "x-hermes-conversation-id": request.conversationId }
        : {}),
      ...(request.repo
        ? {
            "x-hermes-repo-owner": request.repo.owner,
            "x-hermes-repo-name": request.repo.name,
            ...(request.repo.pat ? { "x-hermes-github-pat": request.repo.pat } : {}),
            ...(request.repo.editIntent ? { "x-hermes-repo-edit-intent": "1" } : {}),
          }
        : {}),
      ...(request.extraHeaders ?? {}),
    });

    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens,
      stream: true,
      conversation_id: request.conversationId,
    });

    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body,
      signal: request.signal,
    });

    if (!res.ok || !res.body) throw await this.toError(res);

    for await (const payload of parseSSE(res.body)) {
      if (payload === "[DONE]") {
        yield { type: "done" };
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // Skip malformed frames rather than throwing — matches EventSource behaviour.
        continue;
      }

      yield* this.normalize(parsed);
    }
  }

  /**
   * Translate an OpenAI-compatible delta chunk into one or more `HermesEvent`s.
   * A single chunk can carry multiple extension fields, so this yields each
   * independently.
   */
  private *normalize(chunk: Record<string, unknown>): Generator<HermesEvent> {
    const choices = (chunk.choices as Array<Record<string, unknown>>) ?? [];
    const first = choices[0];
    if (!first) {
      yield { type: "raw", chunk };
      return;
    }

    const delta = (first.delta as Record<string, unknown>) ?? {};
    const finishReason = (first.finish_reason as string | null | undefined) ?? undefined;

    let emitted = false;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text", content: delta.content };
      emitted = true;
    }
    if (delta.tool_activity && typeof delta.tool_activity === "object") {
      yield {
        type: "tool_activity",
        activity: delta.tool_activity as HermesEvent extends { activity: infer A } ? A : never,
      };
      emitted = true;
    }
    if (delta.agent_status && typeof delta.agent_status === "object") {
      yield { type: "agent_status", status: delta.agent_status as never };
      emitted = true;
    }
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
      yield { type: "reasoning", text: delta.reasoning };
      emitted = true;
    }
    if (delta.server_tool_event && typeof delta.server_tool_event === "object") {
      yield {
        type: "server_tool_event",
        event: delta.server_tool_event as Record<string, unknown>,
      };
      emitted = true;
    }

    if (finishReason) {
      yield { type: "done", finishReason };
      emitted = true;
    }

    if (!emitted) yield { type: "raw", chunk };
  }

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.defaultHeaders, ...extra };
  }

  private async getJSON<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.buildHeaders({
        accept: "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      }),
    });
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as T;
  }

  private async toError(res: Response): Promise<HermesError> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        body = undefined;
      }
    }
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Hermes bridge request failed: ${res.status} ${res.statusText}`;
    return new HermesError(message, res.status, body);
  }
}
