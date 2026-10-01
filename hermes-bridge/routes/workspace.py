"""Routes: /workspace commands, auth providers, overview, usage and files; /bridges.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import json
import os
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import bridge_workspace
from bridge_workspace import (
    _canonical_file_entry,
    _canonical_files,
    HermesWorkspaceFileUpdate,
    _list_canonical_files,
    _load_hermes_agent_commands,
    _workspace_overview_payload,
    _workspace_usage_payload,
)

router = APIRouter()


@router.get("/workspace/commands")
async def workspace_commands(request: Request):
    """List the hermes-agent slash commands available to the CloudChat menu."""
    return JSONResponse(content={"commands": _load_hermes_agent_commands()})


def _load_hermes_saved_providers() -> list:
    """List the providers the user has saved/authenticated in the hermes-agent
    (~/.hermes/auth.json: credential_pool + OAuth providers block), with a
    derived status. Read-only, for display in the CloudChat settings UI.
    Returns [] if the auth store is unavailable."""
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
    except Exception:
        return []

    try:
        from hermes_cli.auth import get_auth_provider_display_name as _display
    except Exception:
        _display = None

    def name_for(pid: str, label: str) -> str:
        if _display:
            try:
                n = _display(pid)
                if n and n != pid:
                    return n
            except Exception:
                pass
        return label or pid

    active = (auth.get("active_provider") or "").strip()
    pool = auth.get("credential_pool", {}) or {}
    oauth_block = auth.get("providers", {}) or {}

    result: list = []
    seen = set()

    for pid, entries in pool.items():
        if not entries:
            continue
        entries_sorted = sorted(entries, key=lambda c: c.get("priority", 99))
        best = entries_sorted[0]
        has_token = any(
            (e.get("access_token") or "").strip() not in ("", "***") for e in entries_sorted
        )
        has_fingerprint = any(e.get("secret_fingerprint") for e in entries_sorted)
        if not has_token and not has_fingerprint and pid not in oauth_block:
            continue  # nothing actually saved for this provider
        last_status = (best.get("last_status") or "").strip().lower()
        last_error = (best.get("last_error_message") or "").strip()
        if last_error or last_status in ("error", "failed", "unauthorized", "invalid"):
            status = "error"
        elif has_token:
            status = "active"
        else:
            status = "configured"
        result.append({
            "id": pid,
            "name": name_for(pid, best.get("label", "") or ""),
            "label": best.get("label", "") or "",
            "auth_type": best.get("auth_type", "") or "api_key",
            "base_url": best.get("base_url", "") or "",
            "status": status,
            "detail": last_error[:160],
            "active": pid == active,
            "request_count": int(best.get("request_count", 0) or 0),
        })
        seen.add(pid)

    # OAuth-only providers stored in the `providers` block (codex, xai-oauth, nous).
    for pid, state in oauth_block.items():
        if pid in seen or not isinstance(state, dict):
            continue
        has_tokens = bool(state.get("tokens") or state.get("access_token") or state.get("agent_key"))
        if not has_tokens:
            continue
        last_error = state.get("last_auth_error") or ""
        last_error = last_error if isinstance(last_error, str) else ""
        result.append({
            "id": pid,
            "name": name_for(pid, ""),
            "label": "",
            "auth_type": state.get("auth_mode") or "oauth",
            "base_url": state.get("inference_base_url") or state.get("portal_base_url") or "",
            "status": "error" if last_error else "active",
            "detail": last_error[:160],
            "active": pid == active,
            "request_count": 0,
        })

    order = {"active": 0, "configured": 1, "error": 2}
    result.sort(key=lambda p: (not p["active"], order.get(p["status"], 3), p["name"].lower()))
    return result


@router.get("/workspace/auth-providers")
async def workspace_auth_providers(request: Request):
    """List providers the user has saved/authenticated in their hermes-agent."""
    return JSONResponse(content={"providers": _load_hermes_saved_providers()})


@router.get("/bridges/cursor-composer")
async def cursor_composer_bridge_status(request: Request):
    """Status for the local Hermes → Cursor Composer bridge (:8790)."""
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    return JSONResponse(content=bridge_workspace._cursor_composer_integration_status(hermes_home=hermes_home))


@router.get("/workspace/overview")
async def workspace_overview(request: Request):
    profile_name = bridge_workspace._resolve_profile_name(request)
    hermes_home = bridge_workspace._resolve_hermes_home(profile_name)
    return JSONResponse(content=_workspace_overview_payload(hermes_home=hermes_home, profile_name=profile_name))


@router.get("/workspace/usage")
async def workspace_usage(request: Request):
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    return JSONResponse(content=_workspace_usage_payload(hermes_home=hermes_home))


@router.get("/workspace/files")
async def workspace_files(request: Request):
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    return JSONResponse(content={"files": _list_canonical_files(hermes_home=hermes_home)})


@router.get("/workspace/files/{file_key}")
async def workspace_file_detail(file_key: str, request: Request):
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    entry = _canonical_file_entry(file_key.lower(), hermes_home=hermes_home, include_content=True)
    if not entry:
        return JSONResponse(status_code=404, content={"error": "unsupported file"})
    return JSONResponse(content={"file": entry})


@router.put("/workspace/files/{file_key}")
async def workspace_file_update(file_key: str, payload: HermesWorkspaceFileUpdate, request: Request):
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    entry = _canonical_file_entry(file_key.lower(), hermes_home=hermes_home, include_content=True)
    if not entry:
        return JSONResponse(status_code=404, content={"error": "unsupported file"})

    current_version = entry.get("version")
    if payload.expected_version is not None and payload.expected_version != current_version:
        return JSONResponse(
            status_code=409,
            content={"error": "File changed on disk. Refresh and try again.", "file": entry},
        )

    config = _canonical_files(hermes_home)[file_key.lower()]
    path = config["path"]
    assert isinstance(path, Path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload.content, encoding="utf-8")

    updated = _canonical_file_entry(file_key.lower(), hermes_home=hermes_home, include_content=True)
    return JSONResponse(content={"file": updated})
