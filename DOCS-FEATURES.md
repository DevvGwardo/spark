# Hermes Agent Messaging — Feature Summary

Sourced from https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
and all platform-specific sub-pages (18 URLs fetched 2026-04-11).

---

## Supported Platforms

Telegram, Discord, Slack, WhatsApp, Signal, SMS (Twilio), Email (IMAP/SMTP),
Home Assistant, Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, Weixin,
BlueBubbles (iMessage via BlueBubbles Server), Open WebUI, Webhooks.

---

## Gateway Commands (All Platforms)

| Command | Description |
|---|---|
| `hermes gateway` | Run gateway in foreground |
| `hermes gateway setup` | Interactive setup wizard |
| `hermes gateway install` | Install as user service (Linux/macOS launchd) |
| `sudo hermes gateway install --system` | Linux boot-time system service |
| `hermes gateway start` | Start the service |
| `hermes gateway stop` | Stop the service |
| `hermes gateway status` | Check service status |
| `hermes gateway run` | Run in foreground (for logs) |
| `hermes logs gateway` | View gateway logs |
| `hermes logs -f` | Follow logs in real-time |
| `hermes pairing approve <platform> <CODE>` | Approve DM pairing request |
| `hermes pairing list` | List pending and approved users |
| `hermes pairing revoke <platform> <userId>` | Remove user access |
| `hermes webhook subscribe <name>` | Create dynamic webhook subscription |
| `hermes webhook list` | List active webhook subscriptions |
| `hermes webhook remove <name>` | Remove a subscription |
| `hermes webhook test <name>` | Test a subscription |
| `hermes update` | Update Hermes Agent to latest version |

---

## Slash Commands (In-Chat, All Platforms)

| Command | Description |
|---|---|
| `/new` | Start fresh conversation |
| `/reset` | Reset conversation session |
| `/model [provider:model]` | Show or change the model |
| `/model` | Interactive model picker (inline keyboard/dropdown) |
| `/provider` | Show available providers with auth status |
| `/personality [name]` | Set a personality |
| `/retry` | Retry the last message |
| `/undo` | Remove the last exchange |
| `/status` | Show session info |
| `/stop` | Stop the running agent |
| `/approve` | Approve a pending dangerous command |
| `/deny` | Reject a pending dangerous command |
| `/sethome` | Set this chat as the home channel |
| `/compress` | Manually compress conversation context |
| `/title [name]` | Set or show the session title |
| `/resume [name]` | Resume a previously named session |
| `/usage` | Show token usage for this session |
| `/insights [days]` | Show usage insights and analytics |
| `/reasoning [level\|show\|hide]` | Change reasoning effort or toggle reasoning display |
| `/verbose` | Cycle tool progress display modes |
| `/voice [on\|off\|tts\|join\|leave\|status]` | Control voice replies and voice-channel behavior |
| `/rollback [number]` | List or restore filesystem checkpoints |
| `/background <prompt>` | Run a prompt in a separate background session |
| `/reload-mcp` | Reload MCP servers from config |
| `/update` | Update Hermes Agent |
| `/help` | Show available commands |
| `/card button` | Interactive card action event (Feishu) |
| `/set-home` | Mark current chat as home channel (Feishu) |
| `/<skill-name>` | Invoke any installed skill |
| `yes`/`y` | Approve exec commands |
| `no`/`n` | Deny exec commands |

---

## Chat Capabilities (Cross-Platform)

