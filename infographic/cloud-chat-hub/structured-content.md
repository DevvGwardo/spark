# CloudChat

## Overview
This infographic conveys how CloudChat positions itself as an AI chat client built around Hermes, what the product can do, how the architecture is wired, and what the current repo status looks like.

## Learning Objectives
The viewer will understand:
1. what CloudChat is and what Hermes adds beyond standard chat
2. which product capabilities define the current experience
3. how the architecture, health signals, and codebase scale fit together

---

## Section 1: Product Positioning

**Key Concept**: CloudChat presents itself as an agent-first chat product, not just a text interface.

**Content**:
- AI chat client built around Hermes — an autonomous AI agent with real tool access. Hermes can read and edit your code, browse the web, run terminals, and manage GitHub repos. CloudChat gives it a beautiful interface, multi-provider routing, and live code preview.
- Also supports 16 other LLM providers, an orchestrator for parallel sub-tasks, and ships as a native macOS Electron app.
- version: 1.0.0-beta.3
- license: PolyForm-Shield-1.0.0

**Visual Element**:
- Type: hero product card
- Subject: central CloudChat panel with surrounding capability badges
- Treatment: primary hero block with four compact fact chips

**Text Labels**:
- Headline: "CloudChat"
- Subhead: "AI chat client built around Hermes"
- Labels: "1.0.0-beta.3", "PolyForm-Shield-1.0.0", "16 other LLM providers", "native macOS Electron app"

---

## Section 2: What Hermes Can Do

**Key Concept**: Hermes turns the interface into an agent with concrete tool actions.

**Content**:
- Read, edit, create, and delete files in GitHub repos
- Browse the web and interact with web pages
- Run terminal commands
- Execute code
- Search its own memory and skill library
- Manage multi-step tasks with a todo system

**Visual Element**:
- Type: icon grid
- Subject: six tool capability tiles
- Treatment: evenly spaced module row with action icons

**Text Labels**:
- Headline: "Hermes capabilities"
- Subhead: "Autonomous AI agent with real tool access"
- Labels: "GitHub repos", "web", "terminal", "code", "memory", "todo"

---

## Section 3: Product Surface

**Key Concept**: The product surface combines agent mode, repo workflows, provider breadth, and polished client UX.

**Content**:
- Hermes Agent Mode — Autonomous tool-calling agent with configurable toolsets: web search, browser, terminal, files, code execution, vision
- GitHub Repo Tools — Connect a repo and Hermes reads, edits, creates, deletes, and batch-edits files with full changeset staging and PR workflow
- Multi-Provider Routing — Hermes routes to OpenRouter, Nous, or MiniMax based on model and ~/.hermes/auth.json credentials
- Orchestrator Mode — Decomposes complex requests into parallel sub-tasks, executes with retry and fallback models, synthesizes results
- Brain MCP Integration — Multi-agent coordination for parallel workstreams
- 17 LLM Providers — OpenAI, Anthropic, Google Gemini, xAI, Groq, DeepSeek, Mistral, Together, MiniMax, Kimi, Cerebras, OpenRouter, SambaNova, z.ai, OpenClaw, and Hermes Agent
- Live Code Preview — Real-time preview of generated code: HTML/CSS/JS, React (Vite) with JSX/TSX transpilation, Next.js with mocked routing, and Markdown
- Changeset Panel — Review proposed file changes with inline diffs, added/removed line counts, per-file staging, and revert
- Streaming — Real-time token streaming with context usage tracking
- Themes — 6 themes (Default, Ayu, Dracula, Gruvbox, IntelliJ, Terminal) with 10 accent colors, light/dark/system modes
- Desktop App — Native macOS Electron app with global hotkey (Cmd+Shift+Space), tray menu, and auto-updates

**Visual Element**:
- Type: dense module cluster
- Subject: feature cards grouped by agent, repo, providers, and desktop experience
- Treatment: high-density module board with badges and mini callouts

**Text Labels**:
- Headline: "Core feature surface"
- Subhead: "Agent-first + repo-aware + multi-provider"
- Labels: "Agent Mode", "Repo Tools", "17 providers", "Live Preview", "Changeset Panel", "Desktop App"

---

## Section 4: Architecture

**Key Concept**: CloudChat uses a two-server architecture with distinct execution modes behind the UI.

**Content**:
- The bridge: CloudChat connects to Hermes through the Hermes Bridge — a Python FastAPI server that wraps the Hermes agent, provides GitHub repo tools, handles streaming, and manages credential routing across providers.
- CloudChat UI  →  Express Server (port 3001)  →  Hermes Bridge (port 3002)
- agent-loop (default) — Full Hermes agent with tool calling
- passthrough — Direct API forwarding without agent
- swarm — Architect → Implementor → Reviewer pipeline

