<!-- hatch:begin v1 -->
## Design Context

### Users
Professional software engineers using Spark as a daily AI coding assistant and GitHub workflow tool. They're in flow state — writing code, reviewing diffs, managing PRs — and expect the interface to keep up without friction. Speed and information density matter more than hand-holding.

### Brand Personality
**Bold, technical, fast.** Power-user energy. The interface should feel like a precision instrument — responsive, dense with useful information, and visually sharp. Think Warp terminal meets Linear's polish.

### Aesthetic Direction
- **Visual tone**: Dark-first, high-contrast, monochromatic with restrained accent color. Crisp edges, tight spacing, no visual fluff.
- **References**: Cursor/Windsurf (AI-native code editor feel), ChatGPT/Claude.ai (clean conversational flow), Linear/Vercel (refined dev-tool typography and layout).
- **Anti-references**: Overly playful consumer apps (Notion-cute), heavy gradients/glassmorphism, rounded bubbly UI, excessive whitespace. Nothing that feels slow or decorative.
- **Theme**: Light and dark mode supported; dark mode is the primary design target.
- **Typography**: Geist Sans for UI, Inter for body text, Geist Mono for code. Tight leading, small-to-medium sizes. Information-dense but readable.
- **Motion**: Minimal and functional — fade-in-up entrances, glimmer for streaming state. No bouncy or attention-seeking animations.

### Design Principles
1. **Speed is a feature** — Every interaction should feel instant. Minimize visual latency, avoid layout shifts, keep animations under 200ms.
2. **Density over decoration** — Show more information in less space. Prefer compact layouts, small text sizes, and tight spacing. Don't add visual elements that don't carry information.
3. **Dark-native confidence** — Design for dark mode first. Use high contrast for readability, subtle borders for structure, and restrained color for hierarchy.
4. **Developer-grade precision** — Pixel-perfect alignment, consistent spacing, monospace where appropriate. The interface should feel as precise as the code it helps write.
5. **Get out of the way** — The UI serves the conversation and the code. Chrome should recede; content should dominate. Progressive disclosure over upfront complexity.

### Accessibility
WCAG AA compliance — good contrast ratios, full keyboard navigation, proper ARIA labels, focus indicators. Respect `prefers-reduced-motion`.

## Repo Workflows

### Dev commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Vite dev server (http://localhost:8080) |
| `npm run server` | Express API server (:3001) |
| `npm run build` | Production build (frontend + server bundle) |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | Playwright end-to-end tests against the Electron app |
| `npm run typecheck` | TypeScript checks (app + electron configs) |
| `npm run lint` | ESLint across the repo |

### Ports

- `3001` — Express API server
- `3002` — Hermes bridge (Python FastAPI)
- `8080` — Vite dev server / frontend

### Key directories

- `src/` — React + TypeScript frontend (`components/`, `hooks/`, `lib/`, `stores/`, `mobile/`)
- `server/` — Express API (`routes/`, `lib/`, team/room/orchestrator modules)
- `electron/` — Desktop app shell (tray, updater, OAuth, embedded server)
- `hermes-bridge/` — Python bridge to the Hermes agent (`main.py`, `acp_transport.py`)
- `e2e/` — Playwright end-to-end tests

### Branch & PR conventions

- Feature work lives on `feat/*` branches (e.g. `feat/hermes-acp-transport`)
- `main` is the PR target; keep PRs focused on a single concern
- Run `npm run typecheck && npm run lint && npm test` before opening a PR
<!-- hatch:end v1 -->
