# hermes-bridge-client

TypeScript client for the **CloudChat Hermes bridge** — an OpenAI-compatible SSE
endpoint that front-ends the [Nous Research Hermes
Agent](https://hermes-agent.nousresearch.com) with agent-loop, passthrough, and
swarm execution modes.

Use this if you want to talk to your own running `hermes-bridge` from a
TypeScript app without reimplementing the SSE parser and the custom
`x-hermes-*` header contract.

## Install

```bash
npm install hermes-bridge-client
```

Requires Node 20+ (uses built-in `fetch` + `ReadableStream`).

## Quick start

```ts
import { HermesClient } from "hermes-bridge-client";

const client = new HermesClient({ baseUrl: "http://localhost:3002" });

for await (const event of client.chat({
  model: "meta-llama/llama-4-maverick",
  messages: [{ role: "user", content: "find all TODO comments in this repo" }],
  toolsets: ["files", "terminal"],
  executionMode: "agent-loop",
  conversationId: "demo-session-1",
})) {
  switch (event.type) {
    case "text":
      process.stdout.write(event.content);
      break;
    case "tool_activity":
      console.log(`\n[${event.activity.status}] ${event.activity.tool}`);
      break;
    case "agent_status":
      console.log(`\n[status] ${event.status.label ?? event.status.phase}`);
      break;
    case "done":
      console.log("\n(done)");
      break;
  }
}
```

## API

### `new HermesClient(options?)`

| Option           | Default                    | Description                                        |
|------------------|----------------------------|----------------------------------------------------|
| `baseUrl`        | `http://localhost:3002`    | Bridge URL. Do **not** include `/v1` — paths are added by the client. |
| `apiKey`         | —                          | Bearer token applied to every request.             |
| `defaultHeaders` | `{}`                       | Headers merged into every request.                 |
| `fetch`          | global `fetch`             | Custom fetch implementation (e.g. for undici/polyfill). |

### `client.chat(request)`

Returns an `AsyncGenerator<HermesEvent>`.

```ts
interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  toolsets?: Toolset[];          // → x-hermes-toolsets
  executionMode?: ExecutionMode; // → x-hermes-execution-mode
  conversationId?: string;       // → x-hermes-conversation-id
  repo?: { owner; name; pat?; editIntent? };
  apiKey?: string;               // per-call override
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
}
```

Events:

```ts
type HermesEvent =
  | { type: "text";              content: string }
  | { type: "tool_activity";     activity: ToolActivity }
  | { type: "agent_status";      status: AgentStatus }
  | { type: "reasoning";         text: string }
  | { type: "server_tool_event"; event: Record<string, unknown> }
  | { type: "done";              finishReason?: string }
  | { type: "raw";               chunk: Record<string, unknown> };  // fallback for unknown shapes
```

### Other methods

| Method                     | Wraps                 |
|----------------------------|-----------------------|
| `client.health()`          | `GET /health`         |
| `client.listModels()`      | `GET /v1/models`      |
| `client.listSessions()`    | `GET /sessions`       |
| `client.getSession(id)`    | `GET /sessions/:id`   |
| `client.deleteSession(id)` | `DELETE /sessions/:id`|

All methods throw `HermesError` on non-2xx responses:

```ts
import { HermesError } from "hermes-bridge-client";

try {
  await client.health();
} catch (err) {
  if (err instanceof HermesError) {
    console.error(err.status, err.body);
  }
}
```

## Cancellation

Pass an `AbortSignal` to cancel an in-flight chat stream:

```ts
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 30_000);
for await (const ev of client.chat({ ...req, signal: ctrl.signal })) {
  // ...
}
```

## Running a bridge

You need a `hermes-bridge` endpoint to talk to.  The easiest way is to run the
full [CloudChat](https://github.com/DevvGwardo/cloud-chat-hub) stack and let
`./start-all.sh` spin it up on `:3002`.  For agent-loop mode with real tool
calling, install the [Hermes
Agent](https://hermes-agent.nousresearch.com) to `~/.hermes/hermes-agent`
first.

## License

PolyForm Shield 1.0.0 — same as the parent CloudChat project.  You can use,
modify, and redistribute this client freely; you just can't offer a service
that competes with CloudChat.
