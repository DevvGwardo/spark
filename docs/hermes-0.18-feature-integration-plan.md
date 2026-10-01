# Spark × Hermes 0.18 Feature Integration Plan

**Date:** 2026-07-09  
**Hermes baseline:** v0.18.2 (`2026.7.7.2`)  
**Spark baseline:** 1.0.0-beta.7 (`cloud-chat-hub`)  
**Strategy:** Spark stays the **control plane + dense desktop UX**; Hermes stays the **execution plane**. Prefer bridging native Hermes features over reimplementing them in Node/Express.

---

## 1. Executive summary

Spark already ships a deep Hermes shell: agent-loop chat, tool visualization, profiles, skills, memories (file editor), cron, MCP, kanban + orchestrator, teams, rooms, messaging platforms, swarm pipeline, and multi-provider chat.

Hermes 0.18 has moved past that shell into first-class product surfaces Spark does **not** expose well — especially **Mixture of Agents (MoA)**, native kanban swarm, goals, checkpoints, computer-use, external memory providers, journey/learning graph, plugins/bundles/curator, worktrees, and the async **`/v1/runs`** API.

**Highest-leverage principle:** do not re-build MoA, `delegate_task`, or Hermes kanban.db in Express. Wire Spark to the real Hermes runtime, stream its events into existing UI chrome, and collapse dual stacks over time.

---

## 2. What Spark already has (do not rebuild)

| Area | Spark status | Key paths |
|------|--------------|-----------|
| Multi-provider chat + Hermes agent mode | Done | `server/lib/hermes.ts`, `hermes-bridge/` |
| Tool call viz, approvals (file changes), effort slider | Done | `AgentActivity`, `ChangeApprovalModal`, `HermesEffortSlider` |
| Profiles, skills hub, memories editor, usage | Done | sidebar Hermes panels |
| Cron + history | Done | `CronJobsPanel`, bridge `/cron` |
| MCP install/catalog | Done | `HermesMCPPanel` |
| Kanban board + task orchestrator | Done (Spark-owned) | `kanban-store`, `task-orchestrator.ts` |
| Teams + rooms multi-agent | Done (Spark-owned) | `team-coordinator`, `room-coordinator` |
| Bridge swarm (Architect→Implementor→Reviewer) | Partial (brain-dependent) | `swarm_pattern.py` |
| Messaging platform config | Done | `MessagingTab` |
| Webhooks / pairing / logs panels | Removed | `HermesWebhooksPanel`, `HermesPairingPanel` and the logs tab were deleted: every bridge endpoint behind them returned 404 (see the `HERMES_SUB_TABS` note in `src/components/sidebar/ChatSidebar.tsx`) |

---

## 3. Gap matrix (Hermes 0.18 vs Spark)

### Tier A — missing or barely exposed (high product value)

| Hermes feature | What it is | Spark gap | Difficulty |
|----------------|------------|-----------|------------|
| **MoA (Mixture of Agents)** | Virtual provider: N parallel advisor models → 1 aggregator with tools | No picker entry, no config UI, no `moa.reference` event rendering; adapter provider map has no `moa` | Medium |
| **Fallback providers** | Ordered failover on 429/5xx | Works under Hermes silently; no status banner in Spark | Low |
| **Goals (`/goal`)** | Ralph-loop standing objective + judge | Not in UI | Medium |
| **Checkpoints + `/rollback`** | Shadow-git snapshots before destructive edits | Slash command stubbed; no list/restore UI | Medium |
| **Session fork (native)** | `POST /api/sessions/{id}/fork` | Spark has conversation tree for *Spark* chats; not Hermes session fork | Medium |
| **Computer use (cua-driver)** | Background desktop control toolset | Toggle exists in store; no install/doctor/status UX, no live action stream | High |
| **Native Hermes kanban + swarm** | SQLite multi-profile board + `hermes kanban swarm` | Dual board: Spark Express kanban ≠ Hermes `kanban.db` | High (strategic) |
| **`delegate_task` exposure** | In-process subagents | Display-only in `agent-task-panel`; `delegation` not a first-class toolset toggle | Low–Medium |
| **`/v1/runs` lifecycle API** | Async runs + approval SSE | Spark uses OpenAI chat SSE via bridge only | Medium–High |

### Tier B — partial surfaces to deepen

