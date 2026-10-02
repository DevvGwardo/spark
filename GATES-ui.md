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
