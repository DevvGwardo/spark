"""Routes: /v1/providers and /moa.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import bridge_providers
import bridge_workspace
from bridge_workspace import _ops_thread
from bridge_providers import _cli_custom_provider_row, DEFAULT_MODEL
from moa_config import (
    _enabled_moa_preset_names,
    MOA_PROVIDER_ID,
    MOA_PROVIDER_NAME,
    _save_moa_config,
)
from provider_config import _PROVIDER_CONFIG

logger = logging.getLogger(__name__)
router = APIRouter()


def _load_provider_visibility(hermes_home: Optional[Path] = None) -> dict:
    """Read Hermes 0.19 provider hide flags from config.yaml.

    Returns ``{"excluded": set[str], "disabled": set[str]}`` where
    ``excluded`` comes from ``model_catalog.excluded_providers`` and
    ``disabled`` from ``providers.<name>.enabled: false``.
    """
    excluded: set[str] = set()
    disabled: set[str] = set()
    try:
        config_path = (hermes_home or Path.home() / ".hermes") / "config.yaml"
        if not config_path.is_file():
            return {"excluded": excluded, "disabled": disabled}
        try:
            import yaml
            with open(config_path) as f:
                cfg = yaml.safe_load(f) or {}
        except ImportError:
            return {"excluded": excluded, "disabled": disabled}
        if not isinstance(cfg, dict):
            return {"excluded": excluded, "disabled": disabled}

        catalog = cfg.get("model_catalog") or {}
        if isinstance(catalog, dict):
            raw_excluded = catalog.get("excluded_providers") or []
            if isinstance(raw_excluded, list):
                excluded = {
                    str(item).strip().lower()
                    for item in raw_excluded
                    if str(item).strip()
                }

        providers = cfg.get("providers") or {}
        if isinstance(providers, dict):
            for name, block in providers.items():
                pid = str(name).strip().lower()
                if not pid or not isinstance(block, dict):
                    continue
                flag = block.get("enabled", True)
                enabled = True
                if isinstance(flag, bool):
                    enabled = flag
                elif isinstance(flag, str):
                    enabled = flag.strip().lower() not in {"false", "0", "no", "off"}
                else:
                    enabled = bool(flag)
                if not enabled:
                    disabled.add(pid)
    except Exception:  # noqa: BLE001 - best-effort config read; nothing is excluded or disabled on failure
        logger.debug("provider visibility config read failed; using defaults", exc_info=True)
    return {"excluded": excluded, "disabled": disabled}


@router.get("/v1/providers")
async def list_providers(request: Request):
    """See ``_list_providers_payload``; run off the event loop (spec 5.1)."""
    # Credential checks read config/auth files and probe the local
    # cursor-composer bridge over HTTP (urllib, up to 2s).
    return await _ops_thread(_list_providers_payload, request)


def _list_providers_payload(request: Request):
    """List configured providers with credential status and known models.

    Profile-aware: honors `X-Hermes-Profile` (like chat requests do) so the
    reported default model/provider reflects the active profile's config.yaml,
    falling back to the global ~/.hermes config for unset values.

    When `hermes model` selected a custom base_url (provider: custom / opencode /
    bullinf / etc.), that endpoint is exposed as a synthetic credentialed row and
    becomes default_provider — never silently rewritten to openrouter.
    """
    profile_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    profile_cfg = bridge_providers._load_cli_model_config(profile_home)
    global_cfg = bridge_providers._load_cli_model_config()
    # Prefer the profile's model block when it has a base_url/default; otherwise
    # fall back field-by-field so partial profile configs still work.
    active_cfg = {
        "default": profile_cfg.get("default") or global_cfg.get("default"),
        "provider": profile_cfg.get("provider") or global_cfg.get("provider"),
        "base_url": profile_cfg.get("base_url") or global_cfg.get("base_url"),
        "api_key": profile_cfg.get("api_key") or global_cfg.get("api_key"),
    }
    cfg_provider = (active_cfg.get("provider") or "").strip().lower()
    cli_custom_row = _cli_custom_provider_row(active_cfg, profile_home)
    if cfg_provider and (cfg_provider in _PROVIDER_CONFIG or cfg_provider == MOA_PROVIDER_ID):
        default_provider = cfg_provider
    elif cli_custom_row:
        default_provider = cli_custom_row["id"]
    else:
        default_provider = "openrouter"
    profile_moa_config = bridge_providers._load_moa_config(profile_home)
    global_moa_config = bridge_providers._load_moa_config()
    moa_config = profile_moa_config if _enabled_moa_preset_names(profile_moa_config) else global_moa_config
    moa_models = _enabled_moa_preset_names(moa_config)
    visibility = _load_provider_visibility(profile_home)
    hidden = visibility["excluded"] | visibility["disabled"]

    data = []
    if moa_models and MOA_PROVIDER_ID not in hidden:
        data.append({
            "id": MOA_PROVIDER_ID,
            "name": MOA_PROVIDER_NAME,
            "base_url": "virtual://moa",
            "is_aggregator": True,
            "credentialed": True,
            "models": moa_models,
            "default_model": moa_config.get("default_preset") or moa_models[0],
        })

    # Active CLI custom endpoint first so the picker surfaces the model the user
    # just set with `hermes model` above the built-in catalog.
    if cli_custom_row and cli_custom_row["id"] not in hidden:
        data.append(cli_custom_row)

    for pid, cfg in _PROVIDER_CONFIG.items():
        if pid in hidden:
            continue
        try:
            models = bridge_providers._models_for_provider(pid)
        except Exception:  # noqa: BLE001 - one broken provider must not break the list; shown with no models
            logger.debug("model listing failed for provider %s", pid, exc_info=True)
            models = []
        data.append({
            "id": pid,
            "name": cfg["name"],
            "base_url": cfg["base_url"],
            "is_aggregator": pid == "openrouter",
            "credentialed": bridge_providers._provider_has_credentials(pid),
            "models": models,
        })

    if default_provider in hidden:
        # Prefer an enabled credentialed provider so the picker default stays usable.
        fallback = next(
            (row["id"] for row in data if row.get("credentialed") and row["id"] != MOA_PROVIDER_ID),
            None,
        )
        default_provider = fallback or (data[0]["id"] if data else "openrouter")

    # The agent's CLI-configured default model (config.yaml `model.default`),
    # read fresh so a model change in the terminal is reflected by clients that
    # follow the agent default. Profile config wins over the global one.
    if default_provider == MOA_PROVIDER_ID:
        default_model = (
            profile_cfg.get("default")
            or global_cfg.get("default")
            or moa_config.get("default_preset")
            or (moa_models[0] if moa_models else "default")
        )
    else:
        default_model = (
            active_cfg.get("default")
            or (cli_custom_row or {}).get("default_model")
            or DEFAULT_MODEL
        )

    return {
        "object": "list",
        "default_provider": default_provider,
        "default_model": default_model,
        "data": data,
    }


@router.get("/moa")
async def get_moa_config(request: Request):
    """Return normalized Mixture-of-Agents presets for the active profile."""
    profile_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    profile_cfg = bridge_providers._load_moa_config(profile_home)
    # Fall back to global home when the profile has no presets yet
    if not _enabled_moa_preset_names(profile_cfg):
        profile_cfg = bridge_providers._load_moa_config()
    return {
        "object": "moa.config",
        "default_preset": profile_cfg.get("default_preset") or "default",
        "presets": profile_cfg.get("presets") or {},
        "preset_names": _enabled_moa_preset_names(profile_cfg),
    }


@router.put("/moa")
async def put_moa_config(request: Request):
    """Create/update MoA presets in the active profile's config.yaml."""
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})

    profile_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    try:
        saved = await _ops_thread(_save_moa_config, body, hermes_home=profile_home)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except Exception as exc:  # noqa: BLE001 - surfaced to the client as a 500
        print(f"[hermes-bridge] Failed to save MoA config: {exc}", flush=True)
        return JSONResponse(status_code=500, content={"error": f"Failed to save MoA config: {exc}"})

    return {
        "object": "moa.config",
        "default_preset": saved.get("default_preset") or "default",
        "presets": saved.get("presets") or {},
        "preset_names": _enabled_moa_preset_names(saved),
    }
