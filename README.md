# CloudChat

A multi-provider AI chat client with server-side agentic repo tools, orchestrator mode, GitHub integration, and live code preview — built with React, Vite, TypeScript, and Electron.

![Cloud Chat Interface](public/cloudchat-screenshot-2026-03-17.png)
![Cloud Chat Interface Pull Request](public/cloud-chat-hub-screenshot.png)

## Features

- **Multi-Provider AI Chat** — Connect to 17 LLM providers: OpenAI, Anthropic, Google, xAI, Groq, DeepSeek, Mistral, Together, MiniMax, Kimi, Cerebras, OpenRouter, SambaNova, z.ai (Zhipu), OpenClaw, and Hermes Agent.
- **Server-Side Agentic Tools** — When a GitHub repo is connected, the server provides tool-calling agents that can read, edit, create, delete, and batch-edit repo files — with full changeset staging and PR workflow.
- **Hermes Agent Mode** — Autonomous agent with configurable toolsets (web search, browsing, terminal, file operations, code execution) via the Hermes Bridge, powered by OpenRouter models.
- **Orchestrator Mode** — Multi-agent coordination that decomposes complex requests into parallel sub-tasks, executes them with retry logic and fallback models, then synthesizes results.
- **Live Code Preview** — Real-time preview of generated code:
  - Plain HTML/CSS/JS
  - React (Vite) with JSX/TSX transpilation
  - Next.js with mocked routing (`Link`, `useRouter`, `Image`)
  - Markdown rendering
- **GitHub Integration** — Full PR workflow: analyze repos, propose file changes, stage/unstage with inline diffs, create branches, open PRs, monitor CI checks, and merge — all from the chat.
- **Issue Browser** — Browse, filter, and sort repository issues with issue-to-chat flow for contextual AI assistance.
- **Changeset & Workspace Panel** — Review proposed file changes with inline diffs, added/removed line counts, and per-file staging.
- **Streaming Responses** — Real-time token streaming with context usage tracking (input/output tokens, context window percentage).
- **Desktop App** — Native macOS Electron app with global hotkey (Cmd+Shift+Space), tray menu, and auto-updates via GitHub Releases.
- **Theming** — Light, dark, and system theme modes with customizable font size and family.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **State**: Zustand (11 persisted stores)
- **AI SDK**: Vercel AI SDK (`ai` + `@ai-sdk/react`) with first-party and OpenAI-compatible provider adapters
- **Backend**: Node.js/Express server — chat proxy, direct SSE proxy for compatible providers, server-side agentic tool loop, GitHub integration, orchestrator, preview manager
- **Agent Bridge**: Python FastAPI (Hermes Bridge for autonomous agentic tool calling)
- **Desktop**: Electron with electron-vite and electron-builder
- **Markdown**: react-markdown with GFM, math (KaTeX), and Shiki syntax highlighting

## Getting Started

### Web (Development)

```sh
git clone <YOUR_GIT_URL>
cd cloud-chat-hub

npm install

# Start the API server (required — runs on port 3001)
npm run server

# In a separate terminal, start the frontend dev server
npm run dev
```

The app requires **both** the API server and the frontend dev server to be running.

### Hermes Bridge (Optional — for Agent Mode)

The Hermes Bridge enables autonomous agentic AI with tool access.

```sh
cd hermes-bridge
pip install -r requirements.txt

export HERMES_OPENROUTER_KEY="your-openrouter-key"

# Start the Hermes Bridge (runs on port 3002)
python main.py
```

Select "Hermes Agent" as the provider in Settings. Configure toolsets (web, browser, vision, terminal, files, code_execution) in Settings.

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
| `HERMES_DEFAULT_MODEL` | `meta-llama/llama-4-maverick` | Default Hermes model |
| `HERMES_MAX_ITERATIONS` | `60` | Max tool-use iterations per turn |
| `ORCHESTRATOR_SUBTASK_TIMEOUT_MS` | `5400000` | Per-subtask timeout for orchestrator agents |
| `ORCHESTRATOR_HEARTBEAT_MS` | `5000` | Heartbeat interval for orchestrator streams |
| `OPENCLAW_TURN_TIMEOUT_SECONDS` | `5400` | Timeout for a single OpenClaw turn |
| `OPENCLAW_BIN` | `~/.openclaw/bin/openclaw` | Path to OpenClaw CLI |

