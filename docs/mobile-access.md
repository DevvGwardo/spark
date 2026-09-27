# Mobile & Remote Access

> **Status: optional, not currently deployed.** Spark is primarily a desktop app; the web build below is an opt-in way to reach it from a browser. No hosted instance is maintained — if you want web access, use the setup below on your own infrastructure.

Spark is primarily a desktop app, but the web build can be served over HTTP and reached from any browser — including mobile phones.

## How It Works

The Express API server (`server/index.ts`) has a **production mode** that serves the built frontend (`dist/`) as static files. A single process serves both the API and the UI.

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

## Remote Access: Tailscale

Remote access goes through the user's **own tailnet**. Spark is never exposed to the public internet, and there is no built-in auth to defeat because only devices signed in to the tailnet can reach the host.

### Setup

1. Install Tailscale on the machine running Spark: <https://tailscale.com/download>
2. Install Tailscale on your phone and sign in to the same tailnet.
3. Start the server, then expose it:

   ```
   npm run serve
   tailscale serve --bg --https=8443 http://localhost:3001
   ```

   Spark never runs this for you — `tailscale serve` writes persistent config, so it stays the user's call. The Remote Access dialog shows the exact command for the running port with a copy button.

4. Open `https://<machine>.<tailnet>.ts.net:8443` from any tailnet device, or scan the QR code in the Remote Access dialog (or on `/remote`).

`tailscale serve` provisions real TLS for the `*.ts.net` name, so no certificate setup is needed. The app requests **port 8443, not 443**, deliberately: 443 is `tailscale serve`'s default and is commonly already mapped to another local service, so claiming it would clobber that mapping.

### What the app does and does not do

The Remote Access dialog and `/remote` page **detect** Tailscale and report one of four states — not installed, stopped, running-but-not-exposed, or active. When it is running but not yet exposed, they show the copy-paste command. They never start the daemon, run `tailscale serve`, or change any Tailscale configuration.

Endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/remote/info` | Tailnet URL, QR SVG, detection state, and the setup command |
| `GET /api/remote/hermes-status` | Read-only bridge reachability probe for the mobile status card |
| `GET /remote` | Standalone HTML page with the QR code and setup steps |

All three are registered only when the frontend is served (`SERVE_FRONTEND=true`).

### Environment Variables

None are required. There is no tunnel to configure and no revival action to enable — the tailnet is the transport.

## Mobile Control App

When you visit Spark from a mobile device (or scan the QR code in the Remote Access dialog), open the `/m` mobile-optimized interface. This is a status-first view designed for quick Hermes checks when you're away from home.

### What the view shows

- **Live Hermes status** — online / recently-lost / offline, with a "last seen" timestamp, sourced from the bridge `/health` endpoint. The status polls every 5s (with backoff on failure) and updates without a manual refresh.
- **Chat** — a primary CTA opens `/m/chat`, a mobile-optimized chat that reuses the standard streaming chat infrastructure.

### Security

Reachability is enforced by the tailnet, not by the app. A device that is not signed in to the tailnet cannot resolve or connect to the `*.ts.net` hostname at all.

Do **not** put this behind `tailscale funnel` — that publishes the service to the public internet and reintroduces exactly the exposure this setup exists to avoid.
