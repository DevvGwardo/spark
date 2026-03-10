# Hermes Agent Provider Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hermes Agent as a provider in cloud-chat-hub, backed by a Python bridge server that wraps Hermes's AIAgent with an OpenAI-compatible API, surfacing tool activity in a collapsible UI.

**Architecture:** A FastAPI bridge server (`hermes-bridge/`) exposes `/v1/chat/completions` wrapping Hermes's `AIAgent`. cloud-chat-hub registers it as an OpenAI-compatible provider. Tool activity streams as custom SSE fields and renders in a collapsible `<AgentActivity>` component. Toolset toggles in settings control which Hermes tools are enabled.

**Tech Stack:** Python 3.11+, FastAPI, uvicorn, hermes-agent SDK, React, TypeScript, Zustand, Tailwind CSS

---

## Chunk 1: Hermes Bridge Server

### Task 1: Scaffold hermes-bridge project

**Files:**
- Create: `hermes-bridge/requirements.txt`
- Create: `hermes-bridge/main.py`

- [ ] **Step 1: Create requirements.txt**

```
fastapi>=0.115.0
uvicorn>=0.34.0
hermes-agent>=1.0.0
pydantic>=2.0.0
```

- [ ] **Step 2: Create main.py with health and models endpoints**

```python
import os
import json
import asyncio
from typing import Optional
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="Hermes Bridge")

HERMES_PORT = int(os.environ.get("HERMES_PORT", "3002"))
OPENROUTER_KEY = os.environ.get("HERMES_OPENROUTER_KEY", "")
DEFAULT_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "web,browser,vision")

NOUS_MODELS = [
    {"id": "nousresearch/hermes-3-llama-3.1-405b", "object": "model", "owned_by": "nousresearch"},
    {"id": "nousresearch/hermes-3-llama-3.1-70b", "object": "model", "owned_by": "nousresearch"},
]


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/v1/models")
async def list_models():
    return {"object": "list", "data": NOUS_MODELS}
```

- [ ] **Step 3: Run the server to verify it starts**

Run: `cd hermes-bridge && pip install -r requirements.txt && python -c "from main import app; print('import ok')"`
Expected: `import ok`

- [ ] **Step 4: Commit**

```bash
git add hermes-bridge/requirements.txt hermes-bridge/main.py
git commit -m "feat: scaffold hermes-bridge server with health and models endpoints"
```

### Task 2: Implement chat completions endpoint

**Files:**
- Modify: `hermes-bridge/main.py`

- [ ] **Step 1: Add the chat completions request model and SSE helper**

Add after the `NOUS_MODELS` definition in `main.py`:

```python
class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "nousresearch/hermes-3-llama-3.1-70b"
    messages: list[ChatMessage]
    temperature: float = 0.7
    top_p: float = 0.9
    max_tokens: int = 16384
    stream: bool = True


def sse_chunk(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def make_delta_chunk(chunk_id: str, model: str, delta: dict, finish_reason: Optional[str] = None) -> dict:
    return {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }],
    }
```

- [ ] **Step 2: Add the streaming chat endpoint using AIAgent**

Add after the helper functions:

