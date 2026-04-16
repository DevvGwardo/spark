# CloudChat Beta — Tester Guide

Welcome! You've been invited to test CloudChat. This is a private beta — please don't share builds outside the testing group.

## What you're testing

CloudChat is a desktop AI chat client built around the **Hermes Agent** — an autonomous AI that can read code, edit files, browse the web, and manage GitHub PRs. You're helping us find what's broken before we open it up more broadly.

## Install

### Prerequisites

- **macOS Apple Silicon or Windows 10/11**.
- **Git** (used to clone the Hermes Agent on first launch). macOS has it via Xcode CLT (`xcode-select --install`); on Windows, install [Git for Windows](https://git-scm.com/download/win).

### macOS (Apple Silicon — M1/M2/M3/M4)

1. Go to [Releases](https://github.com/DevvGwardo/cloud-chat-hub/releases) and download the latest `CloudChat-x.y.z-mac.dmg`.
2. Open the DMG and drag CloudChat to Applications.
3. **First launch**: macOS will block the app because it isn't notarized yet. Two options:
   - Right-click CloudChat in Applications → **Open** → click "Open" in the dialog.
   - Or, if Gatekeeper still complains: open Terminal and run:
     ```sh
     xattr -cr /Applications/CloudChat.app
     ```
     Then launch normally.

### macOS (Intel)

The beta ships with an Apple-Silicon-native Python runtime, so on Intel Macs the bundled bridge won't run out of the box. You have two options:

- **Easiest**: install Python 3.10+ from [python.org](https://www.python.org/downloads/) before launching CloudChat. The first-run wizard will detect it and use it.
- **Skip**: file an issue and we'll add an Intel build if there's demand.

### Windows

1. Download the latest `CloudChat-x.y.z-win.exe` from [Releases](https://github.com/DevvGwardo/cloud-chat-hub/releases).
2. Run the installer. SmartScreen will warn "Unknown publisher" — click **More info** → **Run anyway**. (We haven't paid for a code-signing cert yet.)
3. Follow the installer prompts.

### First-run setup

CloudChat ships with a portable Python interpreter and the Hermes bridge built in. On first launch:

1. **If `~/.hermes/hermes-agent` is already installed** (you've used the Hermes CLI before), CloudChat detects it and skips the install step entirely.
2. **Otherwise**, a setup checklist appears with three rows:
   - ✓ Python interpreter — either bundled, the existing hermes-agent venv, or your system Python
   - ⬇ Bridge dependencies — one click installs FastAPI/uvicorn/httpx/pydantic to `~/.hermes/cloudchat-pkgs/`
   - ⬇ Hermes Agent — one click clones [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) and installs its deps (~1–3 min)
3. Once the bridge is healthy, the regular setup wizard appears and walks you through entering an API key for at least one provider.

You'll need an API key for one of: OpenRouter, Anthropic, OpenAI, MiniMax, or any of the 17 supported providers. **OpenRouter is the easiest — one key gets you most models.**

Nothing CloudChat installs ever leaves `~/.hermes/`. To uninstall everything, delete that directory (along with the app).

## Reporting issues

**Easiest:** Click the "Report Issue" button in the app (bottom-left of the chat panel). It opens a GitHub issue with your version, OS, and recent errors pre-filled.

**Direct:** <https://github.com/DevvGwardo/cloud-chat-hub/issues/new/choose>

Three templates:
- **Bug Report** — something is broken
- **Feature Request** — something you wish it could do
- **Beta Feedback** — open-ended reactions, friction, ideas

## Auto-updates

CloudChat checks for updates on launch. When a new beta is released, you'll see a "Restart to update" prompt — that's it.

## What we especially want feedback on

- **First-run experience** — was anything confusing?
- **Hermes Agent mode** — does it complete the tasks you give it? When it fails, why?
- **GitHub integration** — adding repos, browsing issues, creating PRs.
- **Performance** — slow streaming, frozen UI, anything that feels sluggish.
- **Anything that surprised you** — good or bad.

## What we already know is rough

- Windows is brand new — fewer hours of testing than macOS.
- Some providers stream faster than others; this isn't always fixable.
- Auto-update on macOS will not work for unsigned builds across major OS versions in some configurations — please report if it breaks.

## Privacy

Your API keys live on your machine in `~/.hermes/auth.json` and never leave it. Chat content is sent to whatever provider you've selected — see their respective privacy policies. CloudChat itself collects no telemetry in beta.

## Thanks

This is genuinely a small group of people doing us a favor. The more brutal your feedback, the faster CloudChat gets good. Thank you.

---

## Maintainer setup (one-time)

This section is for the project maintainer, not testers.

### 1. Add testers as collaborators

`Settings → Collaborators → Add people`. Pick **Read** access — that lets them clone the repo, download releases, and file issues, but not push.

### 2. Generate the auto-update PAT

The shipped app needs a token to fetch updates from this private repo:

1. Go to <https://github.com/settings/personal-access-tokens/new>
2. **Token name**: `cloudchat-auto-update`
3. **Expiration**: 1 year (or whatever your security policy allows)
4. **Repository access**: Only `DevvGwardo/cloud-chat-hub`
5. **Permissions**: Repository → **Contents: Read-only** (and Metadata: Read-only, which is automatic)
6. Generate and copy the token (starts with `github_pat_…`)
7. In the repo: `Settings → Secrets and variables → Actions → New repository secret`
   - Name: `CLOUDCHAT_UPDATE_TOKEN`
   - Value: paste the token

This token is baked into every build. If it leaks, anyone with it can read the repo (not write to it). Rotate it by repeating the steps above and pushing a new release.

### 3. Cut a beta release

```sh
# Bump version in package.json (e.g. 1.0.0 → 1.0.0-beta.1)
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1
```

The tag push triggers `.github/workflows/release.yml`, which builds Mac + Windows in parallel and publishes a **prerelease** to <https://github.com/DevvGwardo/cloud-chat-hub/releases>.

The release will be marked as **Draft** by electron-builder until both jobs complete; once both are green, edit the release and click "Publish release" (or set `releaseType: prerelease` in `electron-builder.yml` to auto-publish).
