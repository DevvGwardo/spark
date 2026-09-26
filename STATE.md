# Project state · spark

## Verified facts
- Live :3001 (Electron Express) and :3002 (hermes-bridge python 52040) were healthy on 2026-09-20: `/health`, `/api/hermes/workspace/commands`, `/goals`, `/providers` all 200. The console 502s on those routes are the Express proxy failing when the bridge is down/starting, not a bug in the command/approval UI itself.
- `/api/hermes/update/status` is implemented in `server/routes/hermes-update.ts` and currently 200s. A 500 there is `git fetch`/`rev-list` throwing in `~/.hermes/hermes-agent` (timeout, lock, missing repo).
- Chat error `Upstream provider stopped sending data (activity timeout). provider: hermes` is emitted by `server/direct-sse-proxy.ts` after `STREAM_ACTIVITY_TIMEOUT_MS` (30s) of zero bytes from the bridge.
- ACP SSE keepalives in `hermes-bridge/main.py` were 60s of silence (`HEARTBEAT_INTERVAL = 60  # seconds`). File writes and `request_permission` waits emit no tokens, so the 30s proxy timeout killed the stream before the user could approve. Agent-loop keepalives were already ~3s (60 ticks × 50ms).
- ACP approval option ids (`allow_once` / `allow_session` / `deny`) match hermes-agent's ACP adapter. `POST /api/hermes/approvals/:id` already forwards `acp-*` ids to the bridge.

## General rules
- ACP SSE heartbeat interval must stay well under the Express SSE activity timeout (30s). Default is now 10s (`ACP_SSE_HEARTBEAT_SECONDS` / `HERMES_ACP_SSE_HEARTBEAT_SECONDS`).
- SSE comment heartbeats (`: heartbeat`) count as activity for `reader.read()` even though clients ignore them.

## Open failures
- The running Electron process must be fully quit and relaunched to pick up: ACP 10s heartbeat, 127.0.0.1 bridge URL, 30s admin proxy retry, and startBridge-before-window.

## Lessons learned
- A keepalive “fix” that switched ACP from tick-based (~3s) to wall-clock 60s exceeded the 30s proxy idle window and looked like “file write / approval is broken.”

## Last session
2026-09-24 · Fixed UI loop stalling and ACP stream stealing:
- Updated `stalledOnRepoRead` and pseudo tool parsing to recognize standard ACP file tools (`read_file`, `search_files`, `write_to_file`, `replace_file_content`). This prevents the chat loop from stalling mid-analysis or dropping implicit edit continuations when operating via MCP.
- Fixed "stream stealing on concurrent prompts": `_AcpHandle` now uses an `asyncio.Lock` (`turn_lock`) to serialize concurrent `prompt()` calls against the same session, preventing mid-stream emit reassignment.
- Fixed "plan mode dropped in loop/swarm": `ensure_session` now compares `handle.plan_mode` against the requested `plan_mode` and tears down/respawns the session if it changed, ensuring mutating tools are actually stripped during the loop instead of being retained from the previous turn.
- Fixed `DESTRUCTIVE_HERMES_OPS gaps`: Replaced exact-match string paths with a prefix matcher to properly protect mutating `/workspace`, `/skills`, `/mcp-servers` routes.
- Fixed "auto-approve one-way latch": `approvalPolicyStore.setAutoApprove` now accepts and stores `false`, allowing the latch to be cleared if disabled.
- Addressed `npm audit` vulnerabilities: Ran `npm audit fix` to clear non-breaking prototype pollution and DoS vulns.

Medium-tier audit findings remaining: only breaking-change `npm audit` vulns (electron, vite, react-router, ai-sdk) remain.