```python
@app.post("/v1/chat/completions")
async def chat_completions(request: Request, body: ChatCompletionRequest):
    toolsets_header = request.headers.get("x-hermes-toolsets", DEFAULT_TOOLSETS)
    enabled_toolsets = [t.strip() for t in toolsets_header.split(",") if t.strip()]

    api_key = OPENROUTER_KEY
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        api_key = auth_header[7:]

    if not api_key:
        return {"error": "No API key provided. Set HERMES_OPENROUTER_KEY or pass Authorization header."}

    from run_agent import AIAgent

    chunk_id = f"chatcmpl-hermes-{os.urandom(8).hex()}"
    tool_activity_queue: asyncio.Queue = asyncio.Queue()
    text_queue: asyncio.Queue = asyncio.Queue()
    done_event = asyncio.Event()

    def on_tool_start(tool_name: str, tool_input: str):
        tool_activity_queue.put_nowait({
            "tool": tool_name,
            "status": "running",
            "input": tool_input,
            "output": None,
        })

    def on_tool_end(tool_name: str, tool_input: str, tool_output: str):
        tool_activity_queue.put_nowait({
            "tool": tool_name,
            "status": "completed",
            "input": tool_input,
            "output": tool_output[:2000],  # Truncate large outputs
        })

    def on_text(text: str):
        text_queue.put_nowait(text)

    async def run_agent():
        try:
            agent = AIAgent(
                base_url="https://openrouter.ai/api/v1",
                api_key=api_key,
                model=body.model,
                max_iterations=30,
                enabled_toolsets=enabled_toolsets,
                on_tool_start=on_tool_start,
                on_tool_end=on_tool_end,
                on_text=on_text,
            )

            conversation_history = [
                {"role": m.role, "content": m.content} for m in body.messages
            ]

            user_message = conversation_history[-1]["content"] if conversation_history else ""
            history = conversation_history[:-1] if len(conversation_history) > 1 else []

            agent.run_conversation(
                user_message=user_message,
                conversation_history=history,
            )
        except Exception as e:
            text_queue.put_nowait(f"\n\n[Error: {str(e)}]")
        finally:
            done_event.set()

    async def event_stream():
        # Role chunk
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"role": "assistant"}))

        agent_task = asyncio.create_task(run_agent())

        while not done_event.is_set() or not tool_activity_queue.empty() or not text_queue.empty():
            # Drain tool activity
            while not tool_activity_queue.empty():
                activity = tool_activity_queue.get_nowait()
                yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                    "content": "",
                    "tool_activity": activity,
                }))

            # Drain text
            while not text_queue.empty():
                text = text_queue.get_nowait()
                yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))

            if not done_event.is_set():
                await asyncio.sleep(0.05)

        # Final chunk
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {}, finish_reason="stop"))
        yield "data: [DONE]\n\n"

        await agent_task

    return StreamingResponse(event_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=HERMES_PORT)
```

- [ ] **Step 3: Verify the module imports cleanly**

Run: `cd hermes-bridge && python -c "from main import app; print('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add hermes-bridge/main.py
git commit -m "feat: add streaming chat completions endpoint to hermes-bridge"
```

---

## Chunk 2: Provider Registration in cloud-chat-hub

### Task 3: Add hermes to Provider type and config

**Files:**
- Modify: `src/stores/settings-store.ts:4-8` (Provider type)
- Modify: `src/stores/settings-store.ts:64-80` (defaultProviders)
- Modify: `src/stores/settings-store.ts:113` (persist version bump from 10 to 11)
- Modify: `src/lib/providers.ts:1` (Provider import)
- Modify: `src/lib/providers.ts:24-238` (PROVIDERS object)
- Modify: `src/lib/providers.ts:241-245` (PROVIDER_ORDER)

- [ ] **Step 1: Add 'hermes' to the Provider type union**

In `src/stores/settings-store.ts`, add `'hermes'` to the `Provider` type:

```typescript
export type Provider =
  | 'openai' | 'anthropic' | 'google' | 'xai'
  | 'groq' | 'deepseek' | 'mistral' | 'together'
  | 'minimax' | 'minimax-payg' | 'kimi' | 'kimi-coding'
  | 'cerebras' | 'openrouter' | 'sambanova' | 'hermes';
```

- [ ] **Step 2: Add hermes to defaultProviders**

In `src/stores/settings-store.ts`, add after the `sambanova` entry in `defaultProviders`:

```typescript
  hermes: makeDefault('nousresearch/hermes-3-llama-3.1-70b'),
```

- [ ] **Step 3: Bump persist version and add migration**

In `src/stores/settings-store.ts`, change `version: 10` to `version: 11` and add after the `version < 10` migration block:

```typescript
        if (version < 11) {
          if (!state?.providers?.hermes) {
            state.providers = { ...state.providers, hermes: makeDefault('nousresearch/hermes-3-llama-3.1-70b') };
          }
        }
```

- [ ] **Step 4: Add hermes to PROVIDERS in providers.ts**

In `src/lib/providers.ts`, add before the closing `};` of the `PROVIDERS` object (after `sambanova`):

