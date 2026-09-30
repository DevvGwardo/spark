# Gates: Codex-style chat + composer simplification

Scope: Simplify the chat surface and composer toward the Codex app's minimal
treatment — fewer chrome, quieter tool rows, calmer welcome — with zero
behavior regressions (send, stop, queue, voice, plan/loop/goals, model pick,
context refs all still work).

- [x] G1: Composer chrome reduced — heavy hardcoded dark box (#222222 + #3F3F3F
      border) replaced with a theme surface (bg-card + ring-border).
  CHECK: node -e "const s=require('fs').readFileSync('src/components/chat/ChatInput.tsx','utf8'); console.log(s.includes('border border-[#3F3F3F] bg-[#222222]') ? 'old-box-present' : 'old-box-removed')"
  EXPECT: old-box-removed
  EVIDENCE: old-box-removed

- [x] G2: Composer toolbar decluttered — Loop / Goals collapsed into one
      overflow menu (SlidersHorizontal trigger, role=menu); Plan state lives
      in the leader status dot + Plan Mode banner (ChatArea).
  CHECK: node -e "const s=require('fs').readFileSync('src/components/chat/ChatInput.tsx','utf8'); console.log([s.includes('<SlidersHorizontal'), s.includes('role=\"menu\"'), s.includes('Loop until goal met'), s.includes('>Standing goals<')].every(Boolean) ? 'menu-complete' : 'menu-incomplete')"
  EXPECT: menu-complete
  EVIDENCE: menu-complete

- [x] G3: Tool invocation rows quieted — amber card styling replaced with a
      neutral single-line treatment (Codex-style), still expandable.
  CHECK: node -e "const s=require('fs').readFileSync('src/components/chat/MessageBubble.tsx','utf8'); console.log(s.includes('border-amber-500/20 bg-amber-500/5') ? 'amber-present' : 'amber-gone')"
  EXPECT: amber-gone
  EVIDENCE: amber-gone

- [x] G4: User message chip keeps its subtle elevation (no boxed bubble) —
      .chat-user-chip still referenced by MessageBubble.
  CHECK: grep -c "chat-user-chip" src/components/chat/MessageBubble.tsx
  EXPECT: 1
  EVIDENCE: 1

- [x] G5: Welcome screen calmed — hero glow/float removed or reduced, chips
      lose per-tile borders in favor of flat hover rows.
  CHECK: node -e "const s=require('fs').readFileSync('src/components/chat/WelcomeScreen.tsx','utf8'); console.log(/blur-2xl/.test(s)? 'glow':'clean', /repeat: Infinity/.test(s)?'floating':'static')"
  EXPECT: clean static
  EVIDENCE: clean static

- [x] G6: No behavior regressions — existing unit suite passes unchanged.
  CHECK: npm test 2>&1 | grep -E "Tests +[0-9]+ passed" | tail -1
  EXPECT: /Tests  [0-9]+ passed/
  EVIDENCE: Tests  1165 passed | 27 skipped (1192)

- [x] G7: Bridge suite untouched and green (no Python changes this slice).
  CHECK: cd hermes-bridge && .venv/bin/python -m pytest -q 2>&1 | tail -1
  EXPECT: /[0-9]+ passed/
  EVIDENCE: 679 passed, 5 skipped, 1 warning, 51 subtests passed in 32.23s

- [x] G8: Lint and typecheck stay at zero warnings.
  CHECK: npm run lint 2>&1 | tail -2 && npm run typecheck 2>&1 | tail -2 && echo GATES-LINT-TYPECHECK-OK
  EXPECT: GATES-LINT-TYPECHECK-OK
  EVIDENCE: > tsc -p tsconfig.app.json --noEmit && tsc -p tsconfig.electron.json --noEmit && tsc -p tsconfig.node.json --noEmit | GATES-LINT-TYPECHECK-OK

- [x] G9: Visual check of composer + chat rendering (headless capture) confirms
      clean layout: options menu renders with all three rows; composer surface
      is a subtle ring, not a heavy box; welcome chips are flat rows.
  EVIDENCE: /tmp/spark-options-menu.png (menu open, Plan/Loop/Goals rows render clean, no overlap); /tmp/spark-composer-typed.png (composer = light surface + faint ring, no heavy dark box); /tmp/spark-composer-plan.png (toolbar row: plus, Agent model picker, Effort, options icon with status dot, mic, orange send — no overlap); /tmp/spark-welcome.png (hero without glow halo, flat suggestion rows). Headless Chromium against `npm run dev` :8080, zero page errors.
