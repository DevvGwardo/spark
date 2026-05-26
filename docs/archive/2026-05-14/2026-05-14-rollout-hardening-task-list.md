# Rollout Hardening Task List

Scope: local desktop distribution only. No hosted/public-server work.

- Stabilize first-run Hermes setup for downloaded desktop users.
- Distinguish missing local prerequisites from a bridge that only needs to be started.
- Surface actionable setup errors for Python, Git, bridge deps, and Hermes Agent.
- Fix in-scope local release-readiness blockers that currently break verification.
- Preserve the existing Hermes queue/sidebar work and avoid unrelated repo cleanup.

Implementation targets for this pass:

- `src/components/settings/SetupWizard.tsx`
  Improve first-run Hermes recovery so the wizard can inspect local bridge prerequisites, repair missing deps, install Hermes Agent when needed, and start the bridge when everything is already installed.
- `src/components/setup/BridgeSetupModal.tsx`
  Improve post-setup bridge recovery with clearer prerequisite checks and a direct “start bridge” path.
- `electron/bridge.ts`, `electron/index.ts`, `src/electron.d.ts`
  Expose enough local bridge status to drive reliable desktop setup UX.
- `src/components/sidebar/ProfilesPanel.tsx`
  Fix the current typecheck blocker.
- `docs/BETA-TESTING.md`
  Align the install guide with the actual first-run desktop flow.
