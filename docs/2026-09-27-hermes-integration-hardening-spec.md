# Hermes Integration Hardening Spec

**Status:** Implemented (Phases 0–7, 2026-10-01). Open follow-up: #71
**Owner:** @DevvGwardo
**Created:** 2026-09-27
**Hermes baseline:** hermes-agent `v2026.7.20` (0.19.0), pinned in `electron/bridge.ts:275`
**Related:** `hermes-0.18-feature-integration-plan.md` (Phases 0–5, done), `hermes-alignment-phase6-plan.md` (Phases 6–10, mostly done), `qa-audit.md`, `mobile-access.md`

---

## 1. Why

The feature-parity work in the 0.18 and Phase 6–10 plans is essentially finished. Spark now covers nearly all Hermes features. What remains is the *integration layer* that connects them, which has grown by accretion:

- **Three separate Node→bridge fetch layers.** Each has its own retry, auth, timeout and error behavior. There are about 18 raw `fetch` call sites plus 102 `proxyTo` routes, and 7 separate health probes.
- **An 8.4k-line `main.py`.** It has a single ~1,400-line chat handler, duplicated SSE drain loops, and duplicated GitHub tool code.
- **An event contract that is not enforced anywhere.** `bridge_events.py` describes it only in prose, and `hermes.ts` has about 170 lines of `unknown` casts.
- **Frontend data access built by hand in each panel.** React Query is installed and mounted but has zero `useQuery` call sites.
- **Several confirmed correctness bugs** (§2.1). Neither CI nor the test suites catch them.

This spec does **not** add Hermes features. Its aim is that the integration is **correct, observable, typed, and recoverable**, so the next Hermes upgrade costs a day rather than a phase.

Out of scope, because the Phase 6 doc already tracks them: making `/v1/runs` the default transport, MoA-on-runs, and the credential-pool UI. This spec does make them *cheaper*; see §4.4.

---

## 2. Audit snapshot (2026-09-27)

### 2.1 Confirmed defects

| ID | Defect | Evidence | Impact |
|---|---|---|---|
| B1 | `@app.on_event("startup")` handlers never run, because FastAPI ignores them when `lifespan=` is set | `main.py:3271` (lifespan), `main.py:8353`, `:8364` (on_event) | Cron scheduler never ticks. MCP telemetry never initializes. |
| B2 | `swarm_pattern.py` imports `main` while the bridge runs as `python main.py`, which creates a second module copy with `_brain_proc = None` | `swarm_pattern.py:29`, `scripts/start-bridge.sh:45` | Every brain RPC made from swarm silently returns `None` |
| B3 | Admin ACP approval route is shadowed by the chat route: same path, and chat registers first and returns 400 when there is no `decision` | `chat.ts:325` vs `hermes-admin.ts:312`, `index.ts:195/201` | `postAcpApproval({option_id})` always fails; it only works through the direct-bridge fallback |
| B4 | API key prefix is logged, and short keys are logged in full via `repr(api_key)` | `hermes_adapter.py:1568` | Secret leakage into logs |
| B5 | Hard-coded machine paths for brain-mcp and node | `main.py:1476-1480` | Breaks on any machine other than the author's |
| B6 | `os.environ["HERMES_HOME"]` is mutated from worker threads | `hermes_ops.py:341`, `:2301` | Profile cross-talk between concurrent chat and ops calls |
| B7 | `unregister_active_run` pops by conversation id only | `hermes_runs.py` | An overlapping old run can remove a newer run's cancel handle |
| B8 | `hermes_adapter.py` registers `sys.modules["run_agent"]` before `exec_module` | `hermes_adapter.py:88-96` | If the load fails partway, the fallback import gets a half-loaded module |
| B9 | Adapter reads the hard-coded `~/.hermes/config.yaml` | `hermes_adapter.py:1558` | Ignores the active profile |

### 2.2 Structural gaps

| ID | Gap | Evidence |
|---|---|---|
| G1 | No shared bridge client on the Node side. Retry budgets differ (30s admin vs 15s chat), the token header is written 3–4 times, and some callers have no timeout at all | `hermes-admin.ts:134-251`, `lib/hermes.ts:523-608`, `chat.ts:320-351`, `room-coordinator.ts`, `team-coordinator.ts:226`, `validate.ts`, `remote-status.ts` |
| G2 | Chat paths never send `X-Hermes-Bridge-Token` and rely on the loopback exemption | `lib/hermes.ts:41`, `main.py:3309` |
| G3 | `proxyTo` has no timeout and does not abort upstream when the client disconnects | `hermes-admin.ts:161-251` |
| G4 | Five different error shapes across routes, and `ChatErrorBanner` classifies errors with regexes | `ChatErrorBanner.tsx`, `hermes-admin.ts:315`, `routes/bridge.ts` |
| G5 | Only half the SSE custom events are in `bridge_events.py`. `tool_activity`, `agent_status`, `computer_use_frame`, `agent_notice`, `server_tool_event` and `fallback_switch` are built inline | `main.py` (various), `bridge_events.py:1-15` |
| G6 | Transport capability matrix is uneven (see below) | `hermes_adapter.py:1590-1622`, `acp_transport.py:348`, `:788`, `main.py:4623`, `:6462` |
| G7 | No crash respawn in either bridge manager. The headless manager adopts any process that answers `/health` without an ownership check | `bridge-manager.ts:176-242`, `electron/bridge.ts` |
| G8 | Two bridge managers (Electron and headless) share about 70% of their logic but use different pip strategies | `electron/bridge.ts`, `server/lib/bridge-manager.ts` |
| G9 | Hermes update and the pinned-tag install conflict. Update fast-forwards past the pin and staleness-breaks the parity patch, and it does not restart the bridge | `hermes-update.ts`, `electron/bridge.ts:275,511` |
| G10 | Blocking sync I/O inside async handlers: CLI calls up to 300s, sync httpx/urllib, sqlite | `main.py:3862, 4013, 4034, 4214, 4234, 5460, 7214, 7259, 7581, 7928, 8302` |
| G11 | ACP `ensure_session` holds a global lock across the spawn and its retries, which serializes first turns across all conversations | `acp_transport.py:529-611` |
| G12 | Config writes are non-atomic and unlocked, and leave an unbounded number of `.bak-<ts>` files | `main.py:7798` |
| G13 | `/api/hermes/update` and `/api/bridge/*` are not in the destructive-op loopback gate | `hermes-admin.ts:14-62`, `routes/bridge.ts` |
| G14 | Frontend: about 9 panels repeat useState/useEffect loading boilerplate, polling is written ad hoc 3 times, and there is no shared bridge-offline gate | `Hermes*Panel.tsx`, `HermesStatusPill.tsx:21`, `mobile/useHermesStatus.ts` |
| G15 | Two cron systems (the hermes-helper one and a bridge JSON one) | `main.py:824-1370`, `:6840-7185` |
| G16 | Unbounded `_sessions` dict. Metrics counters are updated from threads with no lock and are also defined twice | `main.py:57`, `:1795`, `:2793` |

