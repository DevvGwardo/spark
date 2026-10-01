"""Hermes profile/home resolution, state.db access and workspace inspection helpers.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import asyncio
import hashlib
import logging
import os
import sqlite3
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import Request
from pydantic import BaseModel, Field

import pricing
from cron_manager import (
    _cron_job_count,
    _HERMES_CRON_AVAILABLE,
    _run_hermes_skills_hub_helper,
)
from session_tracker import (
    _append_session_chat_chunk,
    _iso_to_unix,
    _MAX_SESSION_CHAT_MESSAGES,
    _MAX_SESSION_MESSAGE_CHARS,
    _message_field,
    _normalize_chat_messages,
    _normalize_message_content,
    _normalize_message_role,
    _now_iso,
    _session_summary,
    _sessions,
    _sessions_lock,
    _trim_session_message_content,
)

logger = logging.getLogger(__name__)


# --- Session tracking for Hermes Chats view ---


def _save_session_to_db(session: dict) -> None:
    """Persist a session row to hermes state.db. Skips if DB doesn't exist."""
    try:
        profile_name = str(session.get("profile") or "").strip() or _read_active_profile_name()
        state_db_path = _state_db_path(_resolve_hermes_home(profile_name))
        if not state_db_path.exists():
            return
        started_at = _iso_to_unix(session.get("created_at", ""))
        ended_at_raw = session.get("updated_at")
        ended_at = _iso_to_unix(ended_at_raw) if ended_at_raw else None
        status = session.get("status", "active")
        end_reason = None
        if status == "completed":
            end_reason = "completed"
        elif status == "error":
            end_reason = "error"
        with sqlite3.connect(str(state_db_path)) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO sessions (id, source, model, started_at, ended_at, end_reason, message_count, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session.get("id"),
                    "bridge",
                    session.get("model"),
                    started_at,
                    ended_at,
                    end_reason,
                    session.get("messages", 0),
                    session.get("firstUserMessage", "")[:100],
                ),
            )
    except Exception:  # noqa: BLE001 - best-effort; must not break request handling
        logger.debug("session persistence failed", exc_info=True)





