"""Routes: /diag, /health, /v1/models.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import functools
import hmac
import os
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request

import brain_client
import bridge_config
import bridge_providers
import bridge_state
import bridge_workspace
from bridge_config import HERMES_BRIDGE_VERSION
from bridge_providers import (
    _cli_config_is_custom,
    DEFAULT_MODEL,
    _default_model_credentialed,
    _get_agent_models,
    _synthetic_cli_provider_id,
)
from provider_config import _PROVIDER_CONFIG

router = APIRouter()

_RELEASE_DATE_RE = re.compile(r'^__release_date__\s*=\s*["\']([^"\']+)["\']', re.MULTILINE)


@functools.lru_cache(maxsize=1)
def _hermes_agent_version() -> Optional[str]:
    """The installed hermes-agent release (e.g. ``"2026.9.24"``), or None.

    Read once per process from ``hermes_cli/__init__.py``'s ``__release_date__``
    — the value hermes release tags are cut from (tag ``v2026.9.24``). The file is
    parsed as text rather than imported: importing ``hermes_cli`` reconfigures
    stdio, and the package metadata version is a ``0.0.0`` placeholder on the
    editable checkouts Spark installs. Caching per process is correct because the
    supervisor restarts the bridge after an update and compares this field
    (server/lib/hermes-agent-update.ts ``restartBridgeAndVerify``).
    """
    agent_dir = Path(
        os.environ.get("HERMES_AGENT_DIR") or os.path.expanduser("~/.hermes/hermes-agent")
    )
    try:
        text = (agent_dir / "hermes_cli" / "__init__.py").read_text(encoding="utf-8")
    except OSError:
        return None
    match = _RELEASE_DATE_RE.search(text)
    return match.group(1).strip() if match else None


@router.get("/diag")
async def diag(request: Request):
    # Ownership check for the supervisor. /diag is auth-exempt, so it must never
    # disclose the launch token itself (any local process could read it and then
    # pass the loopback token gate). Instead the caller proves it holds the token
    # and gets back only whether it matched (constant-time compare).
    token = bridge_config.HERMES_BRIDGE_TOKEN
    presented = request.headers.get("x-hermes-bridge-token", "")
    return {
        "pid": os.getpid(),
        "bridge_version": HERMES_BRIDGE_VERSION,
        "hermes_agent_version": _hermes_agent_version(),
        "launch_token_present": bool(token),
        "token_matches": bool(token) and bool(presented)
        and hmac.compare_digest(presented.encode(), token.encode()),
    }


@router.get("/health")
async def health(request: Request):
    # Profile-aware: honor X-Hermes-Profile like /v1/providers and chat do so
    # detectHermesBridge.hasAnyCreds matches the active profile's config.yaml.
    profile_name = bridge_workspace._resolve_profile_name(request)
    profile_home = bridge_workspace._resolve_hermes_home(profile_name)
    cfg = bridge_providers._load_cli_model_config(profile_home)

    # Check credential availability for all configured providers
    provider_credentials: dict[str, bool] = {}
    for pid in _PROVIDER_CONFIG:
        provider_credentials[pid] = bridge_providers._provider_has_credentials(pid)

    cursor_composer = bridge_workspace._cursor_composer_integration_status(hermes_home=profile_home)

    hermes_provider = None
    hermes_base_url = (cfg.get("base_url") or "").strip() or None
    if _cli_config_is_custom(cfg):
        hermes_provider = _synthetic_cli_provider_id(cfg)
    else:
        p = (cfg.get("provider") or "").strip().lower()
        if p:
            hermes_provider = p

    return {
        "status": "ok",
        "has_openrouter_creds": provider_credentials.get("openrouter", False),
        "has_minimax_creds": provider_credentials.get("minimax", False),
        "provider_credentials": provider_credentials,
        "default_model_credentialed": _default_model_credentialed(profile_home),
        "cursor_composer_bridge": cursor_composer,
        "launch_token_present": bool(bridge_config.HERMES_BRIDGE_TOKEN),
        "brain_initialized": brain_client._brain_initialized,
        "active_requests": bridge_state._bridge_active_requests,
        # Read ~/.hermes/config.yaml on every call so the Electron app observes
        # `hermes model` CLI changes without requiring a bridge restart. Falls
        # back to the startup-cached DEFAULT_MODEL if the config file is missing
        # or unreadable. The file read is tiny (~KB) and only happens on this
        # endpoint, which is polled at low rates by the UI.
        "hermes_default_model": (cfg.get("default") or "").strip() or DEFAULT_MODEL,
        # Surface active CLI custom endpoint so the UI can show provider/host
        # without a separate /v1/providers fetch.
        "hermes_provider": hermes_provider,
        "hermes_base_url": hermes_base_url,
    }


@router.get("/v1/models")
async def list_models():
    models = await _get_agent_models()
    return {"object": "list", "data": models}