- **Direct messages** — Auto-response without @mention (most platforms)
- **Channel/group messages** — Require @mention by default; exempt channels configurable
- **Thread replies** — Thread-based continuity (configurable: off / first / all)
- **Per-user session isolation** — Each user gets isolated conversation context in shared channels
- **Rich media** — Images, files, audio, video (support varies by platform)
- **Emoji reactions** — Feedback during agent processing; reaction tracking on bot messages
- **Typing indicators** — Show agent is processing
- **Read receipts** — Auto-mark messages as read (BlueBubbles)
- **Markdown rendering** — Auto-detect and format; stripped to plain text if platform rejects
- **Message streaming** — Streaming responses (Telegram Bot API 9.x, others)
- **Streaming tool progress** — Emoji status indicators (💻 🔍 📄 🐍)
- **File attachments in replies** — Via `MEDIA:/path/to/file` syntax (Email)
- **Quote/reply context** — Preserve replied-to message context
- **Message chunking** — Intelligent splitting for platform limits (e.g. Weixin 4000 char)
- **Tapback reactions** — love, like, dislike, laugh, emphasize, question (BlueBubbles/iMessage)
- **Home channel** — Designated channel for proactive messages (cron output, notifications)
- **Proactive notifications** — Cron job delivery, persistent notifications (Home Assistant)
- **Burst protection / batching** — Text/media burst debouncing per chat (Feishu)
- **Message deduplication** — Sliding window deduplication (Signal, DingTalk, WeCom, Weixin, Feishu)
- **Interactive cards/buttons** — Button click events routed as commands (Feishu)
- **Echo prevention** — Filter self-messages and automated senders
- **Phone number redaction** — `+15551234567` → `+155****4567` in all logs (Signal, SMS)
- **HMAC signature validation** — For webhook payloads
- **Rate limiting** — Per-route (webhooks) and per-IP (Feishu webhook)

---

## Session Management

| Feature | Detail |
|---|---|
| **Session persistence** | Sessions persist across messages until reset |
| **Per-user isolation** | `group_sessions_per_user: true` in config.yaml |
| **Thread-based sessions** | Each DM thread / forum topic gets own session namespace |
| **Session reset policies** | `daily` (default 4:00 AM), `idle` (default 1440 min), or both |
| **Per-platform reset overrides** | Set different idle/daily policies per platform in `~/.hermes/gateway.json` |
| **Chat topics** | Telegram Private Chat Topics (Bot API 9.4) — isolated workspaces in DMs |
| **Group forum topics** | Telegram group forum topic skill binding |
| **Session resume** | `/resume [name]` to recall a previously named session |
| **Context compression** | `/compress` manually triggers conversation compression |

---

## Security

- **Allowlist-based access** — Every platform has `*_ALLOWED_USERS` env var; default is **deny all**
- **Global allowlist** — `GATEWAY_ALLOWED_USERS` applies across all platforms
- **DM pairing flow** — Unknown users receive one-time pairing code; approved via CLI
  - `hermes pairing approve <platform> CODE`
  - Codes expire after 1 hour, rate-limited, use cryptographic randomness
- **`GATEWAY_ALLOW_ALL_USERS=true`** — NOT recommended for bots with terminal access
- **IMAP SSL (port 993) and SMTP STARTTLS (port 587)** — Email encryption
- **Signal E2E encryption** — Via Signal protocol
- **Matrix E2EE** — Optional via mautrix library and libolm
- **Webhook HMAC validation** — GitHub (`X-Hub-Signature-256`), GitLab (`X-Gitlab-Token`), Generic (`X-Webhook-Signature`)
- **Webhook body size limits** — Default 1 MB max, configurable
- **Rate limiting** — Default 30 req/min per route (webhooks); 120 req/60s per (app_id, path, IP) for Feishu
- **Idempotency** — Delivery IDs cached 1 hour; duplicate webhook deliveries skipped
- **Home Assistant blocked domains** — `shell_command`, `command_line`, `python_script`, `pyscript`, `hassio`, `rest_command`
- **Entity ID validation** — Pattern: `^[a-z_][a-z0-9_]*\.[a-z0-9_]+$`
- **SSRF protection** — Weixin
- **Payload injection warning** — Run webhook gateway in sandboxed environment

---

## Voice (STT / TTS)

**STT Providers:**
- `local` — faster-whisper (no API key needed)
- `groq` — Groq Whisper (`GROQ_API_KEY`)
- `openai` — OpenAI Whisper (`VOICE_TOOLS_OPENAI_KEY`)

**TTS Providers:**
- OpenAI (Opus native)
- ElevenLabs (Opus native)
- Edge TTS (requires ffmpeg for Opus conversion)

**Platforms with voice support:** Telegram, Discord, Slack, WhatsApp (incoming STT + outgoing TTS as MP3), Mattermost, Matrix, Feishu, WeCom, Weixin