# --- Hermes workspace inspection/editing ---
_HERMES_HOME = Path(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")))
# Profile manager workspace — honor HERMES_HOME so start-all.sh can align the
# bridge with a docker container's bind-mounted data dir.
_PROFILE_MANAGER_HOME = _HERMES_HOME
_PROFILES_ROOT = _PROFILE_MANAGER_HOME / "profiles"
_ACTIVE_PROFILE_PATH = _PROFILE_MANAGER_HOME / "active_profile"


def _normalize_profile_name(value: Optional[object]) -> str:
    if value is None:
        return "default"
    text = str(value).strip()
    if "/" in text or "\\" in text or ".." in text:
        return "default"
    return text if text and text != "default" else "default"


def _read_active_profile_name() -> str:
    if not _ACTIVE_PROFILE_PATH.exists():
        return "default"
    try:
        return _normalize_profile_name(_ACTIVE_PROFILE_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - unreadable profile file falls back to the default profile
        return "default"


def _resolve_profile_name(request: Optional[Request] = None) -> str:
    if request is not None:
        try:
            header_value = request.headers.get("x-hermes-profile")
        except Exception:  # noqa: BLE001 - header access failure treated as no profile header
            header_value = None
        normalized = _normalize_profile_name(header_value)
        if header_value is not None and str(header_value).strip():
            return normalized
    return _read_active_profile_name()


def _resolve_hermes_home(profile_name: Optional[object] = None) -> Path:
    normalized = _normalize_profile_name(profile_name)
    if normalized == "default":
        return _PROFILE_MANAGER_HOME

    candidate = _PROFILES_ROOT / normalized
    return candidate if candidate.exists() else _PROFILE_MANAGER_HOME


def _state_db_path(hermes_home: Path) -> Path:
    return hermes_home / "state.db"


def _skills_dir(hermes_home: Path) -> Path:
    return hermes_home / "skills"


def _canonical_files(hermes_home: Path) -> dict[str, dict[str, object]]:
    return {
        "soul": {
            "label": "SOUL.md",
            "description": "System identity and operating posture",
            "path": hermes_home / "SOUL.md",
        },
        "user": {
            "label": "USER.md",
            "description": "User-facing working memory",
            "path": hermes_home / "memories" / "USER.md",
        },
        "memory": {
            "label": "MEMORY.md",
            "description": "Shared durable memory",
            "path": hermes_home / "memories" / "MEMORY.md",
        },
    }


def _iso_from_unix(timestamp: Optional[float]) -> Optional[str]:
    if timestamp in (None, ""):
        return None
    try:
        return datetime.fromtimestamp(float(timestamp), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _iso_from_stat(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    except (OSError, ValueError, OverflowError):
        return None


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def _content_version(content: str) -> str:
    return hashlib.sha1(content.encode("utf-8")).hexdigest()[:12]


def _collapse_excerpt(text: str, limit: int = 220) -> str:
    if not text:
        return ""

    lines = text.splitlines()
    start_index = 0
    if lines and lines[0].strip() == "---":
        for idx in range(1, len(lines)):
            if lines[idx].strip() == "---":
                start_index = idx + 1
                break

    parts: list[str] = []
    total = 0
    for line in lines[start_index:]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts.append(stripped)
        total += len(stripped) + 1
        if total >= limit:
            break

    excerpt = " ".join(parts).strip()
    if len(excerpt) <= limit:
        return excerpt
    return excerpt[: limit - 1].rstrip() + "…"


def _parse_frontmatter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if len(lines) < 3 or lines[0].strip() != "---":
        return {}

    metadata: dict[str, str] = {}
    for line in lines[1:]:
        stripped = line.strip()
        if stripped == "---":
            break
        if ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        metadata[key.strip()] = value.strip().strip('"').strip("'")
    return metadata


def _canonical_file_entry(
    file_key: str,
    *,
    hermes_home: Optional[Path] = None,
    include_content: bool = False,
) -> Optional[dict]:
    resolved_home = hermes_home or _HERMES_HOME
    config = _canonical_files(resolved_home).get(file_key)
    if not config:
        return None

    path = config["path"]
    assert isinstance(path, Path)
    content = _read_text(path)
    exists = path.exists()
    payload = {
        "key": file_key,
        "label": config["label"],
        "description": config["description"],
        "path": str(path),
        "exists": exists,
        "size": path.stat().st_size if exists else 0,
        "modified_at": _iso_from_stat(path),
        "preview": _collapse_excerpt(content, 180),
        "version": _content_version(content),
    }
    if include_content:
        payload["content"] = content
    return payload


def _list_canonical_files(*, hermes_home: Optional[Path] = None) -> list[dict]:
    return [
        entry
        for key in ("soul", "user", "memory")
        if (entry := _canonical_file_entry(key, hermes_home=hermes_home)) is not None
    ]


def _query_state_db(
    query: str,
    params: tuple = (),
    *,
    hermes_home: Optional[Path] = None,
) -> list[sqlite3.Row]:
    state_db_path = _state_db_path(hermes_home or _HERMES_HOME)
    if not state_db_path.exists():
        return []

    connection = sqlite3.connect(str(state_db_path))
    connection.row_factory = sqlite3.Row
    try:
        return connection.execute(query, params).fetchall()
    finally:
        connection.close()


def _load_state_db_sessions(*, hermes_home: Optional[Path] = None) -> list[dict]:
    """Load sessions from hermes-agent's state.db and map to HermesSession dicts."""
    rows = _query_state_db(
        "SELECT id, source, model, started_at, ended_at, end_reason, message_count, title "
        "FROM sessions ORDER BY started_at DESC",
        hermes_home=hermes_home,
    )
    results: list[dict] = []
    for row in rows:
        row = dict(row)
        if row.get("ended_at") is None:
            status = "active"
        elif "error" in (row.get("end_reason") or "").lower():
            status = "error"
        else:
            status = "completed"
        created_at = datetime.fromtimestamp(row["started_at"], tz=timezone.utc).isoformat()
        updated_at = None
        if row.get("ended_at") is not None:
            updated_at = datetime.fromtimestamp(row["ended_at"], tz=timezone.utc).isoformat()
        results.append({
            "id": row["id"],
            "created_at": created_at,
            "updated_at": updated_at,
            "messages": row.get("message_count") or 0,
            "model": row.get("model") or "",
            "status": status,
            "toolsets": [f"source:{row.get('source') or 'cli'}"],
            "repo": None,
            "firstUserMessage": row.get("title") or "",
        })
    return results


def _query_state_db_row(
    query: str,
    params: tuple = (),
    *,
    hermes_home: Optional[Path] = None,
) -> Optional[sqlite3.Row]:
    rows = _query_state_db(query, params, hermes_home=hermes_home)
    return rows[0] if rows else None


def _list_skills(*, hermes_home: Optional[Path] = None) -> list[dict]:
    skills_dir = _skills_dir(hermes_home or _HERMES_HOME)
    if not skills_dir.exists():
        return []

    skills: list[dict] = []
    for skill_path in sorted(skills_dir.rglob("SKILL.md")):
        content = _read_text(skill_path)
        metadata = _parse_frontmatter(content)
        relative_path = skill_path.relative_to(skills_dir).as_posix()
        parts = skill_path.relative_to(skills_dir).parts
        skills.append(
            {
                "id": relative_path,
                "name": metadata.get("name") or skill_path.parent.name,
                "summary": metadata.get("description") or _collapse_excerpt(content, 180),
                "category": parts[0] if len(parts) > 1 else skill_path.parent.name,
                "path": str(skill_path),
                "modified_at": _iso_from_stat(skill_path),
                "line_count": len(content.splitlines()),
                "size_bytes": skill_path.stat().st_size,
                "estimated_tokens": skill_path.stat().st_size // 4,
            }
        )

    skills.sort(key=lambda item: (str(item["category"]).lower(), str(item["name"]).lower()))
    return skills


def _skill_detail(skill_id: str, *, hermes_home: Optional[Path] = None) -> Optional[dict]:
    if not skill_id:
        return None

    skills_dir = _skills_dir(hermes_home or _HERMES_HOME)
    try:
        candidate = (skills_dir / skill_id).resolve()
        candidate.relative_to(skills_dir.resolve())
    except Exception:  # noqa: BLE001 - any resolve/containment failure rejects the skill id
        return None

    if candidate.is_dir():
        candidate = candidate / "SKILL.md"

    if candidate.name != "SKILL.md" or not candidate.exists():
        return None

    content = _read_text(candidate)
    metadata = _parse_frontmatter(content)
    parts = candidate.relative_to(skills_dir).parts
    return {
        "id": candidate.relative_to(skills_dir).as_posix(),
        "name": metadata.get("name") or candidate.parent.name,
        "summary": metadata.get("description") or _collapse_excerpt(content, 180),
        "category": parts[0] if len(parts) > 1 else candidate.parent.name,
        "path": str(candidate),
        "modified_at": _iso_from_stat(candidate),
        "line_count": len(content.splitlines()),
        "size_bytes": candidate.stat().st_size,
        "content": content,
    }


def _list_skills_hub(*, hermes_home: Optional[Path] = None) -> list[dict]:
    resolved_home = hermes_home or _HERMES_HOME
    result = _run_hermes_skills_hub_helper(resolved_home)
    skills = result.get("skills", [])
    return skills if isinstance(skills, list) else []


def _install_hub_skill(skill_name: str, *, hermes_home: Optional[Path] = None) -> dict:
    normalized = str(skill_name or "").strip()
    if not normalized:
        raise ValueError("skill name is required")

    resolved_home = hermes_home or _HERMES_HOME
    command_env = os.environ.copy()
    command_env["HERMES_HOME"] = str(resolved_home)

    result = subprocess.run(
        ["hermes", "skills", "install", normalized, "--yes"],
        capture_output=True,
        text=True,
        timeout=120,
        env=command_env,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip()
        stdout = result.stdout.strip()
        raise RuntimeError(stderr or stdout or f"install failed for {normalized}")

    return {
        "success": True,
        "message": f"Installed '{normalized}'",
    }


def _workspace_overview_payload(*, hermes_home: Path, profile_name: str) -> dict:
    totals = _query_state_db_row(
        """
        select
            count(*) as session_count,
            coalesce(sum(message_count), 0) as message_count,
            coalesce(sum(input_tokens), 0) as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens,
            max(started_at) as last_started_at
        from sessions
        """,
        hermes_home=hermes_home,
    )
    top_models = _query_state_db(
        """
        select
            coalesce(nullif(model, ''), 'unknown') as model,
            count(*) as session_count,
            coalesce(sum(input_tokens), 0) as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens
        from sessions
        group by 1
        order by (coalesce(sum(input_tokens), 0) + coalesce(sum(output_tokens), 0)) desc, session_count desc
        limit 4
        """,
        hermes_home=hermes_home,
    )
    skill_summaries = _list_skills(hermes_home=hermes_home)

    with _sessions_lock:
        live_sessions = len(
            [
                session
                for session in _sessions.values()
                if _normalize_profile_name(session.get("profile")) == profile_name
            ]
        )

    return {
        "hermes_home": str(hermes_home),
        "session_source": {
            "kind": "sqlite",
            "path": str(_state_db_path(hermes_home)),
            "available": _state_db_path(hermes_home).exists(),
        },
        "cron_backend": "hermes" if _HERMES_CRON_AVAILABLE else "unavailable",
        "counts": {
            "tracked_sessions": int(totals["session_count"]) if totals else 0,
            "messages": int(totals["message_count"]) if totals else 0,
            "input_tokens": int(totals["input_tokens"]) if totals else 0,
            "output_tokens": int(totals["output_tokens"]) if totals else 0,
            "live_sessions": live_sessions,
            "cron_jobs": _cron_job_count(),
            "skills": len(skill_summaries),
        },
        "last_session_started_at": _iso_from_unix(float(totals["last_started_at"])) if totals and totals["last_started_at"] is not None else None,
        "files": _list_canonical_files(hermes_home=hermes_home),
        "top_models": [
            {
                "model": row["model"],
                "session_count": int(row["session_count"]),
                "input_tokens": int(row["input_tokens"]),
                "output_tokens": int(row["output_tokens"]),
                "total_tokens": int(row["input_tokens"]) + int(row["output_tokens"]),
            }
            for row in top_models
        ],
        "integrations": {
            "cursor_composer": _cursor_composer_integration_status(hermes_home=hermes_home),
        },
    }


def _cursor_composer_integration_status(*, hermes_home: Path) -> dict:
    try:
        from cursor_composer_bridge import bridge_status

        return bridge_status(hermes_home=hermes_home)
    except Exception as exc:  # noqa: BLE001 - optional integration status; failure is reported in the returned status payload
        return {
            "id": "cursor-composer",
            "name": "Cursor Composer",
            "connected": False,
            "skills_ready": False,
            "detail": str(exc)[:200],
        }


def _workspace_usage_payload(*, hermes_home: Path) -> dict:
    totals = _query_state_db_row(
        """
        select
            count(*) as session_count,
            coalesce(sum(message_count), 0) as message_count,
            coalesce(sum(tool_call_count), 0) as tool_call_count,
            coalesce(sum(input_tokens), 0) as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens,
            min(started_at) as first_started_at,
            max(started_at) as last_started_at
        from sessions
        """,
        hermes_home=hermes_home,
    )

    # Cost is recomputed from token counts via a curated per-provider price table
    # (see pricing.py) rather than trusting the session store's unreliable
    # estimated_cost_usd. We group by (model, billing_provider) so each alias is
    # priced at its family rate; provider-reported actual_cost_usd is preferred
    # per-row, and any stored estimate is only a clamped last resort for models we
    # can't price (rejecting corrupt rows that imply absurd per-token rates).
    cost_groups = _query_state_db(
        """
        select
            coalesce(nullif(model, ''), 'unknown') as model,
            coalesce(nullif(billing_provider, ''), '') as billing_provider,
            count(*) as session_count,
            coalesce(sum(input_tokens), 0) as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens,
            coalesce(sum(case when actual_cost_usd is null then input_tokens else 0 end), 0) as est_input_tokens,
            coalesce(sum(case when actual_cost_usd is null then output_tokens else 0 end), 0) as est_output_tokens,
            coalesce(sum(case when actual_cost_usd is null then cache_read_tokens else 0 end), 0) as est_cache_read_tokens,
            coalesce(sum(case when actual_cost_usd is null then cache_write_tokens else 0 end), 0) as est_cache_write_tokens,
            coalesce(sum(case when actual_cost_usd is null then reasoning_tokens else 0 end), 0) as est_reasoning_tokens,
            coalesce(sum(case when actual_cost_usd is not null then actual_cost_usd else 0 end), 0) as actual_cost_sum,
            coalesce(sum(case
                when actual_cost_usd is null
                 and estimated_cost_usd is not null
                 and estimated_cost_usd >= 0
                 and estimated_cost_usd <= (((coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) / 1000000.0) * ?)
                then estimated_cost_usd else 0 end), 0) as clamped_estimate_sum
        from sessions
        group by 1, 2
        """,
        (pricing.MAX_PLAUSIBLE_RATE_PER_MTOK,),
        hermes_home=hermes_home,
    )

    per_model: dict[str, dict] = {}
    total_cost = 0.0
    unpriced_models: set[str] = set()
    for group in cost_groups:
        model = group["model"]
        price = pricing.price_for(model, group["billing_provider"])
        if price is not None:
            estimate = pricing.cost_for_tokens(
                price,
                input_tokens=int(group["est_input_tokens"]),
                output_tokens=int(group["est_output_tokens"]),
                cache_read_tokens=int(group["est_cache_read_tokens"]),
                cache_write_tokens=int(group["est_cache_write_tokens"]),
                reasoning_tokens=int(group["est_reasoning_tokens"]),
            )
        else:
            estimate = float(group["clamped_estimate_sum"])
            if int(group["est_input_tokens"]) + int(group["est_output_tokens"]) > 0:
                unpriced_models.add(model)
        group_cost = float(group["actual_cost_sum"]) + estimate
        total_cost += group_cost
        entry = per_model.setdefault(
            model,
            {"model": model, "session_count": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0},
        )
        entry["session_count"] += int(group["session_count"])
        entry["input_tokens"] += int(group["input_tokens"])
        entry["output_tokens"] += int(group["output_tokens"])
        entry["cost_usd"] += group_cost

    top_models = sorted(
        per_model.values(),
        key=lambda m: (m["input_tokens"] + m["output_tokens"], m["session_count"]),
        reverse=True,
    )[:8]

    recent_rows = _query_state_db(
        """
        select
            strftime('%Y-%m-%d', started_at, 'unixepoch') as day,
            count(*) as session_count,
            coalesce(sum(input_tokens), 0) as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens
        from sessions
        where started_at >= ?
        group by 1
        order by day asc
        """,
        (time.time() - 13 * 86400,),
        hermes_home=hermes_home,
    )
    recent_map = {
        str(row["day"]): {
            "day": str(row["day"]),
            "session_count": int(row["session_count"]),
            "input_tokens": int(row["input_tokens"]),
            "output_tokens": int(row["output_tokens"]),
            "total_tokens": int(row["input_tokens"]) + int(row["output_tokens"]),
        }
        for row in recent_rows
        if row["day"]
    }

    today = datetime.now(timezone.utc).date()
    recent_days: list[dict] = []
    for offset in range(13, -1, -1):
        day = (today - timedelta(days=offset)).isoformat()
        recent_days.append(
            recent_map.get(
                day,
                {
                    "day": day,
                    "session_count": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "total_tokens": 0,
                },
            )
        )

    return {
        "state_db_available": _state_db_path(hermes_home).exists(),
        "session_count": int(totals["session_count"]) if totals else 0,
        "message_count": int(totals["message_count"]) if totals else 0,
        "tool_call_count": int(totals["tool_call_count"]) if totals else 0,
        "input_tokens": int(totals["input_tokens"]) if totals else 0,
        "output_tokens": int(totals["output_tokens"]) if totals else 0,
        "total_tokens": (int(totals["input_tokens"]) + int(totals["output_tokens"])) if totals else 0,
        "cost_usd": round(total_cost, 6),
        "pricing_version": pricing.PRICING_VERSION,
        "first_session_started_at": _iso_from_unix(float(totals["first_started_at"])) if totals and totals["first_started_at"] is not None else None,
        "last_session_started_at": _iso_from_unix(float(totals["last_started_at"])) if totals and totals["last_started_at"] is not None else None,
        "top_models": [
            {
                "model": entry["model"],
                "session_count": int(entry["session_count"]),
                "input_tokens": int(entry["input_tokens"]),
                "output_tokens": int(entry["output_tokens"]),
                "total_tokens": int(entry["input_tokens"]) + int(entry["output_tokens"]),
                "cost_usd": round(float(entry["cost_usd"]), 6),
            }
            for entry in top_models
        ],
        "recent_days": recent_days,
    }


class HermesWorkspaceFileUpdate(BaseModel):
    content: str = Field(default="")
    expected_version: Optional[str] = None


class HermesHubSkillInstallRequest(BaseModel):
    name: str = Field(default="")


# ─── Hermes ops (fallback, checkpoints, memory, curator, …) ─────────────────

def _ops_home(request: Request) -> Path:
    return Path(_resolve_hermes_home(_resolve_profile_name(request)))


async def _ops_thread(fn, /, *args, **kwargs):
    """Run sync hermes_ops / CLI work off the event loop so chat stays responsive."""
    return await asyncio.to_thread(fn, *args, **kwargs)


# ------------------------------------------------------------------
# Workspace endpoints for Hermes overview/files/skills/usage
# ------------------------------------------------------------------

# Cache of the hermes-agent slash command catalog (built once per process).
_HERMES_COMMANDS_CACHE: Optional[list] = None


def _load_hermes_agent_commands() -> list:
    """Build the catalog of hermes-agent slash commands a chat client can use:
    built-ins from ``hermes_cli.commands`` (excluding CLI-only ones), installed
    skill commands, and plugin commands. Cached after first load and degrades to
    whatever subset imports successfully, so CloudChat still works if the agent
    is missing or a different version.
    """
    global _HERMES_COMMANDS_CACHE
    if _HERMES_COMMANDS_CACHE is not None:
        return _HERMES_COMMANDS_CACHE

    commands: list = []

    # Built-in registry — surface only what a chat client can use (gateway
    # available or "both"); skip CLI/TUI-only commands unless config-gated.
    try:
        from hermes_cli import commands as _hc
        for c in _hc.COMMAND_REGISTRY:
            if getattr(c, "cli_only", False) and not getattr(c, "gateway_config_gate", None):
                continue
            args_hint = getattr(c, "args_hint", "") or ""
            commands.append({
                "name": c.name,
                "description": c.description,
                "category": getattr(c, "category", "") or "General",
                "usage": "/" + c.name + ((" " + args_hint) if args_hint else ""),
                "aliases": list(getattr(c, "aliases", ()) or ()),
                "kind": "agent",
            })
    except Exception as e:  # noqa: BLE001 - optional command registry; bridge continues without it
        print(f"[hermes-bridge] command registry unavailable: {e}", flush=True)

    # Installed skill commands (one per skill in ~/.hermes/skills/).
    try:
        from agent.skill_commands import get_skill_commands
        for key, info in get_skill_commands().items():
            name = key.lstrip("/")
            commands.append({
                "name": name,
                "description": info.get("description") or f"Run the {name} skill",
                "category": "Skills",
                "usage": "/" + name + " [instructions]",
                "aliases": [],
                "kind": "skill",
            })
    except Exception as e:  # noqa: BLE001 - optional skill commands; bridge continues without them
        print(f"[hermes-bridge] skill commands unavailable: {e}", flush=True)

    # Plugin-registered commands.
    try:
        from hermes_cli.commands import _iter_plugin_command_entries
        for name, desc, args_hint in _iter_plugin_command_entries():
            clean = name.lstrip("/")
            commands.append({
                "name": clean,
                "description": desc,
                "category": "Plugins",
                "usage": "/" + clean + ((" " + args_hint) if args_hint else ""),
                "aliases": [],
                "kind": "agent",
            })
    except Exception as e:  # noqa: BLE001 - optional plugin commands; bridge continues without them
        print(f"[hermes-bridge] plugin commands unavailable: {e}", flush=True)

    _HERMES_COMMANDS_CACHE = commands
    return commands


def _maybe_expand_skill_command(messages: list) -> None:
    """If the latest user message is a hermes-agent skill command (``/skill ...``),
    expand it in place into the skill's invocation prompt so CloudChat's agent
    loop runs the skill. No-op for non-skill messages or when the agent's skill
    system is unavailable."""
    idx = None
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            idx = i
            break
    if idx is None:
        return
    content = (messages[idx].get("content") or "").strip()
    if not content.startswith("/"):
        return
    parts = content.split(None, 1)
    cmd_token = parts[0]
    user_instruction = parts[1] if len(parts) > 1 else ""
    try:
        from agent.skill_commands import (
            resolve_skill_command_key,
            build_skill_invocation_message,
        )
        # resolve_skill_command_key expects the bare name (no leading slash);
        # it returns the canonical key WITH a slash for build_skill_invocation_message.
        cmd_key = resolve_skill_command_key(cmd_token.lstrip("/"))
        if not cmd_key:
            return
        expanded = build_skill_invocation_message(cmd_key, user_instruction)
        if expanded:
            messages[idx]["content"] = expanded
            print(f"[hermes-bridge] Expanded skill command {cmd_token} -> {cmd_key}", flush=True)
    except Exception as e:  # noqa: BLE001 - skill expansion is best-effort; message is sent unexpanded
        print(f"[hermes-bridge] skill command expansion failed: {e}", flush=True)