**Transport capability matrix (current, after Phase 4 items 4.3–4.6 and 4.8):**

| Capability | agent-loop (adapter) | ACP | `/v1/runs` (flag) |
|---|---|---|---|
| Approvals | ✓ hermes approval callback → `approval_request` → `/v1/approvals/{id}` (`bridge-*` ids) | ✓ `request_permission` → same registry and route | partial (gateway `approval.*` events arrive as `server_tool_event`; not advertised) |
| Cancel / Stop | ✓ `AIAgent.interrupt`, via `POST /v1/chat/cancel` | ✓ ACP `session/cancel` | ✓ `POST /v1/runs/{id}/stop` |
| Stops on client disconnect | ✓ unless `background: true` (desktop chat sets it) | ✓ unless `background: true` | ✓ unless `background: true` |
| Usage / cost in stream | ✓ agent token counters, priced by `pricing.py`, on the final chunk | ✓ prompt-response usage + `usage_update` cost, priced | ✓ `run.completed` usage, priced |
| Session resume after reap/crash | ✓ via `session_id` | ✓ `load_session` when advertised, else condensed-history replay | n/a |

### 2.3 Stale docs

- `hermes-0.18-feature-integration-plan.md:33` and `hermes-alignment-phase6-plan.md:57` still list the webhooks, pairing and logs panels. Those panels are deleted in the working tree.
- `overnight-backlog.md` marks session filter and status counts done, but that code and its tests are gone because counts moved server-side.

---

## 3. Principles

1. **One way in.** Each hop has exactly one client: UI→Node through `hermes-api.ts`, Node→bridge through `BridgeClient`, and bridge→hermes-agent through one adapter boundary.
2. **Contract before code.** Every SSE event and every error has a schema that both runtimes validate against.
3. **Honest capability.** Following the Phase 6 §11 rule, the UI shows what the active transport can actually do and never implies more.
4. **Fail loud, recover automatically.** Remove swallowed `except: pass` on anything that affects behavior. Crashes respawn. Readiness is pushed to the UI, not guessed by it.
5. **No behavior change without a test that would have caught the bug.** Each B-item fix ships with a regression test.

---

## 4. Phases

### Phase 0 — Correctness hotfixes

**Goal:** Fix every §2.1 defect with a regression test for each.
**Estimate:** 1 PR, ~1 day.

| ID | Work | Exit criteria |
|---|---|---|
| 0.1 | Move the cron-scheduler and MCP-telemetry startup into `_brain_lifespan` and delete the `on_event` handlers (B1) | `TestClient(app)` startup test shows the scheduler task alive and the telemetry db initialized |
| 0.2 | Break the `import main` cycle (B2). Move brain RPC (`_brain_proc`, `_brain_rpc`) into `brain_client.py` and have `swarm_pattern` and `main` import it. Add `if __name__ == "__main__": sys.modules.setdefault("main", sys.modules["__main__"])` as a belt-and-braces guard | Test: `python main.py` subprocess plus a swarm call returns a non-None brain result, or a unit test asserts one module identity |
| 0.3 | Merge the approval routes (B3). A single `/api/hermes/approvals/:id` accepts `{decision}` or `{option_id}`. Engine-local ids resolve locally and `acp-*` ids forward. Delete the admin duplicate | vitest: both body shapes → 200. `AcpApprovalBanner` no longer needs the direct-bridge fallback |
| 0.4 | Replace the key preview with `mask_secret()` (length plus last 2 characters only) and grep for similar prints (B4) | pytest asserts no key substring in captured stdout |
| 0.5 | Resolve brain-mcp through `BRAIN_MCP_PATH` / `shutil.which("node")`, and skip it gracefully when absent (B5) | Bridge boots with `HOME` pointing at an empty tmp dir |
| 0.6 | Replace the `HERMES_HOME` env mutation with explicit `hermes_home=` arguments. Where upstream needs env, run in a subprocess instead of a thread (B6) | Concurrency test: two profiles in parallel threads each see their own home |
| 0.7 | `unregister_active_run(conv_id, run_id)` compare-and-delete (B7) | pytest: an overlapping-run test |
| 0.8 | Insert into `sys.modules` only after `exec_module` succeeds, and pop it on failure (B8) | pytest: simulated partial-load failure → fallback gets the bridge `AIAgent` |
| 0.9 | Adapter reads `<HERMES_HOME>/<profile>/config.yaml` (B9) | pytest with two profile fixtures |
| 0.10 | Add `/api/hermes/update` and `/api/bridge/start|install-deps` to the loopback gate (G13) | Existing `remote-access-gating.test.ts` extended |