**Visual Element**:
- Type: pipeline diagram
- Subject: left-to-right system flow from UI to server to bridge
- Treatment: arrows, ports, and execution mode tags beneath the pipeline

**Text Labels**:
- Headline: "Architecture"
- Subhead: "UI → server → bridge"
- Labels: "port 3001", "port 3002", "agent-loop", "passthrough", "swarm"

---

## Section 5: Current Status

**Key Concept**: The current repo status shows a clean build with a few visible gaps and tech-debt markers.

**Content**:
- Build: npm run build — ✅ Clean (no errors, chunk-size warnings only)
- HermesPTYPanel — Properly Wired
- DockedMiniBrowser — Correctly Wired
- Sidebar layout (60/40 flex)
- Slash commands — 9/26
- Build — ✅ Pass
- E2E tests — ⚠️ Not run
- npm run build completes in 3.8s
- Only warnings: chunk size (several >500KB chunks including index-CABjcZZs.js at 2.3MB)

**Visual Element**:
- Type: status board
- Subject: green/yellow status chips with one timing metric and one warning callout
- Treatment: compact QA snapshot with badges and a highlighted 3.8s card

**Text Labels**:
- Headline: "Current status"
- Subhead: "Build clean, some gaps remain"
- Labels: "✅ Clean", "3.8s", "9/26", "⚠️ Not run"

---

## Section 6: Codebase + Contributor Workflow

**Key Concept**: The repo is large, TypeScript-heavy, and contribution flow is intentionally focused.

**Content**:
- TypeScript: 221 files, 41559 code, 1826 comment
- TSX: 146 files, 37077 code, 1214 comment
- Python: 23 files, 19096 code, 2602 comment
- JSON: 61 files, 6398 code, 2 comment
- Markdown: 58 files, 5649 comment
- Sum: 1660 files, 106236 code, 11516 comment
- CloudChat is in closed beta
- The fastest path is inside the app: click the "Report Issue" button (bottom-left of the chat panel). It pre-fills your version, OS, and the last error.
- Run checks: npm run typecheck && npm run lint && npm test
- Keep PRs focused. One concern per PR is much easier to review than a grab-bag.
- branch: main
- commit: cd1712c

**Visual Element**:
- Type: metrics + workflow split panel
- Subject: language composition blocks on one side and contributor checklist on the other
- Treatment: stacked stats with a small footer for branch and commit

**Text Labels**:
- Headline: "Repo scale + contribution loop"
- Subhead: "TypeScript-heavy codebase in closed beta"
- Labels: "106236 code", "1660 files", "closed beta", "main @ cd1712c"

---

## Data Points (Verbatim)

All statistics, numbers, and quotes exactly as they appear in source:

### Statistics
- "17 LLM Providers"
- "6 themes"
- "10 accent colors"
- "port 3001"
- "port 3002"
- "9/26"
- "3.8s"
- "2.3MB"
- "1.0.0-beta.3"
- "221 files, 41559 code, 1826 comment"
- "146 files, 37077 code, 1214 comment"
- "23 files, 19096 code, 2602 comment"
- "61 files, 6398 code, 2 comment"
- "58 files, 5649 comment"
- "1660 files, 106236 code, 11516 comment"

### Quotes
- "AI chat client built around Hermes — an autonomous AI agent with real tool access. Hermes can read and edit your code, browse the web, run terminals, and manage GitHub repos. CloudChat gives it a beautiful interface, multi-provider routing, and live code preview."
- "The bridge: CloudChat connects to Hermes through the Hermes Bridge — a Python FastAPI server that wraps the Hermes agent, provides GitHub repo tools, handles streaming, and manages credential routing across providers."
- "The fastest path is inside the app: click the "Report Issue" button (bottom-left of the chat panel). It pre-fills your version, OS, and the last error."

### Key Terms
- **agent-loop**: Full Hermes agent with tool calling
- **passthrough**: Direct API forwarding without agent
- **swarm**: Architect → Implementor → Reviewer pipeline

---

## Design Instructions

Extracted from user's steering prompt:

### Style Preferences
- No explicit style preference provided
- Topic implies technical product communication

### Layout Preferences
- No explicit layout preference provided
- Content supports modular overview or dense technical map

### Other Requirements
- Topic provided: cloud-chat-hub
- Language can remain English