```typescript
  hermes: {
    id: 'hermes',
    label: 'Hermes Agent',
    description: 'Autonomous agent with web search, browser, vision & more',
    needsApiKey: true,
    category: 'specialized',
    badge: 'Agent',
    models: [
      'nousresearch/hermes-3-llama-3.1-405b',
      'nousresearch/hermes-3-llama-3.1-70b',
    ],
    defaultModel: 'nousresearch/hermes-3-llama-3.1-70b',
  },
```

- [ ] **Step 5: Add hermes to PROVIDER_ORDER**

In `src/lib/providers.ts`, update `PROVIDER_ORDER` to include `'hermes'`:

```typescript
export const PROVIDER_ORDER: Provider[] = [
  'openai', 'anthropic', 'google', 'xai',
  'groq', 'cerebras', 'openrouter', 'sambanova',
  'deepseek', 'mistral', 'together', 'minimax', 'minimax-payg', 'kimi', 'kimi-coding',
  'hermes',
];
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd /Users/devgwardo/cloud-chat-hub && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/stores/settings-store.ts src/lib/providers.ts
git commit -m "feat: register Hermes Agent as a provider"
```

### Task 4: Add hermes to server-side provider routing

**Files:**
- Modify: `server/provider-config.ts:6-22` (OPENAI_COMPATIBLE)
- Modify: `server/provider-config.ts:28-44` (VALIDATION_MODELS)

- [ ] **Step 1: Add hermes to OPENAI_COMPATIBLE**

In `server/provider-config.ts`, add after the `sambanova` entry:

```typescript
  hermes: process.env.HERMES_BRIDGE_URL || 'http://localhost:3002/v1',
```

- [ ] **Step 2: Add hermes to VALIDATION_MODELS**

In `server/provider-config.ts`, add after the `sambanova` entry:

```typescript
  hermes: 'nousresearch/hermes-3-llama-3.1-70b',
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/devgwardo/cloud-chat-hub && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add server/provider-config.ts
git commit -m "feat: add hermes bridge URL to server provider routing"
```

---

## Chunk 3: Hermes Toolset Store

### Task 5: Add hermes toolset configuration to settings store

**Files:**
- Create: `src/stores/hermes-store.ts`

- [ ] **Step 1: Create the hermes toolset store**

```typescript
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

interface HermesState {
  toolsets: HermesToolsets;
  bridgeUrl: string;
  setToolset: (key: keyof HermesToolsets, enabled: boolean) => void;
  setBridgeUrl: (url: string) => void;
  getEnabledToolsets: () => string[];
}

const defaultToolsets: HermesToolsets = {
  web: true,
  browser: true,
  vision: true,
  terminal: false,
  files: false,
  code_execution: false,
};

export const useHermesStore = create<HermesState>()(
  persist(
    (set, get) => ({
      toolsets: { ...defaultToolsets },
      bridgeUrl: 'http://localhost:3002/v1',

      setToolset: (key, enabled) =>
        set((state) => ({
          toolsets: { ...state.toolsets, [key]: enabled },
        })),

      setBridgeUrl: (url) => set({ bridgeUrl: url }),

      getEnabledToolsets: () => {
        const ts = get().toolsets;
        return Object.entries(ts)
          .filter(([, v]) => v)
          .map(([k]) => k);
      },
    }),
    { name: 'cloudchat-hermes' }
  )
);
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/devgwardo/cloud-chat-hub && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/stores/hermes-store.ts
git commit -m "feat: add Zustand store for Hermes toolset configuration"
```

---

## Chunk 4: Send Hermes Toolsets Header

### Task 6: Pass X-Hermes-Toolsets header for hermes provider

**Files:**
- Modify: `server/provider-config.ts:46-53` (getProviderHeaders)
- Modify: `server/provider-config.ts:55-82` (createProviderModel)
- Modify: `server/index.ts:77-88` (request body destructuring)
- Modify: `server/index.ts:244-248` (createProviderModel call)
- Modify: `src/hooks/useChat.ts` (imports + body)

