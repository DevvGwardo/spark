---
title: "CloudChat"
topic: "technical"
data_type: "system/structure"
complexity: "complex"
point_count: 6
source_language: "en"
user_language: "en"
---

## Main Topic
CloudChat is an AI chat client built around Hermes, with agent tools, GitHub repo workflows, multi-provider routing, live preview, and a native macOS Electron app. The source also shows a two-server architecture, current build health, and codebase scale.

## Learning Objectives
After viewing this infographic, the viewer should understand:
1. what CloudChat is and what makes Hermes different from standard chat
2. how the product surface combines agent mode, repo workflows, provider routing, and desktop UX
3. how the system is structured today, including architecture, status, and codebase scale

## Target Audience
- **Knowledge Level**: Intermediate
- **Context**: Evaluating the project as a product and engineering system
- **Expectations**: Quick understanding of capabilities, architecture, and current status

## Content Type Analysis
- **Data Structure**: Product overview plus architecture plus status snapshot
- **Key Relationships**: CloudChat UI connects to the Express Server and Hermes Bridge; Hermes powers repo tools, tool loops, and multi-agent workflows
- **Visual Opportunities**: Architecture pipeline, capability modules, metric callouts, status badges, codebase composition blocks

## Key Data Points (Verbatim)
- "AI chat client built around Hermes — an autonomous AI agent with real tool access."
- "Also supports 16 other LLM providers, an orchestrator for parallel sub-tasks, and ships as a native macOS Electron app."
- "17 LLM Providers"
- "Themes — 6 themes (Default, Ayu, Dracula, Gruvbox, IntelliJ, Terminal) with 10 accent colors"
- "CloudChat UI  →  Express Server (port 3001)  →  Hermes Bridge (port 3002)"
- "agent-loop (default) — Full Hermes agent with tool calling"
- "swarm — Architect → Implementor → Reviewer pipeline"
- "Build: npm run build — ✅ Clean (no errors, chunk-size warnings only)"
- "Slash commands — 9/26"
- "E2E tests — ⚠️ Not run"
- "version: 1.0.0-beta.3"
- "license: PolyForm-Shield-1.0.0"
- "Sum: 1660 files, 106236 code, 11516 comment"

## Layout × Style Signals
- Content type: system/structure + overview → suggests bento-grid or dense-modules
- Tone: technical product + current-state snapshot → suggests pop-laboratory or technical-schematic
- Audience: builder / contributor / evaluator → suggests clean technical styles
- Complexity: complex → suggests dense layouts with modular grouping

## Design Instructions (from user input)
- Topic provided: cloud-chat-hub
- No explicit style, color, aspect, or language constraints were provided

## Recommended Combinations
1. **dense-modules + pop-laboratory** (Recommended): Best fit for a high-density technical product map with architecture, metrics, and status modules.
2. **bento-grid + technical-schematic**: Good for a clean system overview with architecture emphasis and strong engineering cues.
3. **dashboard + corporate-memphis**: Best if the user wants a product KPI board feeling with clearer emphasis on metrics and status.
4. **structural-breakdown + technical-schematic**: Best if the user wants the architecture pipeline and subsystem anatomy to dominate the composition.
