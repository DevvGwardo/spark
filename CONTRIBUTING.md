     1|# Contributing to CloudChat
     2|
     3|Thanks for wanting to help. Here's how to get involved.
     4|
     5|## Reporting Issues
     6|
     7|The fastest path is **inside the app**: click the "Report Issue" button (bottom-left of the chat panel). It pre-fills your version, OS, and the last error.
     8|
     9|Or file directly: <https://github.com/DevvGwardo/cloud-chat-hub/issues/new/choose>
    10|
    11|Three templates:
    12|
    13|| Template | When to use |
    14||----------|-------------|
    15|| **Bug Report** | Something is broken or behaves unexpectedly |
    16|| **Feature Request** | You wish CloudChat could do something it can't |
    17|| **Beta Feedback** | Reactions, friction, half-formed thoughts — the catch-all |
    18|
    19|## Submitting Pull Requests
    20|
    21|1. Fork and clone
    22|2. Create a branch: `git checkout -b your-name/short-description`
    23|3. Make your changes (see Dev setup below)
    24|4. Run checks: `npm run typecheck && npm run lint && npm test`
    25|5. Commit and push, then open a PR
    26|
    27|Keep PRs focused. One concern per PR is much easier to review than a grab-bag.
    28|
    29|## Dev Setup
    30|
    31|```bash
    32|# 1. Install JS deps
    33|npm install
    34|
    35|# 2. Set up the Hermes bridge (required for Hermes Agent mode)
    36|cd hermes-bridge
    37|python3 -m venv .venv
    38|.venv/bin/pip install -r requirements.txt
    39|cd ..
    40|
    41|# 3. Run everything
    42|./start-all.sh
    43|# OR for Electron dev with hot reload:
    44|npm run electron:dev
    45|```
    46|
    47|This spawns three things: the Express API server (port 3001), the Hermes bridge (port 3002), and either the Vite dev server or Electron with hot reload.
    48|
    49|### Manual startup (if you prefer separate terminals)
    50|
    51|```bash
    52|# Terminal 1: API server
    53|npm run server
    54|
    55|# Terminal 2: Hermes bridge
    56|cd hermes-bridge && .venv/bin/python main.py
    57|
    58|# Terminal 3: Frontend
    59|npm run dev
    60|```
    61|
    62|## Code Style
    63|
    64|- TypeScript everywhere on the frontend / Electron / server side
    65|- Match existing style — don't reformat code you aren't touching
    66|- Run `npm run lint` and `npm run typecheck` before pushing
    67|- Keep diffs minimal. Don't "improve" adjacent code — surface those ideas in an issue instead
    68|
    69|## Project Conventions
    70|
    71|- **Zustand** for state management (not Redux, not Context for global state)
    72|- **Tailwind CSS** with the design tokens in `src/lib/tokens.ts`
    73|- **react-markdown** + **rehype** plugins for markdown rendering
    74|- Tool call results are displayed inline in chat messages, not in separate panels
    75|- Settings are stored in localStorage via Zustand persist, never in a backend
    76|
    77|## License
    78|
    79|CloudChat is licensed under **PolyForm Shield 1.0.0** (see [LICENSE](LICENSE)). By contributing, you agree your contributions will be licensed the same way.
    80|
    81|The shield license means: use it, modify it, ship it — just don't offer a competing service with it.
    82|