- [ ] **Step 1: Add `extra` parameter to getProviderHeaders**

In `server/provider-config.ts`, change the existing function signature and add the extra headers merge. Replace:

```typescript
export function getProviderHeaders(provider: string, origin?: string): Record<string, string> {
  if (provider !== 'openrouter') return {};

  return {
    'HTTP-Referer': origin || 'https://lovable.app',
    'X-Title': 'CloudChat',
  };
}
```

With:

```typescript
export function getProviderHeaders(provider: string, origin?: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};

  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = origin || 'https://lovable.app';
    headers['X-Title'] = 'CloudChat';
  }

  if (extra) {
    Object.assign(headers, extra);
  }

  return headers;
}
```

- [ ] **Step 2: Add `extraHeaders` to createProviderModel options**

In `server/provider-config.ts`, replace:

```typescript
export function createProviderModel(
  provider: string,
  model: string,
  apiKey: string,
  options?: { origin?: string }
) {
```

With:

```typescript
export function createProviderModel(
  provider: string,
  model: string,
  apiKey: string,
  options?: { origin?: string; extraHeaders?: Record<string, string> }
) {
```

And replace the headers line in the same function:

```typescript
    headers: getProviderHeaders(provider, options?.origin),
```

With:

```typescript
    headers: getProviderHeaders(provider, options?.origin, options?.extraHeaders),
```

- [ ] **Step 3: Add hermes_toolsets to request body destructuring in server/index.ts**

In `server/index.ts` line 77-88, replace:

```typescript
    const {
      provider = 'lovable',
      model,
      messages,
      temperature,
      top_p,
      max_tokens,
      api_key,
      system_prompt,
      activeRepo,
      reasoning_effort,
    } = req.body;
```

With:

```typescript
    const {
      provider = 'lovable',
      model,
      messages,
      temperature,
      top_p,
      max_tokens,
      api_key,
      system_prompt,
      activeRepo,
      reasoning_effort,
      hermes_toolsets,
    } = req.body;
```

- [ ] **Step 4: Pass extraHeaders in the createProviderModel call**

In `server/index.ts` lines 246-248, replace:

```typescript
      aiModel = createProviderModel(provider, model, apiKey, {
        origin: req.headers.origin as string | undefined,
      });
```

With:

```typescript
      aiModel = createProviderModel(provider, model, apiKey, {
        origin: req.headers.origin as string | undefined,
        extraHeaders: provider === 'hermes' && hermes_toolsets
          ? { 'X-Hermes-Toolsets': hermes_toolsets }
          : undefined,
      });
```

- [ ] **Step 5: Send toolsets from useChat on the client side**

In `src/hooks/useChat.ts`, add import after line 13:

```typescript
import { useHermesStore } from '@/stores/hermes-store';
```

Inside the `useChat` function, add after line 118 (`const { activeRepo, isRepoMode, repoFileTree } = changeset;`):

```typescript
  const hermesToolsets = useHermesStore((s) => s.getEnabledToolsets());
```

In the `body` object passed to `useAIChat` (line 249-259), add after the `activeRepo` spread:

```typescript
      ...(effectiveProvider === 'hermes' ? { hermes_toolsets: hermesToolsets.join(',') } : {}),
```

So the body becomes:

```typescript
    body: {
      provider: effectiveProvider,
      model: effectiveModel,
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      api_key: config.apiKey,
      system_prompt: fullSystemPrompt,
      ...(isRepoMode && activeRepo ? { activeRepo } : {}),
      ...(effectiveProvider === 'hermes' ? { hermes_toolsets: hermesToolsets.join(',') } : {}),
    },
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd /Users/devgwardo/cloud-chat-hub && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add server/provider-config.ts server/index.ts src/hooks/useChat.ts
git commit -m "feat: pass Hermes toolset config as header through provider chain"
```

---

## Chunk 5: Agent Activity UI Component

### Task 7: Create AgentActivity component

**Files:**
- Create: `src/components/chat/AgentActivity.tsx`

- [ ] **Step 1: Create the AgentActivity component**