**Defer if:** nothing. These are bugs.

---

### Phase 1 — Shared event and error contract

**Goal:** One schema source for bridge→Node→UI events and errors, validated at runtime at the Node boundary.
**Estimate:** 2 PRs, ~3 days.

| ID | Work | Exit criteria |
|---|---|---|
| 1.1 | Move **all** custom SSE keys into `bridge_events.py` as Pydantic models: `tool_activity`, `agent_status`, `computer_use_frame`, `agent_notice(_clear)`, `server_tool_event`, `fallback_switch`, `transport_status`, `usage`, plus the existing six. `main.py` builds events only through these constructors | `grep -n '"tool_activity"' main.py` only hits `bridge_events` imports |
| 1.2 | Generate JSON Schema from the Pydantic models into `shared/hermes-events.schema.json` (checked in), then generate TS types and zod validators with `json-schema-to-zod` into `server/lib/hermes-events.gen.ts` | `npm run gen:hermes-contract`. CI fails if the generated files are stale |
| 1.3 | Rewrite `normalizeHermesAgentLoopPayload` (`hermes.ts:341`) as a zod `safeParse` dispatch. Unknown events are logged once per type and dropped, not cast | The ~170 lines of `unknown` checks are gone. Fixture-driven vitest replays recorded SSE streams |
| 1.4 | **Error envelope.** Every Node→UI Hermes error becomes `{ error: { code, message, retryable, details? } }` with a closed `code` enum: `BRIDGE_UNREACHABLE`, `BRIDGE_STARTING`, `BRIDGE_AUTH`, `UPSTREAM_TIMEOUT`, `MODEL_INCOMPATIBLE`, `PROVIDER_ERROR`, `APPROVAL_EXPIRED`, `VALIDATION`, `INTERNAL`. The bridge emits the same envelope via a FastAPI exception handler | `ChatErrorBanner` switches on `code`, with no regexes. All five legacy shapes are removed |
| 1.5 | Contract fixtures: record a golden SSE stream per transport (agent-loop, ACP, runs, swarm) into `hermes-bridge/fixtures/sse/`. Both pytest (emit side) and vitest (consume side) replay them | A fixture diff breaks both suites together |

**Verify:** A full chat turn per transport in the Electron e2e (`e2e/`) produces zero "unknown event" logs.

---

### Phase 2 — Single Node→bridge client

**Goal:** Replace the three fetch layers with one `BridgeClient`.
**Estimate:** 2 PRs, ~3 days.

```ts
// server/lib/bridge-client.ts
export interface BridgeRequestOptions {
  profile?: string;
  timeoutMs?: number;          // default 15s; chat streams pass `null` + rely on idle timeout
  idleTimeoutMs?: number;      // streams only; default 30s (config.ts)
  signal?: AbortSignal;        // wired to req 'close'
  retryUntilReady?: boolean;   // default true for idempotent GETs, false for POST
}
export const bridge = {
  json<T>(path: string, init?: RequestInit, opts?: BridgeRequestOptions): Promise<T>;
  stream(path: string, init?: RequestInit, opts?: BridgeRequestOptions): Promise<Response>;
  proxy(req: Request, res: Response, path: string, opts?: BridgeRequestOptions): Promise<void>;
  readiness(): BridgeReadiness;   // single cached health state (see Phase 3)
};
```

| ID | Work | Exit criteria |
|---|---|---|
| 2.1 | Implement `bridge-client.ts`. It always attaches `X-Hermes-Bridge-Token` and `X-Hermes-Profile` (fixes G2), uses one readiness-retry budget, sets a default timeout, propagates `AbortSignal` from the client disconnect (fixes G3), and maps failures to the §1.4 error envelope | Unit tests: timeout, abort-on-close, retry-only-on-connect-error, token always present |
| 2.2 | Port `proxyTo` (102 routes) onto `bridge.proxy`. Keep the 10s read cache, moved into the client | `hermes-admin.ts` loses `proxyTo`, `fetchWithBridgeReadinessRetry` and the token helper |
| 2.3 | Port `lib/hermes.ts` chat, loop, swarm and cancel, `chat.ts` approvals, the room/team coordinators, `validate.ts` and `remote-status.ts` | `rg "fetch\\(.*(getHermesBridge|3002)" server/` returns 0 hits outside `bridge-client.ts` |
| 2.4 | Tighten bridge auth. Once 2.3 lands, loopback requests **still require the token**, except `/health`. Keep an escape hatch, `HERMES_BRIDGE_ALLOW_LOOPBACK_NOAUTH=1`, for one release | Bridge-auth pytest. Chat works with a non-loopback `HERMES_BRIDGE_URL` |
| 2.5 | Delete the frontend's `postBridgeAcpApprovalDirect` fallback (made unnecessary by 0.3) | — |

---

### Phase 3 — Bridge lifecycle: one manager, readiness, and respawn

**Goal:** The bridge is always either ready or visibly recovering, and the UI knows which.
**Estimate:** 2 PRs, ~3 days.

