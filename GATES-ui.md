# Gates: UI/UX pass (fonts, accent, setup wizard, settings, motion/a11y)

Scope: Bring the shell in line with the AGENTS.md Design Context (dark-first,
dense, Geist UI / Inter body / Geist Mono code, motion under 200ms, WCAG AA,
honors prefers-reduced-motion) with zero behavior regressions. Branch
`feat/ui-pass`, base `35ca3ec`.

- [x] G1: Fonts load locally. The Google Fonts `<link>` is gone from index.html,
      `@fontsource-variable/inter` is imported (body default 'inter' setting),
      Geist Mono references use the family name the installed package
      registers ('Geist Mono Variable'), and the 0-use `--v4-*` tokens are
      removed. The 'mono' setting uses Geist Mono; 'serif' falls back to the
      system serif (Source Serif isn't installed).
  CHECK: node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8'),m=fs.readFileSync('src/main.tsx','utf8'),c=fs.readFileSync('src/index.css','utf8');console.log(/fonts\.(googleapis|gstatic)/.test(h)?'remote-fonts':'local-fonts', m.includes(\"import '@fontsource-variable/inter';\")?'inter-imported':'inter-missing', c.includes('--v4-')?'v4-present':'v4-removed')"
  EXPECT: local-fonts inter-imported v4-removed
  EVIDENCE: local-fonts inter-imported v4-removed

- [x] G2: No hardcoded orange accents remain in components. All `#FF8F3F` /
      `#FF8400` classes and inline chart colors use the primary token, so the
      user accent (useTheme writes `--primary`) applies everywhere. The default
      `--primary` is 31 100% 50% (= #FF8400), so the default theme looks the
      same. `src/lib/themes.ts` keeps the default theme's preview swatch on
      purpose.
  CHECK: grep -rniE "#ff8f3f|#ff8400" src | grep -v "\.test\." | grep -v "src/lib/themes.ts" | wc -l | tr -d ' '
  EXPECT: 0
  EVIDENCE: 0

- [x] G3: Setup wizard: Skip and "Stored locally" use muted-foreground (AA). The
      key-help URL is a real link opened with openExternalUrl. The show/hide key
      toggles have aria-label and aria-pressed. Continue on step 0 is disabled
      with a spinner and aria-busy while the bridge is detected or started. The
      purple gradient and glow on the Hermes card are gone. The finish ring
      animation no longer runs 0.9s.
  CHECK: node -e "const s=require('fs').readFileSync('src/components/settings/SetupWizard.tsx','utf8');console.log([!/text-\[#(444|555)\]/.test(s),s.includes('openExternalUrl(href)'),s.includes(\"aria-label={showKey ? 'Hide API key' : 'Show API key'}\"),s.includes('aria-pressed={showKey}'),s.includes('aria-busy={continuingFromProvider}'),!/#8B5CF6|#6D28D9|rgba\(139,92,246/.test(s),!/duration: 0\.9/.test(s)].every(Boolean)?'wizard-ok':'wizard-incomplete')"
  EXPECT: wizard-ok
  EVIDENCE: wizard-ok

- [x] G4: Settings: ToggleRow is a `role="switch"` with `aria-checked` and a
      check mark in the thumb when on (a cue that doesn't rely on color). The
      dead "+ Add provider" button is removed. The Knowledge tab, which showed
      fabricated data, is hidden, and a deep link to it falls back to
      Providers.
  CHECK: node -e "const s=require('fs').readFileSync('src/components/settings/SettingsModal.tsx','utf8');console.log([s.includes('role=\"switch\"'),s.includes('aria-checked={enabled}'),!s.includes('+ Add provider'),!s.includes(\"label: 'Knowledge'\"),!s.includes('KNOWLEDGE_BASES')].every(Boolean)?'settings-ok':'settings-incomplete')"
  EXPECT: settings-ok
  EVIDENCE: settings-ok

- [x] G5: Motion and a11y: the app root is wrapped in
      `<MotionConfig reducedMotion="user">`. There's a global token-based
      focus-visible outline that skips elements with their own focus styles.
      EASE_OUT is 0.18s. TerminalPanel's tab close is a labelled `<button>`.
  CHECK: node -e "const fs=require('fs');const m=fs.readFileSync('src/main.tsx','utf8'),c=fs.readFileSync('src/index.css','utf8'),p=fs.readFileSync('src/components/onboarding/motion-presets.ts','utf8'),t=fs.readFileSync('src/components/terminal/TerminalPanel.tsx','utf8');console.log([m.includes('<MotionConfig reducedMotion=\"user\">'),/:focus-visible:not\(\[class\*=\"focus-visible:\"\]\)/.test(c),p.includes('duration: 0.18'),t.includes('aria-label={\`Close \${tab.label}\`}')].every(Boolean)?'motion-a11y-ok':'motion-a11y-incomplete')"
  EXPECT: motion-a11y-ok
  EVIDENCE: motion-a11y-ok

- [x] G6: Every animate-ping and animate-pulse use respects reduced motion
      (it has `motion-reduce:animate-none` or is already `motion-safe:`).
  CHECK: grep -rnE "animate-(ping|pulse)" src | grep -v "\.test\." | grep -vE "motion-reduce:animate-none|motion-safe:animate-pulse|churning" | wc -l | tr -d ' '
  EXPECT: 0
  EVIDENCE: 0

- [x] G7: No transition over 200ms remains (Tailwind duration-300/500/700/1000
      or framer `duration: 0.3+`).
  CHECK: grep -rnE "duration-(300|500|700|1000)|duration: 0\.[3-9]" src | grep -v "\.test\." | wc -l | tr -d ' '
  EXPECT: 0
  EVIDENCE: 0

- [x] G8: New focused component tests pass: ToggleRow switch semantics, the
      hidden Knowledge tab, the wizard key toggle aria and key-help link, and
      the Continue busy state.
  CHECK: npx vitest run src/test/settings-toggle-row.test.tsx src/test/setup-wizard-a11y.test.tsx 2>&1 | grep -E "Tests +[0-9]+ passed" | tail -1
  EXPECT: /Tests  4 passed/
  EVIDENCE: Tests  4 passed (4)

- [x] G9: Full unit suite green. The baseline was 1250 + 19 (harness) = 1269;
      the 4 new tests bring it to 1273.
  CHECK: npx vitest run 2>&1 | grep -E "Tests +[0-9]+ passed" | tail -1
  EXPECT: /Tests  1273 passed/
  EVIDENCE: Tests  1273 passed | 27 skipped (1300)

- [x] G10: Typecheck is clean and lint has 0 errors. Lint warnings match the
      base commit exactly (128, all `no-explicit-any` and similar in files this
      branch does not touch: electron/, server/, ChatPanel, useChat, ...). This
      branch adds none.
  CHECK: npm run typecheck >/dev/null 2>&1 && echo TYPECHECK-OK; npm run lint 2>&1 | grep problems
  EXPECT: TYPECHECK-OK and "0 errors, 128 warnings" (same as `git archive 35ca3ec` + eslint)
  EVIDENCE: TYPECHECK-OK | ✖ 128 problems (0 errors, 128 warnings) (base 35ca3ec: ✖ 128 problems (0 errors, 128 warnings))

- [x] G11: Visual check. Headless Chromium at 1440x900 against `npx vite --port 8090`,
      dark and light (theme seeded through the app's persisted `cloudchat-settings`).
      The setup wizard renders the calm Hermes card (primary-tinted border, no
      purple glow), an AA Skip with an inset focus ring, a linked key URL and a
      labelled eye toggle. The light-mode wizard has proper light surfaces (no
      dark boxes). Settings show switches with a check-mark thumb and no
      Knowledge tab. The workbench composer is unchanged. The only page errors
      come from API fetches returning the SPA HTML because no backend runs on
      :3001; they're environmental.
  EVIDENCE: /private/tmp/claude-501/-Volumes-T7-Shield-mac-offload-Projects-flash-codex/85f482f3-5906-4495-a1bf-af31a87267de/scratchpad/spark-ui/{setup,setup-other,workbench,settings-general,settings-providers}-{dark,light}.png

---

# Gates: UI/UX pass 2 (command palette, sidebar header, GitHub views, overlay errors)

Scope: The surfaces pass 1 didn't reach. Removes UI that looked interactive or
authoritative without being wired up. Branch `feat/nub-harness`, base `f3cb961`.

- [x] G12: The command palette (⌘K) is a styled cmdk dialog wired to real actions,
      not "coming soon" toasts: new thread, repo issues, both terminals, sidebar,
      theme, remote access, recent and pinned threads, every Hermes sidebar
      section, and settings sections. It ranks results with a strict
      prefix/word/substring filter (`src/lib/palette-filter.ts`) instead of
      cmdk's subsequence scorer, which matched "set" against nearly every row.
  CHECK: node -e "const s=require('fs').readFileSync('src/components/overlay/CommandPalette.tsx','utf8');console.log([!s.includes('coming soon'),s.includes('<Command.Dialog'),s.includes('filter={paletteFilter}'),s.includes('openConversation(c.id)'),s.includes('setSettingsOpen(true, id)')].every(Boolean)?'palette-ok':'palette-incomplete')"
  EXPECT: palette-ok
  EVIDENCE: palette-ok

- [x] G13: The sidebar header's icon-only buttons are square (`w-9 shrink-0`).
      Before this they had a height but no width and collapsed to the icon. One
      definition plus three uses.
  CHECK: grep -c 'TOOLBAR_ICON_BUTTON' src/components/sidebar/ChatSidebar.tsx
  EXPECT: 4
  EVIDENCE: 4

- [x] G14: The GitHub views use theme tokens. CreatePRModal has no hex/rgba
      literals left, and RepoIssueBrowser keeps only its avatar hash palette.
      Light mode, the user accent and AA text contrast all apply.
  CHECK: echo "$(grep -cE '#[0-9A-Fa-f]{6}|rgba\(' src/components/github/CreatePRModal.tsx) $(grep -nE '#[0-9A-Fa-f]{6}' src/components/github/RepoIssueBrowser.tsx | grep -v AVATAR_COLORS | wc -l | tr -d ' ')"
  EXPECT: 0 0
  EVIDENCE: 0 0

- [x] G15: The fake chrome is gone. Issue browser: bell (no handler), "H"
      avatar, dead quick-search box (its state was never read), decorative
      composer icons. PR form: the hardcoded "No conflicts" chip, the B/I/code/link
      spans, and the reviewers/labels fields (the server has no support for
      them). PR stats now show real line deltas (`getChangeLineDelta`) instead of
      file counts dressed up as `+N −M`.
  CHECK: grep -cE 'Bell\b|cmdSearchQuery|No conflicts|Add reviewers|Add labels|<Bold|<AtSign|>H</div>' src/components/github/RepoIssueBrowser.tsx src/components/github/CreatePRModal.tsx | awk -F: '{s+=$2} END {print s}'
  EXPECT: 0
  EVIDENCE: 0

- [x] G16: The error boundaries around AppLayout overlays (setup wizard,
      settings, issue browser, and the PR modal, which had no boundary at all)
      render a fixed `alertdialog` with Close/Escape (dismisses the overlay and
      recovers) and Reload. Before, a crash rendered in document flow and pushed
      the whole shell down about 200px.
  CHECK: grep -c 'ErrorBoundary overlay' src/components/layout/AppLayout.tsx
  EXPECT: 4
  EVIDENCE: 4

- [x] G17: GitHub state hues have per-theme `--gh-{open,blue,indigo,purple}`
      tokens that meet AA as text. Light vs white: 5.07 / 5.20 / 6.18 / 5.67.
      Dark vs --background: 9.06 / 6.90 / 5.91 / 6.30. The old literals were
      1.91 (green on white) and about 3.9 (blue/indigo on dark). Status text in
      the PR modal pairs a 700/800 light shade with its original dark shade.
  CHECK: grep -cE -- '--gh-(open|blue|indigo|purple):' src/index.css
  EXPECT: 8
  EVIDENCE: 8

- [x] G18: The focused tests pass: palette actions/filter/threads/provider
      gating (6), overlay error boundary (5), and the PR modal (12, including
      the new real-deltas/no-placeholders test).
  CHECK: npx vitest run src/test/command-palette.test.tsx src/test/error-boundary-overlay.test.tsx src/test/create-pr-modal.test.tsx 2>&1 | grep -E "Tests +[0-9]+ passed" | tail -1
  EXPECT: /Tests  23 passed/
  EVIDENCE: Tests  23 passed (23)

- [x] G19: The full unit suite is green: 1304 at base plus 6 new = 1310.
  CHECK: npx vitest run 2>&1 | grep -E "Tests +[0-9]+ passed" | tail -1
  EXPECT: /Tests  1310 passed/
  EVIDENCE: Tests  1310 passed | 27 skipped (1337)

- [x] G20: Typecheck is clean. Lint has 0 errors and matches the base warning
      count (128). This pass adds none.
  CHECK: npm run typecheck >/dev/null 2>&1 && echo TYPECHECK-OK; npm run lint 2>&1 | grep problems
  EXPECT: TYPECHECK-OK and "0 errors, 128 warnings"
  EVIDENCE: TYPECHECK-OK | ✖ 128 problems (0 errors, 128 warnings)

- [x] G21: Visual check. Headless Chromium at 1440x900, dark and light, against
      `npx vite --port 8090` with the github-integration endpoint mocked
      through Playwright routes. The palette opens centered with a visible
      selection. The issue browser has light surfaces, the accent, a readable
      Open badge and no dead chrome. The PR modal (create, checks run, review)
      shows real deltas, no placeholders, and readable warning/failure text in
      light mode. The PR modal was mounted through a throwaway harness page that
      was deleted afterwards.
      Not run: `npm run test:e2e`. It boots the embedded server, whose kanban
      runner spawns agents; that's out of scope for this pass. The only e2e
      touchpoints (⌘K and `[aria-label="Browse repo issues"]` in
      screenshots.spec.ts) are unchanged.
  EVIDENCE: /private/tmp/claude-501/-Users-devgwardo/dcb3c241-e316-45af-b9bb-d38c5e67df58/scratchpad/spark-ui-2/{main,palette,palette-search,issues,issues-repo,pr-create,pr-checks,pr-review}-{dark,light}.png
