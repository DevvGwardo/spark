"""Routes: /diag, /health, /v1/models.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import os

from fastapi import APIRouter, Request

import brain_client
import bridge_config
import bridge_providers
import bridge_state
import bridge_workspace
from bridge_config import HERMES_BRIDGE_VERSION, _is_loopback_host
from bridge_providers import (
    _cli_config_is_custom,
    DEFAULT_MODEL,
    _default_model_credentialed,
    _get_agent_models,
    _synthetic_cli_provider_id,
)
from provider_config import _PROVIDER_CONFIG

router = APIRouter()


@router.get("/diag")
async def diag(request: Request):
    # Only expose the launch token to loopback callers (Electron ownership check).
    # Non-loopback clients get a boolean presence flag only.
    payload = {
        "pid": os.getpid(),
        "home": os.path.expanduser("~"),
        "bridge_version": HERMES_BRIDGE_VERSION,
        "launch_token_present": bool(bridge_config.HERMES_BRIDGE_TOKEN),
    }
    client_host = request.client.host if request.client else None
    if _is_loopback_host(client_host):
        payload["token"] = bridge_config.HERMES_BRIDGE_TOKEN
    return payload


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
