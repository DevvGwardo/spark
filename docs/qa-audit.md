# CloudChat / Spark — QA Audit Ledger

Recurring QA audit loop. One surface per run, audited across **Functionality / UI / UX**,
fixed where safe, findings logged. Be surgical — no unrelated refactors.

## Queue

Audit in priority order; skip any already `[x]`.

- [x] 1. Chat core — `src/components/chat/*` (composer, streaming, message actions, approval modals, scroll, tool-call rendering)
- [x] 2. Sidebar — `src/components/sidebar/*` (sessions, nav, search, collapse)
- [x] 3. Settings — `src/components/settings/*`
- [x] 4. Setup + Onboarding — `src/components/setup/*`, `onboarding/*`, `tour/*`
- [x] 5. Terminal — `src/components/terminal/*`
- [x] 6. Browser + Preview — `src/components/browser/*`, `preview/*`
- [x] 7. GitHub — `src/components/github/*`
- [x] 8. Kanban + Workflow — `src/components/kanban/*`, `workflow/*`
- [x] 9. Rooms + MCP — `src/components/rooms/*`, `mcp/*`
- [x] 10. Mobile surfaces — `src/mobile/*` and `/m/chat` (shared ChatArea/ChatInput on phone)
- [x] 11. Layout + Electron — `src/components/layout/*`, `electron/*` shell, window chrome
- [x] 12. UI primitives — `src/components/ui/*` (theming, focus, a11y of shared atoms)

## Findings

_Format: `- [SEV] surface — axis — one-line issue — file:line — suggested fix` (SEV ∈ BLOCKER/HIGH/MED/LOW)_

### 1. Chat core

**Functionality**
- [MED] Chat core — Functionality — `Plus`/Attach composer button has no `onClick`; clicking does nothing (dead affordance) — `src/components/chat/ChatInput.tsx:348` — wire attachment handling or remove the button. _(deferred — likely a planned-feature placeholder; needs product decision.)_
- [MED] Chat core — Functionality — User-message Edit feature is fully built in MessageBubble but unreachable: ChatArea never passes `onEdit`, so `isUser && onEdit` is never true — `src/components/chat/MessageBubble.tsx:1485`, `src/components/chat/ChatArea.tsx:880` — wire `onEdit` to a resend/rewind flow, or remove the dead edit UI. _(deferred — wiring implies resend semantics = a feature, not a fix.)_
- [LOW] Chat core — Functionality — `handleCopy` didn't guard `navigator.clipboard.writeText`; throws an unhandled rejection in non-secure contexts (e.g. `/m/chat` over http) — `src/components/chat/MessageBubble.tsx:1357` — wrap in try/catch. **FIXED.**

**UI**
- [LOW] Chat core — UI/perf — Virtuoso `components.Footer` is `React.memo(() => …)` created inline on every render, so the footer subtree (approval banner / buddy panel / activity) remounts on each ChatArea render — `src/components/chat/ChatArea.tsx:912` — hoist a stable Footer and pass live values via Virtuoso `context` prop. _(deferred — sizable refactor; low practical impact since the footer is mostly empty during streaming.)_

