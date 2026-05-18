# Mobile & Remote Access

CloudChat is primarily a desktop app, but the web build can be deployed to a server and accessed from any browser — including mobile phones.

## How It Works

The Express API server (`server/index.ts`) now has a **production mode** that serves the built frontend (`dist/`) as static files. This means a single process serves both the API and the UI, deployable anywhere Node.js runs.

### Production Mode

```
npm run serve
```

This builds the frontend with `VITE_API_URL=` (same-origin) and starts the server on port 3001 (or `$PORT`). The API is available at `/functions/v1/*` and the UI at `/`.

### Platform-Specific Notes

| Feature | Desktop (Electron) | Mobile/Web |
|---------|-------------------|------------|
| Chat (non-agent) | ✅ | ✅ |
| LLM providers | ✅ | ✅ |
| Conversation history | ✅ (SQLite) | ✅ (SQLite) |
| Hermes agent mode | ✅ | ✅ (via bridge) |
| Terminal/PTY | ✅ | ❌ (Electron-only) |
| Workspace search | ✅ | ✅ |
| GitHub integration | ✅ | ✅ |
| Mini browser | ✅ | ❌ (Electron-only) |

Terminal and mini-browser gracefully degrade — they won't appear in the web build.

## Deployment Options

### Option 1: Railway (recommended)

**Prerequisites:**
- [Railway](https://railway.app) account
- `railway` CLI installed

**Steps:**

1. Create a new Railway project from the `cloud-chat-hub` directory
2. Railway auto-detects Node.js — no custom buildpack needed
3. Set environment variables:
   - `PORT=3001` (Railway assigns this automatically)
   - `SERVE_FRONTEND=true`
   - `HERMES_BRIDGE_URL` (if using agent mode — point to your bridge instance)
4. Set the start command:
   ```
   VITE_API_URL= npm run build && SERVE_FRONTEND=true npx tsx server/index.ts
   ```
5. Deploy

Railway assigns a `*.railway.app` URL. Open it on any device.

Data warning: SQLite is local to the server instance. Railway doesn't persist the filesystem between deploys without a volume mount. For persistent chat history, either:
- Add a Railway volume to `/app/data` 
- Or set up a Postgres-backed chat store (future feature)

### Option 2: Cloudflare Tunnel (from your home machine)

Best when you want to keep everything running on your local machine but access it from anywhere.

**Prerequisites:**
- A domain on Cloudflare
- `cloudflared` installed: `brew install cloudflared`

**Steps:**

1. Start the production server locally:
   ```bash
   npm run serve
   ```

2. Create a tunnel:
   ```bash
   cloudflared tunnel create cloudchat
   ```

3. Configure the tunnel (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: cloudchat
   credentials-file: /Users/devgwardo/.cloudflared/cloudchat.json
   
   ingress:
     - hostname: cloudchat.yourdomain.com
       service: http://localhost:3001
     - service: http_status:404
   ```

4. Start the tunnel:
   ```bash
   cloudflared tunnel run cloudchat
   ```

### Option 3: Direct VPS / Vercel / Fly.io

Any Node.js host works. The key is setting `SERVE_FRONTEND=true` and building with `VITE_API_URL=` (empty).

Example Dockerfile for a VPS:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
EXPOSE 3001
CMD ["npx", "tsx", "server/index.ts"]
```

## Mobile-Specific Considerations

### Responsive Layout
The current UI is desktop-first. Some panels may be cramped on small screens. Key layout features that work on mobile:
- **Chat panel** — responsive, scrolls naturally
- **Sidebar** — collapses automatically
- **Settings** — uses modals and scrollable content

### Touch Interactions
- Standard mobile browser touch works for scrolling, tapping, text input
- Code blocks can be tapped to copy
- Markdown rendering is mobile-friendly

### Performance
- The built frontend is ~5MB total (JS + CSS + assets)
- First load may be slow on cellular — subsequent loads cache well
- Each chat message streams via SSE — works on flaky connections

### Security
There is **no built-in auth** — the server is designed for local use. When deploying publicly:
- Use Cloudflare Tunnel with Access policies (email, Google, one-time pin)
- Or add a reverse proxy with auth (Caddy, nginx, Traefik)
- Or keep it on a VPN (Tailscale, WireGuard, ZeroTier)
