<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard-v:1 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) for structured expertise management.

**At the start of every session**, run:
```bash
mulch prime
```

This injects project-specific conventions, patterns, decisions, and other learnings into your context.
Use `mulch prime --files src/foo.ts` to load only records relevant to specific files.

**Before completing your task**, review your work for insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made — and record them:
```bash
mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Link evidence when available: `--evidence-commit <sha>`, `--evidence-bead <id>`

Run `mulch status` to check domain health and entry counts.
Run `mulch --help` for full usage.
Mulch write commands use file locking and atomic writes — multiple agents can safely record to the same domain concurrently.

### Before You Finish

1. Discover what to record:
   ```bash
   mulch learn
   ```
2. Store insights from this work session:
   ```bash
   mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
   ```
3. Validate and commit:
   ```bash
   mulch sync
   ```
<!-- mulch:end -->

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard-v:1 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd sync` — Sync with git (run before pushing)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->

<!-- canopy:start -->
## Prompt Management (Canopy)
<!-- canopy-onboard-v:1 -->

This project uses [Canopy](https://github.com/jayminwest/canopy) for git-native prompt management.

**At the start of every session**, run:
```
cn prime
```

This injects prompt workflow context: commands, conventions, and common workflows.

**Quick reference:**
- `cn list` — List all prompts
- `cn render <name>` — View rendered prompt (resolves inheritance)
- `cn emit --all` — Render prompts to files
- `cn update <name>` — Update a prompt (creates new version)
- `cn sync` — Stage and commit .canopy/ changes

**Do not manually edit emitted files.** Use `cn update` to modify prompts, then `cn emit` to regenerate.
<!-- canopy:end -->

## reviewer-findings

**File reviewed:** `hermes-bridge/main.py`
**Reviewer:** reviewer
**Date:** 2026-04-06

---

### CRITICAL: No brain_mcp Integration Present

The bridge has **zero brain_mcp API calls**. The following are entirely absent:

- `brain_register` — no session registration
- `brain_set` / `brain_get` — no shared state read/write
- `brain_pulse` — no heartbeat
- `brain_claim` / `brain_release` — no resource locking
- `brain_post` — no channel messaging
- `brain_contract_set` / `brain_contract_get` — no contracts published or consumed
- `brain_dm` — no direct agent messaging

**Implication:** The bridge is a standalone proxy service. It does not coordinate with other agents, does not participate in multi-agent workflows, and cannot be monitored or managed by the brain overseer. The implementor did not add brain_mcp integration.

---

### Code Quality (non-brain)

The bridge code itself is well-structured:

- **Error handling is solid:** `try/except` around adapter import (lines 379-385), `JSONResponse` for upstream failures, graceful SSE heartbeat keepalive, proper `upstream.aclose()` cleanup.
- **Passthrough mode** is cleanly separated (line 372) and handles non-streaming upstream responses (lines 288-297).
- **MiniMax routing** is correct — model prefix check on line 353, direct API with key priority on lines 355-370.
- **Repo mode detection** is thorough — checks both request body tools and headers (lines 323-342).
- **Conversation history slicing** is improved — finds last user message and preserves all prior assistant turns (lines 492-506).
- **SSE stream** is well-formed with role chunk, status chunks, heartbeat comments, and proper `[DONE]` termination.

**Minor observations:**
- `queue.Queue` (sync) used with async code via `asyncio.to_thread` (line 533) works but is unconventional. `asyncio.Queue` would be more idiomatic.
- No request timeout on the FastAPI endpoint itself — relies entirely on upstream `PASSTHROUGH_TIMEOUT_SECONDS` and agent `max_iterations`.

---

### Edge Cases — Non-brain

- **Missing `hermes_adapter`:** Gracefully falls back to `run_agent` (lines 379-385). Logged.
- **Missing GitHub PAT with repo mode:** Warning logged but proceeds (lines 425-426).
- **Empty message list:** Handled — `user_message` becomes `""`, `history` is the full list (lines 504-506).
- **Malformed `custom_tools` / `repo_file_tree`:** Silently ignored with type-check guards (lines 428-441).
- **Upstream 4xx/5xx:** Returns `_passthrough_error_response` with body decoded or raw fallback (lines 283-286).
- **`stream=False` passthrough:** Handled with `aread()` path (lines 288-297).

---

### Multi-Agent Coordination — Assessment

**Not enabled.** The bridge cannot:
- Register as an agent in the brain room
- Read/write shared state for coordination
- Send or receive direct messages between agents
- Publish or consume contracts for inter-agent interfaces
- Participate in supervised multi-agent workflows

If the goal was to allow Claude Code sessions or other agents to call this bridge and have it report back to a central brain, that workflow is unimplemented.

---

### Verdict

| Criterion | Status |
|---|---|
| brain_mcp API usage | **MISSING** — no calls found |
| Edge case handling | Partially met (non-brain edge cases handled) |
| Error handling doesn't break bridge | **PASS** — graceful fallbacks throughout |
|| Enables multi-agent coordination | **FAIL** — standalone service |

---

## architect-findings

**Files analyzed:** `hermes-bridge/main.py`, `hermes-bridge/hermes_adapter.py`
**Architect:** architect
**Date:** 2026-04-06

---

### 1. Where brain_mcp Tools Fit into the Agent Loop

The bridge has a clear three-layer flow:

```
HTTP Request → _run_agent_sync() [thread] → AIAgent.run_conversation()
                                           ↕ callbacks
                           SSE event_stream() [async generator]
```

Each layer has distinct integration points:

**Layer A — Request ingress (main.py chat_completions, ~line 310)**

- `brain_register("hermes-bridge-<instance>")` — call once at first request or on startup. Registers the bridge as a named participant in the brain room. Without this, no other agent can DM it or see it in sessions list.
- `brain_set("bridge:active-request:<chunk_id>", {owner, repo, model, toolsets})` — at request start, publish the active job metadata so overseer or other agents can inspect what's running.

**Layer B — Agent execution (_run_agent_sync, ~line 418)**

- `brain_pulse(status="working", progress="iter-N")` — call every 5-10 tool iterations inside `_run_agent_sync`. The bridge's existing `on_thinking` callback fires on each iteration; wire that to pulse.
- `brain_claim("hermes-bridge:repo:<owner>/<repo>:<path>")` — before `RepoToolProvider` stages a file edit (`_handle_edit_repo_file`, `_handle_create_repo_file`), claim the path. This prevents two concurrent requests on the same repo from overwriting each other's staged changes.
- `brain_release` — after the request completes and `session_cache` is flushed, release all claimed paths.

**Layer C — SSE streaming (event_stream, ~line 520)**

- `brain_post(content="request complete", channel="hermes-bridge")` — after `done_event.set()` and before the final `[DONE]` chunk, post a completion summary. Any listening agent (e.g., a orchestrator that kicked off the request) gets signal without polling.
- `brain_set("bridge:metrics:<chunk_id>", {tokens, api_calls, cost})` — after the agent returns `{api_calls, estimated_cost_usd}`, store metrics in shared state for the room.

---

### 2. Shared State the Bridge Could Pool Across Sessions

The bridge currently maintains per-request isolation. The following state is session-local and would benefit from pooling via `brain_set/get`:

**a) Repo file content cache**