| ID | Work | Exit criteria |
|---|---|---|
| 3.1 | Extract `shared/bridge-supervisor.ts`, used by both Electron and `server/lib/bridge-manager.ts`. It handles Python discovery, the token, the ownership check via `/diag`, spawn, health wait, and stop (SIGINT → 5s → SIGKILL, awaited). Electron and headless differ only through an injected `PythonResolver` and install strategy (G8) | `electron/bridge.ts` and `bridge-manager.ts` each drop to under 100 lines |
| 3.2 | **Respawn.** Unexpected exit triggers a restart with backoff (1s, 2s, 4s … max 30s), up to 5 attempts in 5 minutes, then state `crashed` with the last 50 stderr lines kept (G7) | e2e: `kill -9` the bridge → chat works again within 10s |
| 3.3 | **Readiness state machine:** `starting → ready → degraded (health slow/failing) → restarting → crashed`. Exposed as `GET /api/bridge/readiness` and pushed over the existing server events channel | — |
| 3.4 | Bridge logs go to a rotating file `~/.hermes/logs/spark-bridge.log` (5 × 5MB) as well as the console. The headless manager stops adopting unowned processes | — |
| 3.5 | Hermes update integration (G9). `hermes-update` detects a pinned-tag checkout and offers "move to tag vX" rather than a `main` fast-forward. Afterwards it re-applies `patches/hermes-api-server-runs-parity.patch`, verifies it, then restarts through the supervisor. Replace the POSIX-only `venv/bin/hermes` with a platform-aware resolver | Update → bridge restarts → `/diag` reports the new version. Patch re-applies cleanly or the update rolls back |

---

### Phase 4 — Transport parity and `main.py` decomposition

**Goal:** Every transport meets a minimum capability bar, and the chat path is small enough to change safely.
**Estimate:** 3–4 PRs, ~1.5 weeks. This is the largest phase.

**Minimum capability bar for every transport:** approvals, cancel, stop on client disconnect, usage in the final chunk, and a structured error.

| ID | Work | Exit criteria |
|---|---|---|
| 4.1 | Split `main.py` into `APIRouter` modules: `routes/{health,chat,ops,sessions,workspace,cron,messaging,approvals}.py`. `main.py` keeps only the app factory, middleware and lifespan (target under 500 lines) | No route changes; the existing HTTP tests pass unmodified |
| 4.2 | Split `_chat_completions_impl` (~1,400 lines) into a `ChatTransport` protocol with `AgentLoopTransport`, `AcpTransport`, `RunsTransport`, `SwarmTransport` and `PassthroughTransport`, plus one shared `drain_to_sse(queue)` that replaces the two 50ms-poll loops. Use `asyncio.Queue.get` with a timeout rather than a sleep-poll | One drain loop. Transport choice happens in one function with a table test |
| 4.3 | **agent-loop approvals.** Pass `approval_callback` to `RealAIAgent` and bridge it to the same future-based registry ACP uses (`/v1/approvals/{id}`) | Approval e2e passes on agent-loop |
| 4.4 | **Cancel everywhere.** agent-loop calls the real agent's interrupt flag. ACP calls `conn.cancel(session_id)`. All transports register in one `ActiveRunRegistry` keyed by `(conversation_id, run_id)` (supersedes `hermes_runs._active_runs`, fixes B7 structurally). Client disconnect cancels **unless** the request is marked `background: true`, which keeps today's persist-on-disconnect behavior as an explicit choice | Stop button ends generation within 2s on every transport |
| 4.5 | **Usage.** Forward the adapter's cost/tokens and ACP `usage_update` into a typed `usage` event plus the final chunk, instead of the hard-coded zero at `main.py:4623`. Feed it through `pricing.py` | Usage panel shows non-zero per-turn cost for agent-loop and ACP |
| 4.6 | **ACP resume.** Use `load_session` when the agent advertises it. Otherwise replay condensed history on `new_session` after a reap or crash, rather than sending only the last user message | Test: reap the session mid-conversation → the next turn still has context |
| 4.7 | Deduplicate the GitHub repo tools: one `repo_tools.py` used by both `hermes_adapter.RepoToolProvider` and the legacy `run_agent.AIAgent` | — |
| 4.8 | UI capability honesty: `transport_status` carries the capability matrix row, and the chat header hides or disables Stop and approval affordances the active transport cannot honor | — |

**Defer if:** upstream hermes-agent lands native `/v1/runs` parity first. In that case do 4.1, 4.2 and 4.5 only, and push the others into the Phase 6 doc's "runs default" track.

---

### Phase 5 — Async hygiene and state safety

**Goal:** No request can stall the event loop, and no shared state is written unsafely.
**Estimate:** 1–2 PRs, ~3 days.

| ID | Work | Exit criteria |
|---|---|---|
| 5.1 | Wrap every sync CLI, httpx, urllib and sqlite call reachable from an `async def` in `anyio.to_thread.run_sync` / `_ops_thread`, and switch `hermes_runs` to `httpx.AsyncClient` (G10). Add a debug-mode event-loop lag monitor that logs any stall over 250ms | Lag monitor stays quiet across the pytest HTTP suite |
| 5.2 | Cache `runs_parity_available` / `should_route_via_runs` with a background refresh so they never probe inline on a chat request | — |
| 5.3 | ACP `ensure_session`: take a per-conversation lock and hold the global lock only for dict access (G11) | Two concurrent first turns do not serialize (timing test) |
| 5.4 | Atomic config writes: temp file, `os.replace`, `fcntl` lock, and keep the last 5 `.bak` files (G12). Fail loudly if `ruamel` is missing rather than silently dropping comments | — |
| 5.5 | Bound `_sessions` with an LRU plus TTL, put metrics counters behind a lock or `itertools.count`, and delete the duplicate definitions (G16) | — |
| 5.6 | Consolidate cron (G15): keep the hermes-helper cron and migrate `data/cron_jobs.json` into it once at startup, marking the file migrated | One cron code path |
| 5.7 | `except Exception: pass` audit. Every swallowed exception gets either a `logger.debug(..., exc_info=True)` with a comment explaining why swallowing is safe, or it is removed. Add a ruff rule (`S110`, `BLE001`) scoped to the bridge, with per-line `noqa` for the justified cases | Ruff clean |
| 5.8 | `_reload_agent_mcp` reloads per session or profile, not by tearing down process-wide MCP servers under active runs | — |

