# Spark × Hermes Alignment — Phase 6+ Plan

**Date:** 2026-07-11  
**Hermes baseline:** v0.18.2 (`2026.7.7.2`, install ~1 commit behind)  
**Spark baseline:** post Phase 0–5 surfaces (see `docs/hermes-0.18-feature-integration-plan.md`)  
**Strategy unchanged:** Spark = dense control plane; Hermes = execution plane. Prefer bridging native Hermes over reimplementing.

---

## 1. Why this plan exists

Phases 0–5 shipped **config and observability** for MoA, fallback, goals, ops cards, journey, native kanban.db, pets, OpenClaw, and gateway capability probe.

An audit on 2026-07-11 found the plan overstated **execution alignment**. Several paths are still:

- probe-only (gateway `/v1/runs`, `session_fork`)
- slash passthrough (compress / rollback / goal)
- dual-stack (MCP, swarm naming, `run_agent` vs adapter)
- stubbed UI (profile Save, `/resume`)

This plan closes those disconnects and adds the Hermes 0.18 surfaces that matter for a coding desktop.

---

## 2. Audit snapshot (current gaps)

### Critical disconnects

| # | Issue | Evidence |
|---|--------|----------|
| D1 | Kanban + team workers load legacy `run_agent.AIAgent` | `server/scripts/run-kanban-agent.py` |
| D2 | Chat never uses `/v1/runs` despite probe | `resolveHermesExecutionMode` → always `agent-loop`; ops card display-only |
| D3 | Hermes `session_fork` unused | Probe flag only; Spark forks its own tree |
| D4 | Checkpoint restore is agent text, not restore API/UI | `GET/POST prune` only; `/rollback` passthrough |
| D5 | Profiles Save is a no-op | `ProfilesPanel` closes modal only |
| D6 | Dual MCP (zustand sidebar vs Hermes config.yaml store) | `HermesMCPPanel` vs `McpStoreView` |
| D7 | `/resume` stubbed; `compressContext` unwired | `hermes-commands.ts`, `ChatPanel` |
| D8 | Three “swarm” systems; formation ≠ Hermes swarm | Review pipeline / kanban CLI / team strategy |

### Missing product surfaces (Hermes has it)

| Feature | Hermes | Spark |
|---------|--------|-------|
| Projects (multi-folder + kanban bind) | `hermes project` | — |
| Worktree sessions | `--worktree` / kanban workspace | docs mention only |
| Credential pool / auth | `hermes auth` | read-only saved providers |
| Plugins | `hermes plugins` | slash merge only |
| Shell hooks consent | `hermes hooks` | — |
| Secrets managers | `hermes secrets` | messaging secrets only |
| LSP diagnostics | post-write LSP | not in activity UI |
| Security audit | `hermes security` | — |
| Clarify / context_engine / video toolsets | gateway toolsets | not in Spark toggles |
| Fallback switch toast | runtime | config editor only |

### Already good (do not rebuild)

MoA end-to-end, fallback/goals editors, native kanban.db UI, journey/memory/curator/bundles/CU/pets/OpenClaw ops, delegation toggle, teams durability, skills/cron.

> **Correction (2026-10):** webhooks and pairing were listed here, but those panels (and the logs
> panel) have since been deleted from the sidebar because their bridge endpoints all returned 404.
> They are not shipped surfaces.

---

## 3. Guiding principles

1. **One brain** — Composer, kanban cards, and team workers all use `HermesAgentAdapter` (or gateway `/v1/runs`). Never grow `run_agent` for new features.
2. **Probe → product** — If System ops shows a capability (`run_submission`, `session_fork`), Spark must either use it or clearly label it as probed/conditional, not default behavior.
3. **Thin CLI/API proxies** — Prefer `hermes_ops` + Express proxy over Express reimplementation (`project`, `auth`, `plugins`, `hooks`, `security`).
4. **Honest naming** — “Review pipeline” ≠ “Kanban swarm” ≠ “Team formation.” Fix labels and formation routing.
5. **Passthrough is not done** — Slash-to-agent is a stopgap; first-class UI/API is the exit criterion.

---

## 4. Phased delivery

### Phase 6 — Execution convergence (highest leverage)

**Status (2026-07-11):** Done via Cursor subagent swarm — kanban/team → `HermesAgentAdapter` (`run-kanban-agent.py` + fleet tool registry), MoA refuse on `run_agent` fallback (`MOA_NATIVE_REQUIRED`), Profiles Save → `PUT .../config`, `/compress` → `compressContext` / `handleQuickSend`.

**Goal:** One real Hermes agent path for chat + fleet work.

