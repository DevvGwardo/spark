# CloudChat source bundle

## README.md excerpts

"AI chat client built around Hermes — an autonomous AI agent with real tool access. Hermes can read and edit your code, browse the web, run terminals, and manage GitHub repos. CloudChat gives it a beautiful interface, multi-provider routing, and live code preview."

"Also supports 16 other LLM providers, an orchestrator for parallel sub-tasks, and ships as a native macOS Electron app."

"Read, edit, create, and delete files in GitHub repos"
"Browse the web and interact with web pages"
"Run terminal commands"
"Execute code"
"Search its own memory and skill library"
"Manage multi-step tasks with a todo system"

"The bridge: CloudChat connects to Hermes through the Hermes Bridge — a Python FastAPI server that wraps the Hermes agent, provides GitHub repo tools, handles streaming, and manages credential routing across providers."

"Hermes Agent Mode — Autonomous tool-calling agent with configurable toolsets: web search, browser, terminal, files, code execution, vision"
"GitHub Repo Tools — Connect a repo and Hermes reads, edits, creates, deletes, and batch-edits files with full changeset staging and PR workflow"
"Multi-Provider Routing — Hermes routes to OpenRouter, Nous, or MiniMax based on model and ~/.hermes/auth.json credentials"
"Orchestrator Mode — Decomposes complex requests into parallel sub-tasks, executes with retry and fallback models, synthesizes results"
"Brain MCP Integration — Multi-agent coordination for parallel workstreams"

"17 LLM Providers — OpenAI, Anthropic, Google Gemini, xAI, Groq, DeepSeek, Mistral, Together, MiniMax, Kimi, Cerebras, OpenRouter, SambaNova, z.ai, OpenClaw, and Hermes Agent"
"Live Code Preview — Real-time preview of generated code: HTML/CSS/JS, React (Vite) with JSX/TSX transpilation, Next.js with mocked routing, and Markdown"
"Changeset Panel — Review proposed file changes with inline diffs, added/removed line counts, per-file staging, and revert"
"Streaming — Real-time token streaming with context usage tracking"
"Themes — 6 themes (Default, Ayu, Dracula, Gruvbox, IntelliJ, Terminal) with 10 accent colors, light/dark/system modes"
"Desktop App — Native macOS Electron app with global hotkey (Cmd+Shift+Space), tray menu, and auto-updates"

"CloudChat UI  →  Express Server (port 3001)  →  Hermes Bridge (port 3002)"
"agent-loop (default) — Full Hermes agent with tool calling"
"passthrough — Direct API forwarding without agent"
"swarm — Architect → Implementor → Reviewer pipeline"

## STATUS.md excerpts

"Build: npm run build — ✅ Clean (no errors, chunk-size warnings only)"
"HermesPTYPanel — Properly Wired"
"DockedMiniBrowser — Correctly Wired"
"Sidebar layout (60/40 flex)"
"Slash commands — 9/26"
"Build — ✅ Pass"
"E2E tests — ⚠️ Not run"

"npm run build completes in 3.8s"
"Only warnings: chunk size (several >500KB chunks including index-CABjcZZs.js at 2.3MB)"

## package.json facts

"version: 1.0.0-beta.3"
"license: PolyForm-Shield-1.0.0"
"test: vitest run"
"typecheck: tsc -p tsconfig.app.json --noEmit && tsc -p tsconfig.electron.json --noEmit"
"server: tsx server/index.ts"
"electron:dev: electron-vite dev"
"dev:electron: npx concurrently -n server,bridge,electron -c blue,green,cyan "npm run server" "cd hermes-bridge && .venv/bin/python main.py" "npm run electron:dev""

## CONTRIBUTING.md excerpts

"CloudChat is in closed beta"
"The fastest path is inside the app: click the "Report Issue" button (bottom-left of the chat panel). It pre-fills your version, OS, and the last error."
"Run checks: npm run typecheck && npm run lint && npm test"
"Keep PRs focused. One concern per PR is much easier to review than a grab-bag."

## Codebase inspection (pygount summary, generated 2026-04-19)

"TypeScript: 221 files, 41559 code, 1826 comment"
"TSX: 146 files, 37077 code, 1214 comment"
"Python: 23 files, 19096 code, 2602 comment"
"JSON: 61 files, 6398 code, 2 comment"
"Markdown: 58 files, 5649 comment"
"Sum: 1660 files, 106236 code, 11516 comment"

## Git state

"branch: main"
"commit: cd1712c"
