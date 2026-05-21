# Mobile Hermes Control — Spec

**Status**: Draft
**Owner**: @DevGwardo
**Created**: 2026-05-21
**Related**: `docs/mobile-access.md`, commit `edbfef9` (QR + tunnel), commit `607cb62` (room chat + swarm panel)

---

## 1. Goal

Let a user on their phone, away from home, drive the Hermes agent running on their home PC — start a chat, see status, and (when the PC is asleep or unresponsive) trigger a small set of "revival" actions to get it back online.

**Success criteria** — concrete, testable:
1. From a phone on cellular, scan the QR from `RemoteAccessModal`, land on a mobile-optimized view (no desktop sidebar overflow, no horizontal scroll on a 390px viewport).
2. The mobile view shows live Hermes status (online / offline / last-seen) sourced from the existing bridge `/health` endpoint.
3. User can start a new Hermes chat from the phone and receive streamed responses, reusing existing `/api/hermes/chat/start` + `/api/hermes/chat/stream`.
4. When Hermes is offline, user can trigger at least one revival action (Wake-on-LAN packet to the home PC's MAC) and see the status flip to online within 60s without a manual refresh.

If any of the four fails, the spec is not delivered.

---

## 2. Non-goals

- Native iOS/Android apps. Mobile = responsive PWA over the existing web build.
- Full feature parity with desktop (no terminal, no mini-browser, no kanban editing on phone in v1).
- Auth/identity system. We continue to rely on the tunnel's access control (Cloudflare Access policy, or "share the link, don't share the link").
- Multi-user. Single-user, single-home-PC assumption.

---

## 3. What already exists (don't rebuild)

| Capability | Where | Notes |
|---|---|---|
| Same-origin web build | `npm run serve`, `server/index.ts` | Serves `dist/` + API on :3001 |
| Public tunnel | `RemoteAccessModal.tsx`, `/api/remote/tunnel/*` | cloudflared (preferred) + localtunnel fallback |
| QR + LAN/tunnel URL | `/api/remote/info` | Already renders SVG QR |
| Hermes bridge | `hermes-bridge/main.py` on `localhost:3002/v1` | OpenAI-compatible + `/health` |
| Hermes chat routes | `server/routes/hermes-*.ts` | start, stream, sessions, profiles |
| Bridge URL config | `HERMES_BRIDGE_URL` env | Already wired through server + client |

The only net-new server work is the revival actions. Everything else is a UI layer.

---

## 4. Scope (v1)

### 4.1 Mobile shell
A responsive layout that activates below `md` (768px) for any route. Two acceptable approaches — pick one in the plan phase:

- **A. Adapt existing chat view** — make the current chat panel + conversation list mobile-first. Lower risk, less code, but the desktop layout drives decisions.
- **B. Dedicated `/m` route** — new mobile-optimized routes that wrap existing API/SSE hooks. More code, but lets the mobile UX be designed for the use case (status-first, action-first) instead of "chat with a sidebar collapsed".

**Recommendation: B.** The screenshot's value isn't the chat — it's the status-first layout with action tiles up top. Squeezing that into the desktop chat container will be a fight.

### 4.2 Status panel
Top of the mobile view. Always visible.
- Hermes online indicator (green / amber / red) sourced from `GET {HERMES_BRIDGE_URL}/health` (already used by `src/lib/detect-hermes.ts`).
- "Last seen" timestamp — server-side cache of last successful health check.
- Host name + profile (from `/api/hermes/profiles`).

### 4.3 Revival protocol panel
Shown only when Hermes is offline / health check failed. Three actions in v1:

| Action | Mechanism | Server work |
|---|---|---|
| Wake Computer | Magic packet to configured MAC on the LAN | New: `POST /api/remote/wake` — accepts no args, reads MAC from env/config |
| Ping Bridge | HTTP retry-with-backoff against `:3002/health` | New: `POST /api/remote/ping-bridge` — runs 5 probes over 30s, streams result |
| Smart Plug Power Cycle | Webhook to a configured smart-plug URL (Kasa/Shelly/IFTTT) | New: `POST /api/remote/smart-plug` — reads webhook URL from env |

All three are env-gated. If the env var isn't set, the action button is disabled with a "Not configured" hint — no auto-discovery, no setup wizard in v1.

Out of scope for v1 (good vibes, but not shipping): "Text Someone at the Office", "Play Startup Chime", "Sacrifice a USB-C dongle".

### 4.4 Chat shortcut
A single primary CTA on the mobile shell that opens the most recent Hermes session, or starts a new one. Reuses existing chat infrastructure — no new endpoints.

---

## 5. Technical plan

### 5.1 New files
- `src/mobile/MobileShell.tsx` — root layout for mobile routes (`/m`, `/m/chat`)
- `src/mobile/StatusCard.tsx` — Hermes online/offline card
- `src/mobile/RevivalPanel.tsx` — action tiles, mirrors the screenshot's visual rhythm but in our dark Geist theme
- `src/mobile/useHermesStatus.ts` — polls `/api/remote/hermes-status` every 5s, exponential backoff on failure
- `server/routes/remote-revival.ts` — new express router for `/api/remote/wake`, `/api/remote/ping-bridge`, `/api/remote/smart-plug`, `/api/remote/hermes-status`

### 5.2 Changed files
- `server/index.ts` — register the new revival router
- `src/App.tsx` (or wherever routes are declared) — add `/m` routes
- `docs/mobile-access.md` — append a "Mobile Control App" section linking to this spec

### 5.3 Env vars (new)
```
REMOTE_WAKE_MAC=aa:bb:cc:dd:ee:ff   # MAC of home PC for WoL
REMOTE_WAKE_BROADCAST=192.168.1.255  # optional, defaults to 255.255.255.255
REMOTE_SMART_PLUG_URL=https://...    # webhook URL, POST triggers power cycle
```
None are required to ship — actions degrade gracefully to "Not configured".

### 5.4 Dependencies
- `wake_on_lan` npm package (or hand-rolled UDP magic packet — ~20 lines, no deps).
  Recommend hand-roll to keep `package.json` lean.

---

## 6. Assumptions

1. The home PC stays plugged in. We don't promise to revive a laptop on battery.
2. The user's router doesn't block subnet-directed broadcast (WoL prerequisite). If it does, the smart-plug path is the fallback.
3. The tunnel is already running when the user is away from home (either started before leaving, or running as a service via `cloudflared service install`). Auto-starting the tunnel from a sleeping machine is impossible — that's WoL's job.
4. Mobile Safari + Chrome on iOS 17+ and Android Chrome are the only targets. No legacy browser testing.
5. SSE through the tunnel works reliably enough for streaming chat. Existing commit `edbfef9` already validates this assumption.

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| WoL magic packet doesn't reach sleeping Mac (network/BIOS config) | Wake action silently fails | Show explicit success/failure based on follow-up health check, not just packet-sent |
| Tunnel URL changes between sessions (free cloudflared) | QR goes stale | Already an existing issue; flag in spec, defer fix |
| iOS Safari kills SSE in background | Chat streams hang when phone locks | Reuse existing SSE auto-reconnect from commit `3604821` |
| No auth → anyone with the tunnel URL gets full Hermes access | Security incident | Document loudly; recommend Cloudflare Access in `mobile-access.md` |

---

## 8. Out of scope (parking lot for v2)

- Push notifications when Hermes finishes a task
- Voice input on mobile (Web Speech API)
- "Text someone at the office" via Twilio / iMessage relay
- Background sync for offline queue of chat messages
- Native PWA install prompt + app icon polish
- Multi-host support (controlling more than one Hermes instance)
- Auth (PIN, magic link, OIDC)

---

## 9. Verification plan

Before declaring v1 done:

1. **Layout**: Open the tunnel URL on a real iPhone (or Chrome devtools at 390×844). Mobile shell renders, no horizontal scroll, action tiles are tappable (min 44pt touch target).
2. **Status accuracy**: Kill the Hermes bridge process. Mobile status card flips to offline within 10s. Restart the bridge. Card flips to online within 10s.
3. **Wake action**: Put the home Mac to sleep. From the phone, tap "Wake Computer". Mac wakes. Status flips to online within 60s.
4. **Chat shortcut**: From the mobile shell, tap "Chat". A new Hermes session starts, first token streams within 5s on a normal 4G connection.
5. **Graceful degradation**: Unset `REMOTE_WAKE_MAC`. Tile shows "Not configured" instead of crashing.

If steps 1–4 pass and 5 doesn't regress, v1 ships.

---

## 10. Open questions

1. Where does the Wake-on-LAN MAC live — env var (this spec's assumption) or a settings UI? Env is faster to ship; settings UI is nicer for non-CLI users.
2. Should the mobile shell be the *default* view on small screens (auto-redirect from `/` to `/m`), or opt-in via the QR landing URL? Opt-in is safer for the first release.
3. Do we need a "wake then auto-open chat" combo action, or is two taps fine?

Resolve these before plan phase, or pick the recommended default and move on.