| Work | Files / approach | Exit criteria |
|------|------------------|---------------|
| **6.1** Point kanban runner at adapter | `server/scripts/run-kanban-agent.py` → `HermesAgentAdapter`; same for team spawn in `team-coordinator.ts` | Card/team runs log “adapter”; MoA-capable workers; no `from run_agent import AIAgent` on fleet path |
| **6.2** Adapter fallback policy | `hermes-bridge/main.py` chat path: refuse MoA/fleet on `run_agent`; emit clear error | Fallback only for true import failure + non-MoA |
| **6.3** Fix Profiles Save | Wire `ProfilesPanel` Save → existing `PUT` profile config routes | Edit + save persists; reload shows change |
| **6.4** Wire compress button | Pass `compressContext` from `ChatPanel`; composer affordance or keep `/compress` but call bridge RPC if available | Button works without relying on agent interpreting prose |

**Verify:** Spawn a kanban card with adapter; profile edit persists; compress triggers compression (log/event).

**Estimate:** 2–4 days.

---

### Phase 7 — `/v1/runs` transport (flagship follow-up)

**Status (2026-07-11):** Implemented behind an explicit flag/toggle and hardened with guarded fallbacks — **not full default parity**. Cancel→`POST …/stop`, toolsets/repo/reasoning forwarded in submit body where supported, approve bridge route. Residuals remain: MoA on runs SSE; gateway may ignore some forwarded fields; repo proposal approval stays agent-loop; Spark still defaults to agent-loop unless runs is enabled.

**Goal:** Make the gateway probe meaningful; unlock native approvals, stop, async lifecycle.

| Work | Approach | Exit criteria |
|------|----------|---------------|
| **7.1** Capability gate | If `probe_gateway_capabilities().run_submission`, optionally route Hermes chat via runs | Feature flag `HERMES_USE_RUNS` or settings toggle; default off until stable |
| **7.2** Client lifecycle | `hermes-bridge` or Express: `POST /v1/runs` → poll/SSE events → map to existing `server-tool-events` | Tool accordion + stop + approval work on runs path |
| **7.3** MoA on runs | Forward/translate `moa.*` events in runs SSE (bridge translate if gateway doesn’t emit yet) | MoA advisor cards still render |
| **7.4** Approval banner | Map `approval_events` / `run_approval_response` into shared Approval UI | Dangerous tool pause + allow/deny on runs |
| **7.5** Fallback honesty | When runs is requested but parity gaps force agent-loop, emit a visible transport-status reason in the chat UI | Users can tell when runs was requested but agent-loop is actually being used |

**Architecture sketch:**

```
Spark UI ──► Express ──► hermes-bridge (translate) ──► Hermes :8642 /v1/runs
                │                                           │
                └──────── existing event types ◄── SSE/poll ─┘
```

Keep bridge as the compatibility layer so UI event types stay stable.

**Verify:** Toggle runs on; send chat; see tools stream; stop works; approval works; MoA still works where supported; explicit fallback reasons appear when runs cannot be used.

**Estimate:** 5–8 days (largest risk: event shape drift).

**Defer if:** Adapter unification (Phase 6) is incomplete — do not put fleet on runs before composer is solid.

---

### Phase 8 — Session continuity & safety

**Status (2026-07-11):** Core features implemented: 8.1 session fork, 8.2 checkpoint restore, 8.3 worktree toggle (chat + kanban; residual: GitHub API tools / cleanup), 8.4 fallback toast, 8.5 `/resume` attach. Remaining gap: slash-command UX still overstates native Hermes execution for some forwarded commands.

**Goal:** Fork, rollback, worktree, fallback visibility.

| Work | Approach | Exit criteria |
|------|----------|---------------|
| **8.1** Session fork | Proxy `POST /api/sessions/{id}/fork` (or Hermes gateway); action on `HermesChatsPanel` + chat header | Fork creates new Hermes session; Spark can continue it |
| **8.2** Checkpoint restore UI | Bridge: list checkpoints with indices; `POST /checkpoints/restore` shelling `hermes` / native rollback; sheet near Changeset | One-click restore; prune remains |
| **8.3** Worktree launch | “Open in worktree” on repo-attached panel / kanban card → `hermes --worktree` or workspace flag | Isolated git worktree for parallel agents |
| **8.4** Fallback toast | Detect provider switch from adapter/gateway events or status; toast in composer | “Switched to {provider}/{model}” visible |
| **8.5** `/resume` | Replace stub with Hermes session resume / attach | Resume loads history into panel |
| **8.6** Slash honesty | Distinguish local commands, bridge-expanded skills, and forwarded raw Hermes slash commands in the composer/help UI | `/goal` and `/rollback` no longer look like natively handled CloudChat commands |

