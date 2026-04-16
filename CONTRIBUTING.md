# Contributing to CloudChat

Thanks for poking around. CloudChat is in **closed beta** — this guide is for invited testers and contributors.

## Reporting issues

The fastest path is **inside the app**: click the "Report Issue" button (bottom-left of the chat panel). It pre-fills your version, OS, and the last error.

If you'd rather file directly: <https://github.com/DevvGwardo/cloud-chat-hub/issues/new/choose>

Three templates are available:

| Template | When to use |
|----------|-------------|
| **Bug Report** | Something is broken or behaves unexpectedly |
| **Feature Request** | You wish CloudChat could do something it can't |
| **Beta Feedback** | Reactions, friction, half-formed thoughts — the catch-all |

## Submitting pull requests

The repo is private — fork only works if you've been added as a collaborator. If you're a tester and want to send a PR:

1. Clone: `git clone https://github.com/DevvGwardo/cloud-chat-hub.git`
2. Create a branch: `git checkout -b your-name/short-description`
3. Make your changes (see Dev setup below)
4. Run checks: `npm run typecheck && npm run lint && npm test`
5. Commit and push, then open a PR — the PR template will guide you.

Keep PRs focused. One concern per PR is much easier to review than a grab-bag.

## Dev setup

```sh
# 1. Install JS deps
npm install

# 2. Set up the Hermes bridge (required for Hermes Agent mode)
cd hermes-bridge
python -m venv .venv
.venv/bin/pip install -r requirements.txt

# 3. Run everything together
npm run dev:electron
```

This spawns three things: the Express API server (port 3001), the Hermes bridge (port 3002), and Electron with hot reload.

## Code style

- TypeScript everywhere on the frontend / Electron / server side.
- Match existing style — don't reformat code you aren't touching.
- Run `npm run lint` and `npm run typecheck` before pushing.
- Keep diffs minimal. Don't "improve" adjacent code — surface those ideas in an issue instead.

## License

CloudChat is licensed under PolyForm Shield 1.0.0 (see [LICENSE](LICENSE)). By contributing, you agree your contributions will be licensed the same way.
