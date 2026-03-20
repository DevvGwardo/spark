# CloudChat

Multi-provider AI chat client with server-side agentic repo tools, orchestrator mode, GitHub integration, and live code preview. Built with React, Vite, TypeScript, and Electron.

![Cloud Chat Interface](public/cloudchat-screenshot-2026-03-17.png)
![Cloud Chat Interface — Pull Request](public/cloud-chat-hub-screenshot.png)

## Features

- **17 LLM Providers** — OpenAI, Anthropic, Google Gemini, xAI, Groq, DeepSeek, Mistral, Together, MiniMax, Kimi, Cerebras, OpenRouter, SambaNova, z.ai (Zhipu), OpenClaw, and Hermes Agent. API keys stored client-side.
- **Server-Side Agentic Tools** — Connect a GitHub repo and the server provides tool-calling agents that read, edit, create, delete, and batch-edit files — with full changeset staging and PR workflow.
- **Hermes Agent Mode** — Autonomous agent with configurable toolsets (web search, browsing, terminal, file operations, code execution) via the Hermes Bridge.
- **Orchestrator Mode** — Decomposes complex requests into parallel sub-tasks, executes them with retry logic and fallback models, then synthesizes results.
- **Live Code Preview** — Real-time preview of generated code: plain HTML/CSS/JS, React (Vite) with JSX/TSX transpilation, Next.js with mocked routing, and Markdown rendering.
- **GitHub Integration** — Full PR workflow: analyze repos, propose file changes, stage/unstage with inline diffs, create branches, open PRs, monitor CI checks, and merge.
- **Issue Browser** — Browse, filter, and sort repository issues. Jump into issue-focused chats for contextual AI assistance.
- **Changeset Panel** — Review proposed file changes with inline diffs, added/removed line counts, per-file staging, and revert.
- **Streaming** — Real-time token streaming with context usage tracking (input/output tokens, context window percentage).
- **Themes** — 6 themes (Default, Ayu, Dracula, Gruvbox, IntelliJ, Terminal) with 10 accent colors, light/dark/system modes, and customizable font size and family.
- **Desktop App** — Native macOS Electron app with global hotkey (Cmd+Shift+Space), tray menu, and auto-updates via GitHub Releases.

## Tech Stack

| Layer | Stack |
|-------|-------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| State | Zustand (11 persisted stores) |
| AI SDK | Vercel AI SDK (`ai` + `@ai-sdk/react`) with first-party and OpenAI-compatible provider adapters |
| Backend | Node.js / Express — chat proxy, direct SSE proxy, agentic tool loop, GitHub integration, orchestrator, preview manager |
| Agent Bridge | Python FastAPI (Hermes Bridge for autonomous agentic tool calling) |
| Desktop | Electron with electron-vite and electron-builder |
| Markdown | react-markdown with GFM, math (KaTeX), and Shiki syntax highlighting |

## Getting Started

### Web (Development)

```sh
git clone https://github.com/DevGwardo/cloud-chat-hub.git
cd cloud-chat-hub
npm install

# Start the API server (required — runs on port 3001)
npm run server

# In a separate terminal, start the frontend dev server
npm run dev
```

Both the API server and the frontend dev server must be running.

### Hermes Bridge (Optional — Agent Mode)

Enables autonomous agentic AI with tool access.

```sh
cd hermes-bridge
pip install -r requirements.txt

export HERMES_OPENROUTER_KEY="your-openrouter-key"

# Runs on port 3002
python main.py
```

Select "Hermes Agent" as the provider in Settings. Configure toolsets (web, browser, vision, terminal, files, code_execution) from there.

### Desktop App (Electron)

```sh
npm run electron:dev       # Dev mode with hot reload
npm run electron:build     # Build macOS app (DMG + ZIP)
npm run electron:publish   # Build and publish to GitHub Releases
```

### OpenClaw (Optional — Local Agent)

```sh
# Ensure OpenClaw CLI is installed (~/.openclaw/bin/openclaw)
# Override path: export OPENCLAW_BIN=/path/to/openclaw
# Select "OpenClaw" as provider in Settings
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3001` | URL of the API server |
| `HERMES_OPENROUTER_KEY` | — | OpenRouter API key for Hermes agent |
| `HERMES_PORT` | `3002` | Hermes Bridge server port |
| `HERMES_TOOLSETS` | `web,browser,vision` | Default agent toolsets |
| `HERMES_DEFAULT_MODEL` | `google/gemini-3.1-flash-lite-preview-20260303` | Default Hermes model |
| `HERMES_MAX_ITERATIONS` | `60` | Max tool-use iterations per turn |
| `ORCHESTRATOR_SUBTASK_TIMEOUT_MS` | `5400000` | Per-subtask timeout for orchestrator agents |
| `ORCHESTRATOR_HEARTBEAT_MS` | `5000` | Heartbeat interval for orchestrator streams |
| `OPENCLAW_TURN_TIMEOUT_SECONDS` | `5400` | Timeout for a single OpenClaw turn |
| `OPENCLAW_BIN` | `~/.openclaw/bin/openclaw` | Path to OpenClaw CLI |

