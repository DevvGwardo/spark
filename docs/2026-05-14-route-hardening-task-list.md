# 2026-05-14 Hermes Route Hardening Task List

Scope: local desktop Hermes route reliability for CloudChat's bundled server.

1. Fix `/api/hermes/runtimes` host availability semantics.
   - Do not report `host.available: true` when the local Hermes binary or repo is missing.
   - Add targeted route tests for missing-host and healthy-host cases.

2. Preserve upstream bridge error text in `/api/hermes/*` admin proxy routes.
   - When hermes-bridge returns a non-JSON error body, surface that message instead of a generic status-only fallback.
   - Add targeted tests for JSON and plain-text bridge failures.

3. Expand `/functions/v1/health` route advertisement for Hermes-only surfaces we already expose.
   - Include runtime inspection and resumable Hermes chat endpoints in `HEALTH_ROUTES`.
   - Update health-route coverage so embedded-server reuse checks stay aligned with the server surface.
