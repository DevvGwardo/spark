# Hermes-WebUI Feature Ports — Design Spec

## Overview

Port the highest-ROI features from [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui) into cloud-chat-hub. Eight discrete features, each scoped to ship standalone. This is a feature-parity sprint, not an architectural change.

Architectural choices from hermes-webui that do **not** port (no-build philosophy, Python SSE, PWA, password auth, multi-user model) are deliberately excluded.

## Goals

- Close real friction gaps (export, approval fatigue, session organization at scale)
- No new dependencies unless necessary (only `mermaid` is added)
- Every feature ships with a test that proves its success condition
- Each feature is an independent PR — no cross-feature coupling

## Feature Summary

| # | Feature | Primary files | New dep |
|---|---|---|---|
| 1 | Approval scopes (once / session / always) | `ChangeApprovalModal.tsx`, hermes store | — |
| 2 | Conversation export (MD + JSON) | `db.ts`, sidebar context menu | — |
| 3 | Conversation import (JSON) | `db.ts`, `AppLayout.tsx` | — |
| 4 | Mermaid rendering | `MarkdownRenderer.tsx` | `mermaid` |
| 5 | Turn queue during streaming | `useChat.ts`, `ChatInput.tsx`, hermes store | — |
| 6 | Archive conversations | `Conversation` type, server store, `ChatSidebar.tsx` | — |
| 7 | Session tags | `Conversation` type, server store, `ChatSidebar.tsx` | — |
| 8 | SSE auto-reconnect | `server/lib/hermes.ts`, `useChat.ts` | — |

Recommended sprint order: **1 → 4 → 5 → 2 → 3 → 6 → 7 → 8**. Fast wins early; schema changes (6/7) and bridge changes (8) last.

---

## Feature 1: Approval Scopes

**Problem:** `ChangeApprovalModal.tsx` currently has `onAccept` (once) and `onAcceptAlways` (persistent). Long agent runs still trigger a prompt per tool call because there's no "session" scope, and "always" is all-or-nothing rather than policy-keyed.

**Design:**
- Add middle button `Approve for session` between the existing two.
- New `approvalPolicies` slice in the hermes store:
  ```ts
  type ApprovalScope = 'session' | 'always';
  type ApprovalKey = string; // `${toolName}:${targetHash}` — hash the file path or command signature
  interface ApprovalPolicy { key: ApprovalKey; scope: ApprovalScope; createdAt: number; }
  ```
- Session scope = in-memory only, cleared when the panel closes (subscribe to panel lifecycle).
- Always scope = persisted to settings under `approvalPolicies`.
- Before opening the modal, check policies; if matched → auto-resolve and skip modal.
- New **Settings → General → "Approval policies"** section: list of active policies with revoke button, plus a "Clear all session approvals" action.

**Files:**
- Modify: `src/components/chat/ChangeApprovalModal.tsx` — add 3rd button, rename props to `onApproveOnce | onApproveSession | onApproveAlways`
- Modify: `src/hooks/useChat.ts` — check policy before opening modal; record policy on accept
- Modify: settings store (wherever settings live) — persist `approvalPolicies`
- Modify: existing settings modal — add policies panel

**Verify:**
- Test (`change-approval-modal.test.tsx`): all 3 buttons render, each calls the right handler.
- Manual: agent run touches 5 files; first approval with "session" → remaining 4 auto-approve. Close panel, reopen → modal shows again. Pick "always" → policy listed in settings, revoke works.

---

## Feature 2: Conversation Export

**Problem:** No way to extract a conversation. Users want portability, backup, and the ability to paste a full session into a GitHub issue or doc.

**Design:**
- Add two functions in `src/lib/db.ts`:
  ```ts
  async function exportConversationJson(id: string): Promise<Blob>
  async function exportConversationMarkdown(id: string): Promise<Blob>
  ```
- JSON schema (versioned from v1):
  ```json
  {
    "schemaVersion": 1,
    "exportedAt": "<iso>",
    "conversation": { /* Conversation fields minus runtime-only */ },
    "messages": [ /* Message[] with parts + toolInvocations preserved */ ]
  }
  ```
- Markdown template:
  ```
  # {title}
  _{provider} · {model} · {createdAt}_

  ---

  ## user
  {content}

  ## assistant
  {content}

  > Tool: {name}
  > Input: `{json}`
  > Output: `{json}`

  ---
  ```
  Strip image data URIs to `[image omitted]` with a byte count to keep files small.
- Expose in sidebar row kebab/context menu: **Export → Markdown / JSON**. Triggers browser download via `URL.createObjectURL`.

**Files:**
- Modify: `src/lib/db.ts` — add two exporters, Blob return
- Modify: `src/components/sidebar/ChatSidebar.tsx` — add export submenu to existing row actions
- New: `src/lib/conversation-export.ts` — pure formatting helpers (unit-testable)