API keys for individual providers are configured in the Settings UI and stored in the browser.

## Project Structure

```
src/
├── components/
│   ├── chat/          # Chat UI, messages, markdown renderer, activity indicators
│   ├── github/        # GitHub panel, issue browser, PR creation
│   ├── layout/        # App shell layout
│   ├── preview/       # Workspace sidebar (changeset diffs, live code preview)
│   ├── settings/      # Settings modal, setup wizard, knowledge panel
│   ├── sidebar/       # Chat history sidebar
│   ├── terminal/      # Terminal panel
│   └── ui/            # shadcn/ui primitives
├── hooks/             # useChat, useOrchestrator, useTheme
├── lib/               # API client, providers, tokens, themes, repo tools, diff utils
├── stores/            # Zustand stores (chat, settings, changeset, orchestrator, etc.)
└── contexts/          # React contexts (PanelContext)
server/
├── index.ts           # Express API — chat, GitHub, preview, model discovery
├── agent-loop.ts      # Server-side agentic tool definitions and execution
├── direct-sse-proxy.ts # SSE proxy for compatible providers (MiniMax, Kimi)
├── orchestrator.ts    # Multi-agent orchestrator with planning, execution, synthesis
├── provider-config.ts # Provider routing, model lists, headers, tool_choice safety
├── message-normalization.ts # Chat message normalization across providers
├── http-disconnect.ts # Client disconnect detection
├── chat-store.ts      # Server-side chat persistence
├── repo-clone-manager.ts # Managed repo cloning for preview
├── repo-verifier.ts   # Change verification and PR metadata generation
├── preview-manager.ts # Project preview lifecycle (clone, build, serve)
└── openclaw.ts        # OpenClaw CLI integration
hermes-bridge/
├── main.py            # FastAPI server for agentic tool calling
├── run_agent.py       # AIAgent class with tool definitions and agentic loop
└── requirements.txt   # Python dependencies
electron/
├── index.ts           # Main process (window, tray, hotkey, auto-update)
├── preload.ts         # Preload bridge (API port, theme, window controls)
├── updater.ts         # Auto-update logic
└── server.ts          # Embedded Express server launcher
```

## Supported Providers

| Provider | Default Model | Category |
|----------|--------------|----------|
| OpenAI | gpt-5.4 | Featured |
| Anthropic | claude-sonnet-4-5 | Featured |
| Google Gemini | gemini-2.5-flash | Featured |
| xAI (Grok) | grok-4-fast-reasoning | Featured |
| Groq | llama-3.3-70b-versatile | Open Source |
| Cerebras | llama-3.3-70b | Open Source |
| OpenRouter | nemotron-70b-instruct:free | Open Source |
| SambaNova | Meta-Llama-3.3-70B-Instruct | Open Source |
| DeepSeek | deepseek-chat | Open Source |
| Mistral | mistral-large-latest | Open Source |
| Together AI | Llama-3.3-70B-Instruct-Turbo | Open Source |
| MiniMax | MiniMax-M2.5 | Specialized |
| Kimi | moonshot-v1-32k | Specialized |
| Kimi (Coding) | kimi-for-coding | Specialized |
| z.ai (Zhipu) | glm-5-plus | Specialized |
| OpenClaw | (local) | Specialized |
| Hermes Agent | gemini-3.1-flash-lite-preview | Specialized |

## GitHub Integration

1. **Connect** — Add a GitHub Personal Access Token in Settings.
2. **Browse Issues** — Filter, sort, and jump into issue-focused chats.
3. **Propose Changes** — AI proposes file changes via server-side repo tools. Review in the Workspace panel.
4. **Stage & Review** — Stage/unstage files, view inline diffs with line counts, revert changes.
5. **Create PR** — Open a pull request with auto-generated branch, title, and description. Supports draft PRs.
6. **Monitor & Merge** — Track CI checks, then merge (squash, rebase, or merge commit).

## Orchestrator Mode

Enable in Settings for complex multi-step requests:

1. A **planning model** decomposes the request into 1–6 sub-tasks.
2. **Code agents** execute sub-tasks in parallel with retry logic and optional fallback models.
3. The orchestrator **synthesizes** results into a unified response.

Configure planning model, code model, fallback model, and max sub-agents in Settings.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start frontend dev server |
| `npm run server` | Start API server (port 3001) |
| `npm run build` | Production build |
| `npm run test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint with ESLint |
| `npm run typecheck` | Type-check frontend and Electron |
| `npm run electron:dev` | Electron dev mode with hot reload |
| `npm run electron:build` | Build macOS desktop app |
| `npm run electron:publish` | Build and publish to GitHub Releases |

## License

Licensed under the **Business Source License 1.1** (BSL 1.1).

- **Permitted**: View, modify, fork, and self-host for personal or internal use.
- **Restricted**: You may not offer CloudChat (or a substantially similar product built from this source) as a competing hosted or commercial service without written permission.
- **Change Date**: March 17, 2030
- **Change License**: Apache License 2.0

After the Change Date, all source code transitions to Apache 2.0.

See [LICENSE](LICENSE) for the full text.