API keys for individual providers are configured in the app's Settings UI and stored in the browser.

## Project Structure

```
src/
├── components/
│   ├── chat/          # Chat UI, messages, markdown renderer, activity indicators
│   ├── github/        # GitHub panel, issue browser, PR creation
│   ├── layout/        # App shell and tab layout
│   ├── preview/       # Workspace sidebar (changeset diffs, live code preview)
│   ├── settings/      # Settings modal, setup wizard
│   ├── sidebar/       # Chat history sidebar
│   ├── terminal/      # Terminal panel
│   └── ui/            # shadcn/ui primitives, SlotNumber
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
└── server.ts          # Embedded Express server launcher
```

## Supported Providers

| Provider | Default Model | Category | Notes |
|----------|--------------|----------|-------|
| OpenAI | gpt-5.4 | Featured | Reasoning effort support (GPT-5/o-series) |
| Anthropic | claude-sonnet-4-5 | Featured | |
| Google Gemini | gemini-2.5-flash | Featured | |
| xAI (Grok) | grok-4-fast-reasoning | Featured | |
| Groq | llama-3.3-70b-versatile | Open Source | Ultra-fast inference |
| Cerebras | llama-3.3-70b | Open Source | Free inference |
| OpenRouter | nemotron-70b-instruct:free | Open Source | Free models from multiple providers |
| SambaNova | Meta-Llama-3.3-70B-Instruct | Open Source | Fast free inference |
| DeepSeek | deepseek-chat | Open Source | V3 & R1 reasoning |
| Mistral | mistral-large-latest | Open Source | |
| Together AI | Llama-3.3-70B-Instruct-Turbo | Open Source | Hosted open-source models |
| MiniMax | MiniMax-M2.5 | Specialized | Coding Plan & Pay-as-you-go tiers |
| Kimi | moonshot-v1-32k | Specialized | Long-context reasoning |
| Kimi (Coding) | kimi-for-coding | Specialized | Coding Plan API |
| z.ai (Zhipu) | glm-5-plus | Specialized | GLM-5 coding plan |
| OpenClaw | (local) | Specialized | Local agentic AI (requires CLI) |
| Hermes Agent | llama-4-maverick | Specialized | Autonomous agent with tool access |

## GitHub Integration

1. **Connect** — Add a GitHub Personal Access Token in Settings.
2. **Browse Issues** — Use the issue browser to filter, sort, and jump into issue-focused chats.
3. **Propose Changes** — The AI proposes file changes via server-side repo tools. Review in the Workspace panel.
4. **Stage & Review** — Stage/unstage files, view inline diffs with added/removed line counts, revert changes.
5. **Create PR** — Open a pull request with auto-generated branch, title, and description. Supports draft PRs.
6. **Monitor & Merge** — Track CI checks, then merge with squash, rebase, or merge commit.

## Orchestrator Mode

Enable in Settings → Roles for complex multi-step requests:

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
| `npm run electron:dev` | Electron dev mode with hot reload |
| `npm run electron:build` | Build macOS desktop app |
| `npm run electron:publish` | Build and publish to GitHub Releases |

## License

This project is licensed under the **Business Source License 1.1** (BSL 1.1).

- **Permitted**: View, modify, fork, and self-host for personal or internal use.
- **Restricted**: You may not offer CloudChat (or a substantially similar product built from this source) as a competing hosted or commercial service without explicit written permission from the author.
- **Change Date**: March 17, 2030
- **Change License**: Apache License 2.0

After the Change Date, all source code transitions to Apache 2.0 and becomes fully open-source.

See [LICENSE](LICENSE) for the full text.
