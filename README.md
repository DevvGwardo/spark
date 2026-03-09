# CloudChat

An AI-powered chat application with multi-provider support, live code preview, GitHub integration, and a knowledge base — built with React, Vite, and TypeScript.

## Features

- **Multi-Provider AI Chat** — Connect to 15+ LLM providers including OpenAI, Anthropic, Google, Groq, DeepSeek, Mistral, xAI, and more.
- **Live Code Preview** — Real-time preview of generated code with support for:
  - Plain HTML/CSS/JS
  - React (Vite) projects with JSX/TSX transpilation
  - Next.js projects with mocked routing (`Link`, `useRouter`, `Image`)
- **GitHub Integration** — Analyze repositories and create pull requests directly from the chat interface.
- **Knowledge Base** — Attach custom context to conversations for more relevant AI responses.
- **Streaming Responses** — Real-time token streaming with context usage tracking.
- **Tool Calling** — AI can generate and preview files (HTML, CSS, JS, React components, Next.js pages) in real time.
- **Customizable** — Per-provider model selection, temperature, top-p, max tokens, system prompts, and theme (light/dark/system).

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **State**: Zustand (persisted stores)
- **AI SDK**: Vercel AI SDK (`ai` + `@ai-sdk/react`)
- **Backend**: Local Node.js/Express server (chat proxy, GitHub integration, key validation, project preview)
- **Markdown**: react-markdown with GFM, math (KaTeX), and syntax highlighting

## Getting Started

```sh
# Clone the repository
git clone <YOUR_GIT_URL>
cd cloud-chat-hub

# Install dependencies
npm install

# Start the API server (required — runs on port 3001)
npm run server

# In a separate terminal, start the frontend dev server
npm run dev
```

The app requires **both** the API server and the frontend dev server to be running.

## Environment Variables

Copy `.env.example` to `.env` and configure as needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3001` | URL of the API server |
| `LOVABLE_API_KEY` | — | Server-side key for the Lovable AI provider (set in shell env, not `.env`) |

API keys for individual providers (OpenAI, Anthropic, etc.) are configured in the app's Settings UI and stored in the browser.

## Project Structure

```
src/
├── components/
│   ├── chat/          # Chat UI (input, messages, model selector, welcome screen)
│   ├── github/        # GitHub panel, analyzer, PR creation
│   ├── layout/        # App shell and layout
│   ├── preview/       # Live code preview sidebar (HTML, React, Next.js)
│   ├── settings/      # Settings modal, setup wizard, knowledge panel
│   ├── sidebar/       # Chat history sidebar
│   └── ui/            # shadcn/ui primitives
├── hooks/             # Custom hooks (useChat, useTheme, useMobile)
├── lib/               # API client, token counting, provider config, utilities
├── stores/            # Zustand stores (chat, settings, UI, preview, knowledge)
└── pages/             # Route pages
server/
├── index.ts           # Express API server (chat proxy, GitHub, preview)
└── preview-manager.ts # Project preview lifecycle (clone, build, serve)
```

## Supported Providers

| Provider | Default Model |
|----------|--------------|
| OpenAI | gpt-4o |
| Anthropic | claude-sonnet-4 |
| Google | gemini-2.5-flash |
| xAI | grok-3-mini |
| Groq | llama-3.3-70b |
| DeepSeek | deepseek-chat |
| Mistral | mistral-large-latest |
| Together | Llama-3.3-70B |
| MiniMax | MiniMax-M2.5 |
| Kimi | kimi-k2 |
| Cerebras | llama-3.3-70b |
| OpenRouter | gpt-oss-120b:free |
| SambaNova | Llama-3.3-70B |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start frontend dev server |
| `npm run server` | Start API server |
| `npm run build` | Production build |
| `npm run test` | Run tests |
| `npm run lint` | Lint with ESLint |

## License

Private project.
