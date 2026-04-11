# Missing Features — Cloud Chat Hub UI vs. Hermes Docs

**Reviewed against:** `DOCS-FEATURES.md` (sourced from https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
**Code analyzed:** all components under `src/components/chat/`, `src/components/sidebar/`, `src/components/ui/`, `src/lib/hermes-commands.ts`, `src/hooks/useChat.ts`

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Implemented and working |
| ⚠️   | Partially implemented or stub-only |
| ❌   | Not implemented |

---

## 1. Slash Commands

**Docs spec:** 26 commands (`/new`, `/reset`, `/model`, `/provider`, `/personality`, `/retry`, `/undo`, `/stop`, `/approve`, `/deny`, `/sethome`, `/compress`, `/title`, `/resume`, `/usage`, `/insights`, `/reasoning`, `/verbose`, `/voice`, `/rollback`, `/background`, `/reload-mcp`, `/update`, `/help`) plus any installed skills.

**Current state:** `src/lib/hermes-commands.ts` defines only 9 navigation commands: `/overview`, `/cron`, `/memories`, `/skills`, `/usage`, `/sessions`, `/chats`, `/browse`, `/help`.

| Command | Status | Notes |
|---------|--------|-------|
| `/new` | ❌ | No "new conversation" handler |
| `/reset` | ❌ | No session reset handler |
| `/model` | ❌ | `ModelSelector` exists but slash command not wired |
| `/provider` | ❌ | No provider picker command |
| `/personality` | ❌ | No personality picker command |
| `/retry` | ❌ | `handleRegenerate` exists but no `/retry` command |
| `/undo` | ❌ | No "undo last exchange" handler |
| `/stop` | ⚠️ | `handleStop` + stop button exist; `/stop` slash command missing |
| `/approve` | ⚠️ | `ChangeApprovalModal` shows pending dangerous commands; `/approve` slash command missing |
| `/deny` | ⚠️ | `ChangeApprovalModal` shows pending dangerous commands; `/deny` slash command missing |
| `/sethome` | ❌ | No home channel designation command |
| `/compress` | ❌ | Bridge does it automatically; no manual `/compress` trigger UI |
| `/title` | ❌ | `renameConversation` exists; `/title [name]` command missing |
| `/resume [name]` | ❌ | Sessions are browsable but no named-resume via slash command |
| `/usage` | ⚠️ | Opens Usage tab but command not registered in hermes-commands.ts |
| `/insights [days]` | ❌ | No usage insights viewer |
| `/reasoning [level]` | ❌ | No reasoning effort toggle |
| `/verbose` | ❌ | No verbose tool progress toggle |
| `/voice [on\|off\|tts\|join\|leave\|status]` | ❌ | Voice button stub exists in ChatInput but non-functional |
| `/rollback [number]` | ❌ | No filesystem checkpoint restore UI |
| `/background <prompt>` | ❌ | No background agent spawning UI |
| `/reload-mcp` | ❌ | No MCP reload trigger |
| `/update` | ❌ | No update trigger |
| `/<skill-name>` | ❌ | Skills panel exists; no `/<skill-name>` routing |
| `yes`/`y` (approve exec) | ⚠️ | Handled by `ChangeApprovalModal`; keyboard shortcuts missing |
| `no`/`n` (deny exec) | ⚠️ | Handled by modal; keyboard shortcuts missing |

**Priority:** High. Slash commands are a primary interaction model. The 9 navigation commands are a good start but the gap on agent-facing commands is large.

---

## 2. Voice Messages (STT / TTS)

**Docs spec:** Incoming voice → transcribed via STT; outgoing responses → sent as audio via TTS. Supported on Telegram, Discord, Slack, WhatsApp, Mattermost, Matrix, Feishu, WeCom, Weixin.

**Current state:** `ChatInput.tsx` line 282 has a `title="Voice input"` button. The button exists visually but:
- No Web Audio API / MediaRecorder capture
- No audio blob construction
- No upload to `/audio/transcribe` or equivalent
- No TTS playback of agent responses
- Voice settings (`/voice on|off|tts|join|leave|status`) not implemented

**Priority:** Medium. Most users prefer text, but voice is a meaningful accessibility and mobility feature.

---

## 3. Background Tasks

**Docs spec:** `/background <prompt>` spawns a separate agent instance; main chat stays interactive; result delivered to chat when complete. Configurable notification modes: `all`, `result`, `error`, `off`.

**Current state:**
- ✅ `CronHistoryChat` + `CronJobsPanel` handle cron job runs
- ✅ `RunCard` shows individual cron run output, status, duration
- ❌ No generic `/background` for ad-hoc background prompts
- ❌ No background task notification system (non-cron background agents)
- ❌ No `all | result | error | off` mode selector UI
- ❌ No way to spawn a background agent from the UI without cron

**Priority:** Medium. Cron jobs are the main background use case today. Generic background tasks are a power-user feature.

---

## 4. Session Management

**Docs spec:** Session resume (`/resume [name]`), manual context compression (`/compress`), filesystem checkpoint rollback (`/rollback`), session titles (`/title`), per-user isolation in shared channels, thread-based sessions.

**Current state:**

| Feature | Status | Notes |
|---------|--------|-------|
| Session persistence | ✅ | Via Hermes backend |
| Session resume | ⚠️ | Sessions browsable in HermesChatsPanel; no named `/resume [name]` command |
| Context compression | ❌ | Bridge does it automatically when context limit nears; no manual trigger or UI indicator showing when compression happened |
| Session titles | ⚠️ | `renameConversation` exists; `/title` slash command missing |
| Rollback | ❌ | No `/rollback [number]` — no checkpoint listing or restore UI |
| Per-user isolation | ✅ | Per platform, handled server-side |
| Thread-based sessions | ⚠️ | Multiple chat panels exist but this is multi-panel, not per-DM-thread isolation |
| Session reset policies | ❌ | No UI for `daily | idle` reset config per platform |

**Priority:** High for rollback + compress visibility. These are core session lifecycle features that power users depend on.

---

## 5. Interrupting the Agent

**Docs spec:** `/stop` halts the running agent mid-stream.

**Current state:**
- ✅ `handleStop` in `useChat.ts` calls `abortControllerRef.current?.abort()` and resets state
- ✅ StreamingStatusBar shows elapsed time but no stop button inline
- ✅ ChatPanel passes `handleStop` to ChatArea
- ❌ No `/stop` slash command handler
- ❌ No visible "stop" button visible in the input area during streaming (user must find the panel or know to Ctrl+C)

**Priority:** High. Interrupting a runaway agent is critical. A visible stop button in the ChatInput or StreamingStatusBar during active streaming is the most important UX fix here.

---

## 6. Model Switching

**Docs spec:** `/model [provider:model]` — interactive model picker via inline keyboard/dropdown; `/provider` shows available providers with auth status.

**Current state:**
- ✅ `ModelSelector.tsx` — dropdown of available models per provider
- ✅ `handleSend` passes `activeModel` to the API
- ⚠️ Provider auth status (`/provider`) not shown anywhere
- ❌ `/model` slash command not registered
- ❌ `/provider` slash command not registered
- ⚠️ Provider picker separate from model picker

**Priority:** Medium. The ModelSelector dropdown already covers the core use case. The slash commands would be additive polish.

---

## 7. Tool Call Accordions

**Docs spec:** Streaming tool progress with emoji indicators (💻 🔍 📄 �🐍). Collapsible accordion for each tool call.

**Current state:**
- ✅ `ToolCallAccordion.tsx` — collapsible with chevron, tool icon, name, summary, result preview
- ✅ `ToolInvocationDisplay` in `ChatArea.tsx` — richer accordion for repo tools with file diff previews
- ✅ StreamingStatusBar shows elapsed time and tool count
- ⚠️ `AgentActivity.tsx` shows activity events with expand/collapse
- ❌ No emoji status indicators (💻 🔍 📄 🐍) during streaming
- ❌ No per-tool streaming progress text (e.g., "Reading main.py...")

**Priority:** Low-Medium. Accordions are already solid. Emoji indicators are cosmetic but nice.

---

## 8. Streaming Progress Indicators

**Docs spec:** Streaming responses, typing indicators, tool progress streaming (emoji + text).

**Current state:**
- ✅ `StreamingStatusBar` — elapsed time counter + tool call count during streaming
- ✅ `GhostIcon` (animated) shown during tool execution
- ✅ `VerificationGhostOverlay` shows structured progress for dangerous command verification
- ✅ `AgentActivity` shows running/completed tool events
- ❌ No typing indicator ("Hermes is thinking...")
- ❌ No per-tool streaming label ("Searching for...", "Running command...")
- ❌ No streaming progress bar or ETA

**Priority:** Medium. The elapsed timer is useful; the UX would improve with more granular per-tool progress.

---

## 9. Thread-Based Sessions

**Docs spec:** Each DM thread / forum topic gets its own session namespace. Thread reply modes: off / first / all.

**Current state:**
- ✅ Multi-panel layout (`ChatPanelContainer`) supports multiple independent conversations in parallel
- ✅ Each panel has its own scopeId and conversation isolation
- ⚠️ "Thread" in the UI means "conversation / chat panel" — not Telegram/Matrix/Discord DM threads
- ❌ No Telegram Private Chat Topics integration (Bot API 9.4)
- ❌ No Discord auto-thread creation
- ❌ No thread reply mode configuration (off / first / all)

**Priority:** Low-Medium. The multi-panel UX partially covers this, but true platform-native threading is missing.

---

## 10. Notifications & Proactive Messaging

**Docs spec:** Home channel for cron output, proactive notifications, burst protection, read receipts, typing indicators.

**Current state:**
- ✅ `Sonner` toast system (`src/components/ui/sonner.tsx`) — used for transient toasts
- ✅ `toast` hook available app-wide
- ⚠️ Cron job output delivered via `CronHistoryChat` (not push notification)
- ❌ No "home channel" designation (`/sethome`)
- ❌ No proactive message delivery to the UI (e.g., "A webhook just fired...")
- ❌ No burst protection / batching UI
- ❌ No read receipts
- ❌ No typing indicator (user → agent shown elsewhere)

**Priority:** Low. The toast system is a solid foundation. Proactive notifications would require server-sent events or WebSocket from the bridge.

---

## 11. `/insights [days]` — Usage Analytics

**Docs spec:** Show token usage and analytics per session.

**Current state:**
- ✅ `ContextUsageBar.tsx` — shows % of context window used with a circular gauge
- ✅ `HermesUsagePanel.tsx` — usage dashboard (total requests, estimated cost)
- ❌ No per-session token breakdown
- ❌ No `/insights` command
- ❌ No trend graphs or date range picker

**Priority:** Low. Usage panel exists; the slash command would just be a shortcut to it.

---

## 12. Reasoning Display Control (`/reasoning`)

**Docs spec:** Change reasoning effort or toggle reasoning display (`/reasoning [level|show|hide]`).

**Current state:**
- ✅ `reasoning` prop on `MessageBubble` — collapsible `SlDetails` with loading spinner
- ✅ Auto-opens when reasoning streams, auto-closes when done
- ❌ No `/reasoning` command
- ❌ No per-session reasoning effort level selector
- ❌ No show/hide toggle

**Priority:** Low-Medium. The reasoning display is already collapsible and auto-managed. A control for effort level would require backend support.

---

## 13. Verbose Tool Progress (`/verbose`)

**Docs spec:** Cycle tool progress display modes.

**Current state:**
- ❌ No `/verbose` command
- ❌ No verbose/compact toggle for tool display
- ✅ `AgentActivity` + `ToolInvocationDisplay` already show reasonable detail
- ⚠️ `ToolCallAccordion` is compact by default; `ToolInvocationDisplay` is richer

**Priority:** Low. Already at a reasonable verbosity level.

---

## 14. Emoji Reactions

**Docs spec:** Emoji reactions for feedback during agent processing. Reaction tracking on bot messages.

**Current state:**
- ❌ No emoji reaction UI on chat messages
- ✅ `RepoIssueBrowser.tsx` has a full emoji reaction picker for GitHub comments

**Priority:** Low. Chat-based reactions would be nice UX polish but low functional value.

---

## 15. Personality System (`/personality`)

**Docs spec:** Set agent personality via `/personality [name]`.

**Current state:**
- ❌ No personality picker
- ❌ No personality concept in stores or hooks

**Priority:** Low. Requires backend support and personality definition framework.

---

## 16. MCP Reload (`/reload-mcp`)

**Docs spec:** Reload MCP servers from config without restart.

**Current state:**
- ❌ No `/reload-mcp` command
- ❌ No MCP server management UI (though `HermesSkillsPanel` exists)

**Priority:** Low. A developer-facing feature.

---

## 17. Skills (`/<skill-name>`)

**Docs spec:** Invoke any installed skill via slash command.

**Current state:**
- ✅ `HermesSkillsPanel.tsx` — browses available skills
- ❌ No `/<skill-name>` command routing
- ❌ No skill invocation from chat

**Priority:** Medium. Skills panel exists; linking skills to slash commands would complete the feature.

---

## 18. `MEDIA:/path/to/file` (Email Attachments)

**Docs spec:** Via `MEDIA:/path/to/file` syntax, attach files to replies.

**Current state:**
- ❌ No file attachment in replies from UI

**Priority:** Low. Email-specific; would need file picker + attachment API.

---

## 19. Update Command (`/update`)

**Docs spec:** Update Hermes Agent to latest version.

**Current state:**
- ❌ No `/update` command
- ❌ No update flow UI

**Priority:** Low. Developer-facing.

---

## 20. Security — Allowlist / Pairing UI

**Docs spec:** DM pairing flow — unknown users receive one-time pairing code; approved via CLI.

**Current state:**
- ❌ No pairing UI in the cloud hub (this is server-side)
- ✅ API key modal for model provider auth

**Priority:** N/A — server-side concern.

---

## Summary: Top 10 Priorities by UX Impact

| # | Feature | Impact | Effort |
|---|---------|--------|--------|
| 1 | **Visible stop button** during streaming | High | Low — add button to StreamingStatusBar or ChatInput |
| 2 | **`/new` and `/reset`** slash commands | High | Low — wire up existing `handleNewConversation` and `handleReset` |
| 3 | **`/stop` slash command** | High | Low — wire existing `handleStop` |
| 4 | **Context compression indicator** — show user when context was auto-compressed | High | Low — add a system message on compression |
| 5 | **Per-tool streaming progress text** ("Reading main.py...", "Running npm install...") | Medium | Medium — extend StreamingStatusBar with per-tool label |
| 6 | **`/title [name]`** — set conversation title | Medium | Low — wire existing `renameConversation` |
| 7 | **`/approve` / `/deny`** — keyboard shortcuts for dangerous command approval | Medium | Low — add keyboard listeners in ChatArea |
| 8 | **Background task UI** — show running background agents with result delivery | Medium | Medium — new panel or tray component |
| 9 | **`/resume [name]`** — named session restore | Medium | Medium — needs session list by name + restore flow |
| 10 | **Voice messages** — Mic input → STT → send; TTS playback | Medium | High — requires Web Audio API + audio API endpoints |

---

## What's Already Working Well

These features from the docs are well-implemented in the UI:

- ✅ **Markdown rendering** — `MarkdownRenderer` with code blocks, syntax highlighting, tables
- ✅ **Tool call accordions** — `ToolCallAccordion` + `ToolInvocationDisplay` with file diff previews
- ✅ **Streaming elapsed timer** — `StreamingStatusBar` with seconds counter
- ✅ **Tool call count** — shown in `StreamingStatusBar`
- ✅ **Context usage gauge** — `ContextUsageBar` circular progress
- ✅ **Multi-panel layout** — `ChatPanelContainer` with resizable split view
- ✅ **Conversation pinning** — pin/unpin in `ChatPanel` menu
- ✅ **Conversation archiving** — delete/archive in `ChatPanel` menu
- ✅ **Session browsing** — `HermesChatsPanel` + `SessionHistoryChat`
- ✅ **Cron job management** — `CronJobsPanel` with create/pause/resume/delete
- ✅ **Cron run history** — `CronHistoryChat` with `RunCard` components
- ✅ **Verification overlay** — `VerificationGhostOverlay` with structured progress
- ✅ **Command suggestions** — `CommandSuggestions` popup for `/` trigger
- ✅ **Contextual suggestions** — `ContextualSuggestions` after streaming stops
- ✅ **ChangeApprovalModal** — shows pending dangerous commands with approve/deny
- ✅ **File change badges** — `FileChangeMetaBadge` with staged/added/removed counts
- ✅ **Emoji reactions on GitHub** — `RepoIssueBrowser` reaction picker
- ✅ **Toast notifications** — Sonner toast system app-wide