| Feature | Spark has | Missing |
|---------|-----------|---------|
| Skills | List, hub install, filter | Bundles, curator, usage telemetry, “run skill” CTA |
| Memory | MEMORY/USER file editor | External providers (mem0, honcho, …), journey/learning graph |
| Profiles | Switcher + list | Full config editor, role describe for kanban, export/import |
| Insights/usage | Usage panel | Hermes insights engine (tool patterns, platform trends) |
| Compression | Silent in agent | Manual `/compress`, context meter hooks to Hermes compressor |
| Plugins | — | List/enable/disable only (no authoring) |
| Worktree mode | — | Per-session isolated git worktree for parallel agents |
| LSP diagnostics | Free if Hermes returns them | Optional diagnostics strip in tool accordion |

### Tier C — optional / delight / migration

| Feature | Priority | Notes |
|---------|----------|-------|
| Pets (petdex) | P3 | Cosmetic; Hermes Desktop differentiator |
| Claw (OpenClaw migrate) | P3 | One-shot onboarding wizard |
| ACP | Skip for Spark core | Spark is not an ACP host |
| Hermes Desktop/dashboard embed | P3 | Deep-link or “open in Hermes dashboard” only |
| Portal OAuth polish | P2 | Reuse Nous portal for free models + tool gateway |

---

## 4. Critical distinction: do not confuse these “swarm”s

| Name | What it actually is | Where |
|------|---------------------|--------|
| **Hermes MoA** | Multi-*model* advisors + one acting aggregator | `agent/moa_loop.py` |
| **Hermes `delegate_task`** | Multi-*agent* in-process children | `tools/delegate_tool.py` |
| **Hermes kanban swarm** | Durable multi-*profile* work graph | `hermes kanban swarm` |
| **Spark swarm mode** | Serial Architect→Implementor→Reviewer via brain MCP | `swarm_pattern.py` |
| **Spark formation `strategy: swarm`** | Keyword heuristic → “use all profiles” | `team-formation.ts` |
| **Spark teams** | Express-spawned profile workers + `team_*` tools | `team-coordinator.ts` |

Product copy and UI labels should stop overloaded “swarm” naming. Recommended labels:

- **MoA** → “Mixture of Agents” / “Multi-model”
- **Spark pipeline** → “Review pipeline” (was swarm mode)
- **Kanban multi-profile** → “Fleet board”
- **Teams** → keep “Teams”

---

## 5. Recommended architecture (educated route)

```
┌─────────────────────────────────────────────────────────────┐
│  Spark UI (dense desktop)                                   │
│  model picker · advisor blocks · boards · rooms · approvals │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│  Express control plane (:3001)                              │
│  rooms · team policy · Spark kanban UI · mesh · proxies     │
└────────────────────────────┬────────────────────────────────┘
                             │
          ┌──────────────────┴──────────────────┐
          ▼                                     ▼
┌─────────────────────┐              ┌──────────────────────────┐
│ hermes-bridge :3002 │   migrate    │ Hermes gateway / API     │
│ HermesAgentAdapter  │ ──────────►  │ :8642 /v1/runs + events  │
│ (today’s path)      │  long-term   │ native kanban dispatcher │
└─────────────────────┘              └──────────────────────────┘
          │                                     │
          └──────────────┬──────────────────────┘
                         ▼
              ~/.hermes (config, moa, skills,
               memory, profiles, kanban.db)
```

### Decision: bridge-first, not reimplement

| Capability | Route |
|------------|--------|
| MoA | Pass `provider=moa` + preset as model into real Hermes agent |
| Subagents | Enable `delegation` toolset; render existing events |
| Multi-profile fleet | Prefer Hermes kanban.db over growing Spark Express board forever |
| Multi-model quality | MoA (not Spark swarm) |
| Multi-role coding pipeline | `delegate_task` + `agents/*.md` **or** keep Review pipeline as optional |
| Conversational multi-agent | Keep Spark **Rooms** (product differentiator) |
| Shared team blackboard | Keep Spark team-context SQLite + optional mesh |

---

## 6. Phased delivery plan

### Phase 0 — Foundation (1–2 days)

**Goal:** make the real Hermes path the only production path for agent features.

1. **Adapter hardening**
   - Ensure `HermesAgentAdapter` always wins when hermes-agent is importable.
   - Map `x-hermes-provider: moa` through provider resolution (today’s host→provider map never yields `moa`).
   - Add bonus toolsets optionally: `delegation`, `cronjob` (already has skills/memory/todo/session_search).

2. **Event bus extension**
   - Extend bridge SSE + `packages/hermes-bridge-client` + `server-tool-events` for:
     - `moa.reference` `{ label, text, index, count }`
     - `moa.aggregating` `{ aggregator, ref_count }`
     - `approval.request` / resolve (if not already fully wired for tools)
     - `delegate_task` start/complete (if not fully surfaced)