---

### Phase 6 — Frontend data layer

**Goal:** Panels become thin views over one query layer with a shared offline story.
**Estimate:** 2 PRs, ~3 days.

| ID | Work | Exit criteria |
|---|---|---|
| 6.1 | Add `src/lib/hermes-queries.ts` with a query-key factory and one `useQuery`/`useMutation` hook per `hermes-api.ts` resource. Keep `hermesFetch` as the query function | — |
| 6.2 | Migrate the ~9 panels (Overview, System, Usage, Memories, ProjectsSwitcher, Skills, MCP, OpsExtras, Chats) off hand-rolled useState/useEffect. Polling uses `refetchInterval` plus `refetchIntervalInBackground: false`, replacing the three ad-hoc intervals | `rg "useEffect\\(.*load\\(" src/components/sidebar/Hermes*` → 0 |
| 6.3 | `<BridgeGate>` component driven by `/api/bridge/readiness` (Phase 3.3). It shows a single consistent "starting / reconnecting / offline → Set up" state and pauses queries (`enabled: ready`) so panels don't each fail on their own | No panel shows a raw "Failed to fetch" while the bridge is restarting |
| 6.4 | `<HermesErrorState error>` renders the §1.4 envelope (code-aware copy and a retry button when `retryable`) | The per-panel `err instanceof Error ? …` expressions are gone |
| 6.5 | Split `hermes-api.ts` (1,791 lines) by domain under `src/lib/hermes-api/`, with types re-exported from the Phase 1 generated contract where they overlap | — |
| 6.6 | Fold in the qa-audit leftovers that touch Hermes chat: `role="alert"`/`aria-live` on the approval banner, and the Virtuoso Footer remount (`ChatArea.tsx:912`) that blocks it | axe clean on the approval flow |

---

### Phase 7 — Tests, CI, and docs

Run continuously alongside the other phases. Listed here so it is not skipped.

| ID | Work |
|---|---|
| 7.1 | Bridge HTTP tests via `TestClient` for the currently untested routes: `/v1/approvals`, `/sessions*`, workspace file PUT (optimistic version), MCP install/uninstall, cron, and the token guard |
| 7.2 | `acp_transport` tests with a fake ACP agent subprocess: `ensure_session`, `request_permission`, `session_update` translation, cancel, and resume |
| 7.3 | A startup smoke test that runs `python main.py` as a subprocess, waits for `/health`, asserts the lifespan-owned tasks are alive, then shuts down cleanly. This catches B1/B2-class bugs |
| 7.4 | CI job `hermes-contract`: regenerate the schemas, diff them, and run the pytest and vitest fixture replays |
| 7.5 | Upstream-compat canary: a nightly job that installs hermes-agent `main`, runs 7.3 plus the fixture replays, and opens an issue when it fails. This gives early warning for the version shims listed in the audit (ACP SDK arg order, `tools.registry`, `hermes_cli.commands`) |
| 7.6 | Docs: fix the stale panel references (§2.3), mark this spec's phases in a status table as they land using the Phase 6 §11 labels, and add an event-contract section to `docs/architecture.html` |

---

## 5. PR sequence

1. `fix/hermes-bridge-correctness`: Phase 0, all of it
2. `feat/hermes-event-contract`: 1.1–1.3, 1.5
3. `feat/hermes-error-envelope`: 1.4 and 6.4
4. `refactor/bridge-client`: 2.1–2.2
5. `refactor/bridge-client-callers`: 2.3–2.5
6. `feat/bridge-supervisor`: 3.1–3.4
7. `fix/hermes-update-pinning`: 3.5
8. `refactor/bridge-routers`: 4.1, no behavior change
9. `refactor/chat-transports`: 4.2
10. `feat/transport-parity`: 4.3–4.6, 4.8
11. `fix/bridge-async-hygiene`: Phase 5
12. `feat/hermes-query-layer`: 6.1–6.3, 6.5
13. `fix/hermes-chat-a11y`: 6.6

Every PR runs `npm run typecheck && npm run lint && npm test` plus `pytest hermes-bridge`. PR 8 must be a pure move so the diff is reviewable with `git diff -M`.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Requiring the token on loopback (2.4) breaks an external script or the mobile path | Escape-hatch env var for one release, plus a startup warning when unauthenticated loopback requests arrive |
| Cancel-on-disconnect (4.4) regresses the "finish in background after tab close" behavior users rely on | Background mode stays and becomes explicit (`background: true`, set by default for the desktop chat); disconnect-cancel applies only when it is off |
| The main.py split causes merge pain with in-flight bridge work | Land PR 8 first in a quiet window, as a mechanical move, with a one-line re-export shim for any old import paths |
| Generated contract drifts during upstream hermes changes | 7.4 and 7.5 CI fail loudly, and unknown events are logged and dropped rather than crashing |
| Respawn loops hide a persistent crash | Capped attempts, then a visible `crashed` state with stderr tail in the UI |

---

## 7. Success metrics

