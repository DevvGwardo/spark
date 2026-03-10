# Hermes Agent Provider for cloud-chat-hub

## Overview

Add Hermes Agent from Nous Research as a backend provider in cloud-chat-hub. Hermes provides 40+ built-in tools (web search, browser automation, code execution, vision) via an autonomous agent runtime. A thin Python bridge server wraps Hermes's `AIAgent` class and exposes an OpenAI-compatible API, allowing cloud-chat-hub to treat it like any other provider.

## Architecture

```
cloud-chat-hub (Node.js)          hermes-bridge (Python)          Hermes AIAgent
       |                                  |                            |
       |  POST /v1/chat/completions       |                            |
       |  (OpenAI-compatible SSE)         |                            |
       |--------------------------------->|  AIAgent.run_conversation  |
       |                                  |--------------------------->|
       |                                  |   tool calls + results     |
       |  SSE: tool activity chunks       |<-------------------------->|
       |<---------------------------------|                            |
       |  SSE: final response chunks      |   final text               |
       |<---------------------------------|<---------------------------|
```

## Design Decisions

- **Approach:** Python bridge server (vs child process or Docker sidecar) — cleanest separation, follows existing provider pattern exactly
- **LLM backend:** Fixed to Nous Hermes models via OpenRouter — on-brand, no extra config
- **Tool defaults:** Safe subset (web, browser, vision) enabled by default; terminal, files, code execution opt-in
- **Tool activity UI:** Collapsible "Agent Activity" section below messages — clean but inspectable
- **Bridge URL:** Configurable via env var, defaults to localhost:3002

## Component 1: Hermes Bridge Server

**Location:** `hermes-bridge/` at project root (standalone, pip-installable)

**Stack:** FastAPI, uvicorn, hermes-agent SDK

### Endpoints

- `POST /v1/chat/completions` — OpenAI-compatible chat with SSE streaming
- `GET /v1/models` — returns available Nous Hermes models
- `GET /health` — liveness check

### Configuration (env vars)

- `HERMES_PORT` — server port (default: 3002)
- `HERMES_OPENROUTER_KEY` — OpenRouter API key for Nous models
- `HERMES_TOOLSETS` — comma-separated enabled toolsets (default: `web,browser,vision`)

### SSE Tool Activity Format

Tool activity is encoded as a custom field in streamed delta chunks:

```json
{
  "choices": [{
    "delta": {
      "content": "",
      "tool_activity": {
        "tool": "web_search",
        "status": "running",
        "input": "latest news on X",
        "output": null
      }
    }
  }]
}
```

A second chunk with `"status": "completed"` and populated `output` is sent when the tool finishes. Normal content tokens resume after.

### Bridge Logic

1. Receive OpenAI-format messages from cloud-chat-hub
2. Instantiate `AIAgent` with Nous Hermes model, requested toolsets, and callbacks
3. On tool call start: emit SSE chunk with `tool_activity` (status: running)
4. On tool call end: emit SSE chunk with `tool_activity` (status: completed, output)
5. On text tokens: emit standard OpenAI SSE content chunks
6. On finish: emit `[DONE]`

### Toolset Mapping

Requested toolsets arrive as a custom header `X-Hermes-Toolsets` (comma-separated). Maps to `AIAgent(enabled_toolsets=[...])`.

Available toolsets: `web`, `browser`, `vision`, `terminal`, `files`, `code_execution`

## Component 2: Provider Registration

### `src/lib/providers.ts`

Add `'hermes'` to `Provider` type union.

```typescript
hermes: {
  id: 'hermes',
  label: 'Hermes Agent',
  description: 'Autonomous agent with web search, browser, vision & more',
  needsApiKey: true,
  category: 'specialized',
  badge: 'Agent',
  models: ['nous-hermes-3', 'nous-hermes-3-70b'],
  defaultModel: 'nous-hermes-3',
}
```

Add `'hermes'` to `PROVIDER_ORDER`.

### `server/provider-config.ts`

Add to `OPENAI_COMPATIBLE`:

```typescript
hermes: process.env.HERMES_BRIDGE_URL || 'http://localhost:3002/v1',
```

### `src/stores/settings-store.ts`

Add default config entry for hermes provider with standard defaults.

## Component 3: Tool Activity UI

### New: `src/components/chat/AgentActivity.tsx`

Collapsible component rendered below assistant messages when tool activity is present.

**Shows per tool call:**
- Tool name with icon (search, globe, terminal, eye, file, code)
- Status: spinner while running, checkmark when done
- Expandable detail: input sent, output received

**Collapsed by default.** Header shows summary like "3 tools used" with expand toggle.

### Changes to `src/hooks/useChat.ts`

- Parse `tool_activity` from SSE delta chunks during streaming
- Accumulate tool events into a `toolActivity` array on the message object
- Array persists alongside message content

### Changes to message rendering

- If message has non-empty `toolActivity`, render `<AgentActivity events={toolActivity} />` below the response text

## Component 4: Toolset Settings

### Provider settings UI

When Hermes is the active provider, render an "Agent Tools" section with toggles:

| Toolset | Default | Warning |
|---------|---------|---------|
| Web Search | ON | - |
| Browser Automation | ON | - |
| Vision Analysis | ON | - |
| Terminal Access | OFF | "Allows shell command execution on your machine" |
| File Operations | OFF | "Allows reading and writing files on your machine" |
| Code Execution | OFF | "Allows running arbitrary code on your machine" |

### `src/stores/settings-store.ts`

Add `hermesToolsets` to provider config:

```typescript
hermesToolsets: {
  web: true,
  browser: true,
  vision: true,
  terminal: false,
  files: false,
  code_execution: false,
}
```

### Sending to bridge

`useChat.ts` reads toolset config and sends enabled toolsets as `X-Hermes-Toolsets` header on requests to the hermes provider.

## File Change Summary

| Area | Files | Type |
|------|-------|------|
| Bridge server | `hermes-bridge/main.py`, `hermes-bridge/requirements.txt`, `hermes-bridge/README.md` | New (~150 lines) |
| Provider registration | `src/lib/providers.ts`, `server/provider-config.ts`, `src/stores/settings-store.ts` | Edit (~15 lines) |
| Tool activity UI | `src/components/chat/AgentActivity.tsx` | New (~200 lines) |
| Chat hook | `src/hooks/useChat.ts` | Edit (~30 lines) |
| Message renderer | Existing message component | Edit (~10 lines) |
| Toolset settings | Settings UI component, `src/stores/settings-store.ts` | Edit (~80 lines) |

**Total: ~450 lines new, ~135 lines changed.**
