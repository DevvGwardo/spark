"""
Hermes operational surfaces for Spark — fallback, checkpoints, memory,
curator, computer-use, bundles, goals.

Prefer reading/writing config.yaml or shelling `hermes` CLI with structured
JSON/text parse. Keep secrets out of responses.
"""

from __future__ import annotations

import logging
import ipaddress
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, quote, urlencode, urlparse, urlunparse

logger = logging.getLogger(__name__)

_SAFE_CLI_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,120}$")
_SAFE_CLI_GOAL = re.compile(r"^[A-Za-z0-9][\w .,:;@'\"!?()/+-]{0,500}$")
_SAFE_PET_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
_SAFE_HTTP_SCHEMES = frozenset({"http", "https"})


def _hermes_bin() -> str:
    return os.environ.get("HERMES_BIN") or shutil.which("hermes") or "hermes"


def _run_hermes(args: list[str], *, timeout: int = 30, hermes_home: Optional[Path] = None) -> tuple[int, str, str]:
    env = os.environ.copy()
    if hermes_home:
        env["HERMES_HOME"] = str(hermes_home)
    try:
        proc = subprocess.run(
            [_hermes_bin(), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError:
        return 127, "", "hermes CLI not found"
    except subprocess.TimeoutExpired:
        return 124, "", "hermes command timed out"
    except Exception as exc:  # noqa: BLE001 - CLI wrapper reports any failure as rc=1 with the message
        return 1, "", str(exc)


def assert_safe_cli_token(value: str, *, label: str = "value") -> str:
    """Reject empty values and strings that look like CLI flags."""
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{label} is required")
    if text.startswith("-"):
        raise ValueError(f"{label} must not start with '-'")
    if not _SAFE_CLI_TOKEN.match(text):
        raise ValueError(f"{label} contains unsupported characters")
    return text


def assert_safe_cli_goal(value: str) -> str:
    """Allow natural-language goals while blocking flag-like / control input."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("goal is required")
    if text.startswith("-"):
        raise ValueError("goal must not start with '-'")
    if "\x00" in text or "\n" in text or "\r" in text:
        raise ValueError("goal must be a single line")
    if not _SAFE_CLI_GOAL.match(text):
        raise ValueError("goal contains unsupported characters")
    return text


def assert_safe_http_base_url(value: str) -> str:
    """Allow only http(s) URLs with a host (used for fallback_providers)."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("base_url is required")
    parsed = urlparse(text)
    if parsed.scheme.lower() not in _SAFE_HTTP_SCHEMES:
        raise ValueError("base_url must use http or https")
    if not parsed.hostname:
        raise ValueError("base_url must include a hostname")
    return text.rstrip("/")


def assert_safe_gateway_base_url(value: str) -> str:
    """SSRF guard: only probe loopback / configured Hermes API hosts."""
    text = assert_safe_http_base_url(value)
    parsed = urlparse(text)
    host = (parsed.hostname or "").lower()
    allowed_hosts = {"127.0.0.1", "localhost", "::1"}
    configured = (os.environ.get("HERMES_API_BASE") or "").strip()
    if configured:
        try:
            cfg_host = (urlparse(assert_safe_http_base_url(configured)).hostname or "").lower()
            if cfg_host:
                allowed_hosts.add(cfg_host)
        except ValueError:
            pass
    if host in allowed_hosts:
        return text
    # Also allow literal IPs that resolve to loopback
    try:
        if ipaddress.ip_address(host).is_loopback:
            return text
    except ValueError:
        pass
    raise ValueError(
        "gateway base_url must target localhost/127.0.0.1 "
        "or the configured HERMES_API_BASE host"
    )


# ─── Fallback providers ─────────────────────────────────────────────────────

def get_fallback_providers(config: dict) -> list[dict[str, str]]:
    raw = config.get("fallback_providers")
    chain: list[dict[str, str]] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            provider = str(item.get("provider") or "").strip()
            model = str(item.get("model") or "").strip()
            if not provider or not model:
                continue
            entry: dict[str, str] = {"provider": provider, "model": model}
            base = str(item.get("base_url") or "").strip()
            if base:
                entry["base_url"] = base
            chain.append(entry)
    # legacy single dict
    legacy = config.get("fallback_model")
    if isinstance(legacy, dict):
        provider = str(legacy.get("provider") or "").strip()
        model = str(legacy.get("model") or legacy.get("default") or "").strip()
        if provider and model and not any(
            e["provider"] == provider and e["model"] == model for e in chain
        ):
            chain.append({"provider": provider, "model": model})
    return chain


def set_fallback_providers(data: dict, chain: list[dict]) -> list[dict[str, str]]:
    cleaned: list[dict[str, str]] = []
    for item in chain:
        if not isinstance(item, dict):
            continue
        provider = str(item.get("provider") or "").strip()
        model = str(item.get("model") or "").strip()
        if not provider or not model or provider.lower() == "moa":
            continue
        entry: dict[str, str] = {"provider": provider, "model": model}
        base = str(item.get("base_url") or "").strip()
        if base:
            entry["base_url"] = assert_safe_http_base_url(base)
        cleaned.append(entry)
    data["fallback_providers"] = cleaned
    data.pop("fallback_model", None)
    return cleaned


# ─── Goals ──────────────────────────────────────────────────────────────────

def get_goals_config(config: dict) -> dict[str, Any]:
    goals = config.get("goals")
    if not isinstance(goals, dict):
        goals = {}
    max_turns = goals.get("max_turns", 20)
    try:
        max_turns_i = max(1, min(int(max_turns), 200))
    except (TypeError, ValueError):
        max_turns_i = 20
    return {
        "max_turns": max_turns_i,
        "enabled": bool(goals.get("enabled", True)),
    }


def set_goals_config(data: dict, body: dict) -> dict[str, Any]:
    goals = data.get("goals")
    if not isinstance(goals, dict):
        goals = {}
        data["goals"] = goals
    if "max_turns" in body:
        try:
            goals["max_turns"] = max(1, min(int(body["max_turns"]), 200))
        except (TypeError, ValueError) as exc:
            raise ValueError("max_turns must be an integer between 1 and 200") from exc
    if "enabled" in body:
        goals["enabled"] = bool(body["enabled"])
    return get_goals_config(data)


# ─── Tool search (deferred MCP schemas) ─────────────────────────────────────

def get_tool_search_config(config: dict) -> dict[str, Any]:
    """Read ``tools.tool_search`` from config.yaml (Hermes progressive disclosure)."""
    tools = config.get("tools")
    raw = tools.get("tool_search") if isinstance(tools, dict) else None

    enabled = "auto"
    threshold_pct = 10.0
    search_default_limit = 5
    max_search_limit = 20

    if raw is True:
        enabled = "auto"
    elif raw is False:
        enabled = "off"
    elif isinstance(raw, dict):
        e = str(raw.get("enabled", "auto")).strip().lower()
        if e in ("auto", "on", "off"):
            enabled = e
        elif e in ("true", "1", "yes"):
            enabled = "on"
        elif e in ("false", "0", "no"):
            enabled = "off"
        try:
            threshold_pct = max(0.0, min(100.0, float(raw.get("threshold_pct", 10))))
        except (TypeError, ValueError):
            pass
        try:
            max_search_limit = max(1, min(50, int(raw.get("max_search_limit", 20))))
        except (TypeError, ValueError):
            pass
        try:
            search_default_limit = max(1, min(max_search_limit, int(raw.get("search_default_limit", 5))))
        except (TypeError, ValueError):
            pass

    return {
        "enabled": enabled,
        "defer": enabled != "off",
        "threshold_pct": threshold_pct,
        "search_default_limit": search_default_limit,
        "max_search_limit": max_search_limit,
    }


def set_tool_search_config(data: dict, body: dict) -> dict[str, Any]:
    tools = data.get("tools")
    if not isinstance(tools, dict):
        tools = {}
        data["tools"] = tools
    ts = tools.get("tool_search")
    if not isinstance(ts, dict):
        ts = {}
        tools["tool_search"] = ts

    if "defer" in body:
        ts["enabled"] = "auto" if bool(body["defer"]) else "off"
    if "enabled" in body:
        val = str(body["enabled"]).strip().lower()
        if val not in ("auto", "on", "off"):
            raise ValueError("enabled must be auto, on, or off")
        ts["enabled"] = val
    if "threshold_pct" in body:
        try:
            ts["threshold_pct"] = max(0.0, min(100.0, float(body["threshold_pct"])))
        except (TypeError, ValueError) as exc:
            raise ValueError("threshold_pct must be a number between 0 and 100") from exc

    return get_tool_search_config(data)


# ─── Checkpoints ────────────────────────────────────────────────────────────

def _hermes_agent_dir(hermes_home: Optional[Path] = None) -> Path:
    env = os.environ.get("HERMES_AGENT_DIR")
    if env:
        return Path(env)
    home = hermes_home or Path.home() / ".hermes"
    return home / "hermes-agent"


def assert_safe_workdir(value: str) -> str:
    """Validate an absolute working-directory path for checkpoint ops."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("workdir is required")
    if text.startswith("-"):
        raise ValueError("workdir must not start with '-'")
    if "\x00" in text or "\n" in text or "\r" in text:
        raise ValueError("workdir must not contain control characters")
    if not os.path.isabs(text):
        raise ValueError("workdir must be an absolute path")
    return text


def assert_safe_checkpoint_index(value: Any) -> int:
    try:
        idx = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("index must be a positive integer") from exc
    if idx < 1:
        raise ValueError("index must be >= 1")
    return idx


def _resolve_checkpoint_workdir(
    workdir: Optional[str],
    *,
    projects: list[dict[str, Any]],
    hermes_home: Path,
) -> Optional[str]:
    if workdir:
        return assert_safe_workdir(workdir)
    for project in projects:
        if project.get("state") == "live" and int(project.get("commits") or 0) > 0:
            wd = str(project.get("workdir") or "").strip()
            if wd:
                return wd
    for project in projects:
        if project.get("state") == "live":
            wd = str(project.get("workdir") or "").strip()
            if wd:
                return wd
    cwd = os.getcwd()
    if cwd and os.path.isabs(cwd):
        return cwd
    return None


@contextmanager
def _checkpoint_manager(hermes_home: Path):
    """Yield a Hermes CheckpointManager scoped to one profile, or None.

    A context manager rather than a plain function on purpose: upstream resolves
    the checkpoint root at *call* time (tools.checkpoint_manager's
    _resolve_checkpoint_base calls hermes_constants.get_hermes_home()), so the
    home override has to stay in effect while the manager is being used, not just
    while it is constructed. Returning a manager and letting the caller use it
    after the scope closes would resolve the wrong profile's store.

    Replaces two process-global mutations:
      - rewriting HERMES_HOME (see _scoped_hermes_home), and
      - importlib.reload()ing tools.checkpoint_manager.

    The reload is no longer needed at all: upstream now resolves the checkpoint
    root per call precisely so that one multiplexed process can serve every
    profile. Reloading a module object shared across threads was itself a race —
    two concurrent profiles reloading the same module would interleave, and a
    manager built during the other's reload could bind to the wrong store.

    sys.path still has to carry the agent dir so `import tools...` resolves. That
    is additive and identical for every profile, so it is not a cross-talk risk.
    """
    agent_dir = _hermes_agent_dir(hermes_home)
    if not agent_dir.is_dir():
        yield None
        return
    agent_str = str(agent_dir)
    if agent_str not in sys.path:
        sys.path.insert(0, agent_str)
    with _scoped_hermes_home(hermes_home):
        mgr = None
        try:
            import tools.checkpoint_manager as cm

            mgr = cm.CheckpointManager(enabled=True)
        except Exception:  # noqa: BLE001 - hermes-agent is optional; mgr=None signals unavailable
            mgr = None
        yield mgr


def _format_checkpoint_entries(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for i, row in enumerate(raw, start=1):
        if not isinstance(row, dict):
            continue
        commit_hash = str(row.get("hash") or "").strip()
        if not commit_hash:
            continue
        try:
            files_changed = max(0, int(row.get("files_changed") or 0))
        except (TypeError, ValueError):
            files_changed = 0
        entries.append({
            "index": i,
            "path": commit_hash,
            "label": str(row.get("reason") or "checkpoint").strip() or "checkpoint",
            "mtime": row.get("timestamp"),
            "short_hash": row.get("short_hash"),
            "files_changed": files_changed,
        })
    return entries


def list_checkpoint_entries(
    workdir: Optional[str] = None,
    *,
    hermes_home: Optional[Path] = None,
    projects: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    resolved = _resolve_checkpoint_workdir(
        workdir,
        projects=projects or [],
        hermes_home=home,
    )
    if not resolved:
        return {"ok": False, "workdir": None, "entries": [], "error": "No working directory for checkpoints"}

    with _checkpoint_manager(home) as mgr:
        if mgr is None:
            return {
                "ok": False,
                "workdir": resolved,
                "entries": [],
                "error": "checkpoint manager unavailable (hermes-agent not installed)",
            }
        try:
            raw = mgr.list_checkpoints(resolved)
        except Exception as exc:  # noqa: BLE001 - failure is returned to the caller in the error response
            return {
                "ok": False,
                "workdir": resolved,
                "entries": [],
                "error": str(exc)[:500],
            }

    entries = _format_checkpoint_entries(raw)
    return {"ok": True, "workdir": resolved, "entries": entries, "error": None}


def get_checkpoints_status(
    hermes_home: Optional[Path] = None,
    *,
    workdir: Optional[str] = None,
) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    base = home / "checkpoints"
    code, out, err = _run_hermes(["checkpoints", "status"], hermes_home=home)
    projects: list[dict[str, Any]] = []
    total_size = None
    store_size = None
    # Parse human table loosely
    for line in out.splitlines():
        m = re.match(
            r"^\s*(/\S+)\s+(\d+)\s+(.+?)\s+(live|orphan)\s*$",
            line,
        )
        if m:
            projects.append({
                "workdir": m.group(1),
                "commits": int(m.group(2)),
                "last_touch": m.group(3).strip(),
                "state": m.group(4),
            })
        if line.strip().startswith("Total size:"):
            total_size = line.split(":", 1)[1].strip()
        if line.strip().startswith("store/"):
            store_size = line.split(None, 1)[-1].strip() if line.strip().split(None, 1) else None

    payload: dict[str, Any] = {
        "available": code == 0 or base.is_dir(),
        "base_path": str(base),
        "exists": base.is_dir(),
        "total_size": total_size,
        "store_size": store_size,
        "projects": projects[:40],
        "cli_ok": code == 0,
        "error": err.strip() if code not in (0, 124) and not out.strip() else None,
        "raw_summary": out.strip()[:4000] if out else None,
        "entries": [],
        "workdir": None,
    }

    listed = list_checkpoint_entries(workdir, hermes_home=home, projects=projects)
    payload["workdir"] = listed.get("workdir")
    payload["entries"] = listed.get("entries") or []
    if listed.get("error") and not payload["entries"]:
        payload["entries_error"] = listed["error"]
    return payload


def restore_checkpoint(
    index: Any,
    *,
    workdir: Optional[str] = None,
    hermes_home: Optional[Path] = None,
    projects: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Restore a numbered checkpoint (same index semantics as /rollback N)."""
    home = Path(hermes_home or Path.home() / ".hermes")
    idx = assert_safe_checkpoint_index(index)
    resolved = _resolve_checkpoint_workdir(
        workdir,
        projects=projects or [],
        hermes_home=home,
    )
    if not resolved:
        return {"ok": False, "error": "No working directory for checkpoints"}

    # The scope has to wrap the manager's use, not just its construction:
    # upstream resolves the checkpoint root per call.
    with _checkpoint_manager(home) as mgr:
        if mgr is None:
            return {
                "ok": False,
                "error": "checkpoint manager unavailable (hermes-agent not installed)",
            }

        try:
            checkpoints = mgr.list_checkpoints(resolved)
        except Exception as exc:  # noqa: BLE001 - failure is returned to the caller in the error response
            return {"ok": False, "error": str(exc)[:500]}

        if not checkpoints:
            return {"ok": False, "error": "No checkpoints for this working directory", "workdir": resolved}

        if idx > len(checkpoints):
            return {
                "ok": False,
                "error": f"Invalid checkpoint index. Use 1-{len(checkpoints)}.",
                "workdir": resolved,
            }

        target = checkpoints[idx - 1]
        commit_hash = str(target.get("hash") or "").strip()
        if not commit_hash:
            return {"ok": False, "error": "Checkpoint hash missing", "workdir": resolved}

        try:
            result = mgr.restore(resolved, commit_hash)
        except Exception as exc:  # noqa: BLE001 - failure is returned to the caller in the error response
            return {"ok": False, "error": str(exc)[:500], "workdir": resolved, "index": idx}

    return {
        "ok": bool(result.get("success")),
        "index": idx,
        "workdir": resolved,
        "restored_to": result.get("restored_to"),
        "reason": result.get("reason"),
        "hash": commit_hash,
        "error": result.get("error"),
        "rollback_message": build_rollback_user_message(idx),
    }


def prune_checkpoints(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["checkpoints", "prune"], timeout=120, hermes_home=home)
    return {
        "ok": code == 0,
        "output": (out or err).strip()[:4000],
        "exit_code": code,
    }


# ─── Memory / curator / computer-use / bundles ──────────────────────────────

def get_memory_status(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["memory", "status"], hermes_home=home)
    provider = None
    plugin_ok = None
    for line in out.splitlines():
        if "Provider:" in line:
            provider = line.split(":", 1)[1].strip() or None
        if "Status:" in line and "available" in line:
            plugin_ok = "available" in line
    return {
        "ok": code == 0,
        "provider": provider,
        "plugin_available": plugin_ok,
        "builtin": True,
        "raw": out.strip()[:3000] if out else (err.strip()[:1000] if err else ""),
    }


def get_curator_status(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["curator", "status"], hermes_home=home)
    enabled = None
    last_run = None
    runs = None
    for line in out.splitlines():
        low = line.lower()
        if low.startswith("curator:"):
            enabled = "enabled" in low
        if "last run:" in low:
            last_run = line.split(":", 1)[1].strip()
        if low.strip().startswith("runs:"):
            try:
                runs = int(line.split(":", 1)[1].strip())
            except ValueError:
                pass
    return {
        "ok": code == 0,
        "enabled": enabled,
        "last_run": last_run,
        "runs": runs,
        "raw": out.strip()[:3000] if out else (err.strip()[:1000] if err else ""),
    }


def run_curator(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["curator", "run"], timeout=600, hermes_home=home)
    return {"ok": code == 0, "output": (out or err).strip()[:4000], "exit_code": code}


def get_computer_use_status(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["computer-use", "status"], hermes_home=home)
    installed = "not installed" not in (out + err).lower() and code == 0
    if "not installed" in (out + err).lower():
        installed = False
    return {
        "ok": code == 0 or "not installed" in (out + err).lower(),
        "installed": installed,
        "raw": (out or err).strip()[:2000],
    }


def _read_bundle_file(path: Path) -> Optional[dict[str, Any]]:
    try:
        import yaml

        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - unreadable/invalid YAML treated as absent config
        return None
    if not isinstance(data, dict):
        return None
    name = str(data.get("name") or path.stem).strip()
    skills_raw = data.get("skills") or []
    skills = (
        [str(s).strip() for s in skills_raw if str(s).strip()]
        if isinstance(skills_raw, list)
        else []
    )
    description = str(data.get("description") or "").strip() or None
    instruction = data.get("instruction")
    if isinstance(instruction, str):
        instruction = instruction.strip() or None
    else:
        instruction = None
    return {
        "name": name,
        "slug": path.stem,
        "path": str(path),
        "skills": skills,
        "description": description,
        "instruction": instruction,
    }


def _find_bundle_by_name(
    bundles_dir: Path,
    name: str,
) -> Optional[dict[str, Any]]:
    if not bundles_dir.is_dir():
        return None
    for path in sorted(bundles_dir.glob("*.yaml")) + sorted(bundles_dir.glob("*.yml")):
        info = _read_bundle_file(path)
        if not info:
            continue
        if info["name"] == name or info["slug"] == name or path.stem == name:
            return info
    return None


def list_skill_bundles(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    bundles_dir = home / "skill-bundles"
    bundles: list[dict[str, Any]] = []
    if bundles_dir.is_dir():
        for path in sorted(bundles_dir.glob("*.yaml")) + sorted(bundles_dir.glob("*.yml")):
            info = _read_bundle_file(path)
            if info:
                bundles.append(info)
    code, out, err = _run_hermes(["bundles", "list"], hermes_home=home)
    return {
        "ok": True,
        "bundles": bundles,
        "directory": str(bundles_dir),
        "cli_raw": out.strip()[:2000] if out else "",
        "cli_ok": code == 0,
    }


def show_skill_bundle(name: str, hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    safe_name = assert_safe_cli_token(name, label="bundle")
    bundles_dir = home / "skill-bundles"
    match = _find_bundle_by_name(bundles_dir, safe_name)
    code, out, err = _run_hermes(["bundles", "show", safe_name], hermes_home=home)
    if not match:
        return {
            "ok": False,
            "bundle": None,
            "error": f"Bundle {safe_name!r} not found",
            "cli_raw": (out or err).strip()[:2000],
            "cli_ok": code == 0,
        }
    return {
        "ok": True,
        "bundle": match,
        "cli_raw": (out or err).strip()[:2000],
        "cli_ok": code == 0,
    }


def create_skill_bundle(
    name: str,
    skills: list[str],
    *,
    description: Optional[str] = None,
    instruction: Optional[str] = None,
    force: bool = False,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    safe_name = assert_safe_cli_token(name, label="bundle")
    safe_skills = [
        assert_safe_cli_token(str(skill).strip(), label="skill")
        for skill in skills
        if str(skill).strip()
    ]
    if not safe_skills:
        raise ValueError("at least one skill is required")
    args = ["bundles", "create", safe_name]
    for skill in safe_skills:
        args.extend(["--skill", skill])
    if description:
        args.extend(["--description", assert_safe_cli_goal(str(description))])
    if instruction:
        args.extend(["--instruction", assert_safe_cli_goal(str(instruction))])
    if force:
        args.append("--force")
    code, out, err = _run_hermes(args, timeout=120, hermes_home=home)
    listed = list_skill_bundles(home)
    shown = show_skill_bundle(safe_name, home) if code == 0 else {"bundle": None}
    return {
        "ok": code == 0,
        "name": safe_name,
        "skills": safe_skills,
        "output": (out or err).strip()[:2000],
        "bundle": shown.get("bundle"),
        "bundles": listed.get("bundles") or [],
        "error": None if code == 0 else (err or out or "create failed")[:500],
    }


def delete_skill_bundle(name: str, hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    safe_name = assert_safe_cli_token(name, label="bundle")
    code, out, err = _run_hermes(["bundles", "delete", safe_name], timeout=60, hermes_home=home)
    listed = list_skill_bundles(home)
    return {
        "ok": code == 0,
        "name": safe_name,
        "output": (out or err).strip()[:2000],
        "bundles": listed.get("bundles") or [],
        "error": None if code == 0 else (err or out or "delete failed")[:500],
    }


def reload_skill_bundles(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["bundles", "reload"], timeout=60, hermes_home=home)
    listed = list_skill_bundles(home)
    return {
        "ok": code == 0,
        "output": (out or err).strip()[:2000],
        "bundles": listed.get("bundles") or [],
        "directory": listed.get("directory"),
        "error": None if code == 0 else (err or out or "reload failed")[:500],
    }


def get_dashboard_url() -> dict[str, Any]:
    raw = (os.environ.get("HERMES_DASHBOARD_URL") or "http://127.0.0.1:9119").strip()
    try:
        url = assert_safe_gateway_base_url(raw)
    except ValueError as exc:
        return {"ok": False, "url": None, "error": str(exc)}
    return {"ok": True, "url": url}


def get_insights(days: int = 7, hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    days = max(1, min(int(days or 7), 90))
    code, out, err = _run_hermes(["insights", f"--days={days}"], timeout=60, hermes_home=home)
    return {
        "ok": code == 0,
        "days": days,
        "report": out.strip()[:8000] if out else (err.strip()[:2000] if err else ""),
        "exit_code": code,
    }


# ─── Compress / rollback as agent-side messages ─────────────────────────────

def build_compress_user_message() -> str:
    return (
        "Please run context compression now using your /compress capability "
        "(or equivalent compression tool). Summarize older turns and free context "
        "while preserving task-critical facts, open todos, and recent tool results. "
        "Confirm when compression is complete."
    )


def build_rollback_user_message(index: Optional[int] = None) -> str:
    if index is None:
        return (
            "List available filesystem checkpoints for the current working directory "
            "using /rollback (or checkpoint tools). Show numbered entries with timestamps "
            "and a one-line summary so I can pick one to restore."
        )
    return (
        f"Restore filesystem checkpoint #{int(index)} for the current working directory "
        f"using /rollback {int(index)}. Confirm what was restored and any failures."
    )


# ─── Journey / learning graph ───────────────────────────────────────────────

def get_journey_graph(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["journey", "--json"], timeout=45, hermes_home=home)
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    if out.strip():
        try:
            payload = json.loads(out)
            if isinstance(payload, dict):
                raw_nodes = payload.get("nodes") or payload.get("data") or []
                raw_edges = payload.get("edges") or payload.get("links") or []
                if isinstance(raw_nodes, list):
                    nodes = [n for n in raw_nodes if isinstance(n, dict)]
                if isinstance(raw_edges, list):
                    edges = [e for e in raw_edges if isinstance(e, dict)]
            elif isinstance(payload, list):
                nodes = [n for n in payload if isinstance(n, dict)]
        except json.JSONDecodeError:
            pass
    # Sort newest first for timeline UI
    def _ts(n: dict) -> float:
        try:
            return float(n.get("timestamp") or 0)
        except (TypeError, ValueError):
            return 0.0

    nodes_sorted = sorted(nodes, key=_ts, reverse=True)
    return {
        "ok": code == 0 or bool(nodes_sorted),
        "node_count": len(nodes_sorted),
        "edge_count": len(edges),
        "nodes": nodes_sorted[:500],
        "edges": edges[:1000],
        "error": err.strip()[:500] if code != 0 and not nodes_sorted else None,
    }


# ─── Computer use install ───────────────────────────────────────────────────

def install_computer_use(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(
        ["computer-use", "install"],
        timeout=600,
        hermes_home=home,
    )
    status = get_computer_use_status(home)
    return {
        "ok": code == 0 or status.get("installed") is True,
        "exit_code": code,
        "output": (out or err).strip()[:6000],
        "status": status,
    }


def doctor_computer_use(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["computer-use", "doctor"], timeout=120, hermes_home=home)
    return {
        "ok": code == 0,
        "exit_code": code,
        "report": (out or err).strip()[:6000],
        "status": get_computer_use_status(home),
    }


# ─── Pets (petdex) ──────────────────────────────────────────────────────────

def get_pets_status(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    config = {}
    try:
        import yaml
        cfg_path = home / "config.yaml"
        if cfg_path.is_file():
            with open(cfg_path) as f:
                config = yaml.safe_load(f) or {}
    except Exception:  # noqa: BLE001 - unreadable config falls back to empty defaults
        config = {}
    display = config.get("display") if isinstance(config.get("display"), dict) else {}
    pet_cfg = display.get("pet") if isinstance(display.get("pet"), dict) else {}
    code, out, err = _run_hermes(["pets", "show"], hermes_home=home)
    active = None
    if "no pet" not in (out + err).lower():
        # First non-empty line often names the pet
        for line in (out or "").splitlines():
            if line.strip():
                active = line.strip()[:200]
                break
    return {
        "ok": True,
        "configured": bool(pet_cfg.get("name") or pet_cfg.get("id") or active),
        "config": {
            "name": pet_cfg.get("name") or pet_cfg.get("id") or None,
            "scale": pet_cfg.get("scale"),
            "enabled": pet_cfg.get("enabled", True) is not False if pet_cfg else False,
        },
        "show": active,
        "raw": (out or err).strip()[:1500],
        "gallery_hint": "hermes pets list | hermes pets install <id>",
    }


def list_pets_gallery(limit: int = 40, hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["pets", "list"], timeout=60, hermes_home=home)
    pets: list[dict[str, str]] = []
    for line in (out or "").splitlines():
        # "    id                           Label  (kind)"
        m = re.match(r"^\s{2,}(\S+)\s{2,}(.+?)\s{2,}\(([^)]+)\)\s*$", line)
        if not m:
            m = re.match(r"^\s+(\S+)\s+(.+)$", line)
            if m and not m.group(1).startswith("petdex"):
                pets.append({"id": m.group(1), "label": m.group(2).strip(), "kind": ""})
            continue
        pets.append({"id": m.group(1), "label": m.group(2).strip(), "kind": m.group(3).strip()})
        if len(pets) >= max(1, min(int(limit or 40), 100)):
            break
    return {
        "ok": code == 0 or bool(pets),
        "pets": pets,
        "total_hint": "3420+" if "3420" in (out or "") else None,
        "error": err.strip()[:300] if code != 0 and not pets else None,
    }


def select_pet(pet_id: str, hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    pet_id = assert_safe_cli_token(pet_id, label="pet_id")
    if not _SAFE_PET_ID.match(pet_id):
        raise ValueError("pet_id contains unsupported characters")
    # install if needed then select
    code_i, out_i, err_i = _run_hermes(["pets", "install", pet_id], timeout=120, hermes_home=home)
    code_s, out_s, err_s = _run_hermes(["pets", "select", pet_id], timeout=60, hermes_home=home)
    return {
        "ok": code_s == 0,
        "pet_id": pet_id,
        "install_ok": code_i == 0,
        "install_output": (out_i or err_i).strip()[:2000],
        "select_output": (out_s or err_s).strip()[:2000],
        "status": get_pets_status(home),
    }


# ─── OpenClaw migration ─────────────────────────────────────────────────────

def claw_migrate(
    *,
    dry_run: bool = True,
    migrate_secrets: bool = False,
    yes: bool = False,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    # dry-run takes precedence for safety; never migrate secrets during preview
    if dry_run:
        args = ["claw", "migrate", "--dry-run"]
    else:
        args = ["claw", "migrate", "--yes"]
        if migrate_secrets and yes:
            args.append("--migrate-secrets")
    code, out, err = _run_hermes(args, timeout=300, hermes_home=home)
    return {
        "ok": code == 0,
        "dry_run": dry_run,
        "exit_code": code,
        "report": (out or err).strip()[:12000],
    }


# ─── Hermes gateway /v1 capabilities + runs foundation ─────────────────────

_GATEWAY_CAPS_TTL_SECONDS = 45.0
_gateway_caps_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_gateway_caps_lock = threading.Lock()


def clear_gateway_capabilities_cache() -> None:
    """Drop the process-local capabilities cache (tests / after hermes update)."""
    with _gateway_caps_lock:
        _gateway_caps_cache.clear()


def _gateway_caps_cache_key(base_url: str, api_key: Optional[str]) -> str:
    key = api_key or os.environ.get("HERMES_API_KEY") or os.environ.get("API_SERVER_KEY") or ""
    return f"{base_url}|{bool(key)}"


def peek_gateway_capabilities(
    base_url: str = "http://127.0.0.1:8642",
    api_key: Optional[str] = None,
) -> tuple[Optional[dict[str, Any]], bool]:
    """Last cached capabilities for this gateway without any network I/O.

    Returns ``(caps_or_None, fresh)`` where ``fresh`` means younger than the
    TTL. Raises like ``probe_gateway_capabilities`` for an unsafe base URL.
    """
    base_url = assert_safe_gateway_base_url(base_url)
    cache_key = _gateway_caps_cache_key(base_url, api_key)
    with _gateway_caps_lock:
        hit = _gateway_caps_cache.get(cache_key)
    if not hit:
        return None, False
    return dict(hit[1]), time.time() - hit[0] < _GATEWAY_CAPS_TTL_SECONDS


def probe_gateway_capabilities(
    base_url: str = "http://127.0.0.1:8642",
    api_key: Optional[str] = None,
    *,
    force: bool = False,
) -> dict[str, Any]:
    """Probe local Hermes API server for /v1/runs and related features.

    Results are cached for ``_GATEWAY_CAPS_TTL_SECONDS`` so UI mounts and chat
    routing don't each pay two synchronous urllib round-trips.
    """
    import urllib.error
    import urllib.request

    base_url = assert_safe_gateway_base_url(base_url)
    key = api_key or os.environ.get("HERMES_API_KEY") or os.environ.get("API_SERVER_KEY") or ""
    cache_key = _gateway_caps_cache_key(base_url, api_key)
    now = time.time()
    if not force:
        with _gateway_caps_lock:
            hit = _gateway_caps_cache.get(cache_key)
            if hit and now - hit[0] < _GATEWAY_CAPS_TTL_SECONDS:
                return dict(hit[1])

    url = base_url.rstrip("/") + "/health"
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    health_body = None
    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            health_body = resp.read().decode("utf-8", errors="replace")
            health_ok = resp.status < 400
    except Exception as exc:  # noqa: BLE001 - probe failure is reported as reachable=False
        result = {
            "reachable": False,
            "base_url": base_url,
            "error": str(exc)[:300],
            "features": {},
            "recommended_transport": "bridge",
        }
        with _gateway_caps_lock:
            _gateway_caps_cache[cache_key] = (now, result)
        return dict(result)

    caps_url = base_url.rstrip("/") + "/v1/capabilities"
    features: dict[str, Any] = {}
    try:
        req = urllib.request.Request(caps_url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            raw = json.loads(resp.read().decode("utf-8", errors="replace"))
            if isinstance(raw, dict):
                features = raw.get("features") if isinstance(raw.get("features"), dict) else raw
    except Exception:  # noqa: BLE001 - capabilities probe failed; health result is still valid; logged at debug
        # health worked but capabilities may be under /health detailed
        logger.debug("capabilities probe failed; health result is still valid", exc_info=True)

    runs = bool(features.get("run_submission") or features.get("runs"))
    result = {
        "reachable": health_ok,
        "base_url": base_url,
        "health_body": (health_body or "")[:500] or None,
        "features": features,
        "run_submission": runs,
        "session_fork": bool(features.get("session_fork")),
        "skills_api": bool(features.get("skills_api")),
        "recommended_transport": "runs" if runs else "bridge",
    }
    with _gateway_caps_lock:
        _gateway_caps_cache[cache_key] = (now, result)
    return dict(result)


def _gateway_api_key(api_key: Optional[str] = None) -> str:
    return (
        (api_key or "").strip()
        or os.environ.get("HERMES_API_KEY", "").strip()
        or os.environ.get("API_SERVER_KEY", "").strip()
    )


def _parse_gateway_error_body(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return "Gateway request failed"
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text[:300]
    if not isinstance(parsed, dict):
        return text[:300]
    err = parsed.get("error")
    if isinstance(err, dict):
        msg = err.get("message") or err.get("type")
        if isinstance(msg, str) and msg.strip():
            return msg.strip()[:300]
    if isinstance(err, str) and err.strip():
        return err.strip()[:300]
    if isinstance(parsed.get("message"), str) and parsed["message"].strip():
        return parsed["message"].strip()[:300]
    return text[:300]


def assert_safe_gateway_session_id(session_id: str) -> str:
    text = str(session_id or "").strip()
    if not text:
        raise ValueError("session_id is required")
    if re.search(r"[\r\n\x00]", text):
        raise ValueError("Invalid session_id")
    return text


def fork_gateway_session(
    session_id: str,
    *,
    base_url: str = "http://127.0.0.1:8642",
    api_key: Optional[str] = None,
    title: Optional[str] = None,
) -> tuple[int, dict[str, Any]]:
    """POST /api/sessions/{id}/fork on the Hermes gateway."""
    import urllib.error
    import urllib.request

    session_id = assert_safe_gateway_session_id(session_id)
    base_url = assert_safe_gateway_base_url(base_url)
    url = base_url.rstrip("/") + f"/api/sessions/{quote(session_id, safe='')}/fork"

    body: dict[str, Any] = {}
    if title is not None:
        title_text = str(title).strip()
        if title_text:
            body["title"] = title_text

    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    key = _gateway_api_key(api_key)
    if key:
        headers["Authorization"] = f"Bearer {key}"

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {"error": "Invalid gateway response"}
            if not isinstance(payload, dict):
                payload = {"error": "Invalid gateway response"}
            return resp.status, payload
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(err_body) if err_body else {}
        except json.JSONDecodeError:
            payload = {"error": _parse_gateway_error_body(err_body)}
        if not isinstance(payload, dict):
            payload = {"error": _parse_gateway_error_body(err_body)}
        if "error" not in payload:
            payload = {"error": _parse_gateway_error_body(err_body)}
        return exc.code, payload
    except Exception as exc:  # noqa: BLE001 - gateway failure is surfaced to the client as a 502
        return 502, {"error": str(exc)[:300]}


# ─── Plugins / hooks / LSP ──────────────────────────────────────────────────

_PLUGIN_STATUS_ENABLED = frozenset({"enabled", "on", "active"})


def _sanitize_plugin_row(item: dict[str, Any]) -> dict[str, Any]:
    """Client-safe plugin summary — never include env vars or secrets."""
    name = str(item.get("name") or "").strip()
    status_raw = str(item.get("status") or "").strip().lower()
    enabled = status_raw in _PLUGIN_STATUS_ENABLED or status_raw == "enabled"
    if "not enabled" in status_raw or status_raw == "disabled":
        enabled = False
    return {
        "name": name,
        "status": str(item.get("status") or "").strip() or "unknown",
        "enabled": enabled,
        "version": str(item.get("version") or "").strip() or None,
        "description": str(item.get("description") or "").strip()[:240] or None,
        "source": str(item.get("source") or "").strip() or None,
    }


def list_plugins(
    *,
    hermes_home: Optional[Path] = None,
    limit: int = 120,
) -> dict[str, Any]:
    """List Hermes plugins via `hermes plugins list --json`."""
    home = Path(hermes_home or Path.home() / ".hermes")
    cap = max(1, min(int(limit or 120), 200))
    code, out, err = _run_hermes(["plugins", "list", "--json"], timeout=60, hermes_home=home)
    plugins: list[dict[str, Any]] = []
    if out.strip():
        try:
            raw = json.loads(out)
            if isinstance(raw, list):
                for item in raw[:cap]:
                    if isinstance(item, dict):
                        row = _sanitize_plugin_row(item)
                        if row["name"]:
                            plugins.append(row)
        except json.JSONDecodeError:
            pass
    enabled_count = sum(1 for p in plugins if p.get("enabled"))
    return {
        "ok": code == 0 or bool(plugins),
        "cli_ok": code == 0,
        "total": len(plugins),
        "enabled_count": enabled_count,
        "plugins": plugins,
        "error": err.strip()[:300] if code not in (0, 124) and not plugins and err else None,
    }


def enable_plugin(
    name: str,
    *,
    allow_tool_override: bool = False,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    safe_name = assert_safe_cli_token(name, label="plugin")
    args = ["plugins", "enable", safe_name]
    if allow_tool_override:
        args.append("--allow-tool-override")
    else:
        args.append("--no-allow-tool-override")
    code, out, err = _run_hermes(args, timeout=120, hermes_home=home)
    listed = list_plugins(hermes_home=home, limit=200)
    return {
        "ok": code == 0,
        "name": safe_name,
        "exit_code": code,
        "output": (out or err).strip()[:2000],
        "plugins": listed.get("plugins") or [],
        "total": listed.get("total", 0),
        "enabled_count": listed.get("enabled_count"),
        "error": None if code == 0 else (err or out or "enable failed")[:500],
    }


def disable_plugin(name: str, *, hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    safe_name = assert_safe_cli_token(name, label="plugin")
    code, out, err = _run_hermes(["plugins", "disable", safe_name], timeout=60, hermes_home=home)
    listed = list_plugins(hermes_home=home, limit=200)
    return {
        "ok": code == 0,
        "name": safe_name,
        "exit_code": code,
        "output": (out or err).strip()[:2000],
        "plugins": listed.get("plugins") or [],
        "total": listed.get("total", 0),
        "enabled_count": listed.get("enabled_count"),
        "error": None if code == 0 else (err or out or "disable failed")[:500],
    }


_HOOK_EVENT_LINE = re.compile(r"^\s+\[(.+)\]\s*$")
_HOOK_ENTRY_LINE = re.compile(r"^\s+-\s+(\S+)\s+\(timeout=(\d+)s,\s*(.+)\)\s*$")


def _parse_hooks_list(stdout: str) -> list[dict[str, Any]]:
    hooks: list[dict[str, Any]] = []
    current_event: Optional[str] = None
    for line in stdout.splitlines():
        m_event = _HOOK_EVENT_LINE.match(line)
        if m_event:
            current_event = m_event.group(1).strip()
            continue
        m_entry = _HOOK_ENTRY_LINE.match(line)
        if m_entry and current_event:
            tail = m_entry.group(3).strip()
            hooks.append({
                "event": current_event,
                "command": m_entry.group(1),
                "timeout_s": int(m_entry.group(2)),
                "allowed": "allowed" in tail.lower() or "✓" in tail,
                "status_hint": tail.replace("✓", "").strip() or None,
            })
            continue
        if hooks and line.strip().startswith("approved_at:"):
            hooks[-1]["approved_at"] = line.split(":", 1)[1].strip()
            continue
        if hooks and ("⚠" in line or "warning" in line.lower()):
            hooks[-1]["warning"] = line.strip().lstrip("⚠").strip()
    return hooks


def list_hooks(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["hooks", "list"], timeout=30, hermes_home=home)
    hooks = _parse_hooks_list(out) if out.strip() else []
    issue_hints = sum(1 for h in hooks if h.get("warning"))
    return {
        "ok": code == 0 or bool(hooks),
        "cli_ok": code == 0,
        "total": len(hooks),
        "issue_hints": issue_hints,
        "hooks": hooks,
        "error": err.strip()[:300] if code not in (0, 124) and not hooks and err else None,
    }


def _parse_hooks_doctor(stdout: str) -> dict[str, Any]:
    issue_count = 0
    m = re.search(r"(\d+)\s+issue\(s\)\s+found", stdout or "", re.IGNORECASE)
    if m:
        issue_count = int(m.group(1))
    entries: list[dict[str, Any]] = []
    current: Optional[dict[str, Any]] = None
    for line in (stdout or "").splitlines():
        header = re.match(r"^\s+\[([^\]]+)\]\s+(\S+)\s*$", line)
        if header:
            current = {
                "event": header.group(1).strip(),
                "command": header.group(2).strip(),
                "checks": [],
            }
            entries.append(current)
            continue
        stripped = line.strip()
        if current and stripped:
            if stripped.startswith("✓") or stripped.startswith("⚠"):
                current["checks"].append(stripped)
            if stripped.startswith("⚠"):
                current["warning"] = stripped.lstrip("⚠").strip()
    return {
        "issue_count": issue_count,
        "entries": entries,
        "ok": issue_count == 0,
    }


def doctor_hooks(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["hooks", "doctor"], timeout=120, hermes_home=home)
    report = (out or err).strip()
    parsed = _parse_hooks_doctor(report)
    listed = list_hooks(home)
    return {
        "ok": code == 0 and parsed.get("ok", False),
        "exit_code": code,
        "issue_count": parsed.get("issue_count", 0),
        "entries": parsed.get("entries") or [],
        "hooks": listed.get("hooks") or [],
        "report": report[:6000],
        "error": None if code == 0 else (err or out or "doctor failed")[:500],
    }


def get_lsp_status(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["lsp", "status", "--json"], timeout=45, hermes_home=home)
    if out.strip():
        try:
            payload = json.loads(out)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict):
            service = payload.get("service") if isinstance(payload.get("service"), dict) else {}
            registry_raw = payload.get("registry") if isinstance(payload.get("registry"), list) else []
            registry: list[dict[str, Any]] = []
            for row in registry_raw:
                if not isinstance(row, dict):
                    continue
                registry.append({
                    "server_id": str(row.get("server_id") or "").strip(),
                    "binary_status": str(row.get("binary_status") or "").strip(),
                    "description": str(row.get("description") or "").strip()[:120],
                    "extensions": [
                        str(ext) for ext in (row.get("extensions") or [])[:8]
                    ],
                })
            installed = sum(1 for s in registry if s.get("binary_status") == "installed")
            missing = sum(1 for s in registry if s.get("binary_status") == "missing")
            clients = service.get("clients") if isinstance(service.get("clients"), list) else []
            return {
                "ok": code == 0 or bool(service),
                "enabled": bool(service.get("enabled")),
                "wait_mode": service.get("wait_mode"),
                "wait_timeout": service.get("wait_timeout"),
                "active_clients": len(clients),
                "installed_count": installed,
                "missing_count": missing,
                "registry": registry[:40],
                "error": err.strip()[:300] if code != 0 and not service else None,
            }
    return {
        "ok": code == 0,
        "enabled": None,
        "wait_mode": None,
        "wait_timeout": None,
        "active_clients": 0,
        "installed_count": 0,
        "missing_count": 0,
        "registry": [],
        "raw": (out or err).strip()[:3000] if (out or err) else None,
        "error": err.strip()[:300] if code not in (0, 124) and err else None,
    }


# ─── Kanban swarm ───────────────────────────────────────────────────────────

# ─── Hermes projects (multi-folder workspaces) ─────────────────────────────

_SAFE_PROJECT_NAME = re.compile(r"^[A-Za-z0-9][\w .,:;@'\"!?()/-]{0,120}$")
_PROJECT_LIST_LINE = re.compile(
    r"^([* ])\s+(\S+)\s{2,}(.+?)\s{2,}\[(\d+) folder\(s\)\]\s*$"
)


def assert_safe_project_name(value: str) -> str:
    """Human project name — blocks flag-like / multiline input."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("name is required")
    if text.startswith("-"):
        raise ValueError("name must not start with '-'")
    if "\x00" in text or "\n" in text or "\r" in text:
        raise ValueError("name must be a single line")
    if not _SAFE_PROJECT_NAME.match(text):
        raise ValueError("name contains unsupported characters")
    return text


def assert_safe_project_ref(value: str, *, label: str = "project") -> str:
    """Project id or slug passed to Hermes CLI."""
    return assert_safe_cli_token(value, label=label)


def assert_safe_board_slug(value: str) -> str:
    """Kanban board slug for bind-board."""
    text = str(value or "").strip()
    if not text:
        return ""
    return assert_safe_cli_token(text, label="board")


def _projects_db_path(hermes_home: Path) -> Path:
    return hermes_home / "projects.db"


def _list_projects_from_db(
    hermes_home: Path,
    *,
    include_archived: bool = False,
) -> tuple[list[dict[str, Any]], Optional[str]]:
    db_path = _projects_db_path(hermes_home)
    if not db_path.is_file():
        return [], None
    try:
        import sqlite3

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            active_row = conn.execute(
                "SELECT value FROM project_meta WHERE key = ?",
                ("active_id",),
            ).fetchone()
            active_id = active_row["value"] if active_row else None

            sql = "SELECT * FROM projects"
            if not include_archived:
                sql += " WHERE archived = 0"
            sql += " ORDER BY created_at ASC"
            rows = conn.execute(sql).fetchall()

            projects: list[dict[str, Any]] = []
            for row in rows:
                pid = row["id"]
                folder_rows = conn.execute(
                    "SELECT path, label, is_primary, added_at FROM project_folders "
                    "WHERE project_id = ? ORDER BY is_primary DESC, added_at ASC",
                    (pid,),
                ).fetchall()
                folders = [
                    {
                        "path": fr["path"],
                        "label": fr["label"],
                        "is_primary": bool(fr["is_primary"]),
                        "added_at": fr["added_at"],
                    }
                    for fr in folder_rows
                ]
                keys = row.keys()
                projects.append({
                    "id": pid,
                    "slug": row["slug"],
                    "name": row["name"],
                    "description": row["description"] if "description" in keys else None,
                    "icon": row["icon"] if "icon" in keys else None,
                    "color": row["color"] if "color" in keys else None,
                    "board_slug": row["board_slug"] if "board_slug" in keys else None,
                    "primary_path": row["primary_path"] if "primary_path" in keys else None,
                    "archived": bool(row["archived"]) if "archived" in keys else False,
                    "created_at": row["created_at"],
                    "folders": folders,
                    "active": pid == active_id,
                })
            return projects, active_id
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 - DB failure is returned to the caller as an error string
        return [], str(exc)[:300]


def _parse_project_list_cli(out: str) -> list[dict[str, Any]]:
    projects: list[dict[str, Any]] = []
    for line in out.splitlines():
        m = _PROJECT_LIST_LINE.match(line.rstrip())
        if not m:
            continue
        name_part = m.group(3).strip()
        archived = False
        if name_part.endswith(" (archived)"):
            archived = True
            name_part = name_part[: -len(" (archived)")].strip()
        projects.append({
            "id": None,
            "slug": m.group(2),
            "name": name_part,
            "archived": archived,
            "active": m.group(1) == "*",
            "folder_count": int(m.group(4)),
            "folders": [],
            "board_slug": None,
            "primary_path": None,
        })
    return projects


def list_projects(
    *,
    hermes_home: Optional[Path] = None,
    include_archived: bool = False,
) -> dict[str, Any]:
    """List Hermes projects for the active profile."""
    home = Path(hermes_home or Path.home() / ".hermes")
    projects, active_id = _list_projects_from_db(home, include_archived=include_archived)
    source = "db"
    cli_ok = None
    error = None

    if not projects and not _projects_db_path(home).is_file():
        args = ["project", "list"]
        if include_archived:
            args.append("--all")
        code, out, err = _run_hermes(args, hermes_home=home)
        cli_ok = code == 0
        if code == 0 and out.strip():
            projects = _parse_project_list_cli(out)
            source = "cli"
            active_id = next((p["slug"] for p in projects if p.get("active")), None)
        elif code != 0:
            error = (err or out or "project list failed")[:500]

    active_slug = None
    if active_id:
        for p in projects:
            if p.get("id") == active_id or p.get("slug") == active_id:
                active_slug = p.get("slug")
                break

    return {
        "ok": bool(projects) or error is None,
        "projects": projects,
        "active_id": active_id,
        "active_slug": active_slug,
        "source": source,
        "cli_ok": cli_ok,
        "error": error,
    }


def use_project(
    project: Optional[str],
    *,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    """Set (or clear) the active Hermes project."""
    home = Path(hermes_home or Path.home() / ".hermes")
    args = ["project", "use"]
    if project:
        ref = assert_safe_project_ref(project)
        args.append(ref)
    code, out, err = _run_hermes(args, hermes_home=home)
    listed = list_projects(hermes_home=home)
    return {
        "ok": code == 0,
        "exit_code": code,
        "output": (out or err).strip()[:2000],
        "active_slug": listed.get("active_slug"),
        "projects": listed.get("projects") or [],
        "error": None if code == 0 else (err or out or "use failed")[:500],
    }


def create_project(
    name: str,
    *,
    primary_folder: Optional[str] = None,
    use: bool = True,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    """Create a Hermes project with an optional primary folder."""
    home = Path(hermes_home or Path.home() / ".hermes")
    safe_name = assert_safe_project_name(name)
    args = ["project", "create", safe_name]
    if primary_folder:
        args.extend(["--primary", assert_safe_workdir(primary_folder)])
    if use:
        args.append("--use")
    code, out, err = _run_hermes(args, timeout=60, hermes_home=home)
    listed = list_projects(hermes_home=home)
    created_slug = None
    m = re.search(r"Created project (\S+)", out or "")
    if m:
        created_slug = m.group(1)
    return {
        "ok": code == 0,
        "exit_code": code,
        "output": (out or err).strip()[:4000],
        "created_slug": created_slug,
        "active_slug": listed.get("active_slug"),
        "projects": listed.get("projects") or [],
        "error": None if code == 0 else (err or out or "create failed")[:500],
    }


def bind_board(
    project: str,
    board: Optional[str] = None,
    *,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    """Bind (or unbind) a kanban board to a Hermes project."""
    home = Path(hermes_home or Path.home() / ".hermes")
    ref = assert_safe_project_ref(project)
    board_slug = assert_safe_board_slug(board or "")
    args = ["project", "bind-board", ref]
    if board_slug:
        args.append(board_slug)
    code, out, err = _run_hermes(args, hermes_home=home)
    listed = list_projects(hermes_home=home)
    return {
        "ok": code == 0,
        "exit_code": code,
        "output": (out or err).strip()[:2000],
        "board_slug": board_slug or None,
        "projects": listed.get("projects") or [],
        "error": None if code == 0 else (err or out or "bind-board failed")[:500],
    }


# ─── Auth credential pool (hermes auth) ───────────────────────────────────────

_SECRET_JSON_KEYS = frozenset({
    "access_token",
    "refresh_token",
    "agent_key",
    "api_key",
    "runtime_api_key",
    "client_secret",
    "password",
    "token",
    "secret",
})

_AUTH_LIST_LINE = re.compile(
    r"^\s+#(\d+)\s+(.{20})\s+(\S+)\s+(\S+)(.*)$",
)


def mask_secret(value: Any) -> str:
    """Mask a secret for API responses — last 4 chars or bullet placeholder."""
    text = str(value or "").strip()
    if not text or text in ("***", "••••"):
        return "••••"
    if len(text) <= 4:
        return "••••"
    return "••••" + text[-4:]


def assert_safe_auth_provider(value: str) -> str:
    return assert_safe_cli_token(value, label="provider")


def assert_safe_auth_target(value: str) -> str:
    """Validate remove target: 1-based index, entry id, or label."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("target is required")
    if text.startswith("-"):
        raise ValueError("target must not start with '-'")
    if re.fullmatch(r"\d+", text):
        if int(text) < 1:
            raise ValueError("target index must be >= 1")
        return text
    if _SAFE_CLI_TOKEN.match(text):
        return text
    if "\x00" in text or "\n" in text or "\r" in text:
        raise ValueError("target must be a single line")
    if len(text) > 120:
        raise ValueError("target is too long")
    if not re.match(r"^[\w .,:;@'\"!?()/+-]+$", text):
        raise ValueError("target contains unsupported characters")
    return text


def _auth_json_path(hermes_home: Path) -> Path:
    return hermes_home / "auth.json"


def _read_auth_json(hermes_home: Path) -> dict[str, Any]:
    path = _auth_json_path(hermes_home)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _masked_entry_from_json(
    provider: str,
    entry: dict[str, Any],
    *,
    index: int,
    active_id: Optional[str],
) -> dict[str, Any]:
    """Build a client-safe credential summary — never include raw secrets."""
    entry_id = str(entry.get("id") or "").strip()
    label = str(entry.get("label") or "").strip()
    auth_type = str(entry.get("auth_type") or "api_key").strip()
    source = str(entry.get("source") or "").strip()
    if source.startswith("manual:"):
        source = source.split(":", 1)[1]
    last_status = str(entry.get("last_status") or "").strip().lower() or None
    fingerprint = entry.get("secret_fingerprint")
    masked_key = mask_secret(fingerprint)
    token = str(entry.get("access_token") or entry.get("agent_key") or "").strip()
    if token and token not in ("", "***"):
        masked_key = mask_secret(token)
    exhausted = last_status == "exhausted"
    return {
        "index": index,
        "id": entry_id or None,
        "label": label or f"#{index}",
        "auth_type": auth_type,
        "source": source or "manual",
        "masked_key": masked_key,
        "exhausted": exhausted,
        "active": bool(active_id and entry_id and entry_id == active_id),
        "priority": int(entry.get("priority") or 0),
        "request_count": int(entry.get("request_count") or 0),
        "last_status": last_status,
        "last_error_code": entry.get("last_error_code"),
        "last_error_message": (
            str(entry.get("last_error_message") or "").strip()[:200] or None
        ),
    }


def _parse_auth_list_cli(stdout: str) -> dict[str, list[dict[str, Any]]]:
    """Parse `hermes auth list` table output into per-provider credential rows."""
    by_provider: dict[str, list[dict[str, Any]]] = {}
    current: Optional[str] = None
    for line in stdout.splitlines():
        header = re.match(r"^(\S+)\s+\((\d+)\s+credentials\):\s*$", line.strip())
        if header:
            current = header.group(1)
            by_provider.setdefault(current, [])
            continue
        if not current:
            continue
        m = _AUTH_LIST_LINE.match(line)
        if not m:
            continue
        idx = int(m.group(1))
        label = m.group(2).rstrip()
        auth_type = m.group(3)
        source = m.group(4)
        tail = m.group(5) or ""
        by_provider[current].append({
            "index": idx,
            "label": label,
            "auth_type": auth_type,
            "source": source,
            "active": "←" in tail,
            "exhausted": "exhausted" in tail.lower() or "rate-limited" in tail.lower(),
            "status_hint": tail.strip().lstrip("←").strip() or None,
        })
    return by_provider


def _merge_pool_entries(
    provider: str,
    json_entries: list[dict[str, Any]],
    cli_entries: list[dict[str, Any]],
    active_id: Optional[str],
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for i, raw in enumerate(json_entries, start=1):
        if not isinstance(raw, dict):
            continue
        entry = _masked_entry_from_json(provider, raw, index=i, active_id=active_id)
        cli_row = next((c for c in cli_entries if c.get("index") == i), None)
        if cli_row:
            if cli_row.get("active"):
                entry["active"] = True
            if cli_row.get("exhausted"):
                entry["exhausted"] = True
            if cli_row.get("status_hint"):
                entry["status_hint"] = cli_row["status_hint"]
        merged.append(entry)
    if not merged and cli_entries:
        for cli_row in cli_entries:
            merged.append({
                "index": cli_row.get("index"),
                "id": None,
                "label": cli_row.get("label") or f"#{cli_row.get('index')}",
                "auth_type": cli_row.get("auth_type") or "api_key",
                "source": cli_row.get("source") or "manual",
                "masked_key": "••••",
                "exhausted": bool(cli_row.get("exhausted")),
                "active": bool(cli_row.get("active")),
                "priority": 0,
                "request_count": 0,
                "last_status": "exhausted" if cli_row.get("exhausted") else None,
                "last_error_code": None,
                "last_error_message": None,
                "status_hint": cli_row.get("status_hint"),
            })
    return merged


def _parse_auth_status_cli(stdout: str, provider: str) -> dict[str, Any]:
    text = (stdout or "").strip()
    low = text.lower()
    logged_in = f"{provider}:" in low and "logged in" in low
    logged_out = f"{provider}:" in low and "logged out" in low
    error = None
    if logged_out:
        m = re.search(r"logged out\s*\((.+)\)\s*$", text, re.IGNORECASE)
        if m:
            error = m.group(1).strip()[:200]
    details: dict[str, str] = {}
    for line in text.splitlines()[1:]:
        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip()
            val = val.strip()
            if key and val and key not in _SECRET_JSON_KEYS:
                details[key] = val
    return {
        "provider": provider,
        "logged_in": logged_in,
        "logged_out": logged_out or not logged_in,
        "error": error,
        "details": details,
    }


def list_auth_pool(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    """List credential pool entries with masked secrets (CLI + auth.json)."""
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["auth", "list"], timeout=45, hermes_home=home)
    cli_by_provider = _parse_auth_list_cli(out) if out.strip() else {}
    auth = _read_auth_json(home)
    pool = auth.get("credential_pool") if isinstance(auth.get("credential_pool"), dict) else {}
    active_provider = str(auth.get("active_provider") or "").strip() or None

    providers: list[dict[str, Any]] = []
    provider_ids = sorted({
        *cli_by_provider.keys(),
        *(k for k, v in pool.items() if isinstance(v, list) and v),
    })

    for pid in provider_ids:
        entries_raw = pool.get(pid) if isinstance(pool.get(pid), list) else []
        entries_json = [e for e in entries_raw if isinstance(e, dict)]
        active_id = None
        if entries_json:
            # peek() equivalent: lowest priority usable; CLI marks active with ←
            sorted_entries = sorted(entries_json, key=lambda e: int(e.get("priority") or 99))
            cli_active = next(
                (c for c in cli_by_provider.get(pid, []) if c.get("active")),
                None,
            )
            if cli_active:
                idx = int(cli_active.get("index") or 1)
                if 1 <= idx <= len(sorted_entries):
                    active_id = str(sorted_entries[idx - 1].get("id") or "").strip() or None
            if not active_id and sorted_entries:
                active_id = str(sorted_entries[0].get("id") or "").strip() or None

        credentials = _merge_pool_entries(
            pid,
            entries_json,
            cli_by_provider.get(pid, []),
            active_id,
        )
        if not credentials:
            continue

        status_code, status_out, _ = _run_hermes(
            ["auth", "status", assert_safe_auth_provider(pid)],
            timeout=20,
            hermes_home=home,
        )
        status = _parse_auth_status_cli(status_out if status_code == 0 else "", pid)

        providers.append({
            "provider": pid,
            "credential_count": len(credentials),
            "active_provider": pid == active_provider,
            "logged_in": status.get("logged_in"),
            "status_error": status.get("error"),
            "credentials": credentials,
        })

    return {
        "ok": code == 0 or bool(providers),
        "cli_ok": code == 0,
        "active_provider": active_provider,
        "providers": providers,
        "error": err.strip()[:300] if code not in (0, 124) and not providers and err else None,
    }


def get_auth_provider_status(
    provider: str,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    provider = assert_safe_auth_provider(provider)
    code, out, err = _run_hermes(["auth", "status", provider], timeout=20, hermes_home=home)
    parsed = _parse_auth_status_cli(out if code == 0 else err, provider)
    return {"ok": code == 0, **parsed, "raw": out.strip()[:500] if out else None}


def reset_auth_pool_provider(
    provider: str,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    provider = assert_safe_auth_provider(provider)
    code, out, err = _run_hermes(["auth", "reset", provider], timeout=30, hermes_home=home)
    return {
        "ok": code == 0,
        "provider": provider,
        "output": (out or err).strip()[:1000],
        "exit_code": code,
    }


def remove_auth_pool_credential(
    provider: str,
    target: str,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    home = Path(hermes_home or Path.home() / ".hermes")
    provider = assert_safe_auth_provider(provider)
    target = assert_safe_auth_target(target)
    code, out, err = _run_hermes(
        ["auth", "remove", provider, target],
        timeout=30,
        hermes_home=home,
    )
    return {
        "ok": code == 0,
        "provider": provider,
        "target": target,
        "output": (out or err).strip()[:1000],
        "exit_code": code,
    }


def add_auth_api_key(
    provider: str,
    api_key: str,
    *,
    label: Optional[str] = None,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    """Non-interactive API key add via `hermes auth add --type api-key`."""
    home = Path(hermes_home or Path.home() / ".hermes")
    provider = assert_safe_auth_provider(provider)
    key = str(api_key or "").strip()
    if not key:
        raise ValueError("api_key is required")
    if key.startswith("-"):
        raise ValueError("api_key must not start with '-'")
    if len(key) > 512:
        raise ValueError("api_key is too long")
    args = ["auth", "add", provider, "--type", "api-key", "--api-key", key]
    if label is not None:
        label_text = str(label).strip()
        if label_text:
            args.extend(["--label", assert_safe_auth_target(label_text)])
    code, out, err = _run_hermes(args, timeout=60, hermes_home=home)
    # Never echo api_key back
    return {
        "ok": code == 0,
        "provider": provider,
        "output": (out or err).strip()[:1000],
        "exit_code": code,
    }


# ─── Nous Portal (hermes portal) ─────────────────────────────────────────────

_PORTAL_DEFAULT_URL = "https://portal.nousresearch.com"
_PORTAL_SUBSCRIPTION_URL = "https://portal.nousresearch.com/manage-subscription"
_PORTAL_DOCS_URL = (
    "https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-gateway"
)
_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*m")
_PORTAL_KV_LINE = re.compile(r"^\s{2}([A-Za-z][^:]{0,40}):\s{2,}(.+?)\s*$")
_PORTAL_GATEWAY_ROW = re.compile(r"^\s{2}(.+?)\s{2,}(.+?)\s*$")
_PORTAL_TOOL_ROW = re.compile(
    r"^\s{2}(.+?)\s{2,}partner:\s*(\S+)\s{2,}(.+?)\s*$"
)


def _strip_ansi(text: str) -> str:
    return _ANSI_ESCAPE.sub("", text or "")


def _sanitize_portal_url(url: str) -> Optional[str]:
    """Return a safe http(s) URL — strip query tokens and mask embedded secrets."""
    text = _strip_ansi(str(url or "").strip())
    if not text or text.startswith("hermes "):
        return None
    try:
        parsed = urlparse(text)
    except Exception:  # noqa: BLE001 - unparseable URL treated as unsafe
        return None
    if parsed.scheme.lower() not in _SAFE_HTTP_SCHEMES or not parsed.hostname:
        return None
    # Drop query/fragment — OAuth/device codes must not leak to the client.
    safe = f"{parsed.scheme}://{parsed.netloc}{parsed.path or ''}".rstrip("/")
    if any(
        bad in (parsed.query or "").lower()
        for bad in ("token=", "code=", "key=", "secret=", "access_token=")
    ):
        return safe
    return safe


def _portal_tool_state(raw: str) -> dict[str, Any]:
    """Normalize a Tool Gateway status cell from CLI output."""
    text = _strip_ansi(str(raw or "").strip())
    low = text.lower()
    via_nous = "via nous portal" in low or "✓ via nous" in low
    not_configured = "not configured" in low
    active = not not_configured and (
        via_nous or bool(text) and text not in ("unknown",)
    )
    provider = None
    if active and not via_nous and not not_configured:
        provider = text[:80]
    return {
        "status_text": text[:120] or "unknown",
        "via_nous": via_nous,
        "active": active,
        "configured": active and not not_configured,
        "provider": provider,
    }


def _parse_portal_status_cli(stdout: str) -> dict[str, Any]:
    """Parse `hermes portal info` / `status` human output."""
    clean = _strip_ansi(stdout or "")
    logged_in = False
    logged_out = True
    portal_url: Optional[str] = None
    inference_base_url: Optional[str] = None
    signup_url: Optional[str] = None
    model_hint: Optional[str] = None
    using_nous_provider = False
    tool_gateway: list[dict[str, Any]] = []
    docs_url: Optional[str] = None
    section: Optional[str] = None

    for line in clean.splitlines():
        stripped = line.strip()
        if stripped.startswith("Docs:"):
            docs_url = _sanitize_portal_url(stripped.split(":", 1)[1].strip())
            continue
        if stripped == "Nous Portal":
            section = "portal"
            continue
        if stripped == "Tool Gateway" or stripped == "Tool Gateway catalog":
            section = "gateway"
            continue
        if "─" in stripped or not stripped:
            continue
        if section == "portal":
            m = _PORTAL_KV_LINE.match(line)
            if not m:
                continue
            key, val = m.group(1).strip().lower(), m.group(2).strip()
            if key == "auth":
                if "logged in" in val.lower() and "not logged" not in val.lower():
                    logged_in = True
                    logged_out = False
                else:
                    logged_in = False
                    logged_out = True
            elif key == "portal":
                portal_url = _sanitize_portal_url(val)
            elif key == "api":
                inference_base_url = _sanitize_portal_url(val)
            elif key == "sign up":
                signup_url = _sanitize_portal_url(val)
            elif key == "model":
                model_hint = val[:160]
                using_nous_provider = "using nous" in val.lower()
            continue
        if section == "gateway":
            m = _PORTAL_GATEWAY_ROW.match(line)
            if not m:
                continue
            label = m.group(1).strip()
            if not label or label.startswith("("):
                continue
            state = _portal_tool_state(m.group(2))
            tool_gateway.append({
                "label": label[:80],
                **state,
            })

    return {
        "logged_in": logged_in,
        "logged_out": logged_out,
        "portal_url": portal_url,
        "inference_base_url": inference_base_url,
        "signup_url": signup_url or _PORTAL_SUBSCRIPTION_URL,
        "model_hint": model_hint,
        "using_nous_provider": using_nous_provider,
        "tool_gateway": tool_gateway,
        "docs_url": docs_url or _PORTAL_DOCS_URL,
    }


def _parse_portal_tools_cli(stdout: str) -> dict[str, Any]:
    """Parse `hermes portal tools` catalog output."""
    clean = _strip_ansi(stdout or "")
    tools: list[dict[str, Any]] = []
    nous_auth_present = "not logged into nous portal" not in clean.lower()
    docs_url: Optional[str] = None
    subscription_url: Optional[str] = None

    for line in clean.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("manage your subscription:"):
            subscription_url = _sanitize_portal_url(stripped.split(":", 1)[1].strip())
            continue
        if stripped.startswith("Docs:"):
            docs_url = _sanitize_portal_url(stripped.split(":", 1)[1].strip())
            continue
        m = _PORTAL_TOOL_ROW.match(line)
        if not m:
            continue
        label, partner, state_raw = m.group(1).strip(), m.group(2).strip(), m.group(3)
        state = _portal_tool_state(state_raw)
        tools.append({
            "label": label[:80],
            "partner": partner[:40],
            **state,
        })

    return {
        "tools": tools,
        "nous_auth_present": nous_auth_present,
        "subscription_url": subscription_url or _PORTAL_SUBSCRIPTION_URL,
        "docs_url": docs_url or _PORTAL_DOCS_URL,
    }


def _portal_auth_hints(hermes_home: Path) -> dict[str, Any]:
    """Non-secret hints from auth.json for Portal URL resolution."""
    auth = _read_auth_json(hermes_home)
    portal_url: Optional[str] = None
    has_oauth = False
    pool = auth.get("credential_pool") if isinstance(auth.get("credential_pool"), dict) else {}
    nous_entries = pool.get("nous") if isinstance(pool.get("nous"), list) else []
    for entry in nous_entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("access_token") or entry.get("refresh_token"):
            has_oauth = True
        pb = str(entry.get("portal_base_url") or "").strip()
        if pb:
            portal_url = _sanitize_portal_url(pb)
    return {
        "portal_url": portal_url,
        "has_oauth_credentials": has_oauth,
    }


def get_portal_info(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    """Portal auth + Tool Gateway routing summary (`hermes portal info`)."""
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["portal", "info"], timeout=45, hermes_home=home)
    parsed = _parse_portal_status_cli(out if out.strip() else err)
    hints = _portal_auth_hints(home)
    if hints.get("portal_url") and not parsed.get("portal_url"):
        parsed["portal_url"] = hints["portal_url"]
    if hints.get("has_oauth_credentials") and not parsed.get("logged_in"):
        parsed["logged_in"] = True
        parsed["logged_out"] = False
    return {
        "ok": code == 0 or bool(parsed.get("tool_gateway")),
        "cli_ok": code == 0,
        **parsed,
        "error": err.strip()[:300] if code not in (0, 124) and not out.strip() else None,
    }


def get_portal_status(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    """Alias for `hermes portal status` (same output as info)."""
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["portal", "status"], timeout=45, hermes_home=home)
    if code == 0 and out.strip():
        parsed = _parse_portal_status_cli(out)
    else:
        # Fall back to info semantics when status is unavailable.
        return get_portal_info(home)
    hints = _portal_auth_hints(home)
    if hints.get("portal_url") and not parsed.get("portal_url"):
        parsed["portal_url"] = hints["portal_url"]
    if hints.get("has_oauth_credentials") and not parsed.get("logged_in"):
        parsed["logged_in"] = True
        parsed["logged_out"] = False
    return {
        "ok": code == 0 or bool(parsed.get("tool_gateway")),
        "cli_ok": code == 0,
        **parsed,
        "error": err.strip()[:300] if code not in (0, 124) and not out.strip() else None,
    }


def list_portal_tools(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    """Tool Gateway catalog (`hermes portal tools`)."""
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["portal", "tools"], timeout=45, hermes_home=home)
    parsed = _parse_portal_tools_cli(out if out.strip() else err)
    return {
        "ok": code == 0 or bool(parsed.get("tools")),
        "cli_ok": code == 0,
        **parsed,
        "error": err.strip()[:300] if code not in (0, 124) and not parsed.get("tools") and err else None,
    }


def get_portal_open_url(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    """Safe Portal URLs for Spark — never starts interactive OAuth."""
    home = Path(hermes_home or Path.home() / ".hermes")
    info = get_portal_info(home)
    hints = _portal_auth_hints(home)
    portal_url = (
        info.get("portal_url")
        or hints.get("portal_url")
        or _PORTAL_DEFAULT_URL
    )
    subscription_url = info.get("signup_url") or _PORTAL_SUBSCRIPTION_URL
    login_url = portal_url or _PORTAL_DEFAULT_URL
    logged_in = bool(info.get("logged_in"))
    return {
        "ok": True,
        "portal_url": portal_url,
        "subscription_url": subscription_url,
        "login_url": login_url,
        "docs_url": info.get("docs_url") or _PORTAL_DOCS_URL,
        "logged_in": logged_in,
        "login_hint": (
            "Use Login with device code in Settings to connect Nous Portal."
            if not logged_in
            else "Manage your subscription or Tool Gateway from the Portal."
        ),
    }


# ─── Nous Portal device-code OAuth (in-bridge, no hermes web) ────────────────

_PORTAL_OAUTH_SESSION_TTL_SECONDS = 15 * 60
_DEVICE_AUTH_POLL_INTERVAL_CAP_SECONDS = 1
_portal_oauth_sessions: dict[str, dict[str, Any]] = {}
_portal_oauth_sessions_lock = threading.Lock()
# Only taken on the legacy env-var fallback path in _scoped_hermes_home, where
# the home is process-global and must be serialized to stay coherent.
_legacy_home_env_lock = threading.RLock()


def _hermes_home_override_api(hermes_home: Optional[Path] = None):
    """Return hermes-agent's context-local home override functions, or None.

    hermes_constants.get_hermes_home() resolves, in order: a context-local
    override, then the HERMES_HOME env var, then the platform default. The
    override is a ContextVar, so it is isolated per thread and per asyncio task —
    which is exactly the isolation a per-profile home needs.

    Returns None on a hermes-agent old enough to predate the API, so callers can
    fall back rather than fail.
    """
    agent_str = str(_hermes_agent_dir(hermes_home))
    if agent_str not in sys.path:
        sys.path.insert(0, agent_str)
    try:
        from hermes_constants import (
            reset_hermes_home_override,
            set_hermes_home_override,
        )
    except Exception:  # noqa: BLE001 - hermes-agent is optional; None signals unavailable
        return None
    return set_hermes_home_override, reset_hermes_home_override


@contextmanager
def _scoped_hermes_home(hermes_home: Path):
    """Scope the Hermes home to one profile for the current thread/task.

    Previously this rewrote os.environ["HERMES_HOME"], which is process-global.
    Two profiles served concurrently in worker threads therefore read each
    other's home, so a chat turn could resolve — and write — another profile's
    credentials and state.

    Uses hermes-agent's own context-local override where available. The env
    mutation remains only as a fallback for a hermes-agent too old to expose the
    API, and takes a lock so that degraded path at least stays internally
    consistent instead of interleaving.
    """
    api = _hermes_home_override_api(hermes_home)
    if api is not None:
        set_override, reset_override = api
        token = set_override(hermes_home)
        try:
            yield
        finally:
            reset_override(token)
        return

    with _legacy_home_env_lock:
        prev_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(hermes_home)
        try:
            yield
        finally:
            if prev_home is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = prev_home


def _load_nous_auth_helpers():
    """Import hermes_cli.auth helpers from the installed hermes-agent checkout."""
    agent_dir = _hermes_agent_dir()
    if not agent_dir.is_dir():
        return None
    agent_str = str(agent_dir)
    if agent_str not in sys.path:
        sys.path.insert(0, agent_str)
    try:
        from hermes_cli import auth as auth_mod

        return auth_mod
    except Exception:  # noqa: BLE001 - hermes-agent is optional; None signals unavailable
        return None


def _gc_portal_oauth_sessions() -> None:
    cutoff = time.time() - _PORTAL_OAUTH_SESSION_TTL_SECONDS
    with _portal_oauth_sessions_lock:
        stale = [
            sid
            for sid, sess in _portal_oauth_sessions.items()
            if float(sess.get("created_at") or 0) < cutoff
        ]
        for sid in stale:
            _portal_oauth_sessions.pop(sid, None)


def _sanitize_verification_url(url: str) -> Optional[str]:
    """Return a safe verification URL — strip secret query params, keep user_code."""
    text = _strip_ansi(str(url or "").strip())
    if not text:
        return None
    try:
        parsed = urlparse(text)
    except Exception:  # noqa: BLE001 - unparseable URL treated as unsafe
        return None
    if parsed.scheme.lower() not in _SAFE_HTTP_SCHEMES or not parsed.hostname:
        return None
    secret_keys = frozenset({
        "device_code",
        "access_token",
        "refresh_token",
        "token",
        "code",
    })
    query = parse_qs(parsed.query, keep_blank_values=True)
    safe_pairs: list[tuple[str, str]] = []
    for key, values in query.items():
        if key.lower() in secret_keys:
            continue
        for value in values:
            safe_pairs.append((key, value))
    safe_query = urlencode(safe_pairs)
    rebuilt = urlunparse((
        parsed.scheme,
        parsed.netloc,
        parsed.path or "",
        parsed.params,
        safe_query,
        "",
    ))
    return rebuilt.rstrip("/")


def _portal_oauth_already_logged_in(home: Path) -> bool:
    info = get_portal_info(home)
    if info.get("logged_in"):
        return True
    return bool(_portal_auth_hints(home).get("has_oauth_credentials"))


def _build_nous_auth_state_from_token(
    auth_mod: Any,
    *,
    portal_base_url: str,
    client_id: str,
    scope: Optional[str],
    token_data: dict[str, Any],
) -> dict[str, Any]:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    token_ttl = int(token_data.get("expires_in") or 0)
    expires_at = (
        datetime.fromtimestamp(now.timestamp() + token_ttl, tz=timezone.utc).isoformat()
        if token_ttl
        else None
    )
    inference_url = (
        str(token_data.get("inference_base_url") or "").strip().rstrip("/")
        or auth_mod.DEFAULT_NOUS_INFERENCE_URL
    )
    return {
        "portal_base_url": portal_base_url,
        "inference_base_url": inference_url,
        "client_id": client_id,
        "scope": token_data.get("scope") or scope,
        "token_type": token_data.get("token_type", "Bearer"),
        "access_token": token_data["access_token"],
        "refresh_token": token_data.get("refresh_token"),
        "obtained_at": now.isoformat(),
        "expires_at": expires_at,
        "expires_in": token_ttl,
        "tls": {"insecure": False, "ca_bundle": None},
        "agent_key": None,
        "agent_key_expires_at": None,
    }


def _persist_imported_nous_state(
    auth_mod: Any,
    state: dict[str, Any],
    *,
    hermes_home: Path,
) -> None:
    with _scoped_hermes_home(hermes_home):
        auth_mod.persist_nous_credentials(state)


def _single_poll_nous_token(
    auth_mod: Any,
    sess: dict[str, Any],
) -> tuple[str, Optional[dict[str, Any]], Optional[str]]:
    """One token-endpoint poll. Returns (status, token_data, error_message)."""
    import httpx

    portal_base_url = str(sess["portal_base_url"])
    client_id = str(sess["client_id"])
    device_code = str(sess["device_code"])
    try:
        with httpx.Client(
            timeout=httpx.Timeout(15.0),
            headers={"Accept": "application/json"},
        ) as client:
            response = client.post(
                f"{portal_base_url}/api/oauth/token",
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "client_id": client_id,
                    "device_code": device_code,
                },
            )
    except Exception as exc:  # noqa: BLE001 - network failure is returned as an error status
        return "error", None, str(exc)[:300]

    if response.status_code == 200:
        payload = response.json()
        if not isinstance(payload, dict) or "access_token" not in payload:
            return "error", None, "Token response did not include access_token"
        return "complete", payload, None

    try:
        error_payload = response.json()
    except Exception:  # noqa: BLE001 - non-JSON error body falls back to HTTP status message
        return "error", None, f"Token endpoint returned HTTP {response.status_code}"

    if not isinstance(error_payload, dict):
        return "error", None, "Token endpoint returned a non-JSON error response"

    error_code = str(error_payload.get("error") or "")
    if error_code == "authorization_pending":
        return "pending", None, None
    if error_code == "slow_down":
        current = int(sess.get("poll_interval") or 1)
        sess["poll_interval"] = min(current + 1, 30)
        return "pending", None, None

    description = (
        str(error_payload.get("error_description") or "").strip()
        or "Unknown authentication error"
    )
    return "error", None, f"{error_code}: {description}"[:300]


def portal_oauth_start(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    """Begin Nous Portal device-code OAuth — never returns tokens or device_code."""
    home = Path(hermes_home or Path.home() / ".hermes")
    _gc_portal_oauth_sessions()

    if _portal_oauth_already_logged_in(home):
        return {
            "ok": True,
            "already_logged_in": True,
            "logged_in": True,
        }

    auth_mod = _load_nous_auth_helpers()
    if auth_mod is None:
        return {
            "ok": False,
            "error": "hermes-agent not installed (cannot load Nous OAuth helpers)",
        }

    with _scoped_hermes_home(home):
        imported = auth_mod._try_import_shared_nous_state(timeout_seconds=15.0)
    if imported:
        try:
            _persist_imported_nous_state(auth_mod, imported, hermes_home=home)
        except Exception as exc:  # noqa: BLE001 - failure is returned to the client as an error response
            return {"ok": False, "error": str(exc)[:300]}
        return {
            "ok": True,
            "already_logged_in": True,
            "logged_in": True,
            "imported_shared_state": True,
        }

    pconfig = auth_mod.PROVIDER_REGISTRY["nous"]
    portal_base_url = (
        os.getenv("HERMES_PORTAL_BASE_URL")
        or os.getenv("NOUS_PORTAL_BASE_URL")
        or pconfig.portal_base_url
    ).rstrip("/")
    client_id = pconfig.client_id
    scope = pconfig.scope

    import httpx

    try:
        with httpx.Client(
            timeout=httpx.Timeout(15.0),
            headers={"Accept": "application/json"},
        ) as client:
            device_data = auth_mod._request_device_code(
                client=client,
                portal_base_url=portal_base_url,
                client_id=client_id,
                scope=scope,
            )
    except Exception as exc:  # noqa: BLE001 - failure is returned to the client as an error response
        return {"ok": False, "error": str(exc)[:300]}

    session_id = secrets.token_urlsafe(16)
    expires_in = int(device_data["expires_in"])
    poll_interval = max(
        1,
        min(int(device_data["interval"]), _DEVICE_AUTH_POLL_INTERVAL_CAP_SECONDS),
    )
    verification_url = _sanitize_verification_url(
        str(device_data["verification_uri_complete"])
    )
    if not verification_url:
        verification_url = _sanitize_verification_url(
            str(device_data["verification_uri"])
        )
    user_code = str(device_data["user_code"])

    sess = {
        "session_id": session_id,
        "created_at": time.time(),
        "expires_at": time.time() + expires_in,
        "portal_base_url": portal_base_url,
        "client_id": client_id,
        "scope": scope,
        "device_code": str(device_data["device_code"]),
        "poll_interval": poll_interval,
        "last_poll_at": 0.0,
        "status": "pending",
        "hermes_home": str(home),
    }
    with _portal_oauth_sessions_lock:
        _portal_oauth_sessions[session_id] = sess

    return {
        "ok": True,
        "session_id": session_id,
        "user_code": user_code,
        "verification_url": verification_url,
        "expires_in": expires_in,
        "poll_interval": poll_interval,
        "already_logged_in": False,
    }


def portal_oauth_poll(
    session_id: str,
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    """Poll device-code OAuth status — masked fields only."""
    session_id = assert_safe_gateway_session_id(session_id)
    _gc_portal_oauth_sessions()

    with _portal_oauth_sessions_lock:
        sess = _portal_oauth_sessions.get(session_id)
    if not sess:
        return {
            "ok": False,
            "session_id": session_id,
            "status": "not_found",
            "error": "Session not found or expired",
        }

    home = Path(hermes_home or sess.get("hermes_home") or Path.home() / ".hermes")
    poll_interval = int(sess.get("poll_interval") or 1)
    now = time.time()

    if now >= float(sess.get("expires_at") or 0):
        with _portal_oauth_sessions_lock:
            _portal_oauth_sessions.pop(session_id, None)
        return {
            "ok": True,
            "session_id": session_id,
            "status": "expired",
            "poll_interval": poll_interval,
            "error": "Device code expired — start login again",
        }

    terminal = str(sess.get("status") or "pending")
    if terminal == "complete":
        with _portal_oauth_sessions_lock:
            _portal_oauth_sessions.pop(session_id, None)
        return {
            "ok": True,
            "session_id": session_id,
            "status": "complete",
            "logged_in": True,
            "poll_interval": poll_interval,
        }
    if terminal == "error":
        message = str(sess.get("error_message") or "Authentication failed")[:300]
        with _portal_oauth_sessions_lock:
            _portal_oauth_sessions.pop(session_id, None)
        return {
            "ok": False,
            "session_id": session_id,
            "status": "error",
            "poll_interval": poll_interval,
            "error": message,
        }

    last_poll = float(sess.get("last_poll_at") or 0)
    if now - last_poll < poll_interval:
        return {
            "ok": True,
            "session_id": session_id,
            "status": "pending",
            "poll_interval": poll_interval,
        }

    auth_mod = _load_nous_auth_helpers()
    if auth_mod is None:
        return {
            "ok": False,
            "session_id": session_id,
            "status": "error",
            "error": "hermes-agent not installed (cannot poll OAuth)",
        }

    sess["last_poll_at"] = now
    poll_status, token_data, poll_error = _single_poll_nous_token(auth_mod, sess)

    if poll_status == "pending":
        with _portal_oauth_sessions_lock:
            _portal_oauth_sessions[session_id] = sess
        return {
            "ok": True,
            "session_id": session_id,
            "status": "pending",
            "poll_interval": int(sess.get("poll_interval") or poll_interval),
        }

    if poll_status == "error":
        sess["status"] = "error"
        sess["error_message"] = poll_error
        with _portal_oauth_sessions_lock:
            _portal_oauth_sessions[session_id] = sess
        return portal_oauth_poll(session_id, hermes_home=home)

    assert token_data is not None
    try:
        auth_state = _build_nous_auth_state_from_token(
            auth_mod,
            portal_base_url=str(sess["portal_base_url"]),
            client_id=str(sess["client_id"]),
            scope=sess.get("scope"),
            token_data=token_data,
        )
        with _scoped_hermes_home(home):
            full_state = auth_mod.refresh_nous_oauth_from_state(
                auth_state,
                timeout_seconds=15.0,
                force_refresh=False,
            )
            auth_mod.persist_nous_credentials(full_state)
        sess["status"] = "complete"
        with _portal_oauth_sessions_lock:
            _portal_oauth_sessions[session_id] = sess
    except Exception as exc:  # noqa: BLE001 - failure is recorded on the OAuth session as an error status
        sess["status"] = "error"
        sess["error_message"] = str(exc)[:300]
        with _portal_oauth_sessions_lock:
            _portal_oauth_sessions[session_id] = sess
        return portal_oauth_poll(session_id, hermes_home=home)

    return portal_oauth_poll(session_id, hermes_home=home)


def open_portal_subscription(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    """Non-interactive `hermes portal open` — launches default browser on the host."""
    home = Path(hermes_home or Path.home() / ".hermes")
    code, out, err = _run_hermes(["portal", "open"], timeout=20, hermes_home=home)
    urls = get_portal_open_url(home)
    opened = code == 0
    return {
        "ok": opened,
        "exit_code": code,
        "url": urls.get("subscription_url"),
        "output": _strip_ansi((out or err).strip()[:500]),
        "error": None if opened else (err or out or "could not open browser")[:300],
    }


# ─── Security audit / secrets managers ───────────────────────────────────────

_SECURITY_SEVERITIES = ("critical", "high", "moderate", "low")


def _parse_secrets_status_table(stdout: str) -> dict[str, str]:
    """Parse key/value rows from `hermes secrets * status` box output."""
    fields: dict[str, str] = {}
    for line in (stdout or "").splitlines():
        cleaned = line.strip().strip("│╭╰─").strip()
        if not cleaned or cleaned.lower().startswith("run hermes"):
            continue
        parts = re.split(r"\s{2,}", cleaned, maxsplit=1)
        if len(parts) != 2:
            continue
        key, val = parts[0].strip().lower(), parts[1].strip()
        if key:
            fields[key] = val
    return fields


def _secrets_provider_summary(
    provider_id: str,
    fields: dict[str, str],
    *,
    cli_ok: bool,
) -> dict[str, Any]:
    """Client-safe secrets-manager status — no token values or references."""
    enabled = fields.get("enabled", "no").lower() in ("yes", "true", "1")
    token_in_env = fields.get("token in env", "no").lower() in ("yes", "true", "1")
    binary_key = "bws binary" if provider_id == "bitwarden" else "op binary"
    binary = fields.get(binary_key, "unknown")
    refs_raw = fields.get("references", "0")
    try:
        reference_count = max(0, int(re.sub(r"\D", "", refs_raw) or "0"))
    except ValueError:
        reference_count = 0
    project_set = bool(fields.get("project id") and fields.get("project id") != "(unset)")
    configured = enabled or token_in_env or reference_count > 0 or project_set
    return {
        "id": provider_id,
        "label": "Bitwarden" if provider_id == "bitwarden" else "1Password",
        "cli_ok": cli_ok,
        "enabled": enabled,
        "configured": configured,
        "token_in_env": token_in_env,
        "binary": binary[:80],
        "reference_count": reference_count if provider_id == "onepassword" else None,
        "project_configured": project_set if provider_id == "bitwarden" else None,
    }


def get_secrets_status(hermes_home: Optional[Path] = None) -> dict[str, Any]:
    """Status-only view of Bitwarden / 1Password integrations."""
    home = Path(hermes_home or Path.home() / ".hermes")
    providers: list[dict[str, Any]] = []
    for cmd, pid in (("bitwarden", "bitwarden"), ("onepassword", "onepassword")):
        code, out, err = _run_hermes(["secrets", cmd, "status"], timeout=45, hermes_home=home)
        fields = _parse_secrets_status_table(out or err)
        providers.append(_secrets_provider_summary(pid, fields, cli_ok=code == 0))
    return {
        "ok": True,
        "any_enabled": any(p.get("enabled") for p in providers),
        "any_configured": any(p.get("configured") for p in providers),
        "providers": providers,
    }


def _sanitize_audit_finding(raw: dict[str, Any]) -> dict[str, Any]:
    """Strip audit finding to client-safe fields."""
    fixed = raw.get("fixed_versions")
    fixed_list: list[str] = []
    if isinstance(fixed, list):
        fixed_list = [str(v)[:24] for v in fixed[:4]]
    return {
        "package": str(raw.get("package") or "")[:80],
        "version": str(raw.get("version") or "")[:40],
        "ecosystem": str(raw.get("ecosystem") or "")[:24],
        "source": str(raw.get("source") or "")[:24],
        "vuln_id": str(raw.get("vuln_id") or "")[:48],
        "severity": str(raw.get("severity") or "UNKNOWN").upper()[:16],
        "summary": str(raw.get("summary") or "")[:240],
        "fixed_versions": fixed_list,
    }


def _count_audit_severities(findings: list[dict[str, Any]]) -> dict[str, int]:
    counts = {s: 0 for s in _SECURITY_SEVERITIES}
    for row in findings:
        sev = str(row.get("severity") or "").lower()
        if sev in counts:
            counts[sev] += 1
    return counts


def run_security_audit(
    hermes_home: Optional[Path] = None,
    *,
    skip_venv: bool = False,
) -> dict[str, Any]:
    """Run `hermes security audit --json` and return a masked summary."""
    home = Path(hermes_home or Path.home() / ".hermes")
    args = ["security", "audit", "--json"]
    if skip_venv:
        args.append("--skip-venv")
    code, out, err = _run_hermes(args, timeout=180, hermes_home=home)
    combined = (out or err).strip()
    payload: Optional[dict[str, Any]] = None
    if combined.startswith("{"):
        try:
            parsed = json.loads(combined)
            if isinstance(parsed, dict):
                payload = parsed
        except json.JSONDecodeError:
            payload = None
    if payload is not None:
        raw_findings = payload.get("findings") if isinstance(payload.get("findings"), list) else []
        safe_findings = [
            _sanitize_audit_finding(row)
            for row in raw_findings[:50]
            if isinstance(row, dict)
        ]
        severity_counts = _count_audit_severities(safe_findings)
        finding_count = payload.get("finding_count")
        if not isinstance(finding_count, int):
            finding_count = len(raw_findings)
        scanned = payload.get("total_components_scanned")
        if not isinstance(scanned, int):
            scanned = 0
        return {
            "ok": code == 0 or finding_count == 0,
            "exit_code": code,
            "total_components_scanned": scanned,
            "finding_count": finding_count,
            "severity_counts": severity_counts,
            "findings": safe_findings[:12],
            "error": None if code == 0 else str(err or "")[:300] or None,
        }
    summary = combined[:2000] if combined else ""
    return {
        "ok": code == 0,
        "exit_code": code,
        "total_components_scanned": 0,
        "finding_count": 0,
        "severity_counts": {s: 0 for s in _SECURITY_SEVERITIES},
        "findings": [],
        "summary": summary,
        "error": None if code == 0 else (summary or str(err or ""))[:500],
    }


def kanban_swarm_create(
    goal: str,
    *,
    workers: Optional[list[str]] = None,
    verifier: str = "reviewer",
    synthesizer: str = "writer",
    hermes_home: Optional[Path] = None,
) -> dict[str, Any]:
    """Create a Hermes Kanban Swarm v1 graph via CLI."""
    home = Path(hermes_home or Path.home() / ".hermes")
    goal = assert_safe_cli_goal(goal)
    verifier = assert_safe_cli_token(verifier, label="verifier")
    synthesizer = assert_safe_cli_token(synthesizer, label="synthesizer")
    args = ["kanban", "swarm", goal, "--verifier", verifier, "--synthesizer", synthesizer, "--json"]
    for w in workers or []:
        w = str(w).strip()
        if w:
            args.extend(["--worker", assert_safe_cli_token(w, label="worker")])
    if not workers:
        # Default three parallel workers if none supplied
        args.extend([
            "--worker", "researcher:Research",
            "--worker", "architect:Design",
            "--worker", "sre:Risks",
        ])
    code, out, err = _run_hermes(args, timeout=120, hermes_home=home)
    parsed = None
    if out.strip():
        try:
            parsed = json.loads(out)
        except json.JSONDecodeError:
            parsed = None
    return {
        "ok": code == 0,
        "exit_code": code,
        "output": (out or err).strip()[:6000],
        "result": parsed,
        "error": None if code == 0 else (err or out or "swarm create failed")[:500],
    }
