<div align="center">

# CloudChat

**AI chat client with an autonomous agent brain.**

[![License](https://img.shields.io/badge/license-PolyForm--Shield--1.0.0-blue?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0--beta.3-orange?style=flat-square)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square)](electron-builder.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square)](package.json)
[![Python](https://img.shields.io/badge/python-%3E%3D3.10-green?style=flat-square)](hermes-bridge/requirements.txt)

<img src="public/cloudchat-screenshot-2026-03-17.png" alt="CloudChat interface showing a Hermes agent session with live code preview and tool calls" width="800">

[Quick Start](#-quick-start) · [Features](#-features) · [Architecture](#-architecture) · [Contributing](CONTRIBUTING.md)

</div>

---

## What is this?

CloudChat is an AI chat client that ships with **[Hermes](https://hermes-agent.nousresearch.com)** — Nous Research's autonomous agent that can read your code, browse the web, run terminals, manage GitHub repos, and actually get things done instead of just talking about them.

It also supports **15 other LLM providers** as regular chat clients, an **orchestrator** for parallel sub-tasks, and ships as a **native macOS Electron app** with auto-updates.

**Hermes is optional.** CloudChat works perfectly as a chat client with any provider without it. Hermes just makes it way more useful.

---

## Quick Start

```bash
git clone https://github.com/DevvGwardo/cloud-chat-hub.git
cd cloud-chat-hub
npm install
./start-all.sh
```

That's it. Open **http://localhost:8080**.

`start-all.sh` starts three services automatically:
- **Frontend** on `:8080`
- **API server** on `:3001`
- **Hermes bridge** on `:3002` (if you want agent mode)

It auto-detects if you have [Hermes Agent](https://hermes-agent.nousresearch.com) installed at `~/.hermes/hermes-agent` and uses its venv. If not, it falls back to the bridge's own venv — still works for basic chat across all providers, but agent tool-calling requires the real Hermes install.

To stop everything: `./start-all.sh stop`

### Desktop App

```bash
npm run electron:dev    # dev mode with hot reload
npm run electron:build  # build macOS DMG
```

---

## Features

### Hermes Agent Mode

Hermes isn't a chat bot — it's an autonomous agent with a tool loop. It plans, executes, checks results, and iterates until the task is done.

**Available toolsets:**
| Toolset | What it does |
|---------|-------------|
| `web` | Search the web for current information |
| `browser` | Open and interact with web pages |
| `terminal` | Run shell commands on your machine |
| `files` | Read and write local files |
| `code_execution` | Run code snippets |
| `vision` | Analyze images |

**Example prompts:**
- "Search for React 19 breaking changes and update my imports"
- "Read src/api/routes.ts and fix the auth middleware bug"
- "Create a new React component with a sortable table"
- "Find all TODO comments and create GitHub issues for them"

Hermes shows its work — you see every tool call, its result, and how it's reasoning through the problem in real time.

### Multi-Provider Chat

15 providers out of the box. Enter your API key in Settings and go.

OpenAI · Anthropic · Google Gemini · xAI · Groq · DeepSeek · Mistral · Together · MiniMax · Kimi · Cerebras · OpenRouter · SambaNova · z.ai · OpenClaw

Hermes agent mode is a separate feature — it uses any of the above providers as the underlying LLM, plus adds the autonomous tool loop.

### Live Code Preview

Generated code gets rendered in real time — HTML/CSS/JS, React (Vite) with JSX/TSX transpilation, Next.js with mocked routing, and Markdown.

### GitHub Integration

- Browse repos and issues from the sidebar
- Click an issue → Hermes gets full context
- Review proposed changes in the Changeset panel with inline diffs
- Stage/unstage files, then create a PR with one click

### Orchestrator Mode

For complex tasks that benefit from parallel work. The orchestrator decomposes requests into sub-tasks, runs them concurrently with retry/fallback, and synthesizes results.

### Desktop App

Native macOS Electron app with global hotkey (`Cmd+Shift+Space`), tray menu, and auto-updates.

### Themes

6 themes (Default, Ayu, Dracula, Gruvbox, IntelliJ, Terminal) with 10 accent colors. Light, dark, and system modes.

---

## Architecture

```
CloudChat UI  →  Express Server (:3001)  →  Hermes Bridge (:3002)
                      │                          │
                      ├─ Chat proxy              ├─ FastAPI SSE streaming
                      ├─ GitHub integration      ├─ Hermes AIAgent (tool loop)
                      ├─ Orchestrator            ├─ RepoToolProvider (GitHub API)
                      └─ Preview manager         └─ Credential routing (auth.json)
```

Three execution modes:
- **agent-loop** (default) — Full Hermes agent with tool calling
- **passthrough** — Direct API forwarding without agent
- **swarm** — Architect → Implementor → Reviewer pipeline

---

## Setup (Detailed)

### Prerequisites

- **Node.js** >= 20
- **Python** >= 3.10 (for Hermes bridge)
- **npm** or **bun**

### 1. Install

```bash
git clone https://github.com/DevvGwardo/cloud-chat-hub.git
cd cloud-chat-hub
npm install

# Set up the Hermes bridge (required for agent mode, optional for basic chat)
cd hermes-bridge
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ..

# (Optional) Install Hermes Agent itself for real tool-calling.
# Follow https://hermes-agent.nousresearch.com and install to ~/.hermes/hermes-agent
# (or set HERMES_AGENT_DIR to a custom path).
```

### 2. Configure Credentials

CloudChat reads credentials in this order: env var → `~/.hermes/auth.json` → OpenClaw gateway token.

```bash
# Option A: Environment variables
export HERMES_OPENROUTER_KEY="sk-or-..."
export HERMES_MINIMAX_KEY="..."

# Option B: Use the Hermes CLI (recommended)
# Install Hermes Agent per https://hermes-agent.nousresearch.com
# Then:
hermes auth login
```

### 3. Run

```bash
./start-all.sh          # start everything
# OR manually:
npm run server          # API server on :3001
cd hermes-bridge && .venv/bin/python main.py  # bridge on :3002
npm run dev             # frontend on :8080
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3001` | API server URL |
| `HERMES_PORT` | `3002` | Bridge port |
| `HERMES_TOOLSETS` | `web,browser,terminal` | Default toolsets |
| `HERMES_AGENT_DIR` | `~/.hermes/hermes-agent` | Where the real Hermes agent is installed |
| `HERMES_HOME` | `~/.hermes` | Hermes data / auth.json location |
| `HERMES_DEFAULT_MODEL` | `meta-llama/llama-4-maverick` | Default model |
| `HERMES_MAX_ITERATIONS` | `60` | Max tool calls per turn |
| `HERMES_OPENROUTER_KEY` | — | OpenRouter key (fallback) |
| `HERMES_MINIMAX_KEY` | — | MiniMax key (fallback) |

---

## Project Structure

```
src/                    # React + TypeScript frontend
├── components/
│   ├── chat/           # Chat UI, messages, markdown renderer
│   ├── github/         # GitHub panel, issue browser, PR creation
│   ├── layout/         # App shell
│   ├── preview/        # Changeset diffs, live code preview
│   ├── settings/       # Settings modal, setup wizard
│   └── sidebar/        # Chat history
├── hooks/              # useChat, useOrchestrator, useTheme
├── lib/                # API client, providers, themes
└── stores/             # Zustand stores

server/                 # Express API
├── index.ts            # Chat, GitHub, preview, model discovery
├── agent-loop.ts       # Server-side tool definitions
├── orchestrator.ts     # Multi-agent orchestrator
└── provider-config.ts  # Provider routing

hermes-bridge/          # Python FastAPI server
├── main.py             # Credential routing, SSE streaming
├── hermes_adapter.py   # Wraps real Hermes AIAgent
└── run_agent.py        # Fallback (no hermes-agent needed)

electron/               # macOS desktop app
├── index.ts            # Window, tray, hotkey, auto-update
└── preload.ts          # Preload bridge
```

---

## License

**PolyForm Shield 1.0.0** — see [LICENSE](LICENSE).

You can use, modify, and distribute CloudChat freely. The only restriction: you can't offer a competing service using it.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