**Verify:**
- Unit test: export a 3-message conversation with a tool call → JSON round-trips through JSON.parse; Markdown contains expected headers.
- Manual: export a real conversation, diff contents against the UI.

---

## Feature 3: Conversation Import

**Problem:** Complement to export. Lets users restore backups or share conversations.

**Design:**
- Add `importConversationJson(file: File): Promise<Conversation>` in `src/lib/db.ts`.
- Behavior:
  - Validate `schemaVersion` — reject unknown versions with a clear error.
  - Generate new IDs for conversation and every message. **Never overwrite** an existing conversation.
  - Set `createdAt = updatedAt = now` but preserve original timestamps in a `originalCreatedAt` field (optional, non-breaking).
  - Insert conversation + messages atomically (server-side).
  - Return the new conversation; sidebar refreshes and selects it.
- UI: new "Import conversation" entry in the sidebar header or `AppLayout.tsx` menu; opens a file picker (`.json` only).
- Invalid file → toast error with reason.

**Files:**
- Modify: `src/lib/db.ts` — add importer
- Modify: `src/components/sidebar/ChatSidebar.tsx` or `AppLayout.tsx` — add import entry
- Server: likely a `POST /functions/v1/chat-store/import` endpoint for atomicity; if the existing CRUD supports bulk insert, use that instead

**Verify:**
- Export a conversation → delete it → import the file → conversation reappears with identical content but new ID.
- Import a malformed JSON → clear error toast, no partial write.

---

## Feature 4: Mermaid Rendering

**Problem:** Technical users paste diagrams as ```` ```mermaid ```` fences; today they render as plain code blocks.

**Design:**
- Install `mermaid` (client-only).
- In `src/components/chat/MarkdownRenderer.tsx`, intercept the `code` node renderer:
  - If `className === 'language-mermaid'`, render a `<MermaidDiagram source={children} />` component instead.
- `MermaidDiagram`:
  - Lazy-imports mermaid (keeps initial bundle small)
  - Initializes with `theme: 'dark' | 'default'` based on current theme
  - Re-renders on theme change
  - Catches render errors → fallback to the original code block with an error badge
  - Respects `prefers-reduced-motion` (mermaid supports this via config)

**Files:**
- Modify: `src/components/chat/MarkdownRenderer.tsx` — add mermaid branch
- New: `src/components/chat/MermaidDiagram.tsx`
- Modify: `package.json` — add `mermaid` dep

**Verify:**
- Unit test: renders a valid flowchart → SVG present in DOM; invalid syntax → fallback code block with error message.
- Manual: paste a sequence diagram → renders. Toggle light/dark → re-renders with correct colors.

---

## Feature 5: Turn Queue

**Problem:** Sending a message while the agent is streaming has undefined behavior today (dropped, raced, or errored). Users expect queuing — especially in long agent runs where they want to chain follow-ups without waiting.

**Design:**
- Add `pendingTurns: string[]` per-panel in the hermes store (keyed by panel ID).
- In `useChat.ts` submit path:
  - If `isStreaming` → push content to `pendingTurns`, clear the input, return
  - On stream `done` event → `shift()` from queue and auto-submit the next turn
- UI: a small chip near the composer: **`Queued: {n}`** when `n > 0`, clickable to open a dropdown listing queued messages with a remove (`×`) button per item.
- On panel close or error → prompt user: "Discard N queued messages?" (default: keep in queue until resolved).

**Files:**
- Modify: `src/hooks/useChat.ts` — queuing + drain logic
- Modify: `src/components/chat/ChatInput.tsx` — queued chip + dropdown
- Modify: hermes store — `pendingTurns` slice

**Verify:**
- Unit test: submit 3 messages during `isStreaming=true` → queue length 3; fire `done` → first drains, streaming resumes, etc.
- Manual: rapid-fire 3 messages during a long tool call. All 3 process in order; chip decrements; input stays usable throughout.

---

## Feature 6: Archive Conversations

**Problem:** Pin + search works at 20 conversations, breaks at 200. Archive hides stale sessions without deleting them.

**Design:**
- Extend `Conversation`:
  ```ts
  archivedAt?: string | null;
  ```
- Server-side store (SQLite): migration adds `archived_at TEXT NULL`. List queries default to `WHERE archived_at IS NULL`; pass `?includeArchived=1` or `?archivedOnly=1` to override.
- `ChatSidebar.tsx`:
  - Main list hides archived
  - New collapsed "Archived" group at the bottom of the list, sorted by `archivedAt` desc
  - Row context menu: **Archive** (or **Unarchive** if already archived)
  - Keyboard: `E` on a focused row to archive (hermes-webui convention)
- Count badge on the Archived header: `Archived (12)`.

**Files:**
- Modify: `src/lib/db.ts` — add field, include-archived query param
- Server: migration + updated queries in chat-store route
- Modify: `src/components/sidebar/ChatSidebar.tsx` — archive group, context menu item
- Modify: `ChatSidebar.tsx` grouping logic (currently does Today/Yesterday/Earlier — add "Archived" after Earlier)

**Verify:**
- Migration runs on an existing DB without data loss (backup first, test on copy).
- Archive a conversation → vanishes from main list, appears under Archived. Unarchive → returns to its date group.

---

## Feature 7: Session Tags

**Problem:** Cross-cutting organization. Pin is binary; tags are many-to-one and cross-project.

**Design:**
- Extend `Conversation`:
  ```ts
  tags?: string[];
  ```
- Server store: new column `tags TEXT` (JSON array). Index-free — filter in-memory client-side for now; revisit if conversations exceed ~5k.
- Row UI: small colored chips next to the title (max 2 visible, `+N` overflow). Color derived from `hash(tag) % paletteLength` — stable per tag name.
- Adding a tag: right-click row → **Add tag…** → small inline input; Enter to commit. Autocompletes against existing tags.
- Sidebar filter bar (above the list, optional collapse): `All | #tag1 | #tag2 | …` — click to filter; shift-click for multi-select (AND).
- No tag management panel v1 — tags are created implicitly when first used, removed when unused.