`RepoToolProvider.session_cache` (hermes_adapter.py line 178) caches file reads within one request. Across requests to the same repo, the same files are re-fetched from GitHub on every call. A pooled cache:

```
brain_set("repo-cache:<owner>/<repo>:<path>", content, ttl=300)
```

with `max_age=300` seconds would eliminate redundant GitHub API calls for hot files (e.g., `package.json`, `requirements.txt`).

**b) Repo file tree**

`repo_file_tree` arrives in every request body as `model_extra.repo_file_tree`. This is a list of hundreds of file paths that CloudChat server already computed. A short TTL cache (`brain_set("repo-tree:<owner>/<repo>", paths, ttl=600)`) means the server can skip sending it on subsequent requests within the window.

**c) Edit staging buffers**

The bridge stages file edits in `session_cache` but never commits them — `hermes_adapter.py` emits `repo_file_edit` events to CloudChat for actual GitHub API commits. A pooled staging area:

```
brain_set("staging:<chunk_id>", session_cache_snapshot)
```

would allow a follow-up request (e.g., a review pass) to see what the previous request staged without re-reading the files.

**d) Per-repo edit locks**

The reviewer flagged the risk of concurrent edits to the same repo. A `brain_claim` on `"repo:<owner>/<repo>:edit"` — a single lock per repo, not per file — with a TTL, would serialize edit-mode requests per repo. Implementors use `brain_claim` before entering edit workflow, release on commit or timeout.

**e) Bridge health and load metrics**

```
brain_set("bridge:health", {
    active_requests: N,
    avg_iterations: float,
    error_rate: float,
    uptime: seconds
})
```

updated on each request completion. The brain overseer can read this without polling HTTP endpoints.

---

### 3. Swarm Pattern: Architect → Implementor → Reviewer

The natural multi-agent role pattern for this bridge is a three-phase pipeline triggered when a user sends a code change request:

**Phase 1 — Architect (spawned by bridge on first user message)**

The bridge calls `brain_wake` to spawn an Architect session:

```
brain_wake(
    name="architect",
    task="Analyze this user request and produce an implementation plan. "
         "Break the work into files to edit and in what order. "
         "Post the plan with brain_post, then /exit."
)
```

Architect reads the repo via `read_repo_file`, plans the changes, posts the plan to the room, and exits.

**Phase 2 — Implementor (spawned by Architect or by bridge after Architect posts)**

```
brain_wake(
    name="implementor",
    task="Apply the changes described in the architect's plan. "
         "Use brain_claim on each file before editing. "
         "After all edits are staged, brain_post a summary and /exit."
)
```

