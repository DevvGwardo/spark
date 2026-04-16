# Overnight Audit — 2026-04-15

**Mode:** Report-only. User has significant WIP (8 modified files, 3 untracked) so no code changes were made. Actionable items flagged for next human-driven pass.

---

## 1. Type Safety — PASS

`npx tsc --noEmit` → clean, zero errors.

### `as any` / ts-ignore sweep
- **23 occurrences across 3 files**, all in `e2e/`:
  - [e2e/app-basics.spec.ts](e2e/app-basics.spec.ts) — 11 hits
  - [e2e/mini-browser.spec.ts](e2e/mini-browser.spec.ts) — 11 hits
  - [e2e/app-renderer.spec.ts](e2e/app-renderer.spec.ts) — 1 hit
- All are `(window as any).electronAPI` inside Playwright `page.evaluate()` blocks.
- **Fix available:** [src/electron.d.ts](src/electron.d.ts) already declares `Window.electronAPI`. A small `global.d.ts` inside `e2e/` (or a tsconfig reference) would let these drop the cast.
- **Source code is fully type-clean** — no `as any`/ts-ignore in `src/` or `server/`.

---

## 2. Security — ACTION REQUIRED

### npm audit: 24 vulnerabilities (12 high, 9 moderate, 3 low)

Direct deps with fixes available:
| Package | Severity | Fix | Notes |
|---|---|---|---|
| `react-router-dom` | **high** | non-major | XSS via open-redirects in `@remix-run/router` ≤1.23.1 |
| `undici` | **high** | non-major | safe bump |
| `vite` | moderate | non-major | safe bump |
| `electron` | moderate | non-major | safe bump |
| `ai` (Vercel SDK) | moderate | **semver-major** (v5→v6) | filetype-whitelist bypass; needs migration review |
| `jsdom` | low | **semver-major** (29.x) | test-only dep |

**Recommendation:** Run `npm audit fix` for the non-major batch (react-router-dom, undici, vite, electron) in a dedicated PR. Handle `ai` and `jsdom` majors separately.

### Hardcoded secrets — CLEAN
No `sk-...` or `apiKey = "..."` patterns in source.

### `dangerouslySetInnerHTML` — 1 use, safe
[src/components/chat/MarkdownRenderer.tsx:208](src/components/chat/MarkdownRenderer.tsx:208) renders Shiki tokenizer output. Shiki emits structured `<span>` markup from source text; not a direct user-HTML injection vector.

### Unvalidated `req.body` in server routes — ACTION REQUIRED
Zod is already a dep (imported in `chat.ts`, `local-tools.ts`, `repo-verifier.ts`, `agent-loop.ts`) but **not used for route input validation**. Routes currently destructure `req.body` raw or cast with `as`:

- [server/routes/chat.ts:256](server/routes/chat.ts:256) — `messages`, `model` from body
- [server/routes/chat.ts:296](server/routes/chat.ts:296) — broad destructure
- [server/routes/chat.ts:332](server/routes/chat.ts:332) — `github_pat`
- [server/routes/validate.ts:25](server/routes/validate.ts:25) — `provider`, `api_key`
- [server/routes/translate.ts:92](server/routes/translate.ts:92) — cast-as
- [server/routes/proxy.ts:81](server/routes/proxy.ts:81) — `ChatProxyRequest` cast
- [server/routes/github.ts:463](server/routes/github.ts:463) — `action`, `pat`, rest spread
- [server/routes/github.ts:1297](server/routes/github.ts:1297) — `owner`, `repo`, `pat`
- [server/routes/profiles.ts:129](server/routes/profiles.ts:129) — `name`
- [server/routes/hermes-admin.ts](server/routes/hermes-admin.ts) — proxies raw body to external service (lower risk, but still no schema)

**Recommendation:** Add Zod schemas at each route boundary. Matches the existing scheduled-task idea #9.

---

## 3. Dead Code — LOW-RISK CLEANUP AVAILABLE

`npx knip` (ignoring `.claude/worktrees/` and `e2e-results/`):

- **Unused files:** 0 in live source.
- **Unused exports:** 22 files. Highlights worth removing:
  - [server/lib/helpers.ts](server/lib/helpers.ts) — `ALLOWED_ORIGINS`, `RateLimiter`
  - [server/config.ts](server/config.ts) — 12 unused constants (`STREAM_ACTIVITY_TIMEOUT_MS`, `FETCH_TIMEOUT_MS`, `MAX_BUFFER_SIZE`, …)
  - [server/lib/hermes.ts](server/lib/hermes.ts) — 7 unused (`DIRECT_COMPAT_PROXY_PROVIDERS`, `getCompatibleProviderChatUrl`, `normalizeHermesTextPart`, etc.) — likely stale after Hermes integration landed
  - [server/lib/github-utils.ts](server/lib/github-utils.ts) — 8 unused (`validateGitHubIdentifier`, `encodeGitHubContentPath`, `REPO_ACTIVITY_*`, `hasGitHubNextPage`, `fetchGitHubSearchTotalCount`)
  - [server/repo-verifier.ts](server/repo-verifier.ts) — `selectValidationCommands`
  - [server/openclaw.ts](server/openclaw.ts) — `setOpenClawModel`
  - [server/provider-config.ts](server/provider-config.ts) — `supportsReasoningEffort`, `CONTEXT_WINDOW_SIZES`, `getContextWindow` *(⚠ currently modified — defer)*
  - [src/lib/api.ts](src/lib/api.ts) — `fetchRepoFileTree`, `fetchMessagingPlatform`, `completeOAuth`
  - [src/lib/tokens.ts](src/lib/tokens.ts) — `estimateTokens`, `estimateMessagesTokens`, `getModelContextWindow`, `formatTokenCount` *(⚠ currently modified — defer)*
  - [src/lib/tool-call-parser.ts](src/lib/tool-call-parser.ts) — `TOOL_ICON_MAP`, `TOOL_START_RE`, `TOOL_END_RE`
  - [src/lib/hermes-commands.ts](src/lib/hermes-commands.ts) — `COMMANDS`
  - [src/hooks/chat-utils.ts](src/hooks/chat-utils.ts) — `collectStructuredToolNames`
  - [server/workspace-indexer.ts](server/workspace-indexer.ts) — `WorkspaceIndex` *(⚠ untracked — active WIP, defer)*

  Skipped from cleanup targets:
  - `src/components/ui/*` — shadcn/ui vendored components, unused exports are by design
  - Any file marked ⚠ above (currently modified or untracked WIP)

- **Unused type exports:** 30 files. Mostly stores exporting types no consumer imports (e.g., `ChatStore`, `AppTab`, `PanelChangeset`, `ThemeMode`). Low-priority cosmetic cleanup.

---

## Suggested follow-up PRs (in order of ROI)

1. **`npm audit fix`** — non-major bumps for react-router-dom, undici, vite, electron. Quick win, high security value.
2. **Zod schemas for server routes** — chat.ts, validate.ts, github.ts, profiles.ts first. Already planned (idea #9).
3. **Dead code pass** — delete unused exports from hermes.ts, github-utils.ts, config.ts, api.ts once WIP lands. Avoid tokens.ts/provider-config.ts until their branches merge.
4. **`ai` SDK v5→v6 migration** — separate effort, requires testing.
5. **`window.electronAPI` typing in e2e** — nice-to-have; small.

---

## What I did NOT touch

- Any file appearing in `git status` (8 modified, 3 untracked) — active WIP.
- `src/components/ui/*` — vendored shadcn components.
- `.claude/worktrees/*` — scratch branches.
- No dependency bumps, no `npm install`.