3. **Capabilities probe**
   - On bridge health, also hit Hermes `GET /v1/capabilities` when gateway is up; surface version + feature flags in Overview.

**Exit criteria:** chat with real Hermes agent; provider override accepts `moa`; new event types typed end-to-end (even if UI is temporary dump).

---

### Phase 1 — MoA (flagship) (3–5 days)

**Why first:** unique quality mode, already configured on this machine, zero reimplementation if wired correctly.

#### 1.1 Config / API

| Endpoint | Behavior |
|----------|----------|
| `GET /api/hermes/moa` | Read `moa` block from active profile `config.yaml` (normalized presets) |
| `PUT /api/hermes/moa` | Write presets (validate: no recursive moa slots) |
| `GET /api/hermes/moa/presets` | Flat list for picker |

Implement in `hermes-bridge` (read/write profile home) + proxy in `hermes-admin.ts`. Prefer calling Hermes desktop-style `/api/model/moa` if gateway is available; else YAML R/W via bridge.

#### 1.2 Model picker

In `HermesModelPicker` + `useHermesProviders`:

- Inject synthetic provider row: **`Mixture of Agents`** (`id: moa`)
- Models = preset names (`default`, `review`, …)
- On select: `setUnderlyingProvider('moa')` + `updateProviderConfig('hermes', { model: presetName })`
- Bridge maps to `RealAIAgent(provider="moa", model=preset)`

#### 1.3 Chat UX

- Collapsible **Advisor** blocks in `AgentActivity` / message stream for `moa.reference`
- Status line “Aggregating with {model}…” for `moa.aggregating`
- Cost strip: sum advisor + aggregator when usage events present
- One-shot: `/moa <prompt>` already in Hermes; ensure slash path reaches agent or send encoded `__HERMES_MOA_TURN_V1__` marker

#### 1.4 Settings editor

Under Settings → Hermes (next to swarm/loop):

- List presets
- Edit reference slots (provider + model pickers from credentialed list)
- Aggregator slot
- Knobs: `enabled`, `fanout` (`per_iteration` | `user_turn`), `reference_max_tokens` (default suggest **600** for latency)
- Delete / create preset

#### 1.5 Defaults (sensible Spark presets)

Ship three named presets on first setup (only if none exist):

| Preset | References | Aggregator | fanout | ref max tokens |
|--------|------------|------------|--------|----------------|
| `fast` | 1 cheap model | strong coding model | `user_turn` | 400 |
| `default` | 2 mid models | best available coding model | `per_iteration` | 600 |
| `review` | 2 strong models | strongest available | `user_turn` | 800 |

Use whatever is credentialed on the machine (Nous free / OpenCode / OpenRouter).

**Exit criteria:** user can pick MoA:default, see advisor blocks, get tool-using answer; configure a second preset in Settings; unit tests for config normalize + event parse.

---

### Phase 2 — Reliability & safety (2–4 days)

| Feature | Integration |
|---------|-------------|
| **Fallback providers** | `GET/PUT /api/hermes/fallback`; Settings list UI; toast “Switched to {provider}/{model}” when Hermes emits switch (if event available, else post-hoc from logs) |
| **Checkpoints** | List/prune via bridge shelling `hermes checkpoints` or reading `~/.hermes/checkpoints`; UI sheet near changeset; wire `/rollback` |
| **Approvals** | Generalize `ChangeApprovalModal` → shared ApprovalBanner for tool danger + orchestrator “dispatch?”; Queue badge for pending |
| **Compression** | Button “Compress context” → slash/RPC; meter already exists — bind to real token estimates from Hermes if available |
| **`delegation` toolset toggle** | Add to `HermesToolsets`; default on for coding profiles |

**Exit criteria:** fallback visible; rollback restores a file from checkpoint; dangerous command approval modal works for at least terminal write patterns.

---

### Phase 3 — Multi-agent consolidation (1–2 weeks)

#### 3.1 Short term (keep Spark boards, fix holes)

1. Team store durability (SQLite, not `Map`)
2. Honor `TEAM_MAX_CONCURRENT_AGENTS`
3. Fix subtask dependency IDs (not title strings)
4. Always run kanban workers through `HermesAgentAdapter`, not only `run_agent.py`
5. Enable Hermes `delegation` on team workers where single-process multi-subagent is enough

#### 3.2 Medium term (converge kanban)

**Option A (recommended):** Spark Kanban UI becomes a **client of Hermes `kanban.db`**