**UX**
- [LOW] Chat core — UX — Scroll-to-bottom FAB was gated on `isStreaming`, so there was no jump-to-latest while reading a long transcript when not streaming — `src/components/chat/ChatArea.tsx:963` — drop the `isStreaming` gate (matches ChatGPT/Claude.ai references). **FIXED.**
- [LOW] Chat core — UX/functionality — Message action bar (regenerate/rewind) was hidden for assistant turns that produced tool calls but no prose (`displayContent` falsy) — `src/components/chat/MessageBubble.tsx:1476` — show the bar when regenerate/rewind are available even without text; keep Copy gated on `displayContent`. **FIXED.**
- [LOW] Chat core — a11y — Icon-only buttons (composer Plus, message Copy/Regenerate/Rewind, tool accordions) rely on `title` rather than `aria-label` for their accessible name — `ChatInput.tsx:349`, `MessageBubble.tsx:1478+`, `ToolCallAccordion.tsx:48` — add `aria-label`. _(deferred — `title` provides a fallback accessible name; batch with the UI-primitives a11y pass, surface #12.)_
- [LOW] Chat core — a11y — Approval banner renders without `role="alert"`/`aria-live`, so SR users aren't told Hermes is awaiting approval — `src/components/chat/ChangeApprovalModal.tsx:35` — add an aria-live region. _(deferred — mitigated by the Electron native attention notification; also blocked on the Footer-remount fix to avoid repeat announcements.)_
- [LOW] Chat core — a11y — Collapsed tool accordions keep body content mounted (`max-h-0 overflow-hidden opacity-0`), leaving it in the accessibility tree — `ToolCallAccordion.tsx:74`, `MessageBubble.tsx:1011` — add `aria-hidden={!expanded}` to the collapsing body (preserves the height animation). _(deferred — minor; header already summarizes.)_

### 2. Sidebar

- [MED] Sidebar — Functionality/UX — Thread search is unimplemented: the `Search` icon is decorative (no handler/input) and `searchQuery`/`setSearchQuery` in the chat store are never read — `ChatSidebar.tsx:598`, `chat-store.ts:10,133` — wire a search input → `setSearchQuery` → filter `visibleConversations`, or remove the icon + dead store slot. _(deferred — feature/product decision.)_
- [LOW] Sidebar — UI — Thread-row "Preview line" re-rendered `conv.title` verbatim (duplicate title on every row; `Conversation` has no snippet field) — `ChatSidebar.tsx:938` — removed the redundant line. **FIXED.**
- [LOW] Sidebar — Functionality/UX — Cleanup and Export popovers don't dismiss on outside-click or Escape (unlike `CommandSuggestions`) — `ChatSidebar.tsx:599,884` — add a click-outside/Esc handler. _(deferred.)_
- [LOW] Sidebar — Functionality — Inline rename double-commits: Enter calls `handleRename`, then the unmount fires `onBlur` → `handleRename` again — `ChatSidebar.tsx:744` — guard against the double call. _(deferred — idempotent/harmless.)_
- [LOW] Sidebar — code-quality — Redundant `permissionsLabel` ternary collapses to `isUltraCompactFooter ? null : accessStatusLabel` — `ChatSidebar.tsx:179` — simplify. _(deferred — no behavior change.)_

### 3. Settings

- [MED] Settings — Functionality — Knowledge tab is a non-functional mockup: hardcoded `KNOWLEDGE_BASES` with fabricated file counts/sizes, and the cards + "Add knowledge base" button have no handlers — `SettingsModal.tsx:101,142,163` — wire a real knowledge backend or remove the tab. _(deferred — feature/product; shows fabricated data to users.)_
- [MED] Settings — UX/a11y — The settings modal is a hand-rolled `<div>`: no `role="dialog"`/`aria-modal`, no focus trap, no Escape-to-close (the app already ships an accessible `Dialog` primitive it could adopt) — `SettingsModal.tsx:1163` — migrate to the `Dialog` primitive or add dialog semantics + focus management. _(deferred — larger a11y task; a bare Escape listener risks interfering with nested selects/inputs.)_
- [LOW] Settings — Functionality — "Add provider" placeholder button has no `onClick` (dead) — `SettingsModal.tsx:1326` — wire or remove. _(deferred.)_
- [LOW] Settings — Functionality — "Clear history" deletes the IndexedDB but never refreshes in-memory stores (sidebar keeps showing threads until reload); the delete may also be blocked by the app's open DB connection — `SettingsModal.tsx:245` — close connections, reset stores, reload. _(deferred — risky.)_
- [LOW] Settings — a11y — Toggle buttons lack `role="switch"`/`aria-checked`; `<select>`s have no associated `<label htmlFor>` — _(deferred — batch with UI-primitives a11y.)_

### 4. Setup + Onboarding

- No findings. `TourController` is solid (auto-starts once after setup, waits for blocking modals to clear, marks the tour seen on first close). Setup/onboarding/tour files were scanned for dead handlers/mock/TODO — none found. _(Depth: `TourController` read in full; `BridgeSetupModal`/`WebBridgeSetup`/`SetupWizard`/`tour-config`/`motion` red-flag-grepped, not line-by-line.)_

### 5. Terminal

- [LOW] Terminal — a11y — Tab close is a clickable `<span onClick>` (not keyboard-focusable) nested inside the tab `<button>` — `TerminalPanel.tsx:327` — restructure so the label and close control are sibling buttons. _(deferred — span is a deliberate no-nested-buttons workaround.)_
- Otherwise strong: spawn-error surface, full xterm cleanup on unmount, "desktop app only" fallback when no PTY API, debounced refit/resize, command history + Tab completion (`HermesTerminal`).

### 6. Browser + Preview

- [LOW] Preview — UX — "Revert all" discards every uncommitted change instantly with no confirmation (per-file revert is also unconfirmed) — `PreviewSidebar.tsx:325` — confirm the bulk discard. _(deferred — may be intentional power-user speed.)_
- [LOW] Preview — a11y — Rail resize handle has no keyboard support / ARIA (cf. the sidebar handle which does) — `PreviewSidebar.tsx:244` — add `role="separator"` + arrow-key resize. _(deferred.)_
- `PreviewSidebar` otherwise solid (staged/unstaged totals, per-file diff, tooltips). _(Depth: `PreviewSidebar` read in full; `MiniBrowser` (927 lines) red-flag-grepped only — clean.)_

### 7. GitHub

- [LOW] GitHub — Functionality/UX — `handleSelectFile` swallows file-read failures silently (no toast/error) — `GitHubPanel.tsx:271` — surface a toast on failure. _(deferred.)_
- Strong: `window.confirm` guards on destructive repo switches with pending-change counts, staged progress bar, tree-API fallback, loading/empty/error states. _(Depth: `GitHubPanel` read in full; `CreatePRModal`/`RepoIssueBrowser`/`GitHubAnalyzer` red-flag-grepped — clean.)_

### 8. Kanban + Workflow

- [LOW] Kanban — a11y — Drag-and-drop is mouse-only; there's no keyboard path to move a card between lanes — `KanbanBoard.tsx:163` — add keyboard move/menu. _(deferred — known-hard DnD a11y.)_
- Solid: loading/error/empty ("Drop cards here") states, outside-click menu dismissal, optimistic move with store-level error handling.

### 9. Rooms + MCP

- No findings. `McpStoreView` is exemplary (loading/error/empty states, `confirm` on uninstall, per-card error + busy states, installed-vs-catalog dedupe). _(Depth: `McpStoreView` read in full; `CreateRoomDialog`/`RoomSettingsPanel` red-flag-grepped — clean.)_

### 10. Mobile surfaces

- No findings. `MobileChat`/`MobileShell` reuse the shared `ChatArea`/`ChatInput` (so the surface-1 fixes also land on `/m/chat`), use 44×44 touch targets, and label nav buttons. Confirms the project note that mobile shares chat components rather than re-implementing them.

### 11. Layout + Electron

- [MED] Layout — Functionality — "Rename thread" uses `window.prompt()`, which Electron disables — so the action silently no-ops in the desktop app — `AppLayout.tsx:597` **and** `ChatPanel.tsx:384` — replace with an inline edit or the `Dialog` primitive. _(deferred — needs new UI in 2 files; sidebar double-click rename still works, so degraded not blocking. Note: `ChatPanel.tsx` belongs to surface 1 — found during this pass.)_
- [LOW] Layout — code-quality — No-op prop `cwd={activeRepo?.name ? undefined : undefined}` (both branches `undefined`) — `AppLayout.tsx:814` — removed the dead prop. **FIXED.**
- [LOW] Layout — Functionality — `focusedRoom` is read via `useRoomStore.getState()` during render (not subscribed), so the header room title won't update on a room rename — `AppLayout.tsx:106` — read it through the hook. _(deferred.)_
- Strong a11y/structure: skip-to-content link, `role="separator"` sidebar handle with arrow-key resize, ARIA nav landmarks, `ErrorBoundary` around every lazy surface, Ctrl+`/Cmd+K shortcuts. `window.confirm` usages elsewhere are fine (Electron supports `confirm`, only `prompt` is disabled).

### 12. UI primitives

- [MED] UI primitives — a11y — The toast container has no `aria-live`/`role="status"|"alert"` region and unmounts when empty, so toasts (including errors) are never announced to screen readers — `ui/toast.tsx:71-89` — always-mount an `aria-live="polite"` region (and `role="alert"` for error/warning). _(deferred — needs the region mounted before content for reliable announcement.)_
- [LOW] UI primitives — lint — `button`/`toast`/`toggle` + a couple contexts trip `react-refresh/only-export-components` (pre-existing warnings, dev-only) — split non-component exports out. _(deferred.)_
- shadcn/Radix primitives (`button`, `dialog`, `tooltip`) are correct: focus-visible rings, Radix focus trap + Escape, `sr-only` close labels.

## Done

_Per surface: axis ratings, finding counts by severity, fixed vs. deferred._

### 1. Chat core — audited 2026-06-09
- **Ratings:** Functionality **Warn** · UI **Pass** · UX **Warn**
- **Files reviewed:** ChatInput, ChatArea, MessageBubble, StreamingStatusBar, ToolCallAccordion, ToolMessageAccordion, ChangeApprovalModal, CommandSuggestions.
- **Findings:** 8 total — 0 BLOCKER, 0 HIGH, 2 MED, 6 LOW.
- **Fixed (3, all LOW):** clipboard try/catch (MessageBubble); scroll-to-bottom FAB no longer gated on streaming (ChatArea); action bar shown for prose-less tool-only assistant turns with Copy gated on content (MessageBubble).
- **Deferred (5):** Plus/Attach dead button + unreachable Edit feature (2 MED — product/feature decisions); Footer inline-memo remount, icon-button `aria-label`s, approval-banner aria-live, collapsed-accordion `aria-hidden` (4 LOW — refactor/a11y batch).
- **Verification:** `npm run typecheck` ✓ (exit 0); `eslint` on changed files ✓ (0 new warnings; 1 pre-existing `any`); `vitest` chat specs ✓ (51/51). Changes are render-only and exercised by the jsdom component tests; Electron GUI not launched (self-quits on signals).
- **Non-bug note:** `CommandSuggestions` already resets `selectedIndex` on query change (`CommandSuggestions.tsx:53`), so there is no stale-highlight bug — verified, not a finding.

### 2. Sidebar — audited 2026-06-09
- **Ratings:** Functionality **Warn** · UI **Pass** · UX **Warn**
- **Findings:** 5 — 0 BLOCKER, 0 HIGH, 1 MED, 4 LOW.
- **Fixed (1, LOW):** removed the duplicate-title preview line.
- **Deferred (4):** unimplemented search (MED), popover dismiss, rename double-commit, redundant ternary (LOW).
- **Verification:** typecheck ✓ · eslint(file) ✓ 0 warnings · `chat-sidebar*` specs ✓ 9/9. The tests use `getAllByText(...).length > 0`, so collapsing the duplicate title to one occurrence stays green.

### 3. Settings — audited 2026-06-09
- **Ratings:** Functionality **Warn** · UI **Pass** · UX **Warn**
- **Findings:** 5 — 2 MED, 3 LOW. **Fixed:** 0. **Deferred:** 5 (all features/product or larger a11y; no clearly-safe inline fix).
- **Notable:** the Knowledge tab renders fabricated data; the settings modal lacks dialog semantics despite an accessible `Dialog` primitive existing.
- **Depth:** `SettingsModal` (2003 lines) read in full; other settings files red-flag-grepped.

### 4. Setup + Onboarding — audited 2026-06-09
- **Ratings:** Functionality **Pass** · UI **Pass** · UX **Pass** — 0 findings, 0 fixes.

### 5. Terminal — audited 2026-06-09
- **Ratings:** Functionality **Pass** · UI **Pass** · UX **Pass** — 1 LOW (a11y), deferred.

### 6. Browser + Preview — audited 2026-06-09
- **Ratings:** Functionality **Pass** · UI **Pass** · UX **Warn** — 2 LOW, deferred. MiniBrowser grep-only.

### 7. GitHub — audited 2026-06-09
- **Ratings:** Functionality **Pass** · UI **Pass** · UX **Pass** — 1 LOW, deferred. Large modals grep-only.

### 8. Kanban + Workflow — audited 2026-06-09
- **Ratings:** Functionality **Pass** · UI **Pass** · UX **Pass** — 1 LOW (DnD a11y), deferred.

### 9. Rooms + MCP — audited 2026-06-09
- **Ratings:** Functionality **Pass** · UI **Pass** · UX **Pass** — 0 findings.

### 10. Mobile surfaces — audited 2026-06-09
- **Ratings:** Functionality **Pass** · UI **Pass** · UX **Pass** — 0 findings; benefits transitively from the surface-1 chat fixes.

### 11. Layout + Electron — audited 2026-06-09
- **Ratings:** Functionality **Warn** · UI **Pass** · UX **Pass**
- **Findings:** 3 — 1 MED, 2 LOW. **Fixed (1, LOW):** removed the no-op `cwd` ternary in `AppLayout`.
- **Deferred (2):** `prompt()`-based rename broken in Electron (MED, also in `ChatPanel.tsx`); unsubscribed `focusedRoom` read (LOW).

### 12. UI primitives — audited 2026-06-09
- **Ratings:** Functionality **Pass** · UI **Pass** · UX **Warn** — 1 MED (toast aria-live), 1 LOW (lint), deferred. shadcn/Radix atoms verified accessible.

---

## Summary

| # | Surface | Func | UI | UX | Findings (B/H/M/L) | Fixed | Deferred |
|---|---------|------|----|----|--------------------|-------|----------|
| 1 | Chat core | Warn | Pass | Warn | 0/0/2/6 | 3 | 5 |
| 2 | Sidebar | Warn | Pass | Warn | 0/0/1/4 | 1 | 4 |
| 3 | Settings | Warn | Pass | Warn | 0/0/2/3 | 0 | 5 |
| 4 | Setup + Onboarding | Pass | Pass | Pass | 0/0/0/0 | 0 | 0 |
| 5 | Terminal | Pass | Pass | Pass | 0/0/0/1 | 0 | 1 |
| 6 | Browser + Preview | Pass | Pass | Warn | 0/0/0/2 | 0 | 2 |
| 7 | GitHub | Pass | Pass | Pass | 0/0/0/1 | 0 | 1 |
| 8 | Kanban + Workflow | Pass | Pass | Pass | 0/0/0/1 | 0 | 1 |
| 9 | Rooms + MCP | Pass | Pass | Pass | 0/0/0/0 | 0 | 0 |
| 10 | Mobile surfaces | Pass | Pass | Pass | 0/0/0/0 | 0 | 0 |
| 11 | Layout + Electron | Warn | Pass | Pass | 0/0/1/2 | 1 | 2 |
| 12 | UI primitives | Pass | Pass | Warn | 0/0/1/1 | 0 | 2 |
| | **Total** | | | | **0/0/7/21** (28) | **5** | **23** |

**Verification (final sweep):** `npm run typecheck` ✓ (exit 0) · `eslint` on all changed files ✓ (0 errors, only a pre-existing `any` warning) · `npm run test` ✓ **569/569 across 98 files**.

**Fixes applied (5, all LOW + clearly safe):**
1. `MessageBubble.handleCopy` — try/catch around `navigator.clipboard` (no unhandled rejection on `/m/chat` over http).
2. `MessageBubble` action bar — shown for prose-less tool-only assistant turns (Copy still gated on text).
3. `ChatArea` — scroll-to-bottom FAB no longer gated on `isStreaming`.
4. `ChatSidebar` — removed duplicate-title preview line.
5. `AppLayout` — removed no-op `cwd={x ? undefined : undefined}` prop.

**Top deferred items for human review (no BLOCKER/HIGH found):**
- MED — `prompt()`-based "Rename thread" broken in Electron (`AppLayout.tsx:597`, `ChatPanel.tsx:384`).
- MED — Settings → Knowledge tab shows fabricated mock data with dead buttons.
- MED — Settings modal lacks dialog semantics/focus-trap/Escape (an accessible `Dialog` primitive exists).
- MED — Sidebar thread search is unimplemented (dead `Search` icon + unused store slot).
- MED — Toast notifications aren't announced to screen readers (no `aria-live` region).
- MED (Chat) — Composer Attach button + user-message Edit flow are unwired.

AUDIT COMPLETE — see docs/qa-audit.md