```tsx
import { useState } from 'react';
import { Search, Globe, Terminal, Eye, FileText, Code, ChevronDown, ChevronRight, Loader2, Check } from 'lucide-react';

export interface ToolActivityEvent {
  tool: string;
  status: 'running' | 'completed';
  input: string;
  output: string | null;
}

const TOOL_ICONS: Record<string, typeof Search> = {
  web_search: Search,
  search: Search,
  browser: Globe,
  browse: Globe,
  terminal: Terminal,
  shell: Terminal,
  vision: Eye,
  image: Eye,
  file: FileText,
  files: FileText,
  code: Code,
  code_execution: Code,
};

function getToolIcon(toolName: string) {
  const lower = toolName.toLowerCase();
  for (const [key, Icon] of Object.entries(TOOL_ICONS)) {
    if (lower.includes(key)) return Icon;
  }
  return Code;
}

function ToolEvent({ event }: { event: ToolActivityEvent }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getToolIcon(event.tool);
  const isRunning = event.status === 'running';

  return (
    <div className="border-b border-zinc-200 dark:border-zinc-700 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
      >
        {isRunning ? (
          <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin shrink-0" />
        ) : (
          <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
        )}
        <Icon className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <span className="text-zinc-700 dark:text-zinc-300 truncate font-medium">
          {event.tool}
        </span>
        <span className="text-zinc-400 dark:text-zinc-500 truncate text-xs ml-auto mr-2">
          {event.input.slice(0, 80)}{event.input.length > 80 ? '...' : ''}
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-medium">Input:</span>{' '}
            <span className="font-mono">{event.input}</span>
          </div>
          {event.output && (
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              <span className="font-medium">Output:</span>{' '}
              <pre className="font-mono whitespace-pre-wrap mt-1 bg-zinc-100 dark:bg-zinc-800 rounded p-2 max-h-40 overflow-auto">
                {event.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentActivity({ events }: { events: ToolActivityEvent[] }) {
  const [expanded, setExpanded] = useState(false);

  if (events.length === 0) return null;

  const completedCount = events.filter((e) => e.status === 'completed').length;
  const runningCount = events.filter((e) => e.status === 'running').length;
  const summary = runningCount > 0
    ? `${runningCount} tool${runningCount > 1 ? 's' : ''} running...`
    : `${completedCount} tool${completedCount > 1 ? 's' : ''} used`;

  return (
    <div className="mt-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
      >
        {runningCount > 0 ? (
          <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
        ) : (
          <Check className="w-4 h-4 text-green-500 shrink-0" />
        )}
        <span className="text-zinc-600 dark:text-zinc-400 font-medium">
          Agent Activity
        </span>
        <span className="text-zinc-400 dark:text-zinc-500 text-xs ml-1">
          {summary}
        </span>
        <div className="ml-auto">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-zinc-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-zinc-400" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-zinc-700">
          {events.map((event, i) => (
            <ToolEvent key={`${event.tool}-${i}`} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/devgwardo/cloud-chat-hub && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/AgentActivity.tsx
git commit -m "feat: add collapsible AgentActivity component for Hermes tool display"
```

### Task 8: Parse tool_activity from SSE stream and render in messages

**Files:**
- Modify: `src/hooks/useChat.ts:1-14` (imports)
- Modify: `src/hooks/useChat.ts:211-216` (state declarations)
- Modify: `src/hooks/useChat.ts:239-261` (useAIChat config)
- Modify: `src/hooks/useChat.ts:770-790` (return object)
- Modify: `src/components/chat/MessageBubble.tsx:78-88` (MessageBubbleProps)
- Modify: `src/components/chat/MessageBubble.tsx:492-502` (destructuring)
- Modify: `src/components/chat/MessageBubble.tsx:660-664` (rendering)
- Modify: `src/components/chat/ChatArea.tsx:1-15` (imports)
- Modify: `src/components/chat/ChatArea.tsx:249-270` (MessageBubble rendering)