- Bridge proxies `hermes kanban` CLI / Hermes kanban tools
- Spark lanes map to Hermes statuses (`triage/todo/ready/running/blocked/done/archived`)
- Add **Swarm graph create** UI → `hermes kanban swarm …`
- Retire Express card table gradually

**Option B:** Keep dual boards, label clearly “Spark Board” vs “Hermes Board” (worse UX; only if migration risk is too high)

#### 3.3 Policy layer (formation → Hermes action)

| `analyzeTask().strategy` | Backend |
|--------------------------|---------|
| `single_agent` | agent-loop |
| `pair_programming` | Room with 2 profiles **or** `delegate_task` implement+review |
| `specialist_team` | Multi-profile kanban fan-out |
| `pipeline` | `delegate_task` role chain **or** Review pipeline mode |
| `swarm` | Hermes kanban swarm graph |

#### 3.4 Swarm mode fate

- If brain MCP is required and tests stay skipped → demote Review pipeline to experimental
- Prefer mapping roles to Hermes `agents/code-reviewer.md` + `debugger.md` via `delegate_task`

**Exit criteria:** one primary durable board story; formation strategies change execution shape; team restart survives process restart.

---

### Phase 4 — Memory, skills, automation (1 week)

| Feature | UI mount | Backend |
|---------|----------|---------|
| External memory providers | Memories panel → Providers tab | `hermes memory status/setup` proxy |
| Journey / learning graph | Tab inside `HermesMemoriesPanel` (reuse xyflow) | `hermes journey --json` or learning graph API |
| Skill bundles | Skills panel section | `hermes bundles list` |
| Curator | Skills panel footer | `hermes curator status/run` |
| Goals | ChatInput toggle + Overview card | Pass goal config / slash `/goal` |
| Worktree sessions | “Open in worktree” on panel create | `hermes --worktree` or kanban workspace `worktree:` |
| Webhooks | New panel (the old one was removed) | Only worth rebuilding once the bridge exposes working routes for Hermes dynamic subscriptions |
| Insights | Usage panel enhancement | `hermes insights --json` |

---

### Phase 5 — Desktop wow + long-term transport (optional)

| Feature | Notes |
|---------|-------|
| Computer-use status | Doctor UI; permission grants; stream screenshots into mini dock |
| Pets | Only if brand wants delight; keep off by default |
| OpenClaw import wizard | Call `hermes claw migrate --dry-run` then apply |
| **Migrate chat transport to `/v1/runs`** | Best long-term contract: async, approvals, stop, events; requires forwarding `moa.*` in runs SSE (upstream patch or bridge translate) |
| Deep-link Hermes dashboard | Overview button → `http://127.0.0.1:9119` |

---

## 7. MoA implementation sketch (concrete)

### Bridge (`hermes_adapter.py`)

```python
# When provider_override == "moa":
provider = "moa"
model = preset_name  # e.g. "default"
# Do NOT rewrite moa → openrouter/etc.
# RealAIAgent handles MoAClient internally when provider=="moa"
```

### Headers (chat path)

```
X-Hermes-Provider: moa
# body.model = "default"  (preset name)
```

### UI event rendering

```ts
// server-tool-events / HermesEvent extension
| { type: 'moa_reference'; label: string; text: string; index: number; count: number }
| { type: 'moa_aggregating'; aggregator: string; refCount: number }
```

### Config read (bridge)

Reuse Hermes:

```python
from hermes_cli.moa_config import normalize_moa_config, list_moa_presets
```

Do not invent a second schema.

---

## 8. File-level work map (by phase)

### Phase 1 files

| Layer | Files |
|-------|--------|
| Bridge | `hermes-bridge/hermes_adapter.py`, `main.py` (new `/moa` routes), event callbacks |
| Server | `server/routes/hermes-admin.ts`, `server/lib/hermes.ts` (pass provider) |
| Client types | `packages/hermes-bridge-client/src/types.ts`, `src/lib/server-tool-events.ts` |
| Store | `src/stores/hermes-store.ts` (moa defaults optional) |
| UI | `HermesModelPicker.tsx`, `AgentActivity.tsx`, Settings Hermes section, new `MoaSettingsPanel.tsx` |
| API client | `src/lib/hermes-api.ts` |
| Tests | moa config normalize, picker injection, event parse |

### Phase 2–3 files

| Area | Files |
|------|--------|
| Fallback | hermes-admin proxy, Settings |
| Checkpoints | new panel/sheet, `hermes-commands.ts` `/rollback` |
| Teams | `team-coordinator.ts` durability + concurrency |
| Kanban converge | `kanban.ts`, `kanban_tools.py`, store mapping |
| Delegation | `hermes-store` toolsets, adapter bonus list |