The Implementor is given the architect's plan (via `brain_get("plan:<request_id>")` or Architect DMs it directly). This is where the current `AIAgent.run_conversation()` loop would live — replacing the synchronous single-agent loop with an autonomous sub-agent that has brain context.

**Phase 3 — Reviewer (spawned by Implementor after staging)**

```
brain_wake(
    name="reviewer",
    task="Review the staged file changes for correctness, style, and security. "
         "brain_claim any files you fix. "
         "Post review findings with brain_post and /exit."
)
```

Reviewer reads the staged files from `brain_get("staging:<request_id>")`, inspects them, and posts findings.

**Why this improves on the current loop**

The current bridge runs one monolithic `AIAgent` that does analysis + implementation + review in a single iteration loop. Problems with that:

- If the model changes its mind mid-way, earlier tool calls are already committed
- No structural checkpoints — nothing says "plan verified, now implement"
- No parallelization — reads happen sequentially before writes

The swarm pattern separates concerns and adds two human-review-like gates (Architect plan review, Reviewer feedback) that catch mistakes before they're committed to the session cache.

**Bridge responsibilities in the swarm**

The bridge becomes the coordinator rather than the executor:

```
on_request(body):
    brain_register("hermes-bridge")
    brain_set("request:<id>", {body, status: "received"})
    brain_wake("architect", task=...)
    # Architect posts plan → Implementor spawned
    # Implementor posts completion → Reviewer spawned
    # Reviewer posts verdict → bridge responds to user
```

The bridge's `on_thinking`/`on_tool_start` callbacks still stream events to the SSE client, but now they're forwarding events from whichever sub-agent is currently active.

### Implementation: swarm_pattern.py

The swarm pattern is implemented in `hermes-bridge/swarm_pattern.py`:

```python
from swarm_pattern import run_swarm

result = await run_swarm(
    user_message="Fix the auth bug in main.py",
    conversation_history=history,
    enabled_toolsets=["web", "browser"],
    repo_mode=True,
    repo_owner="DevvGwardo",
    repo_name="cloud-chat-hub",
    github_pat=pat,
)
# result = {success, verdict, review_notes, staged_files, plan, elapsed_ms}
```

**SwarmCoordinator** manages the pipeline:

| Method | Phase | Brain keys read/written |
|---|---|---|
| `run_phase_architect()` | Architect | `request:<id>:ctx` (write), `plan:<id>` (write by agent, read by coordinator) |
| `run_phase_implementor()` | Implementor | `request:<id>:phase`, `request:<id>:staging_keys`, `staging:<id>:<filepath>` |
| `run_phase_reviewer()` | Reviewer | `request:<id>:verdict` (written by agent) |
| `_finish()` | done | `request:<id>:status` (completed/failed) |

**Brain state layout:**

```
request:<id>:ctx        — request metadata (JSON)
request:<id>:phase      — current phase: architect | implementor | reviewer | done
request:<id>:status     — running | completed | failed
plan:<id>               — Architect's plan (JSON steps array)
staging:<id>:<filepath>    — Implementor's staged content per file
request:<id>:staging_keys — array of all staging keys for polling
request:<id>:verdict    — Reviewer's verdict JSON
```

**Execution modes:**

- **swarm mode** (`x-hermes-execution-mode: swarm`) — full 3-phase pipeline; bridge spawns Architect, polls for plan, spawns Implementor, polls for staging, spawns Reviewer, returns verdict
- **agent-loop mode** (default) — existing single-agent loop

The pipeline uses `brain_wake` to spawn each phase as an independent agent session. Phase transitions are driven by brain state polls with timeouts (Architect: 120s, Implementor: 240s, Reviewer: 120s). If any phase times out, the pipeline fails with `verdict=changes_requested`.

---

### Contract Surface for brain_mcp Integration

Publish these contracts so sub-agents know what the bridge provides:

```python
brain_contract_set(entries=[{
    "module": "hermes-bridge/main.py",
    "name": "on_request_received",
    "kind": "provides",
    "signature": '{"params": ["request_id: str", "body: ChatCompletionRequest"], "returns": "void"}'
}, {
    "module": "hermes-bridge/hermes_adapter.py",
    "name": "stage_file_edit",
    "kind": "provides",
    "signature": '{"params": ["path: str", "content: str", "description: str"], "returns": "str"}'
}, {
    "module": "hermes-bridge",
    "name": "request_metrics",
    "kind": "expects",
    "signature": '{"params": ["chunk_id: str"], "returns": "dict"}'
}])
```

---

### Priority Ordering

1. **Highest ROI:** `brain_pulse` in `_run_agent_sync` + `brain_register` at startup — enables overseer monitoring with minimal code change
2. **Second:** `brain_claim`/`brain_release` around `RepoToolProvider` edit handlers — prevents concurrent-edit corruption
3. **Third:** pooled `repo-file-cache` and `repo-tree` via `brain_set/get` — reduces GitHub API calls measurably
4. **Fourth:** full Architect→Implementor→Reviewer swarm — highest complexity, highest reward