**Verify:** Fork → continue; restore file from checkpoint; worktree path used for a card; fallback toast on forced failure; slash menu labels match actual behavior.

**Estimate:** 4–6 days.

---

### Phase 9 — Control-plane honesty (MCP, auth, projects)

**Status (2026-07-11):** Broadly in place — MCP unified (sidebar + Settings → hermes-api / config.yaml); projects switcher + bind-board UI; formation routing; fleet labels. Residual honesty gaps: credential-pool UI is only partially complete in-app, and runs capability display is stronger than default transport behavior.

**Goal:** One MCP story; manage credentials; Hermes projects.

| Work | Approach | Exit criteria |
|------|----------|---------------|
| **9.1** Unify MCP | Sidebar `HermesMCPPanel` reads/writes Hermes MCP via bridge (same as `McpStoreView`); deprecate Spark zustand MCP for Hermes mode or sync both ways | Single list; install once |
| **9.2** Credential pool UI | Thin Settings panel: list/add/reset via `hermes auth` proxy, with API-key add in-app and OAuth remaining terminal/browser-native where required | Rotate OpenRouter/Nous keys without editing `auth.json` by hand for API-key providers |
| **9.3** Hermes projects | `hermes_ops` + `/api/hermes/projects`; sidebar project switcher (multi-folder + bind-board) | Create/use/bind; kanban respects project |
| **9.4** Formation → execution | Map `analyzeTask().strategy` → adapter / `delegate_task` / kanban swarm / rooms (not silent team-only) | Logged strategy matches runtime |
| **9.5** Swarm labels | UI copy: Review pipeline / Fleet swarm / Teams | No overloaded “Swarm” buttons without qualifier |
| **9.6** Gateway capability copy | Present `runs=yes` / similar ops signals as capability probes rather than proof of default active usage | Admin surface no longer implies “available” means “currently used by Spark chat” |

**Verify:** Install MCP in sidebar appears in agent; auth list matches CLI; API-key add works in Settings; project bind affects board cwd; runs probe copy stays explicit.

**Estimate:** 5–7 days.

---

### Phase 10 — Deeper Hermes surfaces (after control plane is honest)

**Status (2026-07-11):** Most planned P2/P3 surfaces shipped. Leftover hardening also done: Portal device-code OAuth in Settings; `/v1/runs` slim body + parity/worktree/computer_use gates (honest agent-loop fallback); CU running frames + capture_after hint + broken progress path removed.

**Upstream-only residuals (cannot fully close without more Hermes core work):**
1. Gateway `/v1/runs` `tool.completed` still omits `result` — computer_use on runs uses agent-loop (Spark poller works on agent-loop)
2. `repo_mode` / `github_pat` / `custom_tools` still need agent-loop
3. Apply `patches/hermes-api-server-runs-parity.patch` after `hermes update` and restart gateway

**Closed in leftover hardening:** Portal device-code; runs slim body + parity gates; local Hermes runs parity patch (cwd/toolsets/provider/reasoning); worktree→runs cwd when parity on; CU aux-vision bypass; mid-action CU frame poller + supplemental capture.

| Work | Priority | Notes | Status |
|------|----------|-------|--------|
| Plugins panel (list/enable/disable) | P2 | `hermes plugins` proxy | Done |
| Hooks consent / doctor | P2 | `hermes hooks` | Done |
| Secrets manager status | P2 | Bitwarden/1Password configured? | Done |
| LSP diagnostics strip in `AgentActivity` | P2 | Render when Hermes emits diagnostics | Done |
| Toolset toggles: clarify, context_engine, video | P2 | Match gateway toolsets | Done (`video` + `video_gen`) |
| Security audit card | P3 | `hermes security audit` | Done |
| Goals composer toggle (standing objective) | P2 | Beyond Settings max_turns | Done |
| Bundles install/manage | P3 | Beyond read-only names | Done |
| Journey xyflow graph | P3 | List timeline exists | Done (Graph\|List) |
| Computer-use live dock | P3 | Screenshots during CU | Done (ephemeral; frames if upstream) |
| Portal OAuth polish | P3 | Free models + tool gateway | Done (status/open/tools; login in browser) |
| Dashboard deep-link | P3 | `127.0.0.1:9119` | Done |
| Composer `@file` / `@diff` refs | P2 | Parity plan “next features” | Done (`@file:` `@folder:` `@diff` `@url:`) |
| Tool search for large MCP | P3 | When enabled tools blow context | Done (UI index + Hermes `tool_search` toggle) |
| Worktree GitHub tools + cleanup | P2 | Local tools + cleanup | Done |
| MoA on runs | P2 | Opt-in translate | Partial / flag-gated |
| Pets gallery select | P3 | | Done |

