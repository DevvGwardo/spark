# CloudChat

An AI-powered chat application with multi-provider support, agentic tool calling, live code preview, GitHub integration, and a knowledge base — built with React, Vite, TypeScript, and Electron.

![Cloud Chat Interface](public/cloudchat-screenshot-2026-03-17.png)
![Cloud Chat Interface Pull Request](public/cloud-chat-hub-screenshot.png)

## Features

- **Multi-Provider AI Chat** — Connect to 15+ LLM providers including OpenAI, Anthropic, Google, Groq, DeepSeek, Mistral, xAI, and more.
- **Hermes Agent Mode** — Agentic AI with configurable tool access (web search, browsing, terminal, file operations, code execution) via the Hermes Bridge.
- **Orchestrator Mode** — Multi-agent coordination that breaks complex requests into parallel sub-tasks executed by specialized code agents.
- **Live Code Preview** — Real-time preview of generated code with support for:
  - Plain HTML/CSS/JS
  - React (Vite) projects with JSX/TSX transpilation
  - Next.js projects with mocked routing (`Link`, `useRouter`, `Image`)
  - Markdown rendering
- **GitHub Integration** — Analyze repositories, propose and stage file changes, create branches, open pull requests, monitor CI checks, and merge — all from the chat interface.
- **Changeset & Workspace Panel** — Review proposed file changes with inline diffs, stage/unstage individual files, revert changes, and commit to a PR.
- **Knowledge Base** — Attach custom notes or files as context injected into conversations for more relevant AI responses.
- **Code Analyzer** — Automated repository analysis for bugs, security issues, performance problems, and improvement suggestions.
- **Streaming Responses** — Real-time token streaming with context usage tracking (input/output tokens, context window percentage).
- **Desktop App** — Native macOS Electron app with global hotkey, tray menu, and auto-updates.
- **Customizable** — Per-provider model selection, temperature, top-p, max tokens, system prompts, and theme (light/dark/system).

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **State**: Zustand (persisted stores)
- **AI SDK**: Vercel AI SDK (`ai` + `@ai-sdk/react`)
- **Backend**: Node.js/Express server (chat proxy, GitHub integration, key validation, orchestrator)
- **Agent Bridge**: Python FastAPI (Hermes Bridge for agentic tool calling)
- **Desktop**: Electron with electron-vite and electron-builder
- **Markdown**: react-markdown with GFM, math (KaTeX), and syntax highlighting

## Getting Started

### Web (Development)

```sh
# Clone the repository
git clone <YOUR_GIT_URL>
cd cloud-chat-hub

# Install dependencies
npm install

# Start the API server (required — runs on port 3001)
npm run server

# In a separate terminal, start the frontend dev server
npm run dev
```

The app requires **both** the API server and the frontend dev server to be running.

### Hermes Bridge (Optional — for Agent Mode)

The Hermes Bridge enables agentic AI with tool access (web search, terminal, file ops, etc.).

```sh
cd hermes-bridge

# Install Python dependencies
pip install -r requirements.txt

# Set your OpenRouter API key
export HERMES_OPENROUTER_KEY="your-openrouter-key"

# Start the Hermes Bridge (runs on port 3002)
python main.py
```

Once running, select "Hermes" as the provider in Settings to use agent mode. Configure which toolsets (web, browser, vision, terminal, files, code_execution) are enabled in Settings.

### Desktop App (Electron)

```sh
# Development mode with hot reload
npm run electron:dev

# Build for macOS (DMG + ZIP)
npm run electron:build

# Build and publish to GitHub Releases
npm run electron:publish
```

The Electron app bundles the frontend and API server together. Features include:
- **Global hotkey**: Cmd+Shift+Space to toggle window visibility
- **Tray menu**: Show, New Chat, Quit
- **Auto-updates**: Via GitHub Releases (production builds)

### OpenClaw (Optional — Local Agent)

```sh
# Ensure OpenClaw CLI is installed
# Default location: ~/.openclaw/bin/openclaw
# Override with: export OPENCLAW_BIN=/path/to/openclaw

# Select "OpenClaw" as provider in Settings
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3001` | URL of the API server |
| `LOVABLE_API_KEY` | — | Server-side key for the Lovable AI provider |
| `HERMES_OPENROUTER_KEY` | — | OpenRouter API key for Hermes agent execution |
| `HERMES_PORT` | `3002` | Port for the Hermes Bridge server |
| `HERMES_TOOLSETS` | `web,browser,vision` | Default toolsets for the Hermes agent |
| `HERMES_DEFAULT_MODEL` | `meta-llama/llama-4-maverick` | Default model for Hermes agent |
| `HERMES_MAX_ITERATIONS` | `60` | Maximum tool-use iterations per Hermes turn |
| `HERMES_PROVIDER_TIMEOUT_SECONDS` | `5400` | Per-request timeout for Hermes model calls |
| `HERMES_RUN_COMMAND_TIMEOUT_SECONDS` | `5400` | Timeout for Hermes `run_command` tool executions |
| `HERMES_EXECUTE_PYTHON_TIMEOUT_SECONDS` | `5400` | Timeout for Hermes `execute_python` tool executions |
| `ORCHESTRATOR_SUBTASK_TIMEOUT_MS` | `5400000` | Per-subtask timeout for orchestrator coding agents |
| `ORCHESTRATOR_HEARTBEAT_MS` | `5000` | Heartbeat interval used to keep orchestrator streams alive |
| `OPENCLAW_TURN_TIMEOUT_SECONDS` | `5400` | Timeout for a single OpenClaw agent turn |
| `OPENCLAW_BIN` | `~/.openclaw/bin/openclaw` | Path to the OpenClaw CLI binary |

