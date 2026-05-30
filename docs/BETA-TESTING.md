# Spark Desktop Install Guide

This guide covers how users install Spark on macOS and Windows, plus the maintainer steps required to ship cross-platform desktop releases.

## What this app is

Spark is a desktop AI client built around the **Hermes Agent** — an autonomous AI that can read code, edit files, browse the web, and manage GitHub PRs.

## Install

### User prerequisites

- **macOS (Apple Silicon or Intel), Windows 10/11 x64, or Linux x64**.
- **Git** only if Spark needs to download Hermes Agent on first launch. macOS has it via Xcode CLT (`xcode-select --install`); on Windows, install [Git for Windows](https://git-scm.com/download/win).

### macOS (Apple Silicon — M1/M2/M3/M4)

1. Go to [Releases](https://github.com/DevvGwardo/cloud-chat-hub/releases) and download the latest `Spark-x.y.z-arm64-mac.dmg`.
2. Open the DMG and drag Spark to Applications.
3. **First launch**: macOS may block the app if the build is unsigned or not notarized yet. Two options:
   - Right-click Spark in Applications → **Open** → click "Open" in the dialog.
   - Or, if Gatekeeper still complains: open Terminal and run:
     ```sh
     xattr -cr /Applications/Spark.app
     ```
     Then launch normally.

### macOS (Intel)

1. Download the latest `Spark-x.y.z-x64-mac.dmg` from [Releases](https://github.com/DevvGwardo/cloud-chat-hub/releases).
2. Open the DMG and drag Spark to Applications.
3. First launch follows the same Gatekeeper steps as Apple Silicon above.

Intel builds now ship a native x64 Python runtime, so the bundled bridge runs without a separate Python install.

### Windows

1. Download the latest `Spark-x.y.z-win.exe` from [Releases](https://github.com/DevvGwardo/cloud-chat-hub/releases).
2. Run the installer. If the build is unsigned, SmartScreen warns "Unknown publisher" — click **More info** → **Run anyway**. Signed builds install without the warning.
3. Follow the installer prompts.

### Linux (x64)

1. Download the latest `Spark-x.y.z-linux-*.AppImage` or `Spark-x.y.z-linux-*.deb` from [Releases](https://github.com/DevvGwardo/cloud-chat-hub/releases).
2. **AppImage:** `chmod +x Spark-*.AppImage` then run it. **`.deb`:** `sudo apt install ./Spark-*.deb`.
3. The build bundles an x64 Python runtime; basic chat works out of the box. For agent mode on an unusual distro, having system Python 3.10+ available is a safe fallback.

### First-run setup

Spark ships with a portable Python interpreter and the Hermes bridge built in. On first launch:

1. **If `~/.hermes/hermes-agent` is already installed** (you've used the Hermes CLI before), Spark detects it and skips the install step entirely.
2. **Otherwise**, a setup checklist appears with four rows, each showing a specific status:
   - ✓ **Python interpreter** — bundled, the existing hermes-agent venv, or your system Python
   - ✓ **Git** — only needed if Hermes Agent must be downloaded
   - ⬇ **Bridge dependencies** — one click installs FastAPI/uvicorn/httpx/pydantic to `~/.hermes/cloudchat-pkgs/`
   - ⬇ **Hermes Agent** — one click clones [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) and installs its deps (~1–3 min)
   A status chip in the modal footer additionally shows the bridge process health: **Running**, **Starting…**, **Stopped**, or **Crashed**.
3. If everything is already installed but the bridge is simply offline, Spark now offers a direct **Start bridge** recovery path instead of telling the user to reinstall Hermes.
4. Once the bridge is healthy, the regular setup wizard appears and walks you through entering an API key for at least one provider.

You'll need an API key for one of: OpenRouter, Anthropic, OpenAI, MiniMax, or any of the supported providers. **OpenRouter is the easiest — one key gets you most models.**

Nothing Spark installs ever leaves `~/.hermes/`. To uninstall everything, delete that directory (along with the app).

## Reporting issues

**Easiest:** Click the "Report Issue" button in the app (bottom-left of the chat panel). It opens a GitHub issue with your version, OS, and recent errors pre-filled.

**Direct:** <https://github.com/DevvGwardo/cloud-chat-hub/issues/new/choose>

Three templates:
- **Bug Report** — something is broken
- **Feature Request** — something you wish it could do
- **Beta Feedback** — open-ended reactions, friction, ideas

## Auto-updates

Spark checks for updates on launch. When a new release is available, you'll see a "Restart to update" prompt.

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

Your API keys live on your machine in `~/.hermes/auth.json` and never leave it. Chat content is sent to whatever provider you've selected — see their respective privacy policies. Spark itself collects no telemetry in beta.

## Thanks

Thanks for testing it carefully and reporting rough edges.

---

## Maintainer setup (one-time)

This section is for the project maintainer, not testers.

### 1. Decide whether releases are private or public

- **Private repo:** add users as collaborators with **Read** access so they can download releases and file issues.
- **Public repo:** skip this step. Anyone can download releases.

### 2. Generate the auto-update PAT

If the repo is private, the shipped app needs a token to fetch updates from GitHub Releases:

1. Go to <https://github.com/settings/personal-access-tokens/new>
2. **Token name**: `cloudchat-auto-update`
3. **Expiration**: 1 year (or whatever your security policy allows)
4. **Repository access**: Only `DevvGwardo/cloud-chat-hub`
5. **Permissions**: Repository → **Contents: Read-only** (and Metadata: Read-only, which is automatic)
6. Generate and copy the token (starts with `github_pat_…`)
7. In the repo: `Settings → Secrets and variables → Actions → New repository secret`
   - Name: `CLOUDCHAT_UPDATE_TOKEN`
   - Value: paste the token

This token is baked into every build. If it leaks, anyone with it can read the repo contents exposed by that token. Rotate it by repeating the steps above and pushing a new release.

If the repo becomes public, remove the private-repo updater assumptions from the build before shipping broadly.

### 3. Cut a cross-platform release

```sh
# Bump version in package.json (e.g. 1.0.0 → 1.0.0-beta.1)
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1
```

The tag push triggers `.github/workflows/release.yml`, which builds macOS (arm64 + Intel), Windows, and Linux in parallel and publishes to <https://github.com/DevvGwardo/cloud-chat-hub/releases>.

Before sharing a release, confirm it contains:
- `Spark-x.y.z-arm64-mac.dmg` and `Spark-x.y.z-x64-mac.dmg`
- the matching macOS `.zip` files used by auto-update (one per arch)
- `Spark-x.y.z-win.exe`
- `Spark-x.y.z-linux-*.AppImage` and `Spark-x.y.z-linux-*.deb`

The release may be marked as **Draft** by electron-builder until all jobs complete. Publish it only after every platform build is green and the expected artifacts are present.

> **Auto-update caveat:** the arm64 and x64 macOS jobs each publish their own `latest-mac.yml` to the same release, so they overwrite each other. Whichever finishes last wins, and the other arch's app may not self-update cleanly — Intel users should reinstall from Releases if an update fails. Apple Silicon, Windows, and Linux each have their own non-conflicting update manifest.

### 4. Current support matrix

- **macOS Apple Silicon (arm64):** first-class desktop target
- **macOS Intel (x64):** native build with a bundled x64 Python runtime
- **Windows 10/11 x64:** supported; unsigned unless `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` secrets are configured
- **Linux x64:** AppImage + `.deb`, the newest target and least battle-tested

### 5. Windows code signing (optional)

To remove the SmartScreen "Unknown publisher" warning, add a code-signing certificate as repo secrets:

- `WIN_CSC_LINK` — the base64-encoded `.pfx` certificate
- `WIN_CSC_KEY_PASSWORD` — its export password

`release.yml` passes these to electron-builder only on the Windows job. With them unset, Windows builds ship unsigned (current behavior).

### 6. Recommended pre-share checklist

- Install the arm64 DMG on a clean Apple Silicon Mac and the x64 DMG on a clean Intel Mac
- Install the Windows `.exe` on a clean Windows 10/11 x64 machine
- Install the AppImage and `.deb` on a clean Linux x64 machine
- Verify first-run bridge setup succeeds on each platform
- Verify a user can complete provider setup with a fresh API key
- Verify the release notes explain any signing or SmartScreen/Gatekeeper warnings
