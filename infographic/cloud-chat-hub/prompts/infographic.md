Create a professional infographic following these specifications:

## Image Specifications

- **Type**: Infographic
- **Layout**: dense-modules
- **Style**: pop-laboratory
- **Aspect Ratio**: 16:9
- **Language**: en

## Core Principles

- Follow the layout structure precisely for information architecture
- Apply style aesthetics consistently throughout
- If content involves sensitive or copyrighted figures, create stylistically similar alternatives
- Keep information concise, highlight keywords and core concepts
- Use ample whitespace for visual clarity
- Maintain clear visual hierarchy
- Minimalist: clean canvas, ample whitespace, no complex background textures. Simple cartoon elements and icons only.

## Text Requirements

- All text must match the specified style treatment
- Main titles should be prominent and readable
- Key concepts should be visually emphasized
- Labels should be clear and appropriately sized
- Use the specified language for all text content

## Layout Guidelines

High-density modular layout with 6-7 typed information modules packed with concrete data.

- 6 distinct modules plus a title area
- Every module contains concrete data: brand names, numbers, versions, ports, file counts, build/status values
- Minimal whitespace—compact spacing prioritized over breathing room, but keep modules clearly separated and readable
- Each module identified by coordinate label or section marker such as MOD-1, SEC-A, SYS-04
- Use module archetypes adapted for this project: hero/selection array, capability array, feature cluster, architecture deep dive, status board, quick-reference metrics/workflow panel
- Include module boundary markers, comparison arrows, data callout boxes, and corner metadata
- Main title at top, prominent and impactful
- Subtitle should frame CloudChat as an agent-first technical product overview
- Numbers highlighted with accent colors, slightly larger than body text
- Every corner should contain useful information or metadata
- Dense but organized; no filler decorations

## Style Guidelines

Lab manual precision meets pop art color impact—coordinate systems, technical diagrams, and fluorescent accents on blueprint grid.

- Background: professional grayish-white with a very faint blueprint grid texture (#F2F2F2)
- Primary blocks: muted teal/sage green (#B8D8BE)
- High-alert accent: vibrant fluorescent pink (#E91E63) strictly for warnings, critical data, or winner highlights
- Marker highlights: vivid lemon yellow (#FFF200) as translucent highlighter effect for keywords and important numbers
- Line art: ultra-fine charcoal brown (#2D2926) for technical grids, coordinates, and hairlines
- Coordinate-style labels on every module (R-20, G-02, SEC-08)
- Technical diagrams, exploded-view annotations, rulers, cross-hair targets, axis arrows, and tiny corner metadata
- Strong contrast between large bold headers and tiny precise annotations
- Strictly systematic color usage: only teal, pink, yellow, charcoal
- Maintain lab-manual tension between microscopic details and macroscopic headers
- Avoid cute/cartoonish doodles, generic stock icons, soft pastel vibes, or large empty spaces

---

Generate the infographic based on the content below:

# CloudChat

## Overview
This infographic conveys how CloudChat positions itself as an AI chat client built around Hermes, what the product can do, how the architecture is wired, and what the current repo status looks like.

## Learning Objectives
The viewer will understand:
1. what CloudChat is and what Hermes adds beyond standard chat
2. which product capabilities define the current experience
3. how the architecture, health signals, and codebase scale fit together

## Required module plan

### MOD-1 — Product Positioning
- Use headline: CloudChat
- Use subhead: AI chat client built around Hermes
- Include these exact facts:
  - AI chat client built around Hermes — an autonomous AI agent with real tool access. Hermes can read and edit your code, browse the web, run terminals, and manage GitHub repos. CloudChat gives it a beautiful interface, multi-provider routing, and live code preview.
  - Also supports 16 other LLM providers, an orchestrator for parallel sub-tasks, and ships as a native macOS Electron app.
  - version: 1.0.0-beta.3
  - license: PolyForm-Shield-1.0.0

### MOD-2 — Hermes Capabilities
- Use headline: Hermes capabilities
- Include these exact items:
  - Read, edit, create, and delete files in GitHub repos
  - Browse the web and interact with web pages
  - Run terminal commands
  - Execute code
  - Search its own memory and skill library
  - Manage multi-step tasks with a todo system

### MOD-3 — Core Feature Surface
- Use headline: Core feature surface
- Use subhead: Agent-first + repo-aware + multi-provider
- Include these exact items:
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

### MOD-4 — Architecture
- Use headline: Architecture
- Use subhead: UI → server → bridge
- Show this exact pipeline prominently:
  - CloudChat UI  →  Express Server (port 3001)  →  Hermes Bridge (port 3002)
- Include these exact execution modes:
  - agent-loop (default) — Full Hermes agent with tool calling
  - passthrough — Direct API forwarding without agent
  - swarm — Architect → Implementor → Reviewer pipeline
- Include this exact bridge description:
  - The bridge: CloudChat connects to Hermes through the Hermes Bridge — a Python FastAPI server that wraps the Hermes agent, provides GitHub repo tools, handles streaming, and manages credential routing across providers.

### MOD-5 — Current Status
- Use headline: Current status
- Include these exact facts:
  - Build: npm run build — ✅ Clean (no errors, chunk-size warnings only)
  - HermesPTYPanel — Properly Wired
  - DockedMiniBrowser — Correctly Wired
  - Sidebar layout (60/40 flex)
  - Slash commands — 9/26
  - Build — ✅ Pass
  - E2E tests — ⚠️ Not run
  - npm run build completes in 3.8s
  - Only warnings: chunk size (several >500KB chunks including index-CABjcZZs.js at 2.3MB)

### MOD-6 — Repo Scale + Contribution Loop
- Use headline: Repo scale + contribution loop
- Use subhead: TypeScript-heavy codebase in closed beta
- Include these exact metrics:
  - TypeScript: 221 files, 41559 code, 1826 comment
  - TSX: 146 files, 37077 code, 1214 comment
  - Python: 23 files, 19096 code, 2602 comment
  - JSON: 61 files, 6398 code, 2 comment
  - Markdown: 58 files, 5649 comment
  - Sum: 1660 files, 106236 code, 11516 comment
- Include these exact workflow facts:
  - CloudChat is in closed beta
  - The fastest path is inside the app: click the "Report Issue" button (bottom-left of the chat panel). It pre-fills your version, OS, and the last error.
  - Run checks: npm run typecheck && npm run lint && npm test
  - Keep PRs focused. One concern per PR is much easier to review than a grab-bag.
  - branch: main
  - commit: cd1712c

## Rendering instructions
- Preserve all listed numbers, names, ports, versions, and labels exactly.
- Do not invent extra features or metrics.
- Use concise text layout with varied module sizes to fit all information.
- Make the architecture module and metrics/status modules especially legible.
- Use chartlets, badges, callout boxes, and ruler-style annotations instead of long paragraphs where possible.
- Keep the overall composition polished, publication-ready, and highly legible despite the density.

Text labels (in en):
CloudChat; AI chat client built around Hermes; Hermes capabilities; Core feature surface; Agent-first + repo-aware + multi-provider; Architecture; UI → server → bridge; Current status; Repo scale + contribution loop; TypeScript-heavy codebase in closed beta; 1.0.0-beta.3; PolyForm-Shield-1.0.0; 17 providers; 6 themes; 10 accent colors; port 3001; port 3002; 9/26; 3.8s; 2.3MB; 106236 code; 1660 files; main @ cd1712c