**Note:** The Vercel AI SDK's `streamProtocol: 'data'` uses its own stream format (not raw OpenAI SSE). The bridge server's `tool_activity` custom field in the delta will pass through the SDK's parser without issues — the SDK ignores unknown fields in the delta object and only extracts `content`, `role`, and `tool_calls`. We intercept the raw fetch response to extract `tool_activity` before the SDK processes it, then pass the unmodified stream through.

- [ ] **Step 1: Add imports to useChat.ts**

In `src/hooks/useChat.ts`, add after the existing imports (after line 13):

```typescript
import { useHermesStore } from '@/stores/hermes-store';
import type { ToolActivityEvent } from '@/components/chat/AgentActivity';
```

Note: `useRef` and `useCallback` are already imported on line 1.

- [ ] **Step 2: Add tool activity state**

In `src/hooks/useChat.ts`, after the existing `useState` declarations (after line 214 where `const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);` is), add:

```typescript
  const [toolActivityMap, setToolActivityMap] = useState<Record<string, ToolActivityEvent[]>>({});
  const toolActivityRef = useRef<Record<string, ToolActivityEvent[]>>({});
```

- [ ] **Step 3: Add hermesStreamFetch and hermes toolsets**

In `src/hooks/useChat.ts`, after line 122 (`const { activeRepo, isRepoMode, repoFileTree } = changeset;`), add:

```typescript
  const hermesToolsets = useHermesStore((s) => s.getEnabledToolsets());
```

Then, before the `useAIChat` call (before line 239), add the fetch interceptor:

```typescript
  const hermesStreamFetch = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    if (effectiveProvider !== 'hermes' || !response.body) return response;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        const text = decoder.decode(value, { stream: true });
        buffer += text;

        // Extract tool_activity from SSE data lines before SDK processes them
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              const delta = parsed?.choices?.[0]?.delta;
              if (delta?.tool_activity) {
                const msgId = parsed.id || 'current';
                const prev = [...(toolActivityRef.current[msgId] || [])];
                const activity = delta.tool_activity as ToolActivityEvent;

                const existingIdx = prev.findIndex(
                  (e) => e.tool === activity.tool && e.input === activity.input && e.status === 'running'
                );
                if (existingIdx >= 0 && activity.status === 'completed') {
                  prev[existingIdx] = activity;
                } else if (existingIdx < 0) {
                  prev.push(activity);
                }

                toolActivityRef.current = { ...toolActivityRef.current, [msgId]: prev };
                setToolActivityMap({ ...toolActivityRef.current });
              }
            } catch {
              // Not valid JSON, skip
            }
          }
        }

        // Pass raw bytes through unmodified for the SDK to process
        controller.enqueue(value);
      },
    });

    return new Response(stream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }, [effectiveProvider]);
```

- [ ] **Step 4: Wire fetch and toolsets into useAIChat**

In `src/hooks/useChat.ts`, the existing `useAIChat` call (line 247) looks like:

```typescript
  } = useAIChat({
    api: `${apiBaseUrl}/functions/v1/chat`,
    body: {
      provider: effectiveProvider,
      model: effectiveModel,
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      api_key: config.apiKey,
      system_prompt: fullSystemPrompt,
      ...(isRepoMode && activeRepo ? { activeRepo } : {}),
    },
    id: chatSessionId,
    streamProtocol: 'data',
```

Replace with:

```typescript
  } = useAIChat({
    api: `${apiBaseUrl}/functions/v1/chat`,
    fetch: hermesStreamFetch,
    body: {
      provider: effectiveProvider,
      model: effectiveModel,
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      api_key: config.apiKey,
      system_prompt: fullSystemPrompt,
      ...(isRepoMode && activeRepo ? { activeRepo } : {}),
      ...(effectiveProvider === 'hermes' ? { hermes_toolsets: hermesToolsets.join(',') } : {}),
    },
    id: chatSessionId,
    streamProtocol: 'data',
```

- [ ] **Step 5: Expose toolActivityMap from the hook return**

In `src/hooks/useChat.ts`, the return object (line 770-790) currently ends with:

```typescript
    activeProvider: effectiveProvider,
    activeModel: effectiveModel,
  };
```

Replace with:

```typescript
    activeProvider: effectiveProvider,
    activeModel: effectiveModel,
    toolActivityMap,
  };
```