- **0** raw `fetch` calls to the bridge outside `bridge-client.ts`.
- **0** regex-based error classification in the UI.
- Every transport ✓ on approvals, cancel, disconnect, usage and structured errors in the §2.2 matrix.
- `main.py` under 500 lines, and no bridge module over 1,500 lines except the upstream-mirroring `hermes_ops.py`.
- Bridge `kill -9` → chat usable again in under 10s with no user action.
- Hermes upgrade (tag bump) → green CI in one PR, with no hand-edited TS types.

---

## 8. What not to do

- Don't add new Hermes feature surfaces in these PRs. Parity work stays in the Phase 6 doc's track.
- Don't introduce a third bridge manager or a second client "just for" one route.
- Don't replace SSE with WebSockets. The problems are contract and lifecycle, not transport.
- Don't fork hermes-agent further. Push fixes upstream and keep `patches/` to the single runs-parity patch.

---

## 9. Open questions

1. Should `/v1/runs` become the default once Phase 4 gives agent-loop parity, or is Phase 4 the reason to keep agent-loop default indefinitely?
2. Is the legacy bridge `run_agent.AIAgent` fallback still needed, or can Phase 4 delete it and require hermes-agent to be installed?
3. Should the Python↔TS contract live in the repo (generated from Pydantic, as proposed) or be upstreamed into hermes-agent's gateway schema?

---

## 10. Implementation status

| Phase | Status | Notes |
|---|---|---|
| 0 Correctness hotfixes | **Done** | All 9 defects fixed, each with a regression test. PR #52 + #53. |
| 1 Event and error contract | **Done** | 1.1–1.5 landed. Error envelope + regex-free `ChatErrorBanner` + golden fixtures. |
| 2 Single bridge client | **Done** | `BridgeClient` owns every bridge request; loopback now token-gated. PR #56. |
| 3 Lifecycle | **Done** | 3.1–3.4 PR #60 (`shared/bridge-supervisor.ts`, respawn, readiness, rotating log; `/diag` now confirms token ownership instead of disclosing it). 3.5 PR #64 (pinned-tag moves, patch re-apply + rollback, supervised restart) |
| 4 Transport parity and decomposition | **Done** | 4.1 PR #62 (`main.py` 7,030 → 397 lines, `routes/*`). 4.2 PR #66 (`chat_transports/`, one `drain_to_sse`). 4.7 PR #65 (`repo_tools.py`). 4.3/4.4 PR #70, 4.5/4.6/4.8 PR #73. Matrix in §2.2 updated in PR #74 |
| 5 Async hygiene | **Done** | Bridge side PR #67; chat-path leftovers (sync I/O, duplicate `bridge:metrics`, except-audit, ruff exclusions) PR #74 |
| 6 Frontend data layer | **Done** | 6.1–6.4 PR #61 (`hermes-queries.ts`, `<BridgeGate>`, `<HermesErrorState>`). 6.5 PR #63 (`src/lib/hermes-api/`). 6.6 PR #59 |
| 7 Tests, CI, and docs | **Done** | 7.1 + 7.5 PR #68 (62 route tests, nightly canary; 404/validation envelope bugs fixed), canary fix PR #72. 7.2 PR #74 (fake ACP agent). 7.3 PR #62 (startup smoke). 7.4 Phase 1. 7.6 PR #59 |

### Phases 3–7 notes

- **Behavior changes users can see:** agent-loop chat now prompts for dangerous
  commands when `approvals.mode: manual` (runners without a callback — kanban,
  Ralph — still auto-resolve); a new turn on a busy conversation cancels the old
  one; `/cron` returns 503 when hermes cron cannot load (no bridge-local
  fallback); config edits require `ruamel.yaml` and are refused with 409 if the
  file changed mid-edit.
- **Bugs found along the way:** every swarm turn raised `NameError`
  (`_finalize_session`); runs-mode requests the gateway could not take returned
  500 instead of falling back; `server_tool_event` / `fallback_switch` SSE keys
  were crossed; ACP plan updates were dropped (`"plan"` vs `"plan_update"`);
  routing 404s and validation errors bypassed the error envelope.
- **Not verified against a live model:** approvals, Stop, usage/cost and ACP
  resume are covered by fakes and fixtures only; each PR lists manual checks.
- **Open:** #71 — `patches/hermes-api-server-runs-parity.patch` no longer applies
  to hermes-agent `main`; regenerate before the next pin bump.

### Phase 5 outcome

PR #67 (branch `fix/bridge-async-hygiene`); the deferred items below landed in PR #74. Files owned by the concurrent 4.2 (chat
transports) and 4.7 (adapter repo tools / `run_agent.py`) work were not touched;
their share of each item is listed as deferred.