**Estimate:** Mostly complete; remaining work is primarily honesty, parity, and upstream dependency tracking.

---

## 5. Suggested PR sequence

_Historical — use for commit/PR splitting if desired._

1. **PR-A** — Kanban/team → `HermesAgentAdapter` + refuse MoA on `run_agent`
2. **PR-B** — Profiles Save + compress wiring + `/resume` stub removal (or real resume)
3. **PR-C** — Checkpoint list + restore API/UI
4. **PR-D** — Session fork proxy + HermesChatsPanel action
5. **PR-E** — MCP unify (sidebar → Hermes bridge)
6. **PR-F** — Auth/credential pool Settings
7. **PR-G** — Hermes projects proxy + switcher
8. **PR-H** — Formation routing + swarm label cleanup
9. **PR-I** — `/v1/runs` behind flag (bridge translate) + explicit fallback reason events
10. **PR-J** — Worktree launch + fallback toast + slash-command honesty
11. **PR-K+** — Plugins/hooks/LSP/toolsets as capacity allows

---

## 6. Testing plan

| Layer | Coverage |
|-------|----------|
| Unit | Adapter selection in kanban runner; checkpoint restore message builders; formation→backend map; MCP list normalization; slash-command kind labeling |
| Bridge | Adapter init smoke for kanban env; runs event → existing event types; fork returns new session id; transport-status event on runs fallback |
| UI | Profiles save round-trip; restore sheet; MCP sidebar matches store; runs toggle streams tools; auth-pool API-key add form |
| Regression | Non-MoA agent-loop; MoA picker; native kanban CRUD; teams restart from JSON store |
| E2E (optional) | Flag runs on → approve dangerous tool → stop mid-run; request runs with repo/custom-tools/computer-use and verify visible fallback reason |

---

## 7. Risks

| Risk | Mitigation |
|------|------------|
| `/v1/runs` event shape ≠ bridge SSE | Bridge translate layer; feature flag; keep agent-loop as default until green |
| Kanban adapter breaks card workers | Shadow-run adapter behind env; compare outcomes; keep script interface stable |
| MCP unify loses Spark-only custom tools | Migrate custom tools into Hermes MCP config or keep explicit “Spark overlay” section |
| Credential UI touches secrets | Never return raw secrets to client; mask; write via CLI/`auth.json` carefully |
| Worktree + repo mode toolset strip | Revisit `REPO_MODE_DISABLED_HERMES_TOOLSETS` when worktree is local clone |
| Slash-command honesty feels like a regression | Improve labels/help without removing current forwarded behavior; only clarify semantics |

---

## 8. Success metrics

| Metric | Target |
|--------|--------|
| Fleet path on adapter | 100% kanban/team spawns |
| Gateway capability honesty | If `runs=yes` shown, it is clearly labeled as capability detection; if runs is requested but rejected, chat explains why |
| Checkpoint restore without chat | Yes |
| Session fork from Spark | Yes |
| Single MCP list for Hermes mode | Yes |
| MoA still works after runs migration | Yes |
| Dual-swarm confusion | Labels fixed; formation routes documented |
| Slash-command truthfulness | Users can distinguish local / skill-expanded / forwarded commands in the composer |

---

## 9. What not to do

- Reimplement MoA, `delegate_task`, or kanban.db in Express
- Grow Spark zustand MCP as a second install path
- Ship pets/Portal polish before adapter + runs/fork/restore
- Market “swarm” without specifying which system
- Claim Phase “Done” for slash-passthrough-only or flag-gated features

---

## 10. Immediate recommendation

**Keep the current architecture: bridge-first, agent-loop-default, explicit honesty improvements.**  
The highest-value remaining work is not a rearchitecture — it is making fallback, command execution type, and capability state explicit where users currently have to infer it.

---

## 11. Relation to prior docs

| Doc | Role |
|-----|------|
| `docs/hermes-0.18-feature-integration-plan.md` | Phases 0–5 (surfaces) — keep as historical + status |
| `docs/superpowers/plans/2026-07-09-hermes-feature-parity.md` | MoA-focused parity notes |
| **This doc** | Phase 6+ execution alignment and remaining Hermes 0.18 product surfaces |

When updating status, distinguish clearly between:
- **implemented and default**,
- **implemented behind a flag/toggle**, and
- **probe-only / partial / upstream-blocked**.
This is the main lesson from the 2026-07-11 audit.