- [ ] **Step 6: Add toolActivity prop to MessageBubble**

In `src/components/chat/MessageBubble.tsx`, add import at top:

```typescript
import { AgentActivity, type ToolActivityEvent } from './AgentActivity';
```

The `MessageBubbleProps` interface (lines 78-88) currently is:

```typescript
interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  streamingContent?: string;
  parts?: MessagePart[];
  reasoning?: string;
  isReasoningStreaming?: boolean;
  toolInvocations?: ToolInvocation[];
  onRegenerate?: () => void;
  onEdit?: (content: string) => void;
}
```

Replace with:

```typescript
interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  streamingContent?: string;
  parts?: MessagePart[];
  reasoning?: string;
  isReasoningStreaming?: boolean;
  toolInvocations?: ToolInvocation[];
  toolActivity?: ToolActivityEvent[];
  onRegenerate?: () => void;
  onEdit?: (content: string) => void;
}
```

The destructuring (line 492-502) currently is:

```typescript
export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isStreaming,
  streamingContent,
  parts,
  reasoning,
  isReasoningStreaming,
  toolInvocations,
  onRegenerate,
  onEdit,
}) => {
```

Replace with:

```typescript
export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isStreaming,
  streamingContent,
  parts,
  reasoning,
  isReasoningStreaming,
  toolInvocations,
  toolActivity,
  onRegenerate,
  onEdit,
}) => {
```

- [ ] **Step 7: Render AgentActivity in assistant messages**

In `src/components/chat/MessageBubble.tsx`, after the `orderedParts.map()` block closes (line 663 `})()`) and before the closing `</>` (line 665), add the AgentActivity:

Current code (lines 662-665):

```tsx
              });
              })()
            )}
          </>
```

Replace with:

```tsx
              });
              })()
            )}
            {toolActivity && toolActivity.length > 0 && (
              <AgentActivity events={toolActivity} />
            )}
          </>
```

- [ ] **Step 8: Pass toolActivityMap in ChatArea**

In `src/components/chat/ChatArea.tsx`, the `ChatArea` component receives props from a parent that calls `useChat`. The `toolActivityMap` needs to be passed through. Add it as a prop to `ChatArea` and thread it to `MessageBubble`.

In the `MessageBubble` rendering (lines 249-270), currently:

```tsx
            return (
              <MessageBubble
                key={`${msg.id}-${i}`}
                message={{
                  id: msg.id,
                  conversationId: conversationId || '',
                  role: msg.role as 'user' | 'assistant',
                  content: msg.content,
                  timestamp: new Date().toISOString(),
                }}
                isStreaming={isLastAssistantStreaming}
                streamingContent={isLastAssistantStreaming ? msg.content : undefined}
                parts={parts}
                reasoning={reasoning}
                isReasoningStreaming={isReasoningStreaming}
                toolInvocations={toolInvocations}
                onRegenerate={
                  msg.role === 'assistant' && i === messages.length - 1 && !isStreaming
                    ? handleRegenerate
                    : undefined
                }
              />
            );
```

Replace with:

```tsx
            return (
              <MessageBubble
                key={`${msg.id}-${i}`}
                message={{
                  id: msg.id,
                  conversationId: conversationId || '',
                  role: msg.role as 'user' | 'assistant',
                  content: msg.content,
                  timestamp: new Date().toISOString(),
                }}
                isStreaming={isLastAssistantStreaming}
                streamingContent={isLastAssistantStreaming ? msg.content : undefined}
                parts={parts}
                reasoning={reasoning}
                isReasoningStreaming={isReasoningStreaming}
                toolInvocations={toolInvocations}
                toolActivity={toolActivityMap?.[msg.id] || toolActivityMap?.['current']}
                onRegenerate={
                  msg.role === 'assistant' && i === messages.length - 1 && !isStreaming
                    ? handleRegenerate
                    : undefined
                }
              />
            );
```