**Voice message behavior:**
- WhatsApp: incoming transcribed via STT; outgoing via TTS as MP3 attachment
- Signal: voice message transcription if Whisper configured
- Weixin: incoming voice → transcription or SILK format
- Other platforms: inbound audio transcribed, outbound TTS audio response

---

## Background Tasks

| Feature | Description |
|---|---|
| `/background <prompt>` | Spawn separate agent instance; inherits model, provider, toolsets, reasoning settings |
| **Non-blocking** | Main chat stays interactive while background runs |
| **Result delivery** | Sent to same chat when finished ("✅ Background task complete" or "❌ Background task failed") |
| **Notification modes** | `all` (running updates + completion), `result` (completion only), `error` (non-zero exit only), `off` |
| **Configurable via** | `display.background_process_notifications` in config.yaml or `HERMES_BACKGROUND_NOTIFICATIONS` env var |

---

## Notifications & Proactive Messaging

- **Home channel** — Designated destination for cron job output, reminders, notifications
  - Set via `/sethome` in any chat, or `*_HOME_CHANNEL` env var per platform
- **Home Assistant** — Delivers as persistent notifications titled "Hermes Agent"
- **Cron scheduler** — Ticks every 60 seconds; due jobs deliver to home channel
- **Scheduled messages** — Slack home channel scheduling; WeCom cron delivery
- **Webhook response routing** — Agent can respond via: log, github_comment, telegram, discord, slack, signal, sms, whatsapp, matrix, mattermost, homeassistant, email, dingtalk, feishu, wecom, weixin, bluebubbles
- **Forum topic delivery** — Target Telegram forum topics via `message_thread_id` in `deliver_extra`

---

## Home Assistant (Smart Home Integration)

**LLM-callable tools:**
- `ha_list_entities` — List entities with optional domain/area filters
- `ha_get_state` — Retrieve detailed state and attributes for a single entity
- `ha_list_services` — Show available services/actions per domain
- `ha_call_service` — Execute device control (turn_on, set_temperature, etc.)

**Capabilities:**
- WebSocket connection with 30s heartbeat for real-time `state_changed` events
- Auto-reconnect with exponential backoff (5s → 10s → 30s → 60s)
- Outbound notifications as Home Assistant persistent notifications
- Device state change formatting (human-readable messages per device type)
- Watch/ignore entity configuration per domain or specific entity IDs

---

## Webhooks (HTTP Inbound)

**Architecture:** HTTP server receives POST from GitHub, GitLab, JIRA, Stripe, etc.; validates HMAC; transforms payloads via prompt templates; routes agent responses to configured platforms.

**Prompt template features:**
- Dot-notation: `{pull_request.title}`
- `{__raw__}` — Full payload as indented JSON (truncated at 4000 chars)
- Missing keys left as literal `{key}`
- Nested dicts/lists JSON-serialized, truncated at 2000 chars

**Delivery destinations:** log, github_comment, telegram, discord, slack, signal, sms, whatsapp, matrix, mattermost, homeassistant, email, dingtalk, feishu, wecom, weixin, bluebubbles

**Hot-reload:** Subscriptions reload automatically (mtime-gated)
**Dynamic subscriptions:** Created via CLI or agent via `webhook-subscriptions` skill
**Static routes:** config.yaml routes take precedence over dynamic ones with same name

---

## Platform-Specific Features