| Item | Status | Notes |
|---|---|---|
| 5.1 Sync I/O off the loop | **Done** (routes) | ops / sessions / workspace / health / providers / messaging / mcp / cron routes wrap CLI, sqlite, urllib and config writes in `_ops_thread`; runs cancel/approve use `httpx.AsyncClient`. `bridge_loop_monitor.py` (`HERMES_BRIDGE_LOOP_LAG_MONITOR=1`) logs stalls > 250ms with the stuck stack; `test_bridge_loop_monitor.py` asserts it is quiet across a slowed route set. Deferred: inline calls on the chat path (chat_impl / acp_chat / chat_transports) |
| 5.2 Routing capability cache | **Done** | `runs_parity_available` / `should_route_via_runs` read cached capabilities with a deduped background refresh; warmed at startup |
| 5.3 ACP per-conversation lock | **Done** | Global lock guards dict access only; timing test |
| 5.4 Atomic config writes | **Done** | `config_io.py`: temp + fsync + `os.replace`, `fcntl` sidecar lock, 5 `.bak` files, ruamel required, load→dump conflict refused with 409 |
| 5.5 Bounded sessions, safe counters | **Done** | `_sessions` LRU + TTL; counters under a lock; main.py duplicates removed. Deferred: the chat path's second `bridge:metrics` publish |
| 5.6 One cron path | **Done** | Bridge-local JSON cron removed; `data/cron_jobs.json` migrated into hermes cron once (deduped, renamed `.migrated` only when complete) |
| 5.7 Swallowed exceptions | **Done** (excl. deferred files) | `hermes-bridge/ruff.toml` gates S110, BLE001, F821; per-file ignores (TODO follow-up) for the chat path (chat_impl / chat_common / acp_chat / routes/chat / chat_transports) and repo_tools / hermes_adapter / run_agent |
| 5.8 Scoped MCP reload | **Done** | hermes `reconcile_mcp_servers_with_config` instead of the wildcard shutdown; other-profile edits never touch process servers |

### Phase 2 outcome

PR #56, stacked on #55. All five items; 2.5 needed no work because item 0.3 had
already removed the fallback it referenced.

| Item | Status | Notes |
|---|---|---|
| 2.1 `bridge-client.ts` | **Done** | Token (unconditional), profile, one readiness budget, 15s default timeout, stream idle timeout, disconnect abort, 10s read cache, error-envelope mapping. 24 tests |
| 2.2 Port `proxyTo` | **Done** | 101 call sites → `bridge.proxy`; `proxyTo`, `fetchWithBridgeReadinessRetry` and the local token helper deleted |
| 2.3 Port the remaining layers | **Done** | hermes.ts −85 duplicated lines; ACP approval forward, startup probe, health probes, room-coordinator, bridge-manager |
| 2.4 Token required on loopback | **Done** | Hatch `HERMES_BRIDGE_ALLOW_LOOPBACK_NOAUTH=1`, logged on first use, loopback-scoped |
| 2.5 Delete the direct-bridge fallback | **Done** | Already removed in Phase 0 item 0.3 |

`hermes-admin.ts` alone went −447 lines; net −219 across 2.1–2.3.

Three deviations, each recorded in the commit bodies:

- **`/diag` stays auth-exempt** alongside `/health`. The spec said "except
  /health", but `/diag` is the Electron supervisor's *ownership* check; gating it
  would make an unauthenticated prober unable to verify the process it launched,
  and the supervisor would then tear the bridge down as unowned. The supervisor now
  also sends the token, so the exemption can go once `/diag` stops being an
  adoption probe.
- **One raw fetch remains outside the client**, in `lib/bridge-manager.ts`, for its
  liveness probe — it runs before the HTTP stack serves, and routing it through the
  client would have it share the readiness cache it populates. Its missing token is
  attached.
- **2.4 leaves the no-token-configured case fully open**, so local dev is
  unaffected.

2.4 is the one behavioural change in Phase 2 that can affect a running desktop
app: a setup relying on loopback being open now gets 401s. The hatch exists for
that, and its first use is logged. It wants a manual smoke test of chat, approvals
and Stop before merge.

### Phase 1 progress

| Item | Status | Notes |
|---|---|---|
| 1.1 All custom SSE events into `bridge_events.py` | **Done** | 9 models + constructors; 33 inline payload literals removed from `main.py`; 26 contract tests |
| 1.2 JSON Schema → TS types + zod codegen | **Done** | `shared/hermes-events.schema.json` + `server/lib/hermes-events.gen.ts`; `npm run gen:hermes-contract` / `check:`; new `hermes-contract` CI job |
| 1.3 `normalizeHermesAgentLoopPayload` as a zod dispatch | **Done** | 110 lines → 38; `unknown` casts in `hermes.ts` 62 → 37; 17 new tests, 7 existing pass unmodified |
| 1.4 Error envelope + regex-free `ChatErrorBanner` | **Done** | Closed 9-code enum generated Python→TS; banner has **0** regexes; suggestions now travel as `details.suggested_models` |
| 1.5 Golden SSE fixtures per transport | **Done** | 4 fixtures, replayed by pytest and vitest; verified a corrupted fixture fails both |

1.2 and 1.3 needed three corrections that only surfaced by testing, all recorded in
their commit bodies: `json-schema-to-zod` does not resolve local `$ref`s (so every
validator silently became `z.any()`); the adapter-owned events would have become
*closed* zod objects and stripped upstream fields; and the generated file embedded
the pydantic version, which would have failed CI against a different pydantic than
the developer's venv.

1.3 carries one deliberate deviation: a known event that *fails* validation is
logged as an error but still forwarded, rather than dropped. Dropping a
`tool_activity` over a type mismatch would make the UI lose tool state with no
visible cause. The spec's drop requirement covers *unknown* events, which are
dropped and logged once per type.

1.1 landed with two deliberate deviations, both recorded in the commit body: the
constructors build plain dicts rather than returning `model_dump()` (the suite runs
with pydantic stubbed, so validation is unavailable under test), and the three
adapter-owned event types are open objects because hermes-agent owns their fields.

Note on the spec's 1.1 exit criterion — `grep -n '"tool_activity"' main.py` only
hits `bridge_events` imports. The key string still appears at the emission site,
because it is the SSE field name inside the delta and has to. What is enforced
instead, on the AST, is that no custom event's *payload* is a dict literal at the
call site. That is the substance of the criterion.


### Phase 0 outcome

Shipped as a stacked pair of PRs:

- **#52** `feat/pre-existing-wip` → `main` — the in-flight work that was uncommitted
  in the tree when this started. **Must merge first:** `main` does not typecheck
  (6 pre-existing errors in `src/hooks/useChat.ts` and `src/test/chat-handoff.test.ts`),
  and this branch fixes all of them. Phase 0 adds no new typecheck errors but cannot
  go green on a red `main`.
- **#53** `fix/hermes-bridge-correctness` → `feat/pre-existing-wip` — the Phase 0 work,
  7 commits, no unrelated changes mixed in.

| Item | Defect | Commit | Regression test |
|---|---|---|---|
| 0.1 | B1 startup handlers never ran | `29b7f8f` | `test_bridge_lifespan.py::LifespanOwnsStartupTests` |
| 0.2 | B2 brain RPC import cycle | `29b7f8f` | `test_bridge_lifespan.py::BrainModuleIdentityTests` |
| 0.3 | B3 duplicate approval route | `e700b97` | `remote-access-gating.test.ts` (5 cases) |
| 0.4 | B4 API key leaked into logs | `da52472` | `test_hermes_adapter_secrets_profile.py::MaskSecretTests` |
| 0.5 | B5 hard-coded machine paths | `29b7f8f` | `test_bridge_lifespan.py::BrainDiscoveryTests` |
| 0.6 | B6 `HERMES_HOME` env mutation | `5fe8177` | `test_hermes_profile_scoping.py::ScopedHermesHomeTests` |
| 0.7 | B7 run-handle cleanup race | `5fe8177` | `test_hermes_profile_scoping.py::ActiveRunRegistryTests` |
| 0.8 | B8 `sys.modules` before `exec_module` | `da52472` | `test_hermes_adapter_secrets_profile.py::RunAgentLoadTests` |
| 0.9 | B9 hard-coded profile config | `da52472` | `test_hermes_adapter_secrets_profile.py::ProfileConfigTests` |
| 0.10 | G13 ungated mutating routes | `98a5f64` | `remote-access-gating.test.ts` (5 cases) |

Suite movement: bridge pytest 714 → 768 passing, vitest 1046 → 1057 passing.
`npm run typecheck` and `npm run lint` (0 errors) clean.

Every B-item was verified by reinstating the original code and confirming the
new test fails, so the tests are not vacuous. The bridge was also booted as a real
process: startup handlers now run (previously silent), brain-mcp absence is a
logged skip, and SIGINT shuts down cleanly with no unretrieved-task warning.

#### Carry-over items for later phases

- **`main` is red on typecheck** (6 errors, fixed by #52). Worth a CI gate so it
  cannot regress again — see 7.4, which currently only covers the contract.
- **The vitest suite has pre-existing load-related flakiness.** Failures surface in
  whichever server-booting test is slowest on a given run, and move between files
  between runs. Phase 0 amplified it by adding app boots to one file and then
  removed that cost (`ee4d1be`), but the underlying sensitivity is not fixed.
- **`hermes-bridge/.venv` python is a shim** that re-execs into the hermes tools
  interpreter with a mutated `sys.path`. Single-file pytest runs intermittently die
  with a bogus `ModuleNotFoundError: No module named 'pytest'`. Full-suite runs are
  reliable; do not trust a red single-file run.
- **Two `mask_secret` implementations** now exist — the new one in
  `hermes_adapter.py` (log lines) and a pre-existing one in `hermes_ops.py` (HTTP
  responses). Different output contracts, so they were left separate rather than
  unified unasked. Worth folding together.
- **`_hermes_agent_dir(hermes_home)` implies a per-profile `hermes-agent` checkout,
  but `sys.path` can only hold one.** If profiles genuinely carry separate
  checkouts, the first one imported wins process-wide. Not in the §2.1 defect list;
  it is a real cross-talk risk that deserves its own investigation.

#### Deviations from the Phase 0 plan

- **0.6 did not use a subprocess.** hermes-agent exposes
  `hermes_constants.set_hermes_home_override` / `reset_hermes_home_override` on a
  `ContextVar`, which `get_hermes_home()` consults ahead of the env var. That gives
  per-thread and per-task isolation in-process, so the subprocess the spec proposed
  was unnecessary. The env mutation survives only as a lock-guarded fallback for a
  hermes-agent too old to expose the API.
- **0.6 also dropped an `importlib.reload`.** Upstream now resolves the checkpoint
  root per call, so the reload was not only unnecessary but was itself a race.
  Consequently `_checkpoint_manager` became a context manager: the override must
  stay in effect while the manager is *used*, not just built.
- **0.1 also fixed a latent shutdown bug** carried over from the old lifespan:
  `asyncio.CancelledError` is a `BaseException`, so the `except Exception` around
  the awaited cancel never caught the cancellation it had just requested.
- **0.1 also moved the bridge metric counters out of the brain startup block.**
  They are bridge state, not brain state; with no brain installed, `start_time`
  stayed `0.0` in `/diag` and in the published `bridge:metrics` payload.
- **0.9 passes `hermes_home` only on the real-adapter path.** The
  `run_agent.AIAgent` fallback has an explicit signature with no `**kwargs`, so
  passing it unconditionally would `TypeError` the fallback. The cron path is
  deliberately untouched: cron jobs carry no profile and that agent's `base_url`
  is always OpenRouter, so the config lookup is unreachable there.
- **0.2 could not use `TestClient`.** This suite deliberately runs with
  fastapi and pydantic stubbed (`test_acp_repo_grounding.py` imports `test_main`
  first), so `main.app` has no router. The lifespan tests drive the async generator
  directly, which tests the startup/shutdown contract more precisely anyway.


