# MCP Worker Inheritance — Build Plan

Clean-room adoption of Claude Desktop architecture patterns into Spark (cloud-chat-hub).
Rule: patterns and self-authored schemas only. No vendor code, strings, fonts, icons, or skill content.

## Where we stand (2026-09-05, reviewer APPROVED)

| Piece | File | State |
|---|---|---|
| Worker host (spawn/stop, length-prefixed JSON-RPC) | `electron/mcp-worker-host.ts` | ✅ tested |
| Pool manager (cap 8, restart budget 3) | `electron/mcp-worker-manager.ts` | ✅ tested |
| Protocol schemas (zod) | `server/lib/mcp-worker-protocol.ts` | ✅ |
| Spawn policy (allowlist validation) | `server/lib/mcp-worker-policy.ts` | ✅ tested |
| HTTP stubs (GET status, POST spawn→501) | `server/routes/mcp-workers.route.ts` | 🟡 unwired |
| Skill registry shape | `resources/skills/manifest.json` | ✅ |
| Behavioral pins (12 tests) | `server/__tests__/mcp-worker-*.test.ts`, `skills-manifest.test.ts` | ✅ 12/12 |

## Phase 1 — Wire-up (next, ~1 session, squad: backend + security + test + reviewer)

- [ ] `trustedHandle` wrapper in `electron/index.ts` (deny-by-default IPC, replaces opt-in `assertTrustedSender` per handler)
- [ ] IPC handlers `mcp-worker:spawn/status/stop` → `McpWorkerManager`, via `trustedHandle`
- [ ] Minimal `preload.ts` surface (status + spawn only; raw commands stay main-side)
- [ ] Register route in `server/index.ts` (`registerMcpWorkersRoute(app)`); POST spawn calls manager through policy gate
- [ ] Proof test: spawn `/usr/bin/true`, assert ready round-trips over IPC + HTTP, then stop

Gates:
- CHECK: `npx vitest run server/__tests__/mcp-worker-` EXPECT: all pass including live spawn case
- CHECK: `npx tsc -p tsconfig.electron.json --noEmit && npx tsc -p tsconfig.node.json --noEmit` EXPECT: zero errors
- CHECK: `grep -rn "ipcMain.handle('mcp-worker" electron/` EXPECT: every handler wrapped in `trustedHandle`

## Phase 2 — Harden (~1 session, squad: security + backend + reviewer)

- [ ] ESLint pin: bare `ipcMain.handle` rejected in `electron/` (must use `trustedHandle`)
- [ ] Spawn rate-limit + per-server stdout cap (OOM guard on the frame buffer)
- [ ] Renderer status UI (reuse existing bridge-status pill pattern)
- [ ] `wb_log` + snapshot after each merge

## Phase 3 — Desktop extensions (~2 sessions, squad: backend + api + test + reviewer)

- [ ] `.dxt`/`.mcpb` install handling via the OPEN `@anthropic-ai/mcpb` SDK (public npm, not reverse-engineered)
- [ ] Registry shape + signature check before install
- [ ] Depends on Phase 1 (workers must be live)

## Phase 4 — Quick window + deep links (~1–2 sessions, squad: frontend + backend + reviewer)

- [ ] `quick_window` renderer (input box → `spark://capture?text=…` → main window)
- [ ] Reuse existing `Cmd+Shift+Space` shortcut (currently show/hide)
- [ ] `spark://chat/<id>`, `spark://skill/<name>`, `spark://oauth/callback` schemes

## Phase 5 — Search workers (CLOSED 2026-09-05, no workers needed)

Measured first per plan — in-process SQLite FTS5 wins. Harness: `scripts/bench-fts.mjs`
(node:sqlite, zero deps, deterministic seed). Results: real corpus (187 msgs) p95 ≤0.06ms;
synth 100k worst warm p95 26.17ms (OR query) vs 200ms budget (~7.6× headroom); repo files
(762 tracked, 6.8MiB) query p95 ≤0.25ms. Reviewer APPROVED close. Adoption DDL (not yet
applied — apply when transcript search ships):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, conversation_id UNINDEXED, role UNINDEXED, tokenize='porter unicode61');
CREATE TRIGGER trg_msg_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,content,conversation_id,role) VALUES (new.rowid,new.content,new.conversation_id,new.role); END;
CREATE TRIGGER trg_msg_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,content,conversation_id,role) VALUES('delete',old.rowid,old.content,old.conversation_id,old.role); END;
CREATE TRIGGER trg_msg_au AFTER UPDATE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,content,conversation_id,role) VALUES('delete',old.rowid,old.content,old.conversation_id,old.role); INSERT INTO messages_fts(rowid,content,conversation_id,role) VALUES (new.rowid,new.content,new.conversation_id,new.role); END;
-- search: SELECT m.*, bm25(messages_fts) r FROM messages_fts f JOIN messages m ON m.rowid=f.rowid WHERE messages_fts MATCH :q ORDER BY r LIMIT :n;
```

Open question (non-blocking): 6055 conversations vs 187 msgs with ~10MB unexplained in
cloudchat.sqlite — one-line schema note needed before DDL lands.

## Explicitly NOT porting

Desktop's JS bundles, `AnthropicSans/Serif` fonts, `en-US.json` strings, `.skill` bundle contents,
icons, `app.asar` internals, Cowork VM (Apple Virtualization + gvisor — macOS-only; Spark's
Hermes bridge + embedded server already covers the Linux/Windows story).

## Workbench

Living log: `~/.workbench/cloud-chat-hub/` — `STANDING.md` (map), `LEDGER.jsonl` (events),
`snapshots/`, `dashboard.html` (graphs). Update via `wb_log`-equivalent entries on every merge.
