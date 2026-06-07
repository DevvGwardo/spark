"""Cursor Composer bridge status for cloud-chat-hub (Hermes → Composer)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_BRIDGE_HEALTH_URL = os.environ.get(
    "CURSOR_COMPOSER_BRIDGE_HEALTH_URL", "http://127.0.0.1:8790/health"
)
DEFAULT_BRIDGE_API_URL = os.environ.get(
    "CURSOR_COMPOSER_BRIDGE_URL", "http://127.0.0.1:8790/v1"
)
SKILL_NAMES = ("cursor-composer", "composer-code")


def probe_bridge_health(*, timeout: float = 2.0) -> dict[str, Any]:
    """GET the local cursor-composer-bridge /health endpoint."""
    try:
        with urllib.request.urlopen(DEFAULT_BRIDGE_HEALTH_URL, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
            ok = resp.status == 200 and body.get("status") == "ok"
            return {
                "reachable": ok,
                "status": "ok" if ok else "degraded",
                "health_url": DEFAULT_BRIDGE_HEALTH_URL,
                "api_url": DEFAULT_BRIDGE_API_URL,
                "payload": body,
            }
    except urllib.error.URLError as exc:
        return {
            "reachable": False,
            "status": "down",
            "health_url": DEFAULT_BRIDGE_HEALTH_URL,
            "api_url": DEFAULT_BRIDGE_API_URL,
            "detail": str(exc.reason)[:200],
        }
    except Exception as exc:
        return {
            "reachable": False,
            "status": "error",
            "health_url": DEFAULT_BRIDGE_HEALTH_URL,
            "api_url": DEFAULT_BRIDGE_API_URL,
            "detail": str(exc)[:200],
        }


def _skill_installed(hermes_home: Path, name: str) -> bool:
    return (hermes_home / "skills" / name / "SKILL.md").is_file()


def bridge_status(*, hermes_home: Path | None = None) -> dict[str, Any]:
    """Aggregate status for Settings UI and workspace overview."""
    home = hermes_home or Path(os.path.expanduser("~/.hermes"))
    health = probe_bridge_health()
    skills = {
        name: _skill_installed(home, name)
        for name in SKILL_NAMES
    }
    return {
        "id": "cursor-composer",
        "name": "Cursor Composer",
        "description": (
            "Hermes delegates coding to Cursor Composer 2.5 via the local "
            "cursor-composer-bridge (:8790). Use cursor-composer / composer-code skills."
        ),
        "bridge": health,
        "skills": skills,
        "skills_ready": any(skills.values()),
        "connected": bool(health.get("reachable")),
        "launchd_label": "com.gwardo.cursor-composer-bridge",
        "bridge_repo": str(Path.home() / "cursor-composer-bridge"),
    }
