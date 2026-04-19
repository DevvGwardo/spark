# Cloud Chat Hub — Status Report
**Analyzed:** 2026-04-18
**Build:** `npm run build` — ✅ Clean (no errors, chunk-size warnings only)

---

## 1. Current Integration State

### ✅ HermesPTYPanel — Properly Wired
- Imported in `AppLayout.tsx` from `@/components/browser/MiniBrowser`
- Rendered conditionally: `{hermesTerminalOpen && <HermesPTYPanel ref={hermesTerminalRef} />}`
- Connected to `window.electronAPI.terminal.spawn({ command: 'hermes' })` → node-pty
- Handles its own xterm.js lifecycle with ResizeObserver + window resize safety net
- Exposes zoom controls via `HermesPTYPanelHandle` ref

### ✅ DockedChatSidebar — Imported & Rendered (But Always Returns Null)
- Imported in `AppLayout.tsx` line 52: `import { DockedChatSidebar } from '@/components/chat/DockedChatSidebar'`
- Rendered in AppLayout JSX at the flex-row level
- **Problem:** `DockedChatSidebar` returns `null` immediately unless `usePanelStore.getState().dockedPanel` is non-null
- `dockedPanel` is only set via the "Pop out to sidebar" button in `ChatPanel.tsx` (lines 348, 371)
- **Verdict:** Component is correctly placed and wired; it silently does nothing until the user explicitly triggers "Pop out to sidebar"

### ⚠️ HermesTerminal — Orphaned Component
- `src/components/terminal/HermesTerminal.tsx` exists and exports a working text-based command shell using `hermes-commands.ts`
- **Never imported or rendered in AppLayout** — replaced entirely by `HermesPTYPanel`
- The Sparkles button (line 541) in AppLayout controls `hermesTerminalOpen` which renders `HermesPTYPanel`, not `HermesTerminal`
- `hermes-commands.ts` lib is still used as context/validation but the UI component is dead code

### ⚠️ hermesTerminalRef — Created But Never Used
- `const hermesTerminalRef = useRef<HermesPTYPanelHandle>(null)` created at line 73
- Passed to `HermesPTYPanel` but no parent code ever calls `hermesTerminalRef.current.zoomIn()` or `.zoomOut()`
- The zoom buttons on `HermesPTYPanel` are driven by local state inside the component

---

## 2. Terminal Subsystem Health

