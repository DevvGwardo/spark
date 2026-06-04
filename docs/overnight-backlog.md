# Overnight Backlog

One feature per overnight run. The loop picks the first unchecked `[ ]` item, builds the
minimum code to satisfy its **Verify** line, ships exactly one Vitest test, and checks it off.

Items are grounded in the existing Hermes architecture (`HERMES_SUB_TABS` in
`src/components/sidebar/ChatSidebar.tsx`, the `Hermes*Panel.tsx` panels, `src/lib/hermes-api.ts`,
and the shared helpers in `src/components/sidebar/hermesSidebarUtils.ts`). Reuse existing
helpers — do not reinvent formatters, SSE, export, or approval logic.

- [x] **Session search filter** — add a search input to `HermesChatsPanel` that filters the
      session list, backed by a pure `filterSessions(sessions, query)` helper in
      `hermesSidebarUtils.ts` (case-insensitive substring match on title/id/repo/model).
      Verify: `filterSessions` returns only matching sessions for a query, is case-insensitive,
      matches across id/repo/model/firstUserMessage, and returns all sessions for an empty query.
      feat/overnight-session-filter — filterSessions helper + HermesChatsPanel search input, proven by hermes-session-filter.test.ts.

- [x] **Cron run-history summary** — add a pure `summarizeCronRuns(runs)` helper that returns
      `{ total, succeeded, failed, successRate }` from a `CronRun[]`, and surface the summary
      line in the Cron panel's run-history view.
      Verify: `summarizeCronRuns` computes correct counts and a 0–1 success rate from a mixed
      list of succeeded/failed runs, and returns a zeroed summary (rate 0) for an empty list.
      feat/overnight-cron-summary — summarizeCronRuns helper + CronHistoryChat summary strip, proven by cron-run-summary.test.ts.

- [ ] **Skill list filter** — add a search input to `HermesSkillsPanel` filtering installed
      skills, backed by a pure `filterSkills(skills, query)` helper (match on name/description).
      Verify: `filterSkills` returns case-insensitively matching skills and all skills for an
      empty query.

- [ ] **Session status counts** — add a pure `countSessionStatuses(sessions)` helper returning
      `{ active, completed, error, total }` and render the counts as small pills in the Sessions
      panel header.
      Verify: `countSessionStatuses` tallies each status correctly, folds unknown statuses into
      `total` only, and returns all-zero for an empty list.

- [ ] **Usage budget level** — add a pure `usageBudgetLevel(spent, budget)` helper returning
      `'ok' | 'warn' | 'over'` (warn ≥ 75%, over ≥ 100%, ok below) and use it to color the
      spend figure in `HermesUsagePanel`.
      Verify: `usageBudgetLevel` returns `ok`/`warn`/`over` at the 0/75/100% thresholds and
      treats a zero or missing budget as `ok`.

- [ ] **Memories export to markdown** — add a pure `memoriesToMarkdown(memories)` helper that
      renders the memories list as a markdown document (one heading + body per memory), wired to
      an export button in `HermesMemoriesPanel` reusing the existing download flow.
      Verify: `memoriesToMarkdown` emits a markdown heading and body for each memory and returns
      an empty-state string (not a throw) for an empty list.