---

## 9. Testing plan

| Layer | What |
|-------|------|
| Unit | MoA config normalize (fixtures from Hermes tests), event parsers, formation→backend mapping |
| Bridge | Integration: `provider=moa` agent init smoke; SSE emits `moa.reference` |
| UI | Vitest: picker shows MoA when presets exist; advisor accordion renders |
| E2E | Electron: select MoA preset, send “summarize this repo structure”, see ≥1 advisor block + final answer |
| Regression | Non-MoA agent-loop still works; swarm mode still selectable |

---

## 10. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| MoA multiplies cost/latency | Default `reference_max_tokens: 600`, `user_turn` for “fast”; warn in UI |
| Credential failures on advisors | Hermes continues with failed note — show failed advisor chips |
| Dual kanban drift | Phase 3 converge or hard label dual boards |
| Swarm brain incomplete | Don’t market as primary multi-agent; prefer MoA + kanban + rooms |
| Bridge vs gateway dual transport | Phase 0 stay on bridge; Phase 5 optional `/v1/runs` |
| Recursive MoA | Reject in write API (Hermes already rejects `provider: moa` slots) |
| Profiles isolation | All new routes respect `X-Hermes-Profile` / `HERMES_HOME` |

---

## 11. Suggested PR sequence (Graphite-friendly)

1. **PR1** — Event types + adapter `moa` provider pass-through (no UI)
2. **PR2** — `GET/PUT /api/hermes/moa` + bridge YAML/gateway
3. **PR3** — Model picker MoA section + advisor stream UI
4. **PR4** — MoA settings editor + preset templates
5. **PR5** — Fallback UI + delegation toolset toggle
6. **PR6** — Checkpoints list + rollback
7. **PR7** — Team durability + concurrency fixes
8. **PR8** — Kanban Hermes.db proxy (or dual-board labeling)
9. **PR9** — Memory journey graph + external provider status
10. **PR10** — Goals + worktree session launch

---

## 12. Success metrics

| Metric | Target |
|--------|--------|
| MoA selectable without CLI | Yes |
| Advisor blocks visible on MoA turns | Yes |
| Time to configure a preset in UI | < 60s |
| Cost awareness | Advisors + aggregator shown separately when available |
| Dual multi-agent confusion | Naming guide applied in UI copy |
| Kanban single source of truth | One board story by end of Phase 3 |
| Agent path | ≥95% sessions on real Hermes adapter, not fallback `run_agent` |

---

## 13. Bottom line recommendation

**Do this first:** Phase 0 + Phase 1 (MoA).  
It is the cleanest “Hermes has it, Spark doesn’t” gap, maps to a virtual provider (exactly how Spark’s model picker already works), and needs no new multi-agent runtime in Express.

**Do not do:** reimplement MoA as a Spark swarm variant; grow a third multi-agent system; ship pets/ACP before MoA/kanban/approvals.

**North star:** Spark = the best dense desktop control surface for Hermes 0.18+ — MoA, fleet kanban, rooms, and approvals — without forking Hermes’ brain.

---

## 14. Implementation status (2026-07-09)

| Phase | Status | Notes |
|-------|--------|-------|
| **0 Foundation** | Done | MoA provider pass-through, `tool_progress_callback` → advisor events |
| **1 MoA** | Done | Picker, settings editor, `/moa` API, AgentActivity advisor cards |
| **2 Reliability** | Done | Fallback settings, goals settings, checkpoints/curator/memory/CU in System ops, `/compress` `/rollback` `/goal` as agent-pass-through, `delegation` toolset + `computer`→`computer_use` map |
| **3 Teams** | Done (core) | Durable `data/teams-store.json`, concurrency cap, dependency title→id resolution, blocked-until-deps |
| **3 Kanban converge** | Done | Already on `~/.hermes/kanban.db`; UI labeled native Hermes; status map includes triage/todo/archived; **Swarm** create via CLI |
| **4 Surfaces** | Done | Journey tab in Memories; memory provider line; curator/bundles/insights/CU/pets/gateway in System ops |
| **5 Optional** | Done (surfaces) | Pets select; OpenClaw dry-run/apply; CU install+doctor; gateway `/v1` capabilities probe (`run_submission` flag). Full chat transport migration to `/v1/runs` deferred as follow-up. |
| **6+ Execution alignment** | Done | Full Phases 6–10 + leftover hardening in [`docs/hermes-alignment-phase6-plan.md`](./hermes-alignment-phase6-plan.md). Upstream-only: mid-action CU frames, gateway runs cwd/toolset fields. |