Note: `toolActivityMap` must be added to ChatArea's props interface and passed from the parent component that calls `useChat`. Check how `ChatArea` receives its data — if it's via props, add `toolActivityMap?: Record<string, ToolActivityEvent[]>` to its interface. If `useChat` is called inside ChatArea, it's already available.

- [ ] **Step 9: Verify TypeScript compiles**

Run: `cd /Users/devgwardo/cloud-chat-hub && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add src/hooks/useChat.ts src/components/chat/MessageBubble.tsx src/components/chat/ChatArea.tsx
git commit -m "feat: parse and render Hermes tool activity in chat messages"
```

---

## Chunk 6: Toolset Settings UI

### Task 9: Add Hermes toolset toggles to settings modal

**Files:**
- Modify: `src/components/settings/SettingsModal.tsx`

- [ ] **Step 1: Import the hermes store**

Add at the top of `SettingsModal.tsx`:

```typescript
import { useHermesStore, type HermesToolsets } from '@/stores/hermes-store';
```

- [ ] **Step 2: Read hermes state in the component**

Inside the `SettingsModal` component body, add:

```typescript
  const { toolsets: hermesToolsets, setToolset: setHermesToolset } = useHermesStore();
```

- [ ] **Step 3: Add the toolset toggles section**

In the provider config panel (right side, after the Model selection dropdown around line 510), add a conditional section for hermes:

```tsx
{selectedProvider === 'hermes' && (
  <div className={settingsCardClass}>
    <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">
      Agent Tools
    </h3>
    <div className="space-y-3">
      {([
        { key: 'web' as const, label: 'Web Search', desc: 'Search the web for information' },
        { key: 'browser' as const, label: 'Browser Automation', desc: 'Browse and interact with web pages' },
        { key: 'vision' as const, label: 'Vision Analysis', desc: 'Analyze images and screenshots' },
        { key: 'terminal' as const, label: 'Terminal Access', desc: 'Allows shell command execution on your machine', warn: true },
        { key: 'files' as const, label: 'File Operations', desc: 'Allows reading and writing files on your machine', warn: true },
        { key: 'code_execution' as const, label: 'Code Execution', desc: 'Allows running arbitrary code on your machine', warn: true },
      ] as const).map(({ key, label, desc, warn }) => (
        <div key={key} className="flex items-center justify-between">
          <div>
            <div className="text-sm text-zinc-700 dark:text-zinc-300">{label}</div>
            <div className={`text-xs ${warn ? 'text-amber-500' : 'text-zinc-400 dark:text-zinc-500'}`}>
              {desc}
            </div>
          </div>
          <button
            onClick={() => setHermesToolset(key, !hermesToolsets[key])}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              hermesToolsets[key]
                ? 'bg-blue-500'
                : 'bg-zinc-300 dark:bg-zinc-600'
            }`}
          >
            <div
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                hermesToolsets[key] ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/devgwardo/cloud-chat-hub && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/SettingsModal.tsx
git commit -m "feat: add Hermes toolset toggles to settings modal"
```

---

## Chunk 7: Integration Testing

### Task 10: Manual integration test

- [ ] **Step 1: Start the hermes bridge**

Run: `cd /Users/devgwardo/cloud-chat-hub/hermes-bridge && HERMES_OPENROUTER_KEY=<key> python main.py`
Expected: `Uvicorn running on http://0.0.0.0:3002`

- [ ] **Step 2: Verify health endpoint**

Run: `curl http://localhost:3002/health`
Expected: `{"status":"ok"}`

- [ ] **Step 3: Verify models endpoint**

Run: `curl http://localhost:3002/v1/models`
Expected: JSON with hermes model list

- [ ] **Step 4: Start cloud-chat-hub**

Run in another terminal:
```bash
cd /Users/devgwardo/cloud-chat-hub
npm run server &
npm run dev
```

- [ ] **Step 5: Test in browser**

1. Open cloud-chat-hub in browser
2. Go to Settings > Providers
3. Select "Hermes Agent" from the specialized section
4. Enter OpenRouter API key
5. Verify toolset toggles appear
6. Send a test message like "Search the web for latest AI news"
7. Verify response streams and Agent Activity section appears

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete Hermes Agent provider integration"
```
