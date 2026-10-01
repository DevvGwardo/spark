# Gates: flash harness port + Sign in with Nub

Scope: bring the flash harness's guardrails into Spark's own agent loop, fix the
OpenAI-compatible wire API, and let people with a nub agent (maiavm.com) sign in
with it, use it as their model, and reach their cloud agent from Spark and Hermes.
Depends on hermes-deploy `feat/nubby-cli` (POST /api/nub/cli/key) being deployed.

- [x] H1: Tool-call argument repair (nulls, string-encoded arrays/objects,
      trailing commas, truncated streams) and near-miss tool names are repaired
      through the AI SDK `repairToolCall` hook.
  CHECK: npx vitest run server/__tests__/harness-tool-args.test.ts server/__tests__/harness-agent-turn.test.ts 2>&1 | grep -E "Tests +[0-9]+ passed"
  EXPECT: /Tests  19 passed/
  EVIDENCE: Tests  19 passed (19)

- [x] H2: Turn guard: stuck nudges between steps (3× identical call, or the same
      command failing twice with the same output), one verify-before-done nudge
      after unverified edits, one zero-edit watchdog nudge on change requests,
      and a nudge for tool calls written as text. Extra passes are capped at 2
      and share one assistant message.
  CHECK: npx vitest run server/__tests__/harness-turn-guard.test.ts server/__tests__/chat-harness-continuation.test.ts 2>&1 | grep -E "Tests +[0-9]+ passed"
  EXPECT: /Tests  13 passed/
  EVIDENCE: Tests  13 passed (13)

- [x] H3: OpenAI-compatible providers use Chat Completions; only `openai`
      keeps the Responses API (`openai(model)` defaulted to /responses, which
      gateways and the Hermes bridge don't serve).
  CHECK: npx vitest run server/__tests__/provider-config.test.ts -t "Chat Completions" 2>&1 | grep -E "Tests +[0-9]+ passed"
  EXPECT: /1 passed/
  EVIDENCE: Tests  1 passed | 18 skipped (19)

- [x] H4: run_command keeps the head and the tail of long output, so trailing
      errors and test summaries survive truncation.
  CHECK: npx vitest run server/__tests__/local-tools-output.test.ts 2>&1 | grep -E "Tests +[0-9]+ passed"
  EXPECT: /Tests  1 passed/
  EVIDENCE: Tests  1 passed (1)

- [x] N1: Sign in with Nub: nonce-bound device code approved in Telegram, key
      minted with client "spark", desktop session kept server-side (0600),
      status / key refresh / logout (revokes on maiavm), single-use codes.
  CHECK: npx vitest run server/__tests__/nub-routes.test.ts 2>&1 | grep -E "Tests +[0-9]+ passed"
  EXPECT: /Tests  4 passed/
  EVIDENCE: Tests  4 passed (4)

- [x] N2: The nub agent is reachable from both loops: `nub_agent_ask` in
      Spark's tool loop when linked, and a bearer-protected MCP endpoint that
      the bridge registers as Hermes's `nub` MCP server (only ever editing the
      entry Spark owns; loopback URLs only).
  CHECK: cd hermes-bridge && .venv/bin/python -m pytest -q test_nub_mcp_route.py test_bridge_route_table.py 2>&1 | tail -1
  EXPECT: /7 passed/
  EVIDENCE: 7 passed in 1.22s

- [x] N3: Nub provider and "Sign in with Nub" UI (stores the key like any
      provider key; refreshes a missing key; sign-out can't re-mint).
  CHECK: npx vitest run src/test/nub-sign-in.test.tsx 2>&1 | grep -E "Tests +[0-9]+ passed"
  EXPECT: /Tests  3 passed/
  EVIDENCE: Tests  3 passed (3)

- [x] N4: Live server smoke (no maiavm side effects): status unlinked, MCP 401
      without the bearer, 405 on GET, unknown code not_found, ask explains it
      isn't linked.
  EVIDENCE: {"linked":false} · 401 · 405 · {"status":"not_found"} · {"error":"Nub is not linked. Sign in to Nub in Spark settings first."}

- [ ] G1: Whole suites, lint and typecheck after merging the UI pass.
  CHECK: npm test 2>&1 | grep -E "Tests +[0-9]+ passed" | tail -1; npm run lint 2>&1 | tail -1; npm run typecheck 2>&1 | tail -1
  EXPECT: all green, zero lint warnings
  EVIDENCE: (filled in after the merge)