**Files:**
- Modify: `src/lib/db.ts` — add `tags`, helper `getAllTags()`
- Server: migration + queries accept/return tags
- Modify: `src/components/sidebar/ChatSidebar.tsx` — chips, filter bar, inline add-tag input
- New: `src/lib/tag-color.ts` — stable hash → palette index

**Verify:**
- Add `#prod` and `#scratch` to two conversations → chips render, filter bar shows both. Click `#prod` → only that row visible.
- Remove all tag uses → filter entry disappears.

---

## Feature 8: SSE Auto-Reconnect

**Problem:** If the network blips mid-agent-run, the SSE stream dies and the user sees a hung UI. hermes-webui solves this with a resume token; we should too.

**Design:**
- **Server-side (`server/lib/hermes.ts`):**
  - `POST /api/hermes/chat/start` returns `{ streamId, resumeToken }`.
  - Bridge buffers the last N SSE events per stream (ring buffer, N=200) keyed by `streamId` with a TTL (e.g. 60s after `done`).
  - `GET /api/hermes/chat/stream?id=<streamId>&since=<lastEventId>` replays buffered events after `since`, then tails live events.
- **Client-side (`useChat.ts`):**
  - Wrap `EventSource` in a reconnecting class
  - Track last successful `event.lastEventId`
  - On `error` → exponential backoff (250ms, 500ms, 1s, 2s, cap 5s), reconnect to `?since=<lastEventId>`
  - After 3 consecutive failures → show "Reconnecting…" toast; after 10 → surface as error to user, let them retry manually
  - Hide the reconnect state entirely when a single retry succeeds within 1s (no flicker)

**Files:**
- Modify: `server/lib/hermes.ts` — event buffer, `?since=` support
- Modify: `src/hooks/useChat.ts` — reconnecting EventSource wrapper
- New: `src/lib/reconnecting-sse.ts` — standalone reusable class

**Verify:**
- Integration test: start a stream, kill the TCP connection mid-run (`server.close()`), restart → client reconnects and receives buffered events in order.
- Manual: disable/re-enable WiFi during a long agent run → stream continues with no user-visible interruption (beyond a brief toast if >1s).

---

## Cross-Cutting Notes

### Testing

Each feature lands with:
- A unit test proving the success condition
- A manual verify step in the PR description
- Updates to existing tests if behavior changes (e.g. approval modal tests)

### Settings Persistence

Features 1 and 7 add to user settings. Use the existing settings store pattern. Migration: if a user upgrades and has no `approvalPolicies` / no `tags`, default to empty — no prompts, no migrations needed.

### Schema Versioning

Feature 2's JSON export is versioned (`schemaVersion: 1`). Any future breaking change bumps the version. Feature 3's importer must reject unknown versions rather than guess.

### What's deferred

- **i18n** — low ROI for the user persona; revisit if international users appear
- **PWA / mobile** — out of scope for Electron-first
- **Password auth** — out of scope for desktop single-user
- **Circular context ring** — already have token counts; reskin is subjective polish

---

## Implementation Plan

A companion plan file will be created at `docs/superpowers/plans/2026-04-23-hermes-webui-features.md` with task-level checkboxes per feature. The plan expands each section above into concrete edits + commit points.

Order: 1 → 4 → 5 → 2 → 3 → 6 → 7 → 8.