### ✅ terminal:spawn Handler (electron/index.ts)
- Lines 402–437: full node-pty integration with dynamic import (load failure doesn't crash app)
- Spawns PTY with `xterm-256color`, `cols: 80`, `rows: 24`
- Without `options.command`: spawns interactive zsh shell
- With `options.command`: spawns shell with `-c` flag (used by `HermesPTYPanel` to run `hermes`)
- `onData` / `onExit` IPC events wired correctly to renderer

### ✅ HermesPTYPanel Renders Correct PTY
- `api.spawn({ command: 'hermes' })` → spawns `hermes` binary via `shellPath -c "hermes"`
- Uses xterm.js with full color theme, FitAddon, WebLinksAddon, 5000-line scrollback
- ResizeObserver + 80ms timeout safety net for sidebar drag events
- Cleanup: disposes term, kills PTY, removes listeners on unmount

### ✅ TerminalPanel (Tabbed Shell)
- Separate component for the generic tabbed terminal (Ctrl+` toggle)
- Multi-tab support, maximize/restore, height drag handle
- `cwd={activeRepo?.name ? undefined : undefined}` — always `undefined` (dead expression, no-op)

### ⚠️ hermesTerminalHeight — Persisted But Hardcoded
- Store defines `hermesTerminalHeight` (clamped 150–600), persisted to localStorage
- AppLayout hardcodes `style={{ height: 300 }}` in the HermesPTYPanel container
- The persisted height is **never read** — the slider/drag logic that should use it is absent

---

## 3. BrowserView / MiniBrowser State

### ✅ DockedMiniBrowser — Correctly Wired
- Rendered as a flex child in AppLayout's main content row
- ResizeObserver tracks container bounds; syncs BrowserView overlay position/size
- Hide/show mechanism prevents flickering during resize
- Off-screen positioning when `rightSidebarHidden` keeps video playing but prevents click interception
- `onForceResize` IPC from main process handles macOS fullscreen transitions

### ✅ Sidebar Layout (60/40 split)
- Left: ChatSidebar (collapsible, drag-resizable 200–480px)
- Middle: ChatPanelContainer + PreviewSidebar (conditional on `activeTab === 'chat'`)
- Right: DockedMiniBrowser (conditional, drag-resizable 300–600px)
- All three sections use flex with `overflow-hidden`

### ⚠️ PreviewSidebar Always Rendered Even in Non-Chat Tabs
- `PreviewSidebar` renders unconditionally inside the `{activeTab !== 'chat' && 'hidden'}` div
- Hidden via CSS (`hidden` class) but still mounted — minor perf concern

### ⚠️ toggleRightSidebarHidden — Defined, Never Called
- `toggleRightSidebarHidden` exists in `ui-store.ts` and is wired to store
- No component calls it — `setRightSidebarHidden` is used directly instead

---

## 4. Known Issues / Tech Debt

### 🔴 Dead Components
| Component | File | Issue |
|---|---|---|
| `HermesTerminal` | `src/components/terminal/HermesTerminal.tsx` | Replaced by `HermesPTYPanel`; never rendered anywhere |
| `hermesTerminalRef` | `AppLayout.tsx:73` | Ref created and passed but never used to call zoom methods |

### 🟡 Dead State
| State | Store | Issue |
|---|---|---|
| `hermesTerminalHeight` | `ui-store.ts` | Persisted but hardcoded to 300 in JSX |
| `cwd={activeRepo?.name ? undefined : undefined}` | `AppLayout.tsx:638` | Always `undefined` — redundant ternary |

### 🟢 Console Errors (All Legitimate Error Handling)
| File | Count | Context |
|---|---|---|
| `src/stores/chat-store.ts:162` | 1 | `Failed to rewind conversation` |
| `src/stores/cron-store.ts:111` | 1 | `Failed to fetch run history` |
| `src/stores/profiles-store.ts:73` | 1 | `Failed to fetch profiles` |
| `src/components/settings/SettingsModal.tsx:253,621,867` | 3 | Settings validation/repo sync |
| `src/components/terminal/TerminalPanel.tsx:49` | 1 | `Failed to spawn terminal` |
| `src/components/github/GitHubAnalyzer.tsx:111` | 1 | `Analysis failed` |
| `src/hooks/useChat.ts:589,1559,1565,1628,2238,2276` | 6 | Network errors, truncation, auto-continue, duplicate send |
| `src/pages/NotFound.tsx:8` | 1 | 404 logging |
| `src/lib/errors.ts:145` | 1 | JSON stringify failure |
| `src/lib/api.ts:122` | 1 | sessionStorage port write failure |

**Verdict:** All `console.error` calls are genuine error handlers, not debug noise. The one `console.warn` in `useChat.ts:1565` is an intentional user-facing truncation warning.

### 🟡 Unused Imports
- None found — ESLint appears to be enforcing import hygiene well

### ⚠️ MISSING-FEATURES.md — Large Slash Command Gap
- Only 9 of ~26 documented slash commands are implemented
- Key missing commands: `/new`, `/reset`, `/model`, `/retry`, `/undo`, `/approve`, `/deny`, `/voice`, `/rollback`
- Voice system (STT/TTS) entirely non-functional — ChatInput has a voice button stub

---

## 5. Build / Test Status

### Build: ✅ PASS
- `npm run build` completes in 3.8s
- No TypeScript errors, no module resolution failures
- Output: `dist/` with full Vite + electron-vite bundle
- Only warnings: chunk size (several >500KB chunks including `index-CABjcZZs.js` at 2.3MB)

### E2E Test Harness
- `e2e/` contains `app-basics.spec.ts`, `app-renderer.spec.ts`, `mini-browser.spec.ts`
- Tests cover: window title, dimensions, BrowserView security (file://, javascript:, data: URL blocking), lifecycle
- `playwright-electron.config.ts` configured for serial execution
- **Tests have not been run** — no `e2e-results/` or test output verified in this session

---

## 6. Recommended Next Steps (Priority Order)

### P0 — Broken / Blocking
None. No blocking bugs found.

### P1 — High Impact, Low Effort

1. **Wire `hermesTerminalHeight` to JSX** (`AppLayout.tsx:641`)
   - Change `style={{ height: 300 }}` → `style={{ height: hermesTerminalHeight }}`
   - Add a resize handle on the HermesPTYPanel container using `setHermesTerminalHeight`
   - Currently: user-resizable terminal height is persisted but never applied

2. **Delete `HermesTerminal` or wire it**
   - If `HermesPTYPanel` (real CLI) is the intended behavior, delete `src/components/terminal/HermesTerminal.tsx`
   - If a text-mode fallback is desired, wire it to a separate toggle state
   - Current state creates confusion for future maintainers

3. **Fix `cwd={activeRepo?.name ? undefined : undefined}`** (`AppLayout.tsx:638`)
   - This expression always evaluates to `undefined`
   - Either remove it or implement actual repo-cwd detection

### P2 — Medium Effort

4. **Add Zoom Controls to HermesPTYPanel Header**
   - The `HermesPTYPanelHandle` ref exposes `zoomIn`/`zoomOut` but no parent UI calls them
   - Add +/- buttons in a small toolbar above the xterm div
   - 10-line fix with high user value

5. **DockedChatSidebar UX polish**
   - The "Pop out to sidebar" button in ChatPanel is the only way to activate it
   - No visual affordance in the sidebar area that a docked conversation is present
   - Consider a persistent small indicator or dedicated dock-docked toggle button

6. **Slash Commands completion** (from `MISSING-FEATURES.md`)
   - `/new`, `/title`, `/retry`, `/undo` are straightforward to add
   - `hermes-commands.ts` already has the parsing infrastructure

### P3 — Nice to Have

7. **Run E2E tests** — validate the BrowserView security fixes actually work
8. **Lazy-load heavy language chunks** — `index.js` at 2.3MB blocks initial render; dynamic `import()` for language parsers would improve TTI
9. **Voice system** — entirely stubbed; requires backend STT/TTS integration

---

## Summary Table

| Area | Status | Notes |
|---|---|---|
| HermesPTYPanel wiring | ✅ Working | Spawns real hermes CLI via node-pty |
| DockedChatSidebar | ✅ Wired | Silently null until "Pop out" triggered |
| terminal:spawn handler | ✅ Working | node-pty, dynamic import, graceful fallback |
| DockedMiniBrowser / BrowserView | ✅ Working | ResizeObserver bounds, hide/show, off-screen mode |
| Sidebar layout (60/40 flex) | ✅ Working | No z-index or bounds issues found |
| hermesTerminalHeight | ⚠️ Dead | Persisted but hardcoded to 300 in JSX |
| HermesTerminal component | ⚠️ Orphaned | Dead code — replaced by HermesPTYPanel |
| hermesTerminalRef usage | ⚠️ Dead | Ref created, passed, never used |
| Build | ✅ Pass | 3.8s, no errors |
| E2E tests | ⚠️ Not run | Harness present, tests written |
| Slash commands | ⚠️ 9/26 | Large gap in agent-facing commands |
| console.error noise | ✅ Acceptable | All calls are genuine error handlers |
