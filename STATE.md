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
2026-09-21 · Full-repo audit (typecheck/lint/tests green: 933 JS tests, 710 Python tests pass; 8 lint warnings, 25 npm-audit vulns incl. 2 high, many deps major-outdated). Top verified findings: (1) bridge blocks event loop with subprocess.run in async endpoints (kills SSE heartbeats bridge-wide); (2) bridge CORS `*` + loopback token exemption = any webpage can call privileged endpoints; (3) Express `sendJson` lacks headersSent guard → write-after-end crash on mid-stream proxy failures; (4) team-agent child stdout never consumed → 64KB pipe deadlock; (5) legacy AcpApprovalBanner still maps session/always→allow_session/allow_always (same bug class as last week's clamp, client-side); (6) single global pendingAcpApproval clobbered by concurrent panels. Full prioritized list delivered in chat 2026-09-21.