API keys for individual providers (OpenAI, Anthropic, etc.) are configured in the app's Settings UI and stored in the browser.

## Project Structure

```
src/
├── components/
│   ├── chat/          # Chat UI (input, messages, error banners, approval modals)
│   ├── github/        # GitHub panel, analyzer, PR creation modal
│   ├── layout/        # App shell and layout
│   ├── preview/       # Workspace sidebar (changeset diffs, live code preview)
│   ├── settings/      # Settings modal, knowledge panel
│   ├── sidebar/       # Chat history sidebar
│   └── ui/            # shadcn/ui primitives
├── hooks/             # Custom hooks (useChat, useTheme, useMobile)
├── lib/               # API client, token counting, provider config, diff utils
├── stores/            # Zustand stores (chat, settings, changeset, knowledge, hermes, orchestrator)
└── pages/             # Route pages
server/
├── index.ts           # Express API server (chat proxy, GitHub, preview, orchestrator)
├── provider-config.ts # Provider routing, model lists, headers
├── openclaw.ts        # OpenClaw CLI integration
├── orchestrator.ts    # Multi-agent orchestrator
└── preview-manager.ts # Project preview lifecycle (clone, build, serve)
hermes-bridge/
├── main.py            # FastAPI server for agentic tool calling
├── run_agent.py       # AIAgent class with tool definitions and agentic loop
└── requirements.txt   # Python dependencies (fastapi, uvicorn, httpx)
electron/
├── index.ts           # Electron main process (window, tray, hotkey, auto-update)
├── preload.ts         # Preload bridge (exposes API port to renderer)
└── server.ts          # Embedded Express server launcher
```

## Supported Providers

| Provider | Default Model | Notes |
|----------|--------------|-------|
| OpenAI | gpt-5.2 | Supports reasoning effort (GPT-5/o-series) |
| Anthropic | claude-sonnet-4-5 | |
| Google | gemini-2.5-flash | |
| xAI | grok-4-fast-reasoning | |
| Groq | llama-3.3-70b-versatile | |
| DeepSeek | deepseek-chat | |
| Mistral | mistral-large-latest | |
| Together | Llama-3.3-70B-Instruct-Turbo | |
| MiniMax | MiniMax-M2.5 | Coding Plan & Pay-as-you-go tiers |
| Kimi | moonshot-v1-32k | Long-context reasoning |
| Cerebras | llama-3.3-70b | Ultra-fast free inference |
| OpenRouter | nvidia/llama-3.1-nemotron-70b-instruct:free | Free models from multiple providers |
| SambaNova | Meta-Llama-3.3-70B-Instruct | |
| Hermes | meta-llama/llama-4-maverick | Agent mode with tool access (requires Hermes Bridge) |
| OpenClaw | (local) | Local agentic AI (requires OpenClaw CLI) |

## GitHub Integration

CloudChat provides a full GitHub workflow:

1. **Connect** — Add a GitHub Personal Access Token in Settings.
2. **Analyze** — Use the Analyzer tab to scan a repository for bugs, security issues, and improvements.
3. **Propose Changes** — The AI proposes file changes via `propose_changes` tool calls. Review them in the Workspace panel.
4. **Stage & Review** — Stage/unstage individual files, view inline diffs with added/removed line counts, and revert unwanted changes.
5. **Create PR** — Open a pull request with auto-generated branch name, title, and description. Supports draft PRs.
6. **Monitor & Merge** — Track CI check status, then merge with squash, rebase, or merge commit strategy.

**Auto-approval mode**: Enable in Settings to skip the approval modal — the agent will propose and execute changes in one step.

## Orchestrator Mode

For complex requests, enable the Orchestrator in Settings → Roles:

1. A **planning model** breaks the request into 1–6 sub-tasks.
2. **Code agents** execute sub-tasks in parallel.
3. The orchestrator **synthesizes** results into a single response.

Configure the planning model, code model, and max sub-agents in Settings.

## Knowledge Base

Add custom context to improve AI responses:

- **Notes** — Write text snippets directly.
- **Files** — Upload documents as knowledge entries.
- Toggle entries on/off per conversation.
- Active entries are prepended to the system prompt.

Access via the Knowledge tab in the sidebar or Settings.

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
| `npm run electron:build` | Build macOS desktop app (DMG + ZIP) |
| `npm run electron:publish` | Build and publish to GitHub Releases |

## License

This project is licensed under the **Business Source License 1.1** (BSL 1.1).

- **Permitted**: View, modify, fork, and self-host for personal or internal use.
- **Restricted**: You may not offer CloudChat (or a substantially similar product built from this source) as a competing hosted or commercial service without explicit written permission from the author.
- **Change Date**: March 17, 2030
- **Change License**: Apache License 2.0

After the Change Date, all source code transitions to Apache 2.0 and becomes fully open-source.

See [LICENSE](LICENSE) for the full text.