### Telegram
- Bot API v9.x streaming support
- Private Chat Topics (Bot API 9.4) — isolated workspaces in DMs
- Group forum topic skill binding
- DNS-over-HTTPS fallback IPs for restricted networks
- Automatic proxy support (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`)
- Interactive model picker via inline keyboard
- BotFather commands: `/newbot`, `/revoke`, `/token`, `/setcommands`, `/setprivacy`, etc.
- Two transport modes: Long Polling (default) and Webhook (cloud platforms)
- Privacy mode ON (default): bot only sees slash commands, replies, service messages

### Discord
- `/model` dropdown picker, `/model <name>` direct selection
- `/voice tts` — Generate spoken audio response
- `/<skill-name>` — Native Discord commands for installed skills
- Auto-thread creation on first message in channel
- Bot message reactions (emoji feedback during processing)
- Free-response channels (bypass @mention requirement)
- `DISCORD_ALLOW_BOTS` policy ("none", "mentions", "all")
- Ignored channels and no-thread channels configuration

### Slack
- Socket Mode (WebSocket, no public URL required)
- Multi-workspace support with single gateway instance (tokens stored in `~/.hermes/slack_tokens.json`)
- `SLACK_HOME_CHANNEL` — Channel ID for notifications
- Thread reply modes: off / first / all
- `slack.require_mention` (default: true); `slack.mention_patterns` for custom triggers
- `slack.reply_prefix` for message prepending
- Voice message STT and TTS audio responses

### WhatsApp
- Baileys-based bridge (emulates WhatsApp Web session)
- Two modes: "bot" (separate number) or "self-chat" (personal number)
- No Meta developer account or Business verification required
- Session persistence (survives restarts without re-scanning QR)
- Voice message support: incoming STT, outgoing TTS as MP3
- Auto-reconnection for temporary disconnections
- Customizable reply prefix

### Signal
- signal-cli daemon mode with HTTP API (Java 17+ runtime required)
- Real-time streaming via SSE, JSON-RPC responses
- E2E encryption via Signal protocol
- Typing indicators (refresh every 8 seconds)
- "Note to Self" support for single-number setups
- Echo-back protection for self-messages
- 100 MB attachment size limit (both directions)
- Health monitoring with auto-reconnect (exponential backoff: 2s → 60s)
- 120-second inactivity detection with ping verification

### SMS (Twilio)
- Webhook-based receiving; plaintext only (markdown auto-stripped)
- 1600 character limit with intelligent splitting
- Shared credentials with telephony skill
- Echo prevention for own Twilio number
- Supports `SMS_HOME_CHANNEL` and `SMS_HOME_CHANNEL_NAME`

### Email (IMAP/SMTP)
- Works with Gmail, Outlook, Yahoo, Fastmail, any IMAP/SMTP provider
- Python built-in modules (no external deps): imaplib, smtplib, email
- Email threading via In-Reply-To and References headers; auto reply-in-thread
- Attachments cached locally (images for vision, documents for file access)
- HTML emails stripped to plain text
- File attachments in replies via `MEDIA:/path/to/file` syntax
- Self-messages and automated senders filtered out
- Configurable polling interval (default 15 seconds)

### Home Assistant
- WebSocket with 30s heartbeat; real-time state_changed events
- Automatic reconnection with exponential backoff
- Outbound notifications as persistent notifications
- Safety blocked domains: shell_command, command_line, python_script, pyscript, hassio, rest_command
- Entity ID pattern validation

### Mattermost
- REST API v4 + WebSocket for real-time events (no external library needed)
- Auto-responds to DMs; @mention required in channels (configurable)
- `MATTERMOST_REPLY_MODE=thread` for threaded replies
- Home channel via `/sethome` slash command
- `MATTERMOST_FREE_RESPONSE_CHANNELS` for mention-free channels
- Per-user session isolation via `group_sessions_per_user: true`
- Self-hosted only (no Mattermost Cloud subscription required)

### Matrix
- Works with any Matrix homeserver (Synapse, Conduit, Dendrite, matrix.org)
- Auto-join on room invite
- Optional E2EE via mautrix library and libolm (install via `pip install 'hermes-agent[matrix]'`)
- Native voice messages (MSC3245) — render as native voice bubbles
- Threads with context isolation; mention required in rooms by default
- Auto-threading for responses (configurable)
- DM without @mention; rooms require @mention (exempt rooms configurable)

### DingTalk
- WebSocket Stream Mode (no public URL required)
- Works behind NAT and firewalls
- DM responses without @mention; group via @mention
- Per-user session isolation in shared groups
- Markdown-formatted replies
- Auto-reconnection with exponential backoff
- Message deduplication (5-minute window)
- 20,000 character message limit

### Feishu/Lark
- **WebSocket mode** (recommended): persistent outbound connection, no public URL
- **Webhook mode**: HTTP endpoint for inbound events
- Receives: images, audio, video, files (pdf, doc, xls, ppt, etc.)
- Sends: text, rich post messages, images, documents, voice, video
- Interactive card button clicks routed as `/card button` command events
- Auto-detects markdown and sends as Feishu post messages
- ACK emoji reactions (adds ✅ to received messages)
- Burst protection: text batching (0.6s debounce, 8 msgs max, 4000 chars max)
- Media batching (0.8s debounce)
- Rate limiting: 120 req/60s sliding window per (app_id, path, IP)
- Deduplication: 24-hour TTL on message IDs, persisted to `~/.hermes/feishu_seen_message_ids.json`
- Signature verification: SHA256 of `timestamp + nonce + encrypt_key + body`
- Per-group access control via `group_rules` in config.yaml

### WeCom (Enterprise WeChat)
- WebSocket transport (persistent connection, no public endpoint)
- DM and group messaging with per-group sender allowlists
- Media support: images, files, voice, video upload/download
- AES-256-CBC encrypted media decryption (automatic)
- Quote/reply context preservation
- Markdown rendering for rich text
- Reply-mode streaming for correlated responses
- Auto-reconnect with exponential backoff
- Message deduplication (5-minute window, 1000-entry cache)
- DM policy values: `open`, `allowlist`, `disabled`, `pairing`
- Group policy values: `open`, `allowlist`, `disabled`
- Media limits: text 4,000 chars, images 10 MB, files 20 MB, voice 2 MB, video 10 MB

### Weixin (WeChat via iLink)
- Long-poll transport (no public endpoint/webhook needed)
- QR code login via scan-to-connect
- DM and group messaging with configurable policies
- Media: images, video, files, voice
- AES-128-ECB encrypted CDN (automatic encryption/decryption)
- Context token persistence (disk-backed continuity)
- Markdown formatting (headers→【Title】, tables→key-value, code preserved)
- Smart message chunking (4000 char max, paragraph-aware)
- Typing indicators, SSRF protection, message deduplication (5-min sliding window)
- Automatic retry with exponential backoff
- DM policy: `open`, `allowlist`, `disabled`, `pairing`; group: `open`, `allowlist`, `disabled`

### BlueBubbles (iMessage)
- Webhook-based instant inbound delivery (no polling)
- Outbound via BlueBubbles REST API
- Text with automatic markdown stripping
- Rich media: images, voice messages, videos, documents
- Tapback reactions: love, like, dislike, laugh, emphasize, question (requires Private API helper)
- Typing indicators (requires Private API helper)
- Read receipts — auto-marks messages as read (requires Private API helper)
- Creating new chats by address (requires Private API helper)
- Local caching of inbound attachments

### Open WebUI
- Self-hosted chat interface (126k GitHub stars)
- Server-to-server comms (no CORS config needed)
- Full tool access: terminal, file ops, web search, memory, skills
- Streaming tool progress with emoji indicators
- Two API modes: Chat Completions (`/v1/chat/completions`, default) and Responses (`/v1/responses`, experimental)
- API server port: 8642 (configurable)
- Multi-user with profiles: `hermes profile create <name>`
- Docker-based deployment; `host.docker.internal` for Linux

---

## Environment Variables Quick Reference

| Variable | Platform | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram | Bot API token |
| `TELEGRAM_ALLOWED_USERS` | Telegram | Comma-separated user IDs |
| `DISCORD_BOT_TOKEN` | Discord | Bot authentication token |
| `DISCORD_ALLOWED_USERS` | Discord | Comma-separated user IDs |
| `SLACK_BOT_TOKEN` | Slack | Bot token (xoxb-) |
| `SLACK_APP_TOKEN` | Slack | App-level token (xapp-) |
| `SLACK_ALLOWED_USERS` | Slack | Comma-separated Member IDs |
| `WHATSAPP_ENABLED` | WhatsApp | Enable WhatsApp |
| `WHATSAPP_MODE` | WhatsApp | `bot` or `self-chat` |
| `WHATSAPP_ALLOWED_USERS` | WhatsApp | Comma-separated E.164 numbers |
| `SIGNAL_HTTP_URL` | Signal | signal-cli HTTP endpoint |
| `SIGNAL_ACCOUNT` | Signal | Bot phone number (E.164) |
| `SIGNAL_ALLOWED_USERS` | Signal | Comma-separated numbers/UUIDs |
| `TWILIO_ACCOUNT_SID` | SMS | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | SMS | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | SMS | E.164 format |
| `SMS_ALLOWED_USERS` | SMS | Comma-separated phone numbers |
| `EMAIL_ADDRESS` | Email | Agent's email address |
| `EMAIL_PASSWORD` | Email | Email or app password |
| `EMAIL_IMAP_HOST` / `EMAIL_SMTP_HOST` | Email | Server hosts |
| `HASS_TOKEN` | Home Assistant | Long-Lived Access Token |
| `HASS_URL` | Home Assistant | Server URL (default: http://homeassistant.local:8123) |
| `MATTERMOST_URL` | Mattermost | Server URL |
| `MATTERMOST_TOKEN` | Mattermost | Bot account token |
| `MATTERMOST_ALLOWED_USERS` | Mattermost | Comma-separated User IDs |
| `MATRIX_HOMESERVER` | Matrix | Homeserver URL |
| `MATRIX_ACCESS_TOKEN` | Matrix | Access token |
| `MATRIX_ALLOWED_USERS` | Matrix | Comma-separated user IDs |
| `MATRIX_ENCRYPTION` | Matrix | Enable E2EE |
| `DINGTALK_CLIENT_ID` | DingTalk | AppKey |
| `DINGTALK_CLIENT_SECRET` | DingTalk | AppSecret |
| `FEISHU_APP_ID` | Feishu | Application ID |
| `FEISHU_APP_SECRET` | Feishu | Application Secret |
| `FEISHU_ALLOWED_USERS` | Feishu | Comma-separated open_id list |
| `WECOM_BOT_ID` | WeCom | Bot ID |
| `WECOM_SECRET` | WeCom | Bot Secret |
| `WEIXIN_ACCOUNT_ID` | Weixin | iLink Bot account ID |
| `WEIXIN_TOKEN` | Weixin | iLink Bot token |
| `BLUEBUBBLES_SERVER_URL` | BlueBubbles | Server URL |
| `BLUEBUBBLES_PASSWORD` | BlueBubbles | Server password |
| `WEBHOOK_ENABLED` | Webhooks | Enable webhook adapter |
| `WEBHOOK_PORT` | Webhooks | HTTP server port (default: 8644) |
| `WEBHOOK_SECRET` | Webhooks | Global HMAC secret |
| `API_SERVER_ENABLED` | Open WebUI | Enable API server |
| `API_SERVER_KEY` | Open WebUI | Bearer token auth |
| `API_SERVER_PORT` | Open WebUI | HTTP server port (default: 8642) |
| `GROQ_API_KEY` | STT | Groq Whisper |
| `VOICE_TOOLS_OPENAI_KEY` | STT/TTS | OpenAI Whisper/Opus TTS |

---

## Platform Feature Matrix

| Feature | Telegram | Discord | Slack | WhatsApp | Signal | SMS | Email | HA | Mattermost | Matrix | DingTalk | Feishu | WeCom | Weixin | BlueBubbles |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Voice (STT/TTS) | ✅ | ✅ | ✅ | ✅ STT+TTS | ✅ STT | — | — | — | ✅ | ✅ | — | ✅ | ✅ | ✅ | — |
| Images | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| Files | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| Threads | ✅ | ✅ | ✅ | — | — | — | ✅ | — | ✅ | ✅ | — | — | — | — | — |
| Reactions | — | ✅ | ✅ | — | — | — | — | — | — | ✅ | — | ✅ | — | — | ✅ tapback |
| Typing indicators | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Streaming | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| @mention required | config | config | config | N/A | N/A | N/A | N/A | N/A | config | config | config | config | config | config | N/A |
| E2EE | — | — | — | — | ✅ | — | — | — | — | ✅ optional | — | — | — | — | — |
| WebSocket mode | — | — | ✅ Socket Mode | — | — | — | — | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | webhook |
| Long polling | ✅ | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| Webhook mode | ✅ | — | — | — | — | ✅ | — | — | — | — | — | ✅ | — | — | ✅ |