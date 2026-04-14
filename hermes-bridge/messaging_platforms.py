"""
Messaging Platform Configuration Manager for hermes-bridge.

Reads/writes platform credentials to ~/.hermes/.env and ~/.hermes/config.yaml.
Tracks connection status via gateway_state.json.
"""

import os
import re
import json
import subprocess
import urllib.parse
from pathlib import Path
from typing import Optional

_HERMES_HOME = Path(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")))
_ENV_PATH = _HERMES_HOME / ".env"
_CONFIG_PATH = _HERMES_HOME / "config.yaml"
_GATEWAY_STATE_PATH = _HERMES_HOME / "gateway_state.json"

# ─── Platform Definitions ───────────────────────────────────────────────
# Each platform defines:
#   env_vars: dict of {key: {required: bool, label: str, secret: bool, placeholder: str}}
#   config_keys: optional dict of {key: {label: str, type: str, default: Any}}
#   docs_url: link to hermes docs for this platform

PLATFORMS = {
    "telegram": {
        "name": "Telegram",
        "description": "Full-featured bot — text, voice, images, files, group chats",
        "icon": "telegram",
        "features": ["Voice", "Images", "Files", "Threads", "Typing", "Streaming"],
        "docs_url": "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram",
        "env_vars": {
            "TELEGRAM_BOT_TOKEN": {
                "required": True,
                "label": "Bot Token",
                "secret": True,
                "placeholder": "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ",
            },
            "TELEGRAM_ALLOWED_USERS": {
                "required": False,
                "label": "Allowed Users",
                "secret": False,
                "placeholder": "Comma-separated user IDs (empty = allow all)",
            },
            "TELEGRAM_HOME_CHANNEL": {
                "required": False,
                "label": "Home Channel",
                "secret": False,
                "placeholder": "Default chat ID for cron delivery",
            },
            "TELEGRAM_HOME_CHANNEL_NAME": {
                "required": False,
                "label": "Home Channel Name",
                "secret": False,
                "placeholder": "Display name for home channel",
            },
        },
        "config_keys": {},
    },
    "discord": {
        "name": "Discord",
        "description": "Bot with slash commands, threads, reactions, voice support",
        "icon": "discord",
        "features": ["Voice", "Images", "Files", "Threads", "Reactions", "Typing", "Streaming"],
        "docs_url": "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord",
        "env_vars": {
            "DISCORD_BOT_TOKEN": {
                "required": True,
                "label": "Bot Token",
                "secret": True,
                "placeholder": "MTIzNDU2Nzg5...",
            },
        },
        "config_keys": {
            "discord.require_mention": {
                "label": "Require @mention in channels",
                "type": "boolean",
                "default": True,
            },
            "discord.auto_thread": {
                "label": "Auto-create threads",
                "type": "boolean",
                "default": True,
            },
            "discord.reactions": {
                "label": "React to messages",
                "type": "boolean",
                "default": True,
            },
            "discord.allowed_channels": {
                "label": "Allowed Channels",
                "type": "string",
                "default": "",
                "placeholder": "Comma-separated channel IDs (empty = all)",
            },
            "discord.free_response_channels": {
                "label": "Free Response Channels",
                "type": "string",
                "default": "",
                "placeholder": "Channels where @mention not required",
            },
        },
    },
    "slack": {
        "name": "Slack",
        "description": "Workspace bot with apps, threads, and reactions",
        "icon": "slack",
        "features": ["Voice", "Images", "Files", "Threads", "Reactions", "Typing", "Streaming"],
        "docs_url": "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack",
        "env_vars": {
            "SLACK_BOT_TOKEN": {
                "required": True,
                "label": "Bot Token (xoxb-)",
                "secret": True,
                "placeholder": "xoxb-...",
            },
            "SLACK_APP_TOKEN": {
                "required": True,
                "label": "App Token (xapp-)",
                "secret": True,
                "placeholder": "xapp-...",
            },
            "SLACK_ALLOWED_USERS": {
                "required": False,
                "label": "Allowed Users",
                "secret": False,
                "placeholder": "Comma-separated user IDs (empty = allow all)",
            },
        },
        "config_keys": {},
    },
    "whatsapp": {
        "name": "WhatsApp",
        "description": "Message via WhatsApp — images, files, typing indicators",
        "icon": "whatsapp",
        "features": ["Images", "Files", "Typing", "Streaming"],
        "docs_url": "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp",
        "env_vars": {
            "WHATSAPP_ENABLED": {
                "required": False,
                "label": "Enabled",
                "secret": False,
                "placeholder": "true",
            },
            "WHATSAPP_ALLOWED_USERS": {
                "required": False,
                "label": "Allowed Users",
                "secret": False,
                "placeholder": "Comma-separated phone numbers",
            },
        },
        "config_keys": {},
        "setup_note": "WhatsApp uses your Twilio account's WhatsApp Business sandbox. Enable it at console.twilio.com → Messaging → Try it out → Send a WhatsApp message to activate.",
    },
    "signal": {
        "name": "Signal",
        "description": "Private messaging via signal-cli",
        "icon": "signal",
        "features": ["Images", "Files", "Typing", "Streaming"],
        "docs_url": "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/signal",
        "env_vars": {},
        "config_keys": {},
        "setup_note": "Requires signal-cli installed on your machine. Run: hermes gateway setup --platform signal",
    },
    "email": {
        "name": "Email",
        "description": "Send and receive emails via IMAP/SMTP",
        "icon": "email",
        "features": ["Files"],
        "docs_url": "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/email",
        "env_vars": {
            "EMAIL_ADDRESS": {
                "required": True,
                "label": "Email Address",
                "secret": False,
                "placeholder": "hermes@gmail.com",
            },
            "EMAIL_PASSWORD": {
                "required": True,
                "label": "App Password",
                "secret": True,
                "placeholder": "xxxx xxxx xxxx",
            },
            "EMAIL_IMAP_HOST": {
                "required": False,
                "label": "IMAP Host",
                "secret": False,
                "placeholder": "imap.gmail.com",
            },
            "EMAIL_IMAP_PORT": {
                "required": False,
                "label": "IMAP Port",
                "secret": False,
                "placeholder": "993",
            },
            "EMAIL_SMTP_HOST": {
                "required": False,
                "label": "SMTP Host",
                "secret": False,
                "placeholder": "smtp.gmail.com",
            },
            "EMAIL_SMTP_PORT": {
                "required": False,
                "label": "SMTP Port",
                "secret": False,
                "placeholder": "587",
            },
            "EMAIL_POLL_INTERVAL": {
                "required": False,
                "label": "Poll Interval (min)",
                "secret": False,
                "placeholder": "15",
            },
            "EMAIL_ALLOWED_USERS": {
                "required": False,
                "label": "Allowed Senders",
                "secret": False,
                "placeholder": "Comma-separated emails (empty = all)",
            },
        },
        "config_keys": {},
        "setup_note": "Use an App Password from your email provider. Gmail: myaccount.google.com → Security → 2-Step Verification → App passwords. Others: check your provider's SMTP/IMAP docs.",
    },
    "sms": {
        "name": "SMS (Twilio)",
        "description": "Send and receive SMS via Twilio",
        "icon": "sms",
        "features": [],
        "docs_url": "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/sms",
        "env_vars": {
            "TWILIO_ACCOUNT_SID": {
                "required": True,
                "label": "Account SID",
                "secret": False,
                "placeholder": "AC...",
            },
            "TWILIO_AUTH_TOKEN": {
                "required": True,
                "label": "Auth Token",
                "secret": True,
                "placeholder": "Your Twilio auth token",
            },
            "TWILIO_PHONE_NUMBER": {
                "required": True,
                "label": "Phone Number",
                "secret": False,
                "placeholder": "+123****7890",
            },
        },
        "config_keys": {},
        "setup_note": "Get your credentials at console.twilio.com. Account SID and Auth Token are on the dashboard. Phone Number is from the Active Numbers section.",
    },
    "teams": {
        "name": "Microsoft Teams",
        "description": "Bot messaging in Microsoft Teams via Bot Framework + Azure AD",
        "icon": "teams",
        "features": ["Channels", "Threads", "Files", "Typing", "Reactions"],
        "docs_url": "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/teams",
        "env_vars": {
            "TEAMS_CLIENT_ID": {
                "required": True,
                "label": "Azure AD Client ID",
                "secret": False,
                "placeholder": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            },
            "TEAMS_CLIENT_SECRET": {
                "required": True,
                "label": "Azure AD Client Secret",
                "secret": True,
                "placeholder": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            },
            "TEAMS_TENANT_ID": {
                "required": True,
                "label": "Azure AD Tenant ID",
                "secret": False,
                "placeholder": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            },
            "TEAMS_BOT_ID": {
                "required": True,
                "label": "Bot Framework Bot ID",
                "secret": False,
                "placeholder": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            },
        },
        "config_keys": {},
    },
    "mattermost": {
        "name": "Mattermost",
        "description": "Connect to self-hosted or cloud Mattermost workspaces",
        "icon": "mattermost",
        "features": ["Channels", "Threads", "Files", "Typing"],
        "docs_url": "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/mattermost",
        "env_vars": {
            "MATTERMOST_URL": {
                "required": True,
                "label": "Mattermost Server URL",
                "secret": False,
                "placeholder": "https://your-mattermost.example.com",
            },
            "MATTERMOST_TOKEN": {
                "required": True,
                "label": "Personal Access Token",
                "secret": True,
                "placeholder": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            },
            "MATTERMOST_TEAM": {
                "required": False,
                "label": "Default Team Name",
                "secret": False,
                "placeholder": "my-team",
            },
        },
        "config_keys": {},
        "setup_note": "Create a Personal Access Token in Mattermost: Profile → Security → Personal Access Tokens → Create New Token. Grant it read/write access to channels.",
    },
}


def _read_env_file() -> dict[str, str]:
    """Read ~/.hermes/.env into a dict. Returns empty dict if missing."""
    env: dict[str, str] = {}
    if not _ENV_PATH.exists():
        return env
    try:
        for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip().strip('"').strip("'")
    except Exception:
        pass
    return env


def _write_env_file(env: dict[str, str]) -> None:
    """Write dict back to ~/.hermes/.env, preserving comment lines and ordering."""
    if not _ENV_PATH.exists():
        _ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
        _ENV_PATH.write_text("", encoding="utf-8")

    lines = _ENV_PATH.read_text(encoding="utf-8").splitlines()
    new_lines: list[str] = []
    seen_keys: set[str] = set()

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            new_lines.append(line)
            continue
        if "=" in stripped:
            key, _, _ = stripped.partition("=")
            key = key.strip()
            if key in env:
                new_lines.append(f'{key}={env[key]}')
                seen_keys.add(key)
            # Drop removed keys entirely
        else:
            new_lines.append(line)

    # Append new keys that weren't in the file
    for key, value in env.items():
        if key not in seen_keys:
            new_lines.append(f"{key}={value}")

    _ENV_PATH.write_text("\n".join(new_lines) + "\n", encoding="utf-8")


def _read_yaml_config() -> dict:
    """Read ~/.hermes/config.yaml. Minimal YAML parser for flat keys."""
    if not _CONFIG_PATH.exists():
        return {}
    try:
        import yaml
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except ImportError:
        # Fallback: basic key: value parsing
        config: dict = {}
        try:
            for line in _CONFIG_PATH.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if ":" in line:
                    key, _, value = line.partition(":")
                    key = key.strip()
                    value = value.strip().strip('"').strip("'")
                    if value.lower() == "true":
                        config[key] = True
                    elif value.lower() == "false":
                        config[key] = False
                    else:
                        config[key] = value
        except Exception:
            pass
        return config
    except Exception:
        return {}


def _get_nested(config: dict, dotted_key: str, default=None):
    """Get a nested value from dict using dotted key like 'discord.require_mention'."""
    parts = dotted_key.split(".")
    current = config
    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return default
    return current if current is not None else default


def _set_nested(config: dict, dotted_key: str, value) -> None:
    """Set a nested value in dict using dotted key."""
    parts = dotted_key.split(".")
    current = config
    for part in parts[:-1]:
        if part not in current or not isinstance(current[part], dict):
            current[part] = {}
        current = current[part]
    current[parts[-1]] = value


def _write_yaml_config(config: dict) -> None:
    """Write config dict back to ~/.hermes/config.yaml."""
    try:
        import yaml
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(_CONFIG_PATH, "w", encoding="utf-8") as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    except ImportError:
        # Fallback: won't handle nested well but won't crash
        print("[messaging] PyYAML not installed — config.yaml may lose formatting", flush=True)


def _read_gateway_state() -> dict:
    """Read gateway_state.json for platform status."""
    if not _GATEWAY_STATE_PATH.exists():
        return {"platforms": {}}
    try:
        return json.loads(_GATEWAY_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"platforms": {}}


def get_platform_status(platform_name: str) -> dict:
    """Get connection status for a platform from gateway state."""
    state = _read_gateway_state()
    platforms = state.get("platforms", {})
    return platforms.get(platform_name, {})


def list_platforms() -> list[dict]:
    """List all platforms with their connection status and configured fields."""
    env = _read_env_file()
    config = _read_yaml_config()
    gateway_state = _read_gateway_state()
    gateway_platforms = gateway_state.get("platforms", {})
    gateway_running = gateway_state.get("gateway_state") == "running"

    result = []
    for platform_id, platform_def in PLATFORMS.items():
        # Check how many env vars are configured
        configured_count = 0
        total_required = 0
        has_secrets = False
        fields = {}

        for env_key, env_def in platform_def["env_vars"].items():
            value = env.get(env_key, "")
            is_set = bool(value)
            if is_set:
                configured_count += 1
                has_secrets = has_secrets or env_def["secret"]
            if env_def["required"]:
                total_required += 1

            fields[env_key] = {
                "value": "••••••" if (is_set and env_def["secret"]) else value,
                "is_set": is_set,
                "is_secret": env_def["secret"],
                "required": env_def["required"],
                "label": env_def["label"],
                "placeholder": env_def["placeholder"],
            }

        # Check config keys
        for config_key, config_def in platform_def.get("config_keys", {}).items():
            value = _get_nested(config, config_key, config_def.get("default"))
            fields[config_key] = {
                "value": value if value is not None else config_def.get("default"),
                "is_set": value is not None,
                "is_secret": False,
                "required": False,
                "label": config_def["label"],
                "type": config_def["type"],
            }

        # Determine connection state
        is_connected = configured_count >= total_required and total_required > 0
        platform_gateway = gateway_platforms.get(platform_id, {})
        gateway_active = platform_gateway.get("status") == "connected" if platform_gateway else False

        result.append({
            "id": platform_id,
            "name": platform_def["name"],
            "description": platform_def["description"],
            "icon": platform_def["icon"],
            "features": platform_def["features"],
            "docs_url": platform_def.get("docs_url", ""),
            "setup_note": platform_def.get("setup_note"),
            "configured_fields": configured_count,
            "total_required": total_required,
            "is_connected": is_connected,
            "gateway_active": gateway_active,
            "gateway_running": gateway_running,
            "has_secrets": has_secrets,
            "fields": fields,
        })

    return result


def get_platform(platform_id: str) -> Optional[dict]:
    """Get a single platform's config and status."""
    platforms = list_platforms()
    for p in platforms:
        if p["id"] == platform_id:
            return p
    return None


def update_platform_env(platform_id: str, updates: dict[str, str]) -> dict:
    """Update environment variables for a platform.

    Args:
        platform_id: Platform identifier (telegram, discord, etc.)
        updates: Dict of {env_key: value}. Empty string value removes the key.

    Returns:
        Updated platform config.
    """
    if platform_id not in PLATFORMS:
        raise ValueError(f"Unknown platform: {platform_id}")

    platform_def = PLATFORMS[platform_id]
    valid_keys = set(platform_def["env_vars"].keys())

    # Validate
    for key in updates:
        if key not in valid_keys:
            raise ValueError(f"Invalid env var '{key}' for platform '{platform_id}'")

    # Read current env
    env = _read_env_file()

    # Apply updates (empty string = remove)
    for key, value in updates.items():
        value = value.strip()
        if value:
            env[key] = value
        else:
            env.pop(key, None)

    # Write back
    _write_env_file(env)

    return get_platform(platform_id)


def update_platform_config(platform_id: str, updates: dict[str, any]) -> dict:
    """Update config.yaml keys for a platform.

    Args:
        platform_id: Platform identifier
        updates: Dict of {dotted_config_key: value}

    Returns:
        Updated platform config.
    """
    if platform_id not in PLATFORMS:
        raise ValueError(f"Unknown platform: {platform_id}")

    platform_def = PLATFORMS[platform_id]
    valid_keys = set(platform_def.get("config_keys", {}).keys())

    for key in updates:
        if key not in valid_keys:
            raise ValueError(f"Invalid config key '{key}' for platform '{platform_id}'")

    config = _read_yaml_config()
    for key, value in updates.items():
        _set_nested(config, key, value)

    _write_yaml_config(config)

    return get_platform(platform_id)


def disconnect_platform(platform_id: str) -> dict:
    """Remove all env vars and config keys for a platform."""
    if platform_id not in PLATFORMS:
        raise ValueError(f"Unknown platform: {platform_id}")

    platform_def = PLATFORMS[platform_id]

    # Remove env vars
    env = _read_env_file()
    for key in platform_def["env_vars"]:
        env.pop(key, None)
    _write_env_file(env)

    # Remove config keys
    config = _read_yaml_config()
    for key in platform_def.get("config_keys", {}):
        parts = key.split(".")
        current = config
        for part in parts[:-1]:
            current = current.get(part, {})
            if not isinstance(current, dict):
                break
        else:
            current.pop(parts[-1], None)
    _write_yaml_config(config)

    return get_platform(platform_id)


def test_platform_connection(platform_id: str) -> dict:
    """Test if a platform can connect. Runs hermes gateway status check."""
    if platform_id not in PLATFORMS:
        raise ValueError(f"Unknown platform: {platform_id}")

    env = _read_env_file()
    platform_def = PLATFORMS[platform_id]

    # Check required vars are set
    missing = []
    for key, var_def in platform_def["env_vars"].items():
        if var_def["required"] and not env.get(key):
            missing.append(var_def["label"])

    if missing:
        return {
            "success": False,
            "error": f"Missing required fields: {', '.join(missing)}",
        }

    # Check gateway status
    state = _read_gateway_state()
    if state.get("gateway_state") != "running":
        return {
            "success": False,
            "error": "Hermes gateway is not running. Start it with: hermes gateway start",
        }

    platform_status = state.get("platforms", {}).get(platform_id, {})
    if platform_status.get("status") == "connected":
        return {
            "success": True,
            "message": f"{platform_def['name']} is connected and active",
            "status": platform_status,
        }

    return {
        "success": True,
        "message": f"Credentials configured. Restart gateway to connect: hermes gateway restart",
        "status": platform_status,
    }


# ─── OAuth 1-Click Setup ──────────────────────────────────────────────────
# Platforms that support OAuth2 have their own app registration flow.
# The bridge acts as an OAuth callback receiver so tokens never hit the browser.

DISCORD_OAUTH_URL = "https://discord.com/api/oauth2/authorize"
DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token"
DISCORD_API_URL = "https://discord.com/api/v10"

SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize"
SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access"
SLACK_API_URL = "https://slack.com/api"

# Microsoft Teams via Azure AD / Bot Framework
TEAMS_AUTHORITY_URL = "https://login.microsoftonline.com"
TEAMS_TOKEN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
TEAMS_API_URL = "https://graph.microsoft.com/v1.0"

# Mattermost (no OAuth in most self-hosted deployments — uses Personal Access Token)
MATTERMOST_API_SUFFIX = "/api/v4"

# OAuth callback port — must match the port the bridge is running on.
# The bridge defaults to 3002. Set HERMES_CALLBACK_PORT env var to override.
CALLBACK_PORT = int(os.environ.get("HERMES_CALLBACK_PORT", os.environ.get("HERMES_PORT", "3002")))


def build_discord_oauth_url() -> str:
    """Build the Discord OAuth2 authorization URL for bot token flow."""
    client_id = os.environ.get("DISCORD_CLIENT_ID", "")
    redirect_uri = f"http://localhost:{CALLBACK_PORT}/discord/callback"
    # Bot scope for bot token flow
    scopes = "bot"
    # 0 = let server owner configure exact permissions in Developer Portal
    permissions = "0"
    return (
        f"{DISCORD_OAUTH_URL}"
        f"?client_id={client_id}"
        f"&redirect_uri={redirect_uri}"
        f"&scope={scopes}"
        f"&response_type=code"
        f"&permissions={permissions}"
    )


def build_slack_oauth_url() -> str:
    """Build the Slack OAuth2 authorization URL."""
    client_id = os.environ.get("SLACK_CLIENT_ID", "")
    redirect_uri = f"http://localhost:{CALLBACK_PORT}/slack/callback"
    scopes = "chat:write,channels:read,groups:read,im:read,im:write,mpim:read,mpim:write,app_mentions:read,reactions:read,reactions:write,files:read,files:write,users:read"
    return (
        f"{SLACK_OAUTH_URL}"
        f"?client_id={client_id}"
        f"&redirect_uri={redirect_uri}"
        f"&scope={scopes}"
        f"&response_type=code"
    )


def exchange_discord_code(code: str) -> dict:
    """Exchange a Discord OAuth code for a bot token."""
    import urllib.request
    import urllib.parse

    client_id = os.environ.get("DISCORD_CLIENT_ID", "")
    client_secret = os.environ.get("DISCORD_CLIENT_SECRET", "")
    redirect_uri = f"http://localhost:{CALLBACK_PORT}/discord/callback"

    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }).encode()

    req = urllib.request.Request(
        DISCORD_TOKEN_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        token_data = json.loads(resp.read())

    if "access_token" not in token_data:
        raise RuntimeError(f"Discord OAuth failed: {token_data.get('error_description', token_data)}")

    # Bot token is in the `access_token` field for bot flows
    bot_token = token_data.get("access_token")
    return {"bot_token": bot_token}


def exchange_slack_code(code: str) -> dict:
    """Exchange a Slack OAuth code for bot and app tokens."""
    import urllib.request
    import urllib.parse

    client_id = os.environ.get("SLACK_CLIENT_ID", "")
    client_secret = os.environ.get("SLACK_CLIENT_SECRET", "")
    redirect_uri = f"http://localhost:{CALLBACK_PORT}/slack/callback"

    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }).encode()

    req = urllib.request.Request(
        SLACK_TOKEN_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        token_data = json.loads(resp.read())

    if not token_data.get("ok"):
        raise RuntimeError(f"Slack OAuth failed: {token_data.get('error', 'unknown error')}")

    bot_token = token_data.get("bot_access_token") or token_data.get("access_token", "")
    app_token = token_data.get("authed_user", {}).get("access_token", "") or token_data.get("app_token", "")

    return {"bot_token": bot_token, "app_token": app_token}


# ─── Microsoft Teams OAuth ─────────────────────────────────────────────────

def build_teams_oauth_url() -> str:
    """Build the Microsoft/Azure AD authorization URL for Teams bot.

    Scopes needed:
      - https://graph.microsoft.com/BotChat.ReadWrite (bot messaging)
      - offline_access (refresh token)
    """
    client_id = os.environ.get("TEAMS_CLIENT_ID", "")
    tenant_id = os.environ.get("TEAMS_TENANT_ID", "")
    redirect_uri = f"http://localhost:{CALLBACK_PORT}/teams/callback"
    # Use common endpoint so any tenant can authenticate, or specific tenant
    authority = TEAMS_AUTHORITY_URL
    if tenant_id:
        authority = f"{TEAMS_AUTHORITY_URL}/{tenant_id}"
    # Build MSAL-style authorization URL
    auth_url = (
        f"{authority}/oauth2/v2.0/authorize"
        f"?client_id={client_id}"
        f"&response_type=code"
        f"&redirect_uri={urllib.parse.quote(redirect_uri, safe='')}"
        f"&scope=https%3A%2F%2Fgraph.microsoft.com%2FBotChat.ReadWrite%20offline_access"
        f"&response_mode=query"
    )
    return auth_url


def exchange_teams_code(code: str) -> dict:
    """Exchange a Microsoft/Azure AD OAuth code for an access token.

    For Teams bots the access token IS the bot token used with the
    Bot Framework Direct Line / WebSocket API.
    """
    import urllib.request
    import urllib.parse

    client_id = os.environ.get("TEAMS_CLIENT_ID", "")
    client_secret = os.environ.get("TEAMS_CLIENT_SECRET", "")
    tenant_id = os.environ.get("TEAMS_TENANT_ID", "common")
    redirect_uri = f"http://localhost:{CALLBACK_PORT}/teams/callback"

    token_url = TEAMS_TOKEN_URL.replace("{tenant}", tenant_id)

    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "scope": "https://graph.microsoft.com/BotChat.ReadWrite offline_access",
    }).encode()

    req = urllib.request.Request(
        token_url,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        token_data = json.loads(resp.read())

    if "access_token" not in token_data:
        raise RuntimeError(f"Teams OAuth failed: {token_data.get('error_description', token_data)}")

    return {
        "access_token": token_data.get("access_token"),
        "refresh_token": token_data.get("refresh_token", ""),
    }


def get_oauth_status(platform_id: str) -> dict:
    """Return the OAuth setup status and authorization URL for a platform."""
    if platform_id == "discord":
        client_id = os.environ.get("DISCORD_CLIENT_ID", "")
        if not client_id:
            return {
                "available": False,
                "error": "DISCORD_CLIENT_ID not set. Set it in ~/.hermes/.env to enable 1-click Discord setup.",
            }
        url = build_discord_oauth_url()
        return {"available": True, "auth_url": url, "platform": "Discord"}

    if platform_id == "slack":
        client_id = os.environ.get("SLACK_CLIENT_ID", "")
        if not client_id:
            return {
                "available": False,
                "error": "SLACK_CLIENT_ID not set. Set it in ~/.hermes/.env to enable 1-click Slack setup.",
            }
        url = build_slack_oauth_url()
        return {"available": True, "auth_url": url, "platform": "Slack"}

    return {"available": False, "error": f"Platform '{platform_id}' does not support OAuth."}


def complete_oauth(platform_id: str, code: str) -> dict:
    """Exchange an OAuth code for tokens and save them to the env file."""
    if platform_id == "discord":
        result = exchange_discord_code(code)
        update_platform_env("discord", {"DISCORD_BOT_TOKEN": result["bot_token"]})
        return {"success": True, "message": "Discord bot token saved!"}

    if platform_id == "slack":
        result = exchange_slack_code(code)
        updates = {"SLACK_BOT_TOKEN": result["bot_token"]}
        if result.get("app_token"):
            updates["SLACK_APP_TOKEN"] = result["app_token"]
        update_platform_env("slack", updates)
        return {"success": True, "message": "Slack tokens saved!"}

    raise ValueError(f"Platform '{platform_id}' does not support OAuth.")
