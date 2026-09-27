import os
os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
import os
import re
import json
import asyncio
import time
import threading
import subprocess
import uuid
import sys
import hashlib
import hmac
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
import httpx
import pricing
import mcp_telemetry
import delegation_live
from bridge_events import (
    agent_notice_clear_event,
    hermes_run_server_tool_event,
    swarm_result_server_tool_event,
    agent_status_event,
    build_plan_update_event,
    fallback_switch_event,
    filter_toolsets_for_plan_mode,
    output_truncation_info,
    stream_retry_event,
    todo_plan_steps,
    tool_activity_event,
    tool_call_begin_event,
    tool_call_end_event,
    transport_status_event,
    usage_event,
)
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

app: FastAPI = None  # created after brain-lifespan is defined

# SSE comment keepalive for ACP streams. The Express SSE proxy
# (server/direct-sse-proxy.ts) aborts after STREAM_ACTIVITY_TIMEOUT_MS
# (default 30s) of zero bytes. File writes and approval waits are silent
# on the wire, so this MUST stay well under 30s. The agent-loop path
# already heartbeats ~every 3s (60 idle ticks × 50ms).
def _acp_sse_heartbeat_seconds() -> float:
    raw = os.environ.get("HERMES_ACP_SSE_HEARTBEAT_SECONDS", "10").strip()
    try:
        value = float(raw)
    except ValueError:
        return 10.0
    if value <= 0:
        return 10.0
    return value


ACP_SSE_HEARTBEAT_SECONDS = _acp_sse_heartbeat_seconds()

# --- Session tracking for Hermes Chats view ---
_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()
_MAX_SESSION_CHAT_MESSAGES = 200
_MAX_SESSION_MESSAGE_CHARS = 12000


def _iso_to_unix(iso_str: str) -> float:
    """Convert ISO timestamp string to unix seconds."""
    try:
        return datetime.fromisoformat(iso_str).timestamp()
    except Exception:
        return datetime.now(timezone.utc).timestamp()


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
    except Exception:
        pass  # Best-effort; don't break request handling


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _trim_session_message_content(content: str) -> str:
    if len(content) <= _MAX_SESSION_MESSAGE_CHARS:
        return content
    head = _MAX_SESSION_MESSAGE_CHARS // 2
    tail = _MAX_SESSION_MESSAGE_CHARS - head
    return (
        content[:head]
        + "\n\n...[session message truncated]...\n\n"
        + content[-tail:]
    )


def _message_field(message, field: str):
    if isinstance(message, dict):
        return message.get(field)
    return getattr(message, field, None)


def _normalize_message_role(message) -> str:
    role = str(_message_field(message, "role") or "").strip().lower()
    if role in {"system", "user", "assistant", "tool"}:
        return role
    return "assistant"


def _normalize_message_content(message, strip_images: bool = False) -> str:
    content = _message_field(message, "content")
    if content is None:
        return ""
    if isinstance(content, list):
        text_parts = []
        for part in content:
            if isinstance(part, dict):
                part_type = part.get("type", "")
                if part_type == "text":
                    text_parts.append(str(part.get("text", "")))
                elif strip_images and part_type in ("image", "image_url"):
                    pass
        return " ".join(text_parts)
    if strip_images and isinstance(content, str):
        import re

        content = re.sub(r"!\[.*?\]\(.*?\)", "", content)
        content = re.sub(r"data:image/[^;]+;base64,", "[image]", content)
    return str(content)


def _normalize_chat_messages(messages, model: str = None, strip_images: bool = False) -> list[dict]:
    if strip_images and model and not _model_supports_vision(model):
        strip_images = True
    else:
        strip_images = False
    normalized: list[dict] = []
    for message in messages or []:
        normalized.append(
            {
                "role": _normalize_message_role(message),
                "content": _normalize_message_content(message, strip_images=strip_images),
            }
        )
    return normalized


def _append_session_chat_chunk(session_id: str, role: str, text: str):
    if not text:
        return

    with _sessions_lock:
        session = _sessions.get(session_id)
        if not session:
            return

        chat = session.setdefault("chat", [])
        if (
            role == "assistant"
            and chat
            and chat[-1].get("role") == "assistant"
        ):
            merged = f"{chat[-1].get('content', '')}{text}"
            chat[-1]["content"] = _trim_session_message_content(merged)
        else:
            chat.append(
                {
                    "role": role,
                    "content": _trim_session_message_content(text),
                }
            )

        if len(chat) > _MAX_SESSION_CHAT_MESSAGES:
            session["chat"] = chat[-_MAX_SESSION_CHAT_MESSAGES:]

        session["messages"] = len(session.get("chat", []))
        session["updated_at"] = _now_iso()


def _session_summary(session: dict) -> dict:
    summary = dict(session)
    summary.pop("chat", None)
    summary.pop("profile", None)
    return summary


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
    except Exception:
        return "default"


def _resolve_profile_name(request: Optional[Request] = None) -> str:
    if request is not None:
        try:
            header_value = request.headers.get("x-hermes-profile")
        except Exception:
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
    except Exception:
        return None


def _iso_from_stat(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    except Exception:
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
    except Exception:
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


def _cron_job_count() -> int:
    if _HERMES_CRON_AVAILABLE:
        try:
            return len(_hermes_list_jobs(include_disabled=True) or [])
        except Exception:
            pass

    return len(_cron_jobs)


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
        "cron_backend": "hermes" if _HERMES_CRON_AVAILABLE else "bridge-local",
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
    except Exception as exc:
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


# --- Hermes cron backend integration ---
_HERMES_AGENT_DIR = os.environ.get(
    "HERMES_AGENT_DIR",
    os.path.expanduser("~/.hermes/hermes-agent"),
)
_HERMES_CRON_HELPER_PYTHON = os.environ.get(
    "HERMES_CRON_PYTHON",
    os.path.join(os.path.dirname(__file__), ".venv", "bin", "python"),
)
_HERMES_CRON_RESULT_PREFIX = "__HERMES_CRON_RESULT__="
_HERMES_CRON_OUTPUT_DIR = (
    Path(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")))
    / "cron"
    / "output"
)
_HERMES_SKILLS_HUB_RESULT_PREFIX = "__HERMES_SKILLS_HUB_RESULT__="

if _HERMES_AGENT_DIR not in sys.path:
    sys.path.insert(0, _HERMES_AGENT_DIR)

_HERMES_CRON_AVAILABLE = False
_HERMES_CRON_IMPORT_ERROR: Optional[str] = None

_HERMES_CRON_HELPER_CODE = f"""
import json
import sys

agent_dir = sys.argv[1]
action = sys.argv[2]
payload = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {{}}
if agent_dir not in sys.path:
    sys.path.insert(0, agent_dir)

from cron.jobs import create_job, get_job, list_jobs, pause_job, remove_job, resume_job, trigger_job
from cron.scheduler import tick

if action == "list_jobs":
    result = list_jobs(**payload)
elif action == "create_job":
    result = create_job(**payload)
elif action == "get_job":
    result = get_job(**payload)
elif action == "pause_job":
    result = pause_job(**payload)
elif action == "remove_job":
    result = remove_job(**payload)
elif action == "resume_job":
    result = resume_job(**payload)
elif action == "trigger_job":
    result = trigger_job(**payload)
elif action == "tick":
    tick(**payload)
    result = True
else:
    raise ValueError(f"unsupported Hermes cron action: {{action}}")

print("{_HERMES_CRON_RESULT_PREFIX}" + json.dumps({{"result": result}}, default=str))
"""

_HERMES_SKILLS_HUB_HELPER_CODE = f"""
import json
import os
import sys
from pathlib import Path

agent_dir = sys.argv[1]
payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {{}}
hermes_home = payload.get("hermes_home") or os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
if agent_dir not in sys.path:
    sys.path.insert(0, agent_dir)
os.environ["HERMES_HOME"] = hermes_home

from tools.skills_hub import GitHubAuth, create_source_router, parallel_search_sources

_TRUST_RANK = {{"builtin": 3, "trusted": 2, "community": 1}}
_PER_SOURCE_LIMIT = {{
    "official": 200,
    "skills-sh": 200,
    "well-known": 50,
    "github": 200,
    "clawhub": 500,
    "claude-marketplace": 100,
    "lobehub": 500,
}}

def _parse_frontmatter_name(skill_md: Path) -> str:
    try:
        content = skill_md.read_text(encoding="utf-8")
    except Exception:
        return skill_md.parent.name

    if not content.startswith("---"):
        return skill_md.parent.name

    end_marker = content.find("\\n---\\n", 4)
    if end_marker == -1:
        return skill_md.parent.name

    try:
        import yaml
        parsed = yaml.safe_load(content[4:end_marker])
    except Exception:
        return skill_md.parent.name

    if isinstance(parsed, dict):
        name = parsed.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()

    return skill_md.parent.name

def _installed_skill_names(home: str) -> set[str]:
    names: set[str] = set()
    skills_dir = Path(home) / "skills"
    if not skills_dir.exists():
        return names

    for skill_md in skills_dir.rglob("SKILL.md"):
        if ".hub" in skill_md.parts or "__pycache__" in skill_md.parts:
            continue
        names.add(skill_md.parent.name.strip().lower())
        parsed_name = _parse_frontmatter_name(skill_md)
        if parsed_name:
            names.add(parsed_name.lower())

    return names

def _skill_category(meta) -> str:
    extra = getattr(meta, "extra", {{}}) or {{}}
    category = extra.get("category")
    if isinstance(category, str) and category.strip():
        return category.strip()

    path = getattr(meta, "path", None)
    if isinstance(path, str) and path.strip():
        parts = [part for part in path.replace("\\\\", "/").split("/") if part]
        if len(parts) >= 2:
            return parts[-2]
        if len(parts) == 1:
            return parts[0]

    identifier = str(getattr(meta, "identifier", "") or "")
    parts = [part for part in identifier.split("/") if part]
    if len(parts) >= 2:
        return parts[-2]

    return "general"

def _skill_source(meta) -> str:
    source = str(getattr(meta, "source", "") or "").strip().lower()
    if source == "official":
        return "optional"
    if source == "claude-marketplace":
        return "anthropic"
    if source == "lobehub":
        return "lobehub"
    if source == "builtin":
        return "built-in"
    return "community"

auth = GitHubAuth()
sources = create_source_router(auth)
all_results, _, _ = parallel_search_sources(
    sources,
    query="",
    per_source_limits=_PER_SOURCE_LIMIT,
    source_filter="all",
    overall_timeout=15,
)

seen = {{}}
for result in all_results:
    name = str(getattr(result, "name", "") or "").strip()
    if not name:
        continue
    rank = _TRUST_RANK.get(str(getattr(result, "trust_level", "") or "").strip().lower(), 0)
    current = seen.get(name.lower())
    current_rank = -1
    if current is not None:
        current_rank = _TRUST_RANK.get(
            str(getattr(current, "trust_level", "") or "").strip().lower(),
            0,
        )
    if current is None or rank > current_rank:
        seen[name.lower()] = result

installed_names = _installed_skill_names(hermes_home)
skills = []
for result in sorted(
    seen.values(),
    key=lambda item: (
        -_TRUST_RANK.get(str(getattr(item, "trust_level", "") or "").strip().lower(), 0),
        str(getattr(item, "source", "") or "").strip().lower() != "official",
        str(getattr(item, "name", "") or "").strip().lower(),
    ),
):
    name = str(getattr(result, "name", "") or "").strip()
    if not name:
        continue
    skills.append(
        {{
            "name": name,
            "description": str(getattr(result, "description", "") or "").strip(),
            "category": _skill_category(result),
            "source": _skill_source(result),
            "installed": name.lower() in installed_names,
        }}
    )

print("{_HERMES_SKILLS_HUB_RESULT_PREFIX}" + json.dumps({{"skills": skills}}, ensure_ascii=False))
"""


def _run_hermes_cron_helper(action: str, payload: Optional[dict] = None):
    try:
        completed = subprocess.run(
            [
                _HERMES_CRON_HELPER_PYTHON,
                "-c",
                _HERMES_CRON_HELPER_CODE,
                _HERMES_AGENT_DIR,
                action,
                json.dumps(payload or {}),
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Hermes cron helper timed out after 30s for {action}"
        )
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        raise RuntimeError(
            stderr or stdout or f"Hermes cron helper failed for {action}"
        )

    for line in reversed((completed.stdout or "").splitlines()):
        if line.startswith(_HERMES_CRON_RESULT_PREFIX):
            payload_text = line[len(_HERMES_CRON_RESULT_PREFIX):]
            return json.loads(payload_text).get("result")

    raise RuntimeError(f"Hermes cron helper returned no result for {action}")


def _run_hermes_skills_hub_helper(hermes_home: Path) -> dict:
    completed = subprocess.run(
        [
            _HERMES_CRON_HELPER_PYTHON,
            "-c",
            _HERMES_SKILLS_HUB_HELPER_CODE,
            _HERMES_AGENT_DIR,
            json.dumps({"hermes_home": str(hermes_home)}),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        raise RuntimeError(
            stderr or stdout or "Hermes skills hub helper failed"
        )

    for line in reversed((completed.stdout or "").splitlines()):
        if line.startswith(_HERMES_SKILLS_HUB_RESULT_PREFIX):
            payload_text = line[len(_HERMES_SKILLS_HUB_RESULT_PREFIX):]
            result = json.loads(payload_text)
            return result if isinstance(result, dict) else {}

    raise RuntimeError("Hermes skills hub helper returned no result")

try:
    from cron.jobs import (
        create_job as _hermes_create_job,
        get_job as _hermes_get_job,
        list_jobs as _hermes_list_jobs,
        pause_job as _hermes_pause_job,
        remove_job as _hermes_remove_job,
        resume_job as _hermes_resume_job,
        trigger_job as _hermes_trigger_job,
        OUTPUT_DIR as _HERMES_CRON_OUTPUT_DIR,
    )
    from cron.scheduler import tick as _hermes_cron_tick
    _HERMES_CRON_AVAILABLE = True
except Exception as e:
    _HERMES_CRON_IMPORT_ERROR = str(e)
    helper_error = None
    if os.path.exists(_HERMES_CRON_HELPER_PYTHON):
        try:
            _run_hermes_cron_helper("list_jobs", {"include_disabled": True})
            _hermes_create_job = lambda **kwargs: _run_hermes_cron_helper("create_job", kwargs)
            _hermes_get_job = lambda job_id: _run_hermes_cron_helper("get_job", {"job_id": job_id})
            _hermes_list_jobs = lambda include_disabled=False: _run_hermes_cron_helper(
                "list_jobs",
                {"include_disabled": include_disabled},
            )
            _hermes_pause_job = lambda job_id: _run_hermes_cron_helper("pause_job", {"job_id": job_id})
            _hermes_remove_job = lambda job_id: _run_hermes_cron_helper("remove_job", {"job_id": job_id})
            _hermes_resume_job = lambda job_id: _run_hermes_cron_helper("resume_job", {"job_id": job_id})
            _hermes_trigger_job = lambda job_id: _run_hermes_cron_helper("trigger_job", {"job_id": job_id})
            _hermes_cron_tick = lambda verbose=False: _run_hermes_cron_helper("tick", {"verbose": verbose})
            _HERMES_CRON_AVAILABLE = True
            print(
                f"[cron] Hermes cron backend enabled via helper interpreter {_HERMES_CRON_HELPER_PYTHON}",
                flush=True,
            )
        except Exception as helper_exc:
            helper_error = str(helper_exc)

    if not _HERMES_CRON_AVAILABLE:
        detail = (
            f"{e}; helper {_HERMES_CRON_HELPER_PYTHON} failed: {helper_error}"
            if helper_error
            else str(e)
        )
        print(
            f"[cron] Hermes cron backend unavailable, falling back to bridge-local store: {detail}",
            flush=True,
        )


def _cron_query_value(request: Request, key: str) -> Optional[str]:
    query_params = getattr(request, "query_params", None)
    if query_params is None:
        return None
    value = query_params.get(key)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _cloudchat_origin_from_body(body: dict) -> Optional[dict]:
    conversation_id = str(body.get("conversation_id") or "").strip()
    if not conversation_id:
        return None

    title = str(body.get("conversation_title") or "").strip() or None
    origin = {
        "platform": "cloud-chat-hub",
        "chat_id": conversation_id,
    }
    if title:
        origin["chat_name"] = title
    return origin


def _hermes_schedule_input(job: dict) -> str:
    schedule = job.get("schedule")
    if not isinstance(schedule, dict):
        return str(job.get("schedule_display") or "")

    kind = schedule.get("kind")
    if kind == "cron":
        return str(schedule.get("expr") or job.get("schedule_display") or "")
    if kind == "interval":
        minutes = schedule.get("minutes")
        return f"every {minutes}m" if minutes else str(job.get("schedule_display") or "")
    if kind == "once":
        return str(schedule.get("run_at") or job.get("schedule_display") or "")

    return str(job.get("schedule_display") or "")


def _map_hermes_job(job: dict) -> dict:
    origin = job.get("origin") if isinstance(job.get("origin"), dict) else {}
    origin_platform = str(origin.get("platform") or "").strip() or None
    conversation_id = None
    conversation_title = None
    if origin_platform == "cloud-chat-hub":
        conversation_id = str(origin.get("chat_id") or "").strip() or None
        conversation_title = str(origin.get("chat_name") or "").strip() or None

    state = str(job.get("state") or "").strip() or (
        "scheduled" if job.get("enabled", True) else "paused"
    )
    if state == "paused":
        status = "paused"
    elif state == "completed":
        status = "completed"
    elif job.get("enabled", True):
        status = "active"
    else:
        status = "paused"

    schedule = _hermes_schedule_input(job)

    return {
        "id": job["id"],
        "name": job.get("name") or job["id"],
        "schedule": schedule,
        "schedule_display": job.get("schedule_display") or schedule,
        "prompt": job.get("prompt") or "",
        "status": status,
        "state": state,
        "created_at": job.get("created_at"),
        "last_run": job.get("last_run_at"),
        "next_run": job.get("next_run_at"),
        "last_status": job.get("last_status"),
        "last_error": job.get("last_error"),
        "conversation_id": conversation_id,
        "conversation_title": conversation_title,
        "origin_platform": origin_platform,
    }


def _local_tz():
    return datetime.now().astimezone().tzinfo or timezone.utc


def _history_timestamp_from_output(path: Path) -> str:
    try:
        dt = datetime.strptime(path.stem, "%Y-%m-%d_%H-%M-%S").replace(tzinfo=_local_tz())
        return dt.isoformat()
    except ValueError:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _history_sort_key(path: Path) -> float:
    try:
        return datetime.strptime(path.stem, "%Y-%m-%d_%H-%M-%S").replace(
            tzinfo=_local_tz()
        ).timestamp()
    except ValueError:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0


def _iso_timestamp(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except Exception:
        return None


def _run_matches_last(run_started_at: Optional[str], last_run_at: Optional[str]) -> bool:
    run_ts = _iso_timestamp(run_started_at)
    last_ts = _iso_timestamp(last_run_at)
    if run_ts is None or last_ts is None:
        return False
    return abs(run_ts - last_ts) < 120


def _extract_history_error(output: str) -> Optional[str]:
    if "## Error" not in output:
        return None
    error_block = output.split("## Error", 1)[1].strip()
    if error_block.startswith("```"):
        error_block = error_block.strip("`\n")
    error_block = error_block.strip()
    return error_block[:500] or None


def _excerpt_history_output(output: str, limit: int = 500) -> Optional[str]:
    # If the output has a "## Response" section, extract from there to skip
    # system hints and metadata (e.g. from cron job output files).
    if "## Response" in output:
        response_section = output.split("## Response", 1)[1]
    else:
        response_section = output
    lines = [line.rstrip() for line in response_section.splitlines()]
    cleaned = "\n".join(line for line in lines if line).strip()
    if not cleaned:
        return None
    return cleaned[:limit]


MAX_RUN_HISTORY = 20

# Client-controlled cron job ids must be validated before they are used to
# build filesystem paths (output_dir = OUTPUT_DIR / job_id) — otherwise a
# crafted id could traverse directories. Mirror of acp_transport._SAFE_ID_RE.
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _build_hermes_run_history(job_id: str) -> list[dict]:
    if not _HERMES_CRON_AVAILABLE or not _JOB_ID_RE.match(job_id or ""):
        return []

    runs: list[dict] = []
    output_dir = Path(_HERMES_CRON_OUTPUT_DIR) / job_id
    output_files = []
    if output_dir.exists():
        output_files = sorted(
            output_dir.glob("*.md"),
            key=_history_sort_key,
            reverse=True,
        )[:MAX_RUN_HISTORY]

    for path in output_files:
        try:
            output = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        started_at = _history_timestamp_from_output(path)
        completed_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
        error = _extract_history_error(output)
        status = "error" if error or "(FAILED)" in output else "success"
        runs.append({
            "run_id": path.stem,
            "job_id": job_id,
            "started_at": started_at,
            "completed_at": completed_at,
            "status": status,
            "output": _excerpt_history_output(output),
            "error": error,
            "tool_log": [],
            "duration_ms": None,
        })

    job = _hermes_get_job(job_id)
    if job and job.get("last_run_at") and not any(
        _run_matches_last(run.get("started_at"), job.get("last_run_at"))
        for run in runs
    ):
        status = "error" if job.get("last_status") == "error" else "success"
        runs.insert(0, {
            "run_id": f"{job_id}:{job.get('last_run_at')}",
            "job_id": job_id,
            "started_at": job.get("last_run_at"),
            "completed_at": job.get("last_run_at"),
            "status": status,
            "output": None,
            "error": job.get("last_error"),
            "tool_log": [],
            "duration_ms": None,
        })

    return runs[:MAX_RUN_HISTORY]


def _run_hermes_tick_now():
    if not _HERMES_CRON_AVAILABLE:
        return
    try:
        _hermes_cron_tick(verbose=False)
    except Exception as e:
        print(f"[cron] Hermes tick failed: {e}", flush=True)

# --- Brain MCP integration ---
# The brain subprocess handle and the JSON-RPC layer live in brain_client.py, not
# here. swarm_pattern.py needs the same RPC layer and used to reach it through
# `import main` — but the bridge runs as `python main.py` (scripts/start-bridge.sh),
# so that import loaded a SECOND copy of this file whose _brain_proc was always
# None. Every brain RPC made from a swarm therefore returned None, silently, while
# the real bridge instance kept a healthy handle in its own copy. Both modules now
# depend on brain_client; brain_client depends on neither, so there is no cycle.
#
# These names are re-exported into main's namespace because callers (and tests)
# patch them here — patch.object(main, "_brain_set", ...) must keep working.
import brain_client
from brain_client import (
    _brain_call_async,
    _brain_claim,
    _brain_contract_check,
    _brain_contract_get,
    _brain_contract_set,
    _brain_dm,
    _brain_get,
    _brain_post,
    _brain_pulse,
    _brain_release,
    _brain_rpc,
    _brain_set,
    _claimed_resources,
    _claimed_resources_lock,
)


def _bridge_metrics_snapshot() -> dict:
    """Sample the bridge counters for brain_client's heartbeat.

    Reads main's globals at call time so rebinding them is picked up live.
    """
    return {
        "start_time": _bridge_start_time,
        "active_requests": _bridge_active_requests,
        "total_requests": _bridge_total_requests,
        "error_count": _bridge_error_count,
    }


brain_client.set_metrics_provider(_bridge_metrics_snapshot)


async def _bridge_lifespan(app):
    """FastAPI lifespan — bring up brain, cron and telemetry, then tear them down.

    Ordering is load-bearing. Brain is an optional integration whose startup can
    legitimately fail (no `node`, no brain-mcp checkout), so it goes first and is
    fully isolated. Cron and MCP telemetry are NOT optional and must come up
    whether or not brain connected.
    """
    global _bridge_start_time, _bridge_total_requests, _bridge_error_count
    global _bridge_iterations_total, _bridge_request_count, _cron_scheduler_task

    # These are bridge counters, not brain state. Previously they were only
    # initialized inside the brain startup block, so when brain was unavailable
    # _bridge_start_time stayed 0.0 and both /diag and the published
    # bridge:metrics reported a zero start_time. Initialize them unconditionally.
    _bridge_start_time = time.time()
    _bridge_total_requests = 0
    _bridge_error_count = 0
    _bridge_iterations_total = 0
    _bridge_request_count = 0

    try:
        await brain_client.start_brain(
            brain_client.BrainConfig(
                port=HERMES_PORT,
                model=DEFAULT_MODEL,
                toolsets=DEFAULT_TOOLSETS,
                max_iterations=MAX_AGENT_ITERATIONS,
            )
        )
    except Exception as e:
        # start_brain already swallows its own failures; this is belt-and-braces so
        # a malformed config can never stop the bridge from serving.
        print(f"[hermes-bridge] brain startup failed: {e}", flush=True)

    # These used to be @app.on_event("startup") handlers. FastAPI ignores on_event
    # entirely when `lifespan=` is supplied, which this app does — so neither ever
    # ran and the cron scheduler never ticked.
    try:
        _init_mcp_telemetry()
    except Exception as e:
        print(f"[mcp-telemetry] startup init failed: {e}", flush=True)
    _cron_scheduler_task = _start_cron_scheduler()

    yield

    # Tear down in reverse order. Cancellation is awaited so shutdown does not
    # leave orphaned tasks behind the ACP children.
    #
    # asyncio.CancelledError inherits BaseException, not Exception, so an
    # `except Exception` here does NOT catch the cancellation we just requested
    # and the error escapes the lifespan, breaking shutdown.
    if _cron_scheduler_task:
        _cron_scheduler_task.cancel()
        try:
            await _cron_scheduler_task
        except asyncio.CancelledError:
            pass  # expected — we just cancelled it
        except Exception as e:
            print(f"[cron] scheduler shutdown error: {e}", flush=True)
    _cron_scheduler_task = None

    await brain_client.stop_brain()

    # Shut down ACP sessions so spawned hermes-acp children don't outlive
    # the bridge on restart. Safe no-op when the SDK/transport is absent.
    try:
        import acp_transport

        await acp_transport.shutdown_all()
    except Exception:
        pass


HERMES_PORT = int(os.environ.get("HERMES_PORT", "3002"))
# Default to loopback so LAN clients cannot reach mutating ops. Override with
# HERMES_BRIDGE_HOST=0.0.0.0 only when intentionally exposing the bridge.
HERMES_BRIDGE_HOST = os.environ.get("HERMES_BRIDGE_HOST", "127.0.0.1").strip() or "127.0.0.1"
OPENROUTER_KEY = os.environ.get("HERMES_OPENROUTER_KEY", "")
MINIMAX_KEY = os.environ.get("HERMES_MINIMAX_KEY", "")
HERMES_BRIDGE_TOKEN = os.environ.get("HERMES_BRIDGE_TOKEN", "")
HERMES_BRIDGE_VERSION = os.environ.get("HERMES_BRIDGE_VERSION", "dev")
DEFAULT_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "web,browser,terminal")
_BRIDGE_AUTH_EXEMPT_PATHS = frozenset({"/health", "/diag"})


def _is_loopback_host(host: Optional[str]) -> bool:
    if not host:
        return False
    h = host.split("%", 1)[0].strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    return h in ("127.0.0.1", "::1", "localhost")


def _bridge_token_matches(provided: str) -> bool:
    if not provided or not HERMES_BRIDGE_TOKEN:
        return False
    try:
        return hmac.compare_digest(provided.encode("utf-8"), HERMES_BRIDGE_TOKEN.encode("utf-8"))
    except (TypeError, ValueError):
        return False


def _extract_bridge_token(request: Request) -> str:
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("x-hermes-bridge-token") or "").strip()

def _load_cli_model_config(hermes_home: Optional[Path] = None) -> dict:
    """Read the `model:` block from <hermes_home>/config.yaml (Hermes CLI config).

    Defaults to ~/.hermes; pass a profile home to read that profile's config.
    Returns a dict with keys: default, provider, base_url, api_key (each may be None).
    """
    result = {"default": None, "provider": None, "base_url": None, "api_key": None}
    try:
        config_path = (hermes_home or Path.home() / ".hermes") / "config.yaml"
        if not config_path.is_file():
            return result
        try:
            import yaml
            with open(config_path) as f:
                cfg = yaml.safe_load(f)
            model_cfg = (cfg or {}).get("model", {}) if isinstance(cfg, dict) else {}
            if isinstance(model_cfg, dict):
                for k in ("default", "provider", "base_url", "api_key"):
                    v = model_cfg.get(k)
                    if isinstance(v, str) and v.strip():
                        result[k] = v.strip()
        except ImportError:
            # Fallback: simple parse for keys under "model:" section
            text = config_path.read_text()
            in_model = False
            for line in text.splitlines():
                stripped = line.strip()
                if stripped == "model:":
                    in_model = True
                    continue
                if in_model:
                    if not line.startswith(" ") and not line.startswith("\t"):
                        break
                    for k in ("default", "provider", "base_url", "api_key"):
                        prefix = f"{k}:"
                        if stripped.startswith(prefix):
                            v = stripped.split(prefix, 1)[1].strip().strip('"').strip("'")
                            if v:
                                result[k] = v
    except Exception:
        pass
    return result


def _load_cli_default_model() -> str | None:
    """Backward-compat shim — returns just the default model string."""
    return _load_cli_model_config().get("default")


def _cli_config_is_custom(cfg: dict) -> bool:
    """True when config.yaml model.base_url is a non-hardcoded custom endpoint."""
    base_url = (cfg.get("base_url") or "").strip()
    if not base_url:
        return False
    return not any(h in base_url for h in _KNOWN_HOSTS)


def _synthetic_cli_provider_id(cfg: dict) -> str:
    """Stable id for a config.yaml custom endpoint (e.g. custom:api.bullinf.fun)."""
    from urllib.parse import urlparse

    base_url = (cfg.get("base_url") or "").strip()
    provider = (cfg.get("provider") or "").strip().lower()
    if provider and provider not in _PROVIDER_CONFIG and provider not in ("", "custom", "auto", "default"):
        return provider if provider.startswith("custom:") else f"custom:{provider}"
    host = ""
    try:
        host = (urlparse(base_url).hostname or "").strip().lower()
    except Exception:
        host = ""
    if host:
        return f"custom:{host}"
    return "custom"


def _load_custom_providers_list(hermes_home: Optional[Path] = None) -> list[dict]:
    """Read config.yaml `custom_providers:` entries (name/base_url/model/models/api_key)."""
    try:
        config_path = (hermes_home or Path.home() / ".hermes") / "config.yaml"
        if not config_path.is_file():
            return []
        try:
            import yaml
            with open(config_path) as f:
                cfg = yaml.safe_load(f) or {}
        except ImportError:
            return []
        raw = cfg.get("custom_providers") if isinstance(cfg, dict) else None
        if not isinstance(raw, list):
            return []
        return [entry for entry in raw if isinstance(entry, dict)]
    except Exception:
        return []


def _models_for_custom_base_url(base_url: str, hermes_home: Optional[Path] = None) -> list[str]:
    """Collect model ids declared for a custom base_url in custom_providers."""
    base_norm = (base_url or "").strip().rstrip("/").lower()
    if not base_norm:
        return []
    models: list[str] = []
    seen: set[str] = set()
    for entry in _load_custom_providers_list(hermes_home):
        entry_base = (entry.get("base_url") or "").strip().rstrip("/").lower()
        if entry_base != base_norm:
            continue
        for mid in entry.get("models") or []:
            if isinstance(mid, str) and mid.strip() and mid.strip() not in seen:
                seen.add(mid.strip())
                models.append(mid.strip())
        default = entry.get("model")
        if isinstance(default, str) and default.strip() and default.strip() not in seen:
            seen.add(default.strip())
            models.insert(0, default.strip())
    return models


def _has_pool_entry(provider_name: str) -> bool:
    if not provider_name:
        return False
    try:
        auth_path = os.path.expanduser("~/.hermes/auth.json")
        with open(auth_path, "r") as f:
            auth = json.load(f)
        pool = auth.get("credential_pool", {}).get(provider_name, [])
        return bool(pool)
    except Exception:
        return False

def _cli_custom_endpoint_credentialed(cfg: dict, hermes_home: Optional[Path] = None) -> bool:
    """True when the CLI custom base_url has its own key (not OpenClaw gateway alone).

    A local gateway token does not prove the custom host accepts that token, so
    synthetic /v1/providers rows must not show as connected unless config.yaml or
    auth.json actually supplies a key for this endpoint.
    """
    if (cfg.get("api_key") or "").strip():
        return True
    provider = (cfg.get("provider") or "").strip().lower()
    if provider and (_get_credential_pool_key(provider) or _has_pool_entry(provider)):
        return True
    if provider:
        env_key = provider.upper().replace("-", "_").replace(":", "_") + "_API_KEY"
        if os.environ.get(env_key):
            return True
        # OPENCODE_* keys only prove credentials for opencode providers — a
        # generic custom host (e.g. api.bullinf.fun) must not inherit them.
        if provider.startswith("opencode") or provider.startswith("custom:opencode"):
            if os.environ.get("OPENCODE_GO_API_KEY") or os.environ.get("OPENCODE_API_KEY"):
                return True
    custom_id = _synthetic_cli_provider_id(cfg)
    if _get_credential_pool_key(custom_id) or _get_credential_pool_key("custom") or _has_pool_entry(custom_id) or _has_pool_entry("custom"):
        return True
    base_norm = (cfg.get("base_url") or "").strip().rstrip("/").lower()
    if not base_norm:
        return False
    for entry in _load_custom_providers_list(hermes_home):
        entry_base = (entry.get("base_url") or "").strip().rstrip("/").lower()
        if entry_base == base_norm and (entry.get("api_key") or "").strip():
            return True
    return False


def _cli_custom_provider_row(cfg: dict, hermes_home: Optional[Path] = None) -> Optional[dict]:
    """Synthetic /v1/providers row for the active CLI custom base_url, or None."""
    if not _cli_config_is_custom(cfg):
        return None
    base_url = (cfg.get("base_url") or "").strip()
    default_model = (cfg.get("default") or "").strip() or "auto"
    pid = _synthetic_cli_provider_id(cfg)
    models = _models_for_custom_base_url(base_url, hermes_home)
    # Always surface the configured default first so Settings/model pickers do
    # not lock onto catalog lead entries (e.g. e2ee-*) when default is present.
    if default_model:
        models = [m for m in models if m != default_model]
        models = [default_model, *models]
    # Prefer a short human name from matching custom_providers entries.
    name = pid.removeprefix("custom:") if pid.startswith("custom:") else pid
    base_norm = base_url.rstrip("/").lower()
    for entry in _load_custom_providers_list(hermes_home):
        entry_base = (entry.get("base_url") or "").strip().rstrip("/").lower()
        if entry_base == base_norm and isinstance(entry.get("name"), str) and entry["name"].strip():
            name = entry["name"].strip()
            break
    return {
        "id": pid,
        "name": name,
        "base_url": base_url,
        "is_aggregator": True,
        "credentialed": _cli_custom_endpoint_credentialed(cfg, hermes_home),
        "models": models,
        "default_model": default_model,
    }


_cli_model_config = _load_cli_model_config()
_cli_default_model = _cli_model_config.get("default")
DEFAULT_MODEL = os.environ.get("HERMES_DEFAULT_MODEL", _cli_default_model or "meta-llama/llama-4-maverick")
MOA_PROVIDER_ID = "moa"
MOA_PROVIDER_NAME = "Mixture of Agents"
MOA_NATIVE_REQUIRED_CODE = "MOA_NATIVE_REQUIRED"
MOA_NATIVE_REQUIRED_MESSAGE = (
    "MoA presets require the native Hermes agent adapter (HermesAgentAdapter). "
    "The bridge fell back to legacy run_agent, which cannot run MoA. "
    "Install or update Hermes Agent and restart the bridge."
)


def _resolve_chat_agent_class():
    """Return (agent_class, using_real_adapter). Falls back to run_agent on import failure."""
    try:
        from hermes_adapter import HermesAgentAdapter as AIAgent
        return AIAgent, True
    except Exception as adapter_err:
        print(f"[hermes-bridge] Adapter import failed: {adapter_err}", flush=True)
        from run_agent import AIAgent
        return AIAgent, False


def _moa_native_adapter_required_error(
    *,
    model: str,
    finalize_session,
) -> JSONResponse:
    """Refuse MoA when only the legacy run_agent fallback is available."""
    _mark_request_finished(
        model=model,
        success=False,
        summary=f"model={model} mode=agent-loop error=moa-native-required",
    )
    finalize_session(False, MOA_NATIVE_REQUIRED_MESSAGE)
    return JSONResponse(
        status_code=400,
        content={
            "error": {
                "message": MOA_NATIVE_REQUIRED_MESSAGE,
                "code": MOA_NATIVE_REQUIRED_CODE,
            }
        },
    )


def _read_config_yaml(hermes_home: Optional[Path] = None) -> dict:
    """Best-effort YAML config reader used for rich config sections."""
    config_path = (hermes_home or Path.home() / ".hermes") / "config.yaml"
    if not config_path.is_file():
        return {}
    try:
        import yaml
        with open(config_path) as f:
            data = yaml.safe_load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _coerce_moa_model_ref(raw) -> Optional[dict]:
    if isinstance(raw, str) and raw.strip():
        return {"provider": "", "model": raw.strip()}
    if not isinstance(raw, dict):
        return None
    model = raw.get("model")
    if not isinstance(model, str) or not model.strip():
        return None
    provider = raw.get("provider")
    return {
        "provider": provider.strip() if isinstance(provider, str) else "",
        "model": model.strip(),
    }


def _coerce_optional_float(raw):
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def _coerce_optional_int(raw):
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _coerce_moa_fanout(raw) -> str:
    mode = str(raw or "").strip().lower()
    return mode if mode in {"per_iteration", "user_turn"} else "per_iteration"


def _normalize_moa_preset(name: str, raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None

    aggregator = _coerce_moa_model_ref(raw.get("aggregator"))
    references_raw = raw.get("reference_models") or raw.get("references") or []
    references = []
    if isinstance(references_raw, list):
        for item in references_raw:
            ref = _coerce_moa_model_ref(item)
            if ref:
                references.append(ref)

    if not aggregator or not references:
        return None

    # Block recursive MoA slots (aggregator/reference must not be provider=moa)
    if str(aggregator.get("provider") or "").strip().lower() == MOA_PROVIDER_ID:
        return None
    references = [
        ref for ref in references
        if str(ref.get("provider") or "").strip().lower() != MOA_PROVIDER_ID
    ]
    if not references:
        return None

    return {
        "name": name,
        "enabled": raw.get("enabled") is not False,
        "reference_models": references,
        "aggregator": aggregator,
        "reference_temperature": _coerce_optional_float(raw.get("reference_temperature")),
        "aggregator_temperature": _coerce_optional_float(raw.get("aggregator_temperature")),
        "max_tokens": _coerce_optional_int(raw.get("max_tokens")),
        "reference_max_tokens": _coerce_optional_int(raw.get("reference_max_tokens")),
        "fanout": _coerce_moa_fanout(raw.get("fanout")),
    }


def _normalize_moa_config(raw) -> dict:
    """Normalize Hermes `moa:` config into the shape CloudChat needs."""
    result = {"default_preset": "default", "presets": {}}
    if not isinstance(raw, dict):
        return result

    moa_cfg = raw.get("moa") if "moa" in raw else raw
    if not isinstance(moa_cfg, dict):
        return result

    default_preset = moa_cfg.get("default_preset")
    if isinstance(default_preset, str) and default_preset.strip():
        result["default_preset"] = default_preset.strip()

    raw_presets = moa_cfg.get("presets")
    if not isinstance(raw_presets, dict):
        return result

    presets = {}
    for raw_name, raw_preset in raw_presets.items():
        name = str(raw_name).strip()
        if not name:
            continue
        preset = _normalize_moa_preset(name, raw_preset)
        if preset:
            presets[name] = preset

    result["presets"] = presets
    if result["default_preset"] not in presets and presets:
        result["default_preset"] = next(iter(presets.keys()))
    return result


def _load_moa_config(hermes_home: Optional[Path] = None) -> dict:
    return _normalize_moa_config(_read_config_yaml(hermes_home))


def _enabled_moa_preset_names(moa_config: dict) -> list[str]:
    presets = moa_config.get("presets")
    if not isinstance(presets, dict):
        return []
    return [
        name for name, preset in presets.items()
        if isinstance(preset, dict) and preset.get("enabled") is not False
    ]


def _preset_to_yaml(preset: dict) -> dict:
    """Serialize a normalized preset into the Hermes config.yaml shape."""
    out: dict = {
        "enabled": preset.get("enabled") is not False,
        "reference_models": [
            {"provider": r.get("provider") or "", "model": r.get("model") or ""}
            for r in (preset.get("reference_models") or [])
            if isinstance(r, dict) and r.get("model")
        ],
        "aggregator": {
            "provider": (preset.get("aggregator") or {}).get("provider") or "",
            "model": (preset.get("aggregator") or {}).get("model") or "",
        },
        "fanout": _coerce_moa_fanout(preset.get("fanout")),
    }
    for key in ("reference_temperature", "aggregator_temperature", "max_tokens", "reference_max_tokens"):
        value = preset.get(key)
        if value is not None:
            out[key] = value
    return out


def _save_moa_config(body: dict, hermes_home: Optional[Path] = None) -> dict:
    """Merge a MoA config payload into config.yaml and return the normalized result.

    Accepts either a full `{ default_preset, presets }` object or a single
    `{ preset: {name, ...} }` upsert. Never writes recursive moa slots.
    """
    home = hermes_home or (Path.home() / ".hermes")
    dump, data = _load_hermes_config_editable(Path(home))
    if not isinstance(data, dict):
        data = {}

    current = _normalize_moa_config({"moa": data.get("moa")} if isinstance(data.get("moa"), dict) else data.get("moa") or {})
    presets = dict(current.get("presets") or {})
    default_preset = current.get("default_preset") or "default"

    if isinstance(body.get("presets"), dict):
        # Full replace of named presets (only valid ones kept)
        incoming = body["presets"]
        rebuilt = {}
        for raw_name, raw_preset in incoming.items():
            name = str(raw_name).strip()
            if not name or not isinstance(raw_preset, dict):
                continue
            # Accept both normalized and raw hermes shapes
            candidate = dict(raw_preset)
            if "name" not in candidate:
                candidate["name"] = name
            normalized = _normalize_moa_preset(name, candidate)
            if normalized:
                rebuilt[name] = normalized
        if not rebuilt:
            raise ValueError("At least one valid MoA preset with reference_models and aggregator is required")
        presets = rebuilt
    elif isinstance(body.get("preset"), dict):
        raw_preset = body["preset"]
        name = str(raw_preset.get("name") or body.get("name") or "").strip()
        if not name:
            raise ValueError("preset.name is required")
        if body.get("delete") is True or raw_preset.get("delete") is True:
            presets.pop(name, None)
            if not presets:
                raise ValueError("Cannot delete the last MoA preset")
        else:
            normalized = _normalize_moa_preset(name, raw_preset)
            if not normalized:
                raise ValueError(
                    f"Invalid preset '{name}': needs at least one non-moa reference model and a non-moa aggregator"
                )
            presets[name] = normalized

    if isinstance(body.get("default_preset"), str) and body["default_preset"].strip():
        default_preset = body["default_preset"].strip()
    if default_preset not in presets and presets:
        default_preset = next(iter(presets.keys()))

    yaml_presets = {name: _preset_to_yaml(p) for name, p in presets.items()}
    active = presets.get(default_preset) or next(iter(presets.values()))
    data["moa"] = {
        "default_preset": default_preset,
        "active_preset": "",
        "presets": yaml_presets,
        # Flattened compat view for older Hermes readers / dashboard
        "reference_models": list(active.get("reference_models") or []),
        "aggregator": dict(active.get("aggregator") or {}),
        "reference_temperature": active.get("reference_temperature"),
        "aggregator_temperature": active.get("aggregator_temperature"),
        "max_tokens": active.get("max_tokens") or 4096,
        "reference_max_tokens": active.get("reference_max_tokens"),
        "fanout": active.get("fanout") or "per_iteration",
        "enabled": active.get("enabled") is not False,
    }
    dump()
    return _normalize_moa_config({"moa": data["moa"]})

# ------------------------------------------------------------------
# Circuit breaker for upstream API calls
# ------------------------------------------------------------------
class CircuitBreaker:
    """Prevents cascading failures by opening the circuit after consecutive errors."""

    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failures = 0
        self.last_failure_time: Optional[float] = None
        self.state = "closed"  # closed | open | half-open

    def record_success(self):
        self.failures = 0
        self.state = "closed"

    def record_failure(self):
        self.failures += 1
        self.last_failure_time = time.monotonic()
        if self.failures >= self.failure_threshold:
            self.state = "open"

    def is_available(self) -> bool:
        if self.state == "closed":
            return True
        if self.state == "open":
            if self.last_failure_time and (time.monotonic() - self.last_failure_time) >= self.recovery_timeout:
                self.state = "half-open"
                return True
            return False
        # half-open: allow one attempt
        return True

    def get_state(self) -> str:
        return self.state


# Circuit breakers per upstream provider (created lazily below)
_provider_circuits: dict[str, CircuitBreaker] = {}
_brain_circuit = CircuitBreaker(failure_threshold=3, recovery_timeout=15.0)

def _get_circuit(provider: str) -> CircuitBreaker:
    """Get or create a circuit breaker for a provider."""
    if provider not in _provider_circuits:
        _provider_circuits[provider] = CircuitBreaker(failure_threshold=5, recovery_timeout=30.0)
    return _provider_circuits[provider]

# Backward-compatible circuit references (evaluated at each use via _get_circuit)
_openrouter_circuit_ref = "openrouter"
_minimax_circuit_ref = "minimax"
_nous_circuit_ref = "nous"

# ── Provider base URL registry ──────────────────────────────────────────────
# Mirrors the hermes-agent PROVIDER_REGISTRY in hermes_cli/auth.py.
# Each entry maps a provider_id → (base_url, description, model_prefixes).
# Model prefixes are used for automatic routing when the model name starts with
# one of these prefixes (e.g. "anthropic/" → Anthropic, "deepseek/" → DeepSeek).
# OpenRouter handles everything else as the universal fallback.
import os
MINIMAX_BASE_URL = os.environ.get("MINIMAX_BASE_URL", "https://api.minimax.io/anthropic")

_PROVIDER_CONFIG: dict[str, dict] = {
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "name": "OpenRouter",
        "model_prefixes": [],  # Default — handles everything not explicitly routed
        "auth_json_provider": "openrouter",
        "env_var": "HERMES_OPENROUTER_KEY",
    },
    "minimax": {
        "base_url": MINIMAX_BASE_URL,
        "name": "MiniMax",
        "model_prefixes": ["MiniMax-", "minimax-"],
        "auth_json_provider": "minimax",
        "env_var": "HERMES_MINIMAX_KEY",
    },
    "nous": {
        "base_url": "https://inference-api.nousresearch.com/v1",
        "name": "Nous Research",
        "model_prefixes": ["nousresearch/", "nous/"],
        "auth_json_provider": "nous",
    },
    "anthropic": {
        "base_url": "https://api.anthropic.com",
        "name": "Anthropic",
        "model_prefixes": ["anthropic/", "claude-"],
        "auth_json_provider": "anthropic",
        "env_var": "ANTHROPIC_API_KEY",
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com",
        "name": "DeepSeek",
        "model_prefixes": ["deepseek/"],
        "auth_json_provider": "deepseek",
        "env_var": "DEEPSEEK_API_KEY",
    },
    "google": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "name": "Google AI Studio",
        "model_prefixes": ["google/", "gemini-"],
        "auth_json_provider": "google",
        "env_var": "GOOGLE_API_KEY",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "name": "OpenAI",
        "model_prefixes": ["openai/", "gpt-", "o1-", "o3-", "o4-"],
        "auth_json_provider": "openai",
        "env_var": "OPENAI_API_KEY",
    },
    "xai": {
        "base_url": "https://api.x.ai/v1",
        "name": "xAI (Grok)",
        "model_prefixes": ["xai/", "grok-"],
        "auth_json_provider": "xai",
        "env_var": "XAI_API_KEY",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "name": "Groq",
        "model_prefixes": ["groq/"],
        "auth_json_provider": "groq",
        "env_var": "GROQ_API_KEY",
    },
    "mistral": {
        "base_url": "https://api.mistral.ai/v1",
        "name": "Mistral",
        "model_prefixes": ["mistral/", "mistral-", "mistralai/", "codestral/", "codestral-"],
        "auth_json_provider": "mistral",
        "env_var": "MISTRAL_API_KEY",
    },
    "kimi": {
        "base_url": "https://api.moonshot.ai/v1",
        "name": "Kimi / Moonshot",
        "model_prefixes": ["kimi/", "kimi-", "moonshot/", "moonshotai/"],
        "auth_json_provider": "kimi-coding",
        "env_var": "KIMI_API_KEY",
    },
    "zai": {
        "base_url": "https://api.z.ai/api/paas/v4",
        "name": "Z.AI / GLM",
        "model_prefixes": ["z-ai/", "glm-", "z.ai/"],
        "auth_json_provider": "zai",
        "env_var": "GLM_API_KEY",
    },
    "alibaba": {
        "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "name": "Alibaba DashScope",
        "model_prefixes": ["alibaba/", "qwen/"],
        "auth_json_provider": "alibaba",
        "env_var": "DASHSCOPE_API_KEY",
    },
    "huggingface": {
        "base_url": "https://api-inference.huggingface.co/v1",
        "name": "Hugging Face",
        "model_prefixes": ["huggingface/", "hf/"],
        "auth_json_provider": "huggingface",
        "env_var": "HF_TOKEN",
    },
    "kilocode": {
        "base_url": "https://api.kilocode.ai/v1",
        "name": "Kilo Code",
        "model_prefixes": ["kilocode/"],
        "auth_json_provider": "kilocode",
        "env_var": "KILOCODE_API_KEY",
    },
    "cerebras": {
        "base_url": "https://api.cerebras.ai/v1",
        "name": "Cerebras",
        "model_prefixes": ["cerebras/"],
        "auth_json_provider": "cerebras",
        "env_var": "CEREBRAS_API_KEY",
    },
    "together": {
        "base_url": "https://api.together.xyz/v1",
        "name": "Together AI",
        "model_prefixes": ["together/", "together_ai/"],
        "auth_json_provider": "together",
        "env_var": "TOGETHER_API_KEY",
    },
    "cursor-composer": {
        "base_url": os.environ.get("CURSOR_COMPOSER_BRIDGE_URL", "http://127.0.0.1:8790/v1"),
        "name": "Cursor Composer (local bridge)",
        "model_prefixes": ["composer-"],
        "auth_json_provider": "custom:Cursor-Composer",
        "env_var": "CURSOR_API_KEY",
    },
    # --- Providers synced from hermes-agent's PROVIDER_REGISTRY (hermes_cli/auth.py) ---
    # Sync check:
    #   python3 -c "import re;auth=open('~/.hermes/hermes-agent/hermes_cli/auth.py').read();\
    #   ids=set(re.findall(r'id=\"([a-z0-9_]+)\"',auth));main=open('hermes-bridge/main.py').read();\
    #   m=re.search(r'_PROVIDER_CONFIG[^=]*=\s*\{',main);keys=set(re.findall(r'\"([a-z0-9_]+)\":\s*\{',main[m.end():]));\
    #   print(sorted(ids-keys))"
    "xiaomi": {
        "base_url": "https://api.xiaomimimo.com/v1",
        "name": "Xiaomi MiMo",
        "model_prefixes": ["xiaomi/", "mimo"],
        "auth_json_provider": "xiaomi",
        "env_var": "XIAOMI_API_KEY",
    },
    "gemini": {
        # Distinct registry id upstream; same endpoint as google/ai-studio.
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "name": "Google AI Studio (gemini)",
        "model_prefixes": ["gemini/"],
        "auth_json_provider": "gemini",
        "env_var": "GEMINI_API_KEY",
    },
    "lmstudio": {
        "base_url": "http://127.0.0.1:1234/v1",
        "name": "LM Studio (local)",
        "model_prefixes": ["lmstudio/"],
        "auth_json_provider": "lmstudio",
        "env_var": "LM_API_KEY",
    },
    "copilot": {
        "base_url": "https://api.githubcopilot.com",
        "name": "GitHub Copilot",
        "model_prefixes": ["copilot/"],
        "auth_json_provider": "copilot",
        "env_var": "COPILOT_GITHUB_TOKEN",
    },
    "stepfun": {
        "base_url": "https://api.stepfun.ai/step_plan/v1",
        "name": "StepFun Step Plan",
        "model_prefixes": ["stepfun/"],
        "auth_json_provider": "stepfun",
        "env_var": "STEPFUN_API_KEY",
    },
    "arcee": {
        "base_url": "https://api.arcee.ai/api/v1",
        "name": "Arcee AI",
        "model_prefixes": ["arcee/"],
        "auth_json_provider": "arcee",
        "env_var": "ARCEEAI_API_KEY",
    },
    "gmi": {
        "base_url": "https://api.gmi-serving.com/v1",
        "name": "GMI Cloud",
        "model_prefixes": ["gmi/"],
        "auth_json_provider": "gmi",
        "env_var": "GMI_API_KEY",
    },
    "actual": {
        "base_url": "https://api.actual.inc/v1",
        "name": "Actual Computer",
        "model_prefixes": ["actual/"],
        "auth_json_provider": "actual",
        "env_var": "ACTUAL_API_KEY",
    },
    "nvidia": {
        "base_url": "https://integrate.api.nvidia.com/v1",
        "name": "NVIDIA NIM",
        "model_prefixes": ["nvidia/", "nvidia-nim/"],
        "auth_json_provider": "nvidia",
        "env_var": "NVIDIA_API_KEY",
    },
    # aws_sdk / vertex auth types — no bearer-token proxying via the bridge;
    # registered so model-prefix routing and /health credential reporting
    # recognize them instead of falling through to OpenRouter with a wrong key.
    "bedrock": {
        "base_url": "https://bedrock-runtime.us-east-1.amazonaws.com",
        "name": "AWS Bedrock (no bridge proxying — SDK auth)",
        "model_prefixes": ["bedrock/"],
        "auth_json_provider": "bedrock",
    },
    "vertex": {
        "base_url": "",
        "name": "Google Vertex AI (no bridge proxying — ADC auth)",
        "model_prefixes": ["vertex/"],
        "auth_json_provider": "vertex",
    },
}

# Build a reverse lookup: model_prefix → provider_id
_MODEL_PREFIX_TO_PROVIDER: dict[str, str] = {}
for _pid, _cfg in _PROVIDER_CONFIG.items():
    for _pfx in _cfg.get("model_prefixes", []):
        _MODEL_PREFIX_TO_PROVIDER[_pfx] = _pid

# Known hosts for custom base_url detection
def _known_host_label(hostname: str) -> str:
    """Collapse a provider's public host to its matchable form.

    Strips only a LEADING ``api.`` / ``www.`` label. ``str.replace`` also
    mangled hosts where those labels appear mid-name — e.g. Nous's
    ``inference-api.nousresearch.com`` became ``inference-nousresearch.com``,
    an entry that never substring-matches the real base_url, so the native
    nous config was misclassified as a custom endpoint (bogus synthetic
    ``custom:<host>`` provider row + stale UI pins routing to OpenRouter).
    """
    for prefix in ("api.", "www."):
        if hostname.startswith(prefix):
            return hostname[len(prefix):]
    return hostname


_KNOWN_HOSTS: tuple[str, ...] = tuple(
    # Filter empty strings: a provider entry with base_url "" (e.g. vertex,
    # resolved at request time) would otherwise yield "" as a host and
    # `"" in url` is always True — silently marking every base_url "known"
    # and killing the cli_is_custom passthrough path.
    h
    for h in {
        _known_host_label(u.split("://")[-1].split("/")[0])
        for u in [_c["base_url"] for _c in _PROVIDER_CONFIG.values()]
    }
    if h
)

# Backward-compatible constants
MINIMAX_MODEL_PREFIX = "MiniMax-"
NOUS_MODEL_PREFIX = "nousresearch/"
NOUS_BASE_URL = _PROVIDER_CONFIG["nous"]["base_url"]

# Vision-capable models — these support image input (base64, URLs, or multimodal content)
# Models NOT in this list will have image content stripped before being sent upstream
_VISION_CAPABLE_MODELS: set[str] = {
    # MiniMax models with vision support
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    # Claude Opus 4 and Sonnet 4 support vision
    "anthropic/claude-opus-4-5",
    "anthropic/claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    # Gemini 2.x flash variants support vision
    "google/gemini-2.0-flash-exp",
    "google/gemini-3.1-flash-preview",
    "gemini-2.0-flash-exp",
    "gemini-3.1-flash-preview",
    # GPT-4o and vision models
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "gpt-4o",
    "gpt-4o-mini",
    # Nous Hermès variants with multimodal
    "nousresearch/hermes-3-llama-3.3-70b",
}


def _model_supports_vision(model: str) -> bool:
    """Check if a model supports image/vision input."""
    if model in _VISION_CAPABLE_MODELS:
        return True
    model_lower = model.lower()
    for capable in _VISION_CAPABLE_MODELS:
        if capable.lower() in model_lower or model_lower in capable.lower():
            return True
    if model_lower.startswith("claude") and "sonnet" in model_lower:
        return True
    if model_lower.startswith("gpt-4o"):
        return True
    if "gemini-2" in model_lower or "gemini-3" in model_lower:
        return True
    if "minimax-m2" in model_lower:
        return True
    return False

# ------------------------------------------------------------------
# Retry helper for brain gateway calls
# ------------------------------------------------------------------
def _retry_brain_call(func, *args, retries: int = 2, backoff: float = 0.5, **kwargs):
    """Call a brain gateway function with retry and exponential backoff."""
    for attempt in range(retries + 1):
        if not _brain_circuit.is_available():
            return None
        try:
            result = func(*args, **kwargs)
            if result is not None:
                _brain_circuit.record_success()
                return result
            # None means brain unavailable — treat as failure
            _brain_circuit.record_failure()
        except Exception as e:
            print(f"[hermes-bridge] brain call attempt {attempt + 1} failed: {e}", flush=True)
            _brain_circuit.record_failure()
        if attempt < retries:
            time.sleep(backoff * (2 ** attempt))
    return None

# ------------------------------------------------------------------
# Error message helpers for common failures
# ------------------------------------------------------------------
def _no_api_key_error(provider: str) -> JSONResponse:
    """Build a user-friendly 401 error for a missing API key."""
    cfg = _PROVIDER_CONFIG.get(provider, {})
    name = cfg.get("name", provider)
    env_var = cfg.get("env_var", f"HERMES_{provider.upper()}_KEY")
    messages = {
        "openrouter": "No API key provided. Set HERMES_OPENROUTER_KEY, pass Authorization: Bearer *** header, or run the local OpenClaw gateway.",
        "minimax": "MiniMax API key required. Set HERMES_MINIMAX_KEY, configure a MiniMax key in Settings, or run the local OpenClaw gateway.",
        "nous": "Nous API key required. Configure a Nous agent key in ~/.hermes/auth.json or run `hermes auth login --provider nous`.",
        "github": "GitHub token required for repository operations. Provide x-hermes-github-pat header or configure a GitHub token in Settings.",
    }
    if provider in messages:
        return JSONResponse(
            status_code=401,
            content={"error": {"message": messages[provider]}},
        )
    # Generic message for all other providers
    return JSONResponse(
        status_code=401,
        content={"error": {"message": f"{name} API key required. Set {env_var} environment variable, "
                                      f"add {provider} credentials to ~/.hermes/auth.json, or run `hermes auth add`."}},
    )


def _repo_not_found_error(owner: str, repo: str) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={
            "error": {
                "message": f"Repository '{owner}/{repo}' not found or not accessible. Check the repository name and ensure your GitHub token has access.",
                "code": "REPO_NOT_FOUND",
            }
        },
    )


def _github_token_expired_error() -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={
            "error": {
                "message": "GitHub token is invalid or expired. Please update your GitHub Personal Access Token in Settings.",
                "code": "GITHUB_TOKEN_EXPIRED",
            }
        },
    )


def _circuit_open_error(provider: str) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "message": f"{provider} service is temporarily unavailable (circuit open). Please retry shortly.",
                "code": "CIRCUIT_OPEN",
            }
        },
    )


# ------------------------------------------------------------------
# Metrics helper
# ------------------------------------------------------------------
_bridge_start_time: float = 0.0
_bridge_total_requests: int = 0
_bridge_error_count: int = 0
_bridge_active_requests: int = 0


def _update_bridge_metrics(
    success: bool,
    increment_active: bool = False,
    decrement_active: bool = False,
):
    global _bridge_error_count, _bridge_active_requests
    if decrement_active:
        _bridge_active_requests = max(0, _bridge_active_requests - 1)
    if increment_active:
        _bridge_active_requests += 1
    if not success:
        _bridge_error_count += 1
    error_rate = _bridge_error_count / max(_bridge_total_requests, 1)
    uptime = time.time() - _bridge_start_time if _bridge_start_time else 0
    metrics = json.dumps({
        "api_calls": _bridge_total_requests,
        "error_rate": round(error_rate, 4),
        "active_requests": _bridge_active_requests,
        "uptime": round(uptime, 1),
        "start_time": _bridge_start_time,
        "total_requests": _bridge_total_requests,
        "error_count": _bridge_error_count,
    })
    _brain_set("bridge:metrics", metrics, "global")


def _mark_request_started(
    *,
    model: str,
    enabled_toolsets: list[str],
    repo_mode: bool,
    repo_owner: str,
    repo_name: str,
    repo_edit_intent: bool,
) -> str:
    global _bridge_total_requests
    _bridge_total_requests += 1
    _update_bridge_metrics(success=True, increment_active=True)
    active_job_meta = json.dumps({
        "owner": repo_owner or None,
        "repo": repo_name or None,
        "model": model,
        "toolsets": enabled_toolsets,
        "repo_mode": repo_mode,
        "edit_intent": repo_edit_intent,
        "request_num": _bridge_total_requests,
    })
    _brain_set("hermes-bridge:active_request", active_job_meta)
    _brain_set("hermes-bridge:active_sessions", str(_bridge_active_requests), "global")
    _brain_set("hermes-bridge:model", model, "global")
    _brain_set("hermes-bridge:toolsets", ",".join(enabled_toolsets), "global")
    return active_job_meta


def _mark_request_finished(*, model: str, success: bool, summary: Optional[str] = None):
    _update_bridge_metrics(success=success, decrement_active=True)
    _brain_set("hermes-bridge:active_request", "")
    _brain_set("hermes-bridge:active_sessions", str(_bridge_active_requests), "global")
    if summary:
        _brain_set("hermes-bridge:last_completion", summary, "global")


def _get_local_gateway_key() -> Optional[str]:
    """Read the gateway auth token from local openclaw.json config.

    Returns the gateway's Bearer token (gateway.auth.token) if the gateway
    is configured and the file is readable. Returns None if not configured
    or file missing/parseable.
    """
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    try:
        with open(config_path, "r") as f:
            config = json.load(f)
        token = config.get("gateway", {}).get("auth", {}).get("token")
        if token and isinstance(token, str) and len(token) > 0:
            return token
    except Exception:
        pass
    return None


def _get_openrouter_key_from_hermes_creds() -> Optional[str]:
    """Read OpenRouter API keys from ~/.hermes/auth.json credential_pool.

    Returns the highest-priority (lowest priority number) OpenRouter API key.
    Returns None if auth.json doesn't exist or has no OpenRouter credentials.
    """
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
        pool = auth.get("credential_pool", {}).get("openrouter", [])
        if not pool:
            return None
        # Sort by priority (lower = higher priority), pick first with a key
        sorted_creds = sorted(pool, key=lambda c: c.get("priority", 99))
        for cred in sorted_creds:
            key = cred.get("access_token", "")
            if key and key != "***" and len(key) > 0:
                return key
    except Exception:
        pass
    return None


def _get_nous_agent_key() -> Optional[str]:
    """Read Nous inference agent key from ~/.hermes/auth.json.

    Returns the agent_key from the nous provider entry.
    Returns None if auth.json doesn't exist or has no Nous credentials.
    """
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
        nous = auth.get("providers", {}).get("nous", {})
        key = nous.get("agent_key", "")
        if key and len(key) > 0:
            return key
    except Exception:
        pass
    return None


_HERMES_DOTENV_CACHE: Optional[dict] = None

def _read_hermes_dotenv_var(name: str) -> str:
    """Read one var from ~/.hermes/.env (KEY=value lines, no quotes stripping
    beyond what dotenv does). Cached per-process; returns "" when absent."""
    global _HERMES_DOTENV_CACHE
    if _HERMES_DOTENV_CACHE is None:
        _HERMES_DOTENV_CACHE = {}
        try:
            dotenv_path = os.path.expanduser("~/.hermes/.env")
            with open(dotenv_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    _HERMES_DOTENV_CACHE[k.strip()] = v.strip().strip('"').strip("'")
        except Exception:
            pass
    return _HERMES_DOTENV_CACHE.get(name, "")


def _get_credential_pool_key(provider_name: str) -> Optional[str]:
    """Read an API key from ~/.hermes/auth.json credential_pool[provider_name].

    Returns the highest-priority (lowest priority number) entry's access_token.
    Returns None if auth.json doesn't exist or has no matching credentials.
    """
    if not provider_name:
        return None
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
        pool = auth.get("credential_pool", {}).get(provider_name, [])
        if not pool:
            return None
        sorted_creds = sorted(pool, key=lambda c: c.get("priority", 99))
        for cred in sorted_creds:
            key = cred.get("access_token", "")
            if key and key != "***":
                return key
            # Env-sourced pool entries (source: "env:VARNAME") don't persist the
            # secret in auth.json — only a fingerprint. Resolve by reading the
            # referenced env var at lookup time, mirroring hermes_cli.auth.
            # When the bridge is spawned by Electron it may not inherit the
            # user's shell exports — fall back to ~/.hermes/.env (hermes loads
            # that file itself, and it takes precedence over stale shell vars).
            source = str(cred.get("source") or "").strip()
            if source.startswith("env:"):
                env_var = source.split(":", 1)[1].strip()
                if env_var:
                    env_key = os.environ.get(env_var, "")
                    if not env_key or env_key == "***":
                        env_key = _read_hermes_dotenv_var(env_var)
                    if env_key and env_key != "***":
                        return env_key
    except Exception:
        pass
    return None


def _get_active_provider() -> Optional[str]:
    """Read the active_provider from ~/.hermes/auth.json."""
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
        return auth.get("active_provider")
    except Exception:
        pass
    return None


def _load_credential_pool() -> dict[str, list[dict]]:
    """Return ~/.hermes/auth.json credential_pool entries keyed by provider id."""
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
        pool = auth.get("credential_pool", {}) or {}
        return pool if isinstance(pool, dict) else {}
    except Exception:
        return {}


def _credential_pool_entry_usable(entry: dict) -> bool:
    key = (entry.get("access_token") or "").strip()
    base_url = (entry.get("base_url") or "").strip()
    if not key or key == "***" or not base_url:
        return False
    status = (entry.get("last_status") or "").strip().lower()
    return status not in ("error", "failed", "unauthorized", "invalid", "exhausted")


def _best_usable_credential_pool_entry(pool: dict[str, list[dict]], provider_name: str) -> Optional[dict]:
    entries = pool.get(provider_name) or []
    for entry in sorted(entries, key=lambda c: c.get("priority", 99)):
        if _credential_pool_entry_usable(entry):
            return entry
    return None


def _provider_serves_model(pid: str, model: str) -> bool:
    """Whether a bridge provider's catalog includes this model id."""
    catalog = _models_for_provider(pid)
    if not catalog:
        return True
    return _match_model_for_provider(pid, model) is not None


# Aggregators proxy arbitrary model ids — don't second-guess them via pool routing
# when the local catalog is incomplete (e.g. OpenRouter hosting llama-3-70b).
_AGGREGATOR_PROVIDERS = frozenset({"openrouter", "nous", "minimax"})


def _native_provider_cannot_serve_model(pid: str, model: str) -> bool:
    """True when a native API provider is selected but its catalog lacks this model."""
    if pid in _AGGREGATOR_PROVIDERS or pid not in _PROVIDER_CONFIG:
        return False
    return not _provider_serves_model(pid, model)


# Pool-only providers Hermes CLI commonly uses for models that native APIs
# don't host (deepseek-v4-flash via opencode-zen, etc.). Checked before the
# alphabetical pool scan so crofai doesn't win by sort order.
_POOL_ROUTE_PRIORITY = (
    "opencode-zen",
    "opencode-go",
    "custom:opencode.ai",
    "custom:opencode-go",
)


def _resolve_custom_credential_pool_route(
    *,
    prefer_providers: list[str],
    model: str = "",
) -> Optional[tuple[str, str, str]]:
    """Pick a custom credential_pool provider (opencode-zen, etc.) for routing."""
    pool = _load_credential_pool()
    if not pool:
        return None

    ordered: list[str] = []
    for raw in prefer_providers:
        pid = (raw or "").strip().lower()
        if pid and pid not in _PROVIDER_CONFIG and pid not in ordered:
            ordered.append(pid)
    for pid in _POOL_ROUTE_PRIORITY:
        if pid in pool and pid not in ordered:
            ordered.append(pid)
    for pid in sorted(pool.keys()):
        if pid not in ordered:
            ordered.append(pid)

    model_lower = (model or "").strip().lower()
    best: Optional[tuple[int, str, str, str]] = None
    for pid in ordered:
        if pid in _PROVIDER_CONFIG:
            continue
        entry = _best_usable_credential_pool_entry(pool, pid)
        if not entry:
            continue
        base_url = (entry.get("base_url") or "").strip().rstrip("/")
        if not base_url or any(host in base_url for host in _KNOWN_HOSTS):
            continue
        key = (entry.get("access_token") or "").strip()
        score = 0
        if model_lower and _match_model_for_provider(pid, model):
            score += 100
        if model_lower.startswith("deepseek") and "opencode" in pid:
            score += 80
        if pid in _POOL_ROUTE_PRIORITY:
            score += 10 * (_POOL_ROUTE_PRIORITY.index(pid) + 1)
        candidate = (score, pid, base_url, key)
        if best is None or candidate[0] > best[0]:
            best = candidate
    if not best:
        return None
    _, pid, base_url, key = best
    return (pid, base_url, key)


# ── Provider → model catalog ──────────────────────────────────────────────
# Best-effort import of the canonical Hermes CLI model catalog. Never crash the
# bridge if the import fails (sys.path may not include the agent in all setups).
try:
    import hermes_cli.models as _hermes_cli_models
    _CLI_PROVIDER_MODELS = dict(getattr(_hermes_cli_models, "_PROVIDER_MODELS", {}) or {})
except Exception:
    _CLI_PROVIDER_MODELS = {}

# Bridge provider id → hermes_cli provider id (where they differ)
_BRIDGE_TO_CLI_PROVIDER = {
    "anthropic": "anthropic", "deepseek": "deepseek", "google": "gemini",
    "gemini": "gemini", "openai": "openai-api", "xai": "xai", "kimi": "kimi-coding",
    "zai": "zai", "alibaba": "alibaba", "huggingface": "huggingface",
    "kilocode": "kilocode", "nous": "nous", "minimax": "minimax",
    "xiaomi": "xiaomi", "copilot": "copilot", "stepfun": "stepfun",
    "arcee": "arcee", "gmi": "gmi", "actual": "actual", "nvidia": "nvidia",
    "lmstudio": "lmstudio",
}

# Static fallbacks for bridge ids with no clean cli source.
_STATIC_PROVIDER_MODELS = {
    "openrouter": [
        "anthropic/claude-sonnet-4", "anthropic/claude-opus-4.8",
        "google/gemini-3.1-flash-lite-preview", "deepseek/deepseek-v3.2",
        "meta-llama/llama-4-maverick", "openai/gpt-4.1-mini",
        "x-ai/grok-4.3", "qwen/qwen3-coder", "moonshotai/kimi-k2.6",
    ],
    "groq": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    "mistral": ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "open-mistral-nemo"],
    "cerebras": ["llama-3.3-70b", "qwen-3-32b", "openai/gpt-oss-120b", "llama-3.1-8b"],
    "together": ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo", "mistralai/Mixtral-8x22B-Instruct-v0.1", "deepseek-ai/DeepSeek-V3"],
    "cursor-composer": ["composer-2.5", "composer-2.5-fast", "composer-2"],
}


def _models_for_provider(pid: str) -> list[str]:
    """Return the model id list for a bridge provider id (best-effort)."""
    return _CLI_PROVIDER_MODELS.get(_BRIDGE_TO_CLI_PROVIDER.get(pid, pid)) or _STATIC_PROVIDER_MODELS.get(pid, [])


def _match_model_for_provider(pid: str, model: str) -> Optional[str]:
    """Return this provider's catalog id for `model`, or None if it can't serve it.

    Matches exactly first, then ignores any vendor namespace prefix on either
    side so a bare `deepseek-v4-flash` resolves to an aggregator's namespaced
    `deepseek/deepseek-v4-flash`. Used by credential-aware rerouting so a model
    requested under its native id can be served by a credentialed aggregator.
    """
    models = _models_for_provider(pid)
    if not models:
        return None
    ml = model.lower()
    for m in models:
        if m.lower() == ml:
            return m
    base = ml.split("/")[-1]
    for m in models:
        if m.lower().split("/")[-1] == base:
            return m
    return None


def _read_positive_int_env(name: str, fallback: int) -> int:
    raw_value = os.environ.get(name)
    if not raw_value:
        return fallback
    try:
        parsed_value = int(raw_value)
    except ValueError:
        return fallback
    return parsed_value if parsed_value > 0 else fallback


MAX_AGENT_ITERATIONS = _read_positive_int_env("HERMES_MAX_ITERATIONS", 60)
PASSTHROUGH_TIMEOUT_SECONDS = _read_positive_int_env(
    "HERMES_PROVIDER_TIMEOUT_SECONDS", 5400
)
REQUEST_TIMEOUT_SECONDS = _read_positive_int_env("HERMES_REQUEST_TIMEOUT_SECONDS", 600)

# ── Dynamic model discovery from OpenRouter ─────────────────────────────────
# Fetches available models from OpenRouter API and caches them.
# Falls back to a hardcoded list if the fetch fails.

_FALLBACK_AGENT_MODELS = [
    # Paid models (curated defaults)
    {"id": "anthropic/claude-sonnet-4", "object": "model", "owned_by": "anthropic"},
    {"id": "openai/gpt-4.1-mini", "object": "model", "owned_by": "openai"},
    {"id": "MiniMax-M2.7", "object": "model", "owned_by": "minimax"},
    {"id": "MiniMax-M2.7-highspeed", "object": "model", "owned_by": "minimax"},
    {"id": "google/gemini-3.1-flash-lite-preview", "object": "model", "owned_by": "google"},
    {"id": "google/gemini-2.5-flash", "object": "model", "owned_by": "google"},
    {"id": "deepseek/deepseek-v3.2", "object": "model", "owned_by": "deepseek"},
    {"id": "deepseek/deepseek-chat-v3.1", "object": "model", "owned_by": "deepseek"},
    {"id": "meta-llama/llama-4-maverick", "object": "model", "owned_by": "meta"},
    {"id": "meta-llama/llama-4-scout", "object": "model", "owned_by": "meta"},
    # Free models
    {"id": "deepseek/deepseek-r1-0528", "object": "model", "owned_by": "deepseek"},
    {"id": "google/gemini-2.0-flash-001", "object": "model", "owned_by": "google"},
    {"id": "nousresearch/hermes-3-llama-3.1-405b:free", "object": "model", "owned_by": "nousresearch"},
    {"id": "meta-llama/llama-3.3-70b-instruct:free", "object": "model", "owned_by": "meta"},
    {"id": "qwen/qwen3-next-80b-a3b-instruct:free", "object": "model", "owned_by": "qwen"},
    {"id": "mistralai/mistral-small-3.1-24b-instruct:free", "object": "model", "owned_by": "mistral"},
    # Nous Research models
    {"id": "xiaomi/mimo-v2-pro", "object": "model", "owned_by": "xiaomi"},
]

# MiniMax models aren't on OpenRouter — always include them
_MINIMAX_MODELS = [
    {"id": "MiniMax-M2.7", "object": "model", "owned_by": "minimax"},
    {"id": "MiniMax-M2.7-highspeed", "object": "model", "owned_by": "minimax"},
]

_MODEL_CACHE_TTL_SECONDS = 3600  # 1 hour
_model_cache: Optional[list[dict]] = None
_model_cache_time: float = 0


async def _fetch_openrouter_models() -> list[dict]:
    """Fetch all available models from OpenRouter and format as OpenAI-style model list."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://openrouter.ai/api/v1/models")
            resp.raise_for_status()
            data = resp.json()
            models = []
            for m in data.get("data", []):
                mid = m.get("id", "")
                if not mid:
                    continue
                # Determine owner from model ID prefix
                owner = mid.split("/")[0] if "/" in mid else "unknown"
                models.append({"id": mid, "object": "model", "owned_by": owner})
            return models
    except Exception as e:
        print(f"[bridge] OpenRouter model fetch failed: {e}", file=sys.stderr)
        return []


async def _get_agent_models() -> list[dict]:
    """Return the model list, fetching from OpenRouter if cache is stale."""
    global _model_cache, _model_cache_time
    now = time.time()
    if _model_cache is not None and (now - _model_cache_time) < _MODEL_CACHE_TTL_SECONDS:
        return _model_cache

    openrouter_models = await _fetch_openrouter_models()
    if openrouter_models:
        # Merge: OpenRouter models + always-include MiniMax models
        model_ids = {m["id"] for m in openrouter_models}
        for mm in _MINIMAX_MODELS:
            if mm["id"] not in model_ids:
                openrouter_models.append(mm)
        _model_cache = openrouter_models
        _model_cache_time = now
        print(f"[bridge] Loaded {len(openrouter_models)} models from OpenRouter", file=sys.stderr)
        return _model_cache

    # Fallback to hardcoded list
    _model_cache = list(_FALLBACK_AGENT_MODELS)
    _model_cache_time = now
    print(f"[bridge] Using fallback model list ({len(_model_cache)} models)", file=sys.stderr)
    return _model_cache

app = FastAPI(title="Hermes Bridge", lifespan=_bridge_lifespan)


# --- Error envelope (spec Phase 1.4) ------------------------------------------------
# Every error leaving the bridge is {"error": {code, message, retryable, details?}}
# with a closed code enum, so the UI switches on `code` instead of pattern-matching
# message strings. Defined in bridge_errors.py, which also owns the enum; the
# Python and TypeScript enums are kept in sync by a contract test.

from bridge_errors import (  # noqa: E402
    BRIDGE_AUTH,
    BRIDGE_STARTING,
    BRIDGE_UNREACHABLE,
    INTERNAL,
    PROVIDER_ERROR,
    UPSTREAM_TIMEOUT,
    VALIDATION,
    BridgeError,
    HermesErrorEnvelope,
)


@app.exception_handler(BridgeError)
async def _handle_bridge_error(request: Request, exc: BridgeError):
    """Emit a BridgeError's own envelope, verbatim."""
    return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())


@app.exception_handler(HTTPException)
async def _handle_http_exception(request: Request, exc: HTTPException):
    """Map FastAPI's HTTPException onto the same envelope.

    FastAPI raises this for 404s and validation failures, which would otherwise
    reach the client as {"detail": ...} — a second, incompatible error shape.
    """
    # Map the status onto a code. A 401/403 is an auth failure; a 4xx that is not
    # 401/403/404 is a client-side validation problem.
    if exc.status_code in (401, 403):
        code, retryable = BRIDGE_AUTH, False
    elif exc.status_code == 404:
        code, retryable = VALIDATION, False
    elif exc.status_code == 503:
        code, retryable = BRIDGE_STARTING, True
    elif exc.status_code == 504:
        code, retryable = UPSTREAM_TIMEOUT, True
    elif 400 <= exc.status_code < 500:
        code, retryable = VALIDATION, False
    else:
        code, retryable = (INTERNAL if exc.status_code >= 500 else PROVIDER_ERROR), (
            exc.status_code >= 500
        )
    detail = exc.detail
    message = detail if isinstance(detail, str) else str(detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": code, "message": message, "retryable": retryable}},
    )


@app.exception_handler(Exception)
async def _handle_unexpected_error(request: Request, exc: Exception):
    """Last resort: never leak a traceback or a bare {"detail"} to the client.

    Registered as a catch-all so an unexpected failure still produces a
    contract-shaped envelope. The traceback goes to the log, not the wire.
    """
    import traceback

    print(f"[hermes-bridge] unhandled error: {exc!r}", file=sys.stderr)
    traceback.print_exc()
    envelope = BridgeError(INTERNAL, "The bridge hit an unexpected error.", retryable=False)
    return JSONResponse(status_code=500, content=envelope.to_envelope())


# Codes the bridge itself raises for transport-level conditions, re-exported so
# callers (and tests) do not have to reach into bridge_errors for the common ones.
BRIDGE_ERROR_CODES = frozenset({
    BRIDGE_UNREACHABLE, BRIDGE_STARTING, BRIDGE_AUTH,
    UPSTREAM_TIMEOUT, PROVIDER_ERROR, VALIDATION, INTERNAL,
})

# Origins the app UI may load from. The renderer talks to the bridge only via the
# Express proxy (server-side fetch, no Origin header); browsers from any other
# origin are rejected in the token guard below so webpages cannot drive the
# bridge's privileged endpoints (chat, approvals, workspace writes) via CSRF.
_BRIDGE_ALLOWED_ORIGINS = frozenset(
    {
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    }
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(_BRIDGE_ALLOWED_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def bridge_token_guard(request: Request, call_next):
    """When HERMES_BRIDGE_TOKEN is set, require it for non-loopback clients.

    Loopback (Electron, local Express proxy) stays open so chat can keep using
    Authorization for provider API keys. /health and /diag stay exempt so
    ownership probes and health polls work before auth is wired.
    """
    origin = request.headers.get("origin")
    if origin is not None and origin not in _BRIDGE_ALLOWED_ORIGINS:
        return JSONResponse(status_code=403, content={"error": "Forbidden origin"})
    if not HERMES_BRIDGE_TOKEN:
        return await call_next(request)
    if request.url.path in _BRIDGE_AUTH_EXEMPT_PATHS:
        return await call_next(request)
    client_host = request.client.host if request.client else None
    if _is_loopback_host(client_host):
        return await call_next(request)
    if not _bridge_token_matches(_extract_bridge_token(request)):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})
    return await call_next(request)


@app.get("/diag")
async def diag(request: Request):
    # Only expose the launch token to loopback callers (Electron ownership check).
    # Non-loopback clients get a boolean presence flag only.
    payload = {
        "pid": os.getpid(),
        "home": os.path.expanduser("~"),
        "bridge_version": HERMES_BRIDGE_VERSION,
        "launch_token_present": bool(HERMES_BRIDGE_TOKEN),
    }
    client_host = request.client.host if request.client else None
    if _is_loopback_host(client_host):
        payload["token"] = HERMES_BRIDGE_TOKEN
    return payload


def _provider_has_native_credentials(pid: str) -> bool:
    """Whether a provider has its own credentials (excludes OpenClaw gateway token).

    The gateway token can talk to the local OpenClaw gateway, but it is not an
    OpenRouter/Anthropic/etc. key. Callers that demote or advertise provider-
    specific auth must use this rather than `_provider_has_credentials`.
    """
    if pid == "cursor-composer":
        try:
            from cursor_composer_bridge import probe_bridge_health

            if probe_bridge_health().get("reachable"):
                return True
        except Exception:
            pass

    pcfg = _PROVIDER_CONFIG.get(pid, {})
    env_var = pcfg.get("env_var", "")
    auth_provider = pcfg.get("auth_json_provider", pid)
    return bool(
        (env_var and os.environ.get(env_var))
        or _get_credential_pool_key(auth_provider)
        or (pid == "nous" and _get_nous_agent_key())
        or (pid == "openrouter" and _get_openrouter_key_from_hermes_creds())
    )


def _provider_has_credentials(pid: str) -> bool:
    """Whether a configured bridge provider has usable credentials.

    Mirrors the exact credential logic the /health endpoint reports.
    Includes the local OpenClaw gateway token as a last-resort "can serve
    something" signal for generic provider_credentials maps.
    """
    return _provider_has_native_credentials(pid) or bool(_get_local_gateway_key())


def _default_model_credentialed(hermes_home: Optional[Path] = None) -> bool:
    """Whether the agent's configured default model can actually be served.

    `provider_credentials` only covers _PROVIDER_CONFIG, so a default model
    routed through a config.yaml custom base_url — e.g. deepseek-v4-pro via
    opencode-go, which is not a _PROVIDER_CONFIG entry — is invisible there.
    This mirrors the chat route's credential resolution for the configured
    model so /health doesn't under-report what the bridge can serve.

    Profile-aware when `hermes_home` is passed (active profile home).
    Custom base_url endpoints require a real endpoint key — gateway alone
    does not count.
    """
    cfg = _load_cli_model_config(hermes_home)
    if (cfg.get("api_key") or "").strip():
        return True
    if _cli_config_is_custom(cfg):
        return _cli_custom_endpoint_credentialed(cfg, hermes_home)
    provider = (cfg.get("provider") or "").strip().lower()
    if provider in _PROVIDER_CONFIG and _provider_has_native_credentials(provider):
        return True
    if provider and _get_credential_pool_key(provider):
        return True
    return bool(_get_local_gateway_key())


def _provider_ids_for_chat_routing(profile_home: Optional[Path] = None) -> set[str]:
    """Provider ids a chat request may legitimately pin via x-hermes-provider.

    Mirrors what /v1/providers exposes: the built-in _PROVIDER_CONFIG ids, the
    synthetic CLI custom endpoint id (custom:<host> / custom:<name>), and the
    MoA virtual provider. A pin outside this set is stale UI state (the CLI
    config moved on) and must be dropped rather than forwarded to routing —
    forwarding it makes the real agent resolve an unknown custom endpoint and
    400 at OpenRouter with "<host>:<model> is not a valid model ID".
    """
    ids = set(_PROVIDER_CONFIG.keys())
    ids.add(MOA_PROVIDER_ID)
    cfg = _load_cli_model_config(profile_home)
    if _cli_config_is_custom(cfg):
        ids.add(_synthetic_cli_provider_id(cfg))
    return ids


@app.get("/health")
async def health(request: Request):
    # Profile-aware: honor X-Hermes-Profile like /v1/providers and chat do so
    # detectHermesBridge.hasAnyCreds matches the active profile's config.yaml.
    profile_name = _resolve_profile_name(request)
    profile_home = _resolve_hermes_home(profile_name)
    cfg = _load_cli_model_config(profile_home)

    # Check credential availability for all configured providers
    provider_credentials: dict[str, bool] = {}
    for pid in _PROVIDER_CONFIG:
        provider_credentials[pid] = _provider_has_credentials(pid)

    cursor_composer = _cursor_composer_integration_status(hermes_home=profile_home)

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
        "launch_token_present": bool(HERMES_BRIDGE_TOKEN),
        "brain_initialized": brain_client._brain_initialized,
        "active_requests": _bridge_active_requests,
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


@app.get("/v1/models")
async def list_models():
    models = await _get_agent_models()
    return {"object": "list", "data": models}


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
    except Exception:
        pass
    return {"excluded": excluded, "disabled": disabled}


@app.get("/v1/providers")
async def list_providers(request: Request):
    """List configured providers with credential status and known models.

    Profile-aware: honors `X-Hermes-Profile` (like chat requests do) so the
    reported default model/provider reflects the active profile's config.yaml,
    falling back to the global ~/.hermes config for unset values.

    When `hermes model` selected a custom base_url (provider: custom / opencode /
    bullinf / etc.), that endpoint is exposed as a synthetic credentialed row and
    becomes default_provider — never silently rewritten to openrouter.
    """
    profile_home = _resolve_hermes_home(_resolve_profile_name(request))
    profile_cfg = _load_cli_model_config(profile_home)
    global_cfg = _load_cli_model_config()
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
    profile_moa_config = _load_moa_config(profile_home)
    global_moa_config = _load_moa_config()
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
            models = _models_for_provider(pid)
        except Exception:
            models = []
        data.append({
            "id": pid,
            "name": cfg["name"],
            "base_url": cfg["base_url"],
            "is_aggregator": pid == "openrouter",
            "credentialed": _provider_has_credentials(pid),
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


@app.get("/moa")
async def get_moa_config(request: Request):
    """Return normalized Mixture-of-Agents presets for the active profile."""
    profile_home = _resolve_hermes_home(_resolve_profile_name(request))
    profile_cfg = _load_moa_config(profile_home)
    # Fall back to global home when the profile has no presets yet
    if not _enabled_moa_preset_names(profile_cfg):
        profile_cfg = _load_moa_config()
    return {
        "object": "moa.config",
        "default_preset": profile_cfg.get("default_preset") or "default",
        "presets": profile_cfg.get("presets") or {},
        "preset_names": _enabled_moa_preset_names(profile_cfg),
    }


@app.put("/moa")
async def put_moa_config(request: Request):
    """Create/update MoA presets in the active profile's config.yaml."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})

    profile_home = _resolve_hermes_home(_resolve_profile_name(request))
    try:
        saved = _save_moa_config(body, hermes_home=profile_home)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except Exception as exc:
        print(f"[hermes-bridge] Failed to save MoA config: {exc}", flush=True)
        return JSONResponse(status_code=500, content={"error": f"Failed to save MoA config: {exc}"})

    return {
        "object": "moa.config",
        "default_preset": saved.get("default_preset") or "default",
        "presets": saved.get("presets") or {},
        "preset_names": _enabled_moa_preset_names(saved),
    }


# ─── Hermes ops (fallback, checkpoints, memory, curator, …) ─────────────────

def _ops_home(request: Request) -> Path:
    return Path(_resolve_hermes_home(_resolve_profile_name(request)))


async def _ops_thread(fn, /, *args, **kwargs):
    """Run sync hermes_ops / CLI work off the event loop so chat stays responsive."""
    return await asyncio.to_thread(fn, *args, **kwargs)


@app.get("/fallback")
async def get_fallback(request: Request):
    import hermes_ops
    home = _ops_home(request)
    cfg = _read_hermes_config(home)
    return {
        "object": "fallback.chain",
        "providers": hermes_ops.get_fallback_providers(cfg),
    }


@app.put("/fallback")
async def put_fallback(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    chain = body.get("providers") if isinstance(body, dict) else None
    if not isinstance(chain, list):
        return JSONResponse(status_code=400, content={"error": "providers must be a list"})
    home = _ops_home(request)
    dump, data = _load_hermes_config_editable(home)
    try:
        saved = hermes_ops.set_fallback_providers(data, chain)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    dump()
    return {"object": "fallback.chain", "providers": saved}


@app.get("/delegation/live/latest")
async def get_delegation_live_latest(request: Request):
    """Return the most recently started Hermes live-transcript manifest."""
    home = _ops_home(request)
    try:
        limit = int(request.query_params.get("limit", "1"))
    except (TypeError, ValueError):
        limit = 1
    if limit <= 1:
        manifest = await _ops_thread(delegation_live.latest_manifest, home)
        if not manifest:
            return JSONResponse(status_code=404, content={"error": "no live delegations"})
        return {"object": "delegation.live.manifest", **manifest}
    manifests = await _ops_thread(delegation_live.list_recent_manifests, home, limit=limit)
    return {"object": "list", "data": manifests}


@app.get("/delegation/live/{delegation_id}")
async def get_delegation_live_manifest(delegation_id: str, request: Request):
    """Read Hermes cache/delegation/live/<id>/manifest.json."""
    home = _ops_home(request)
    try:
        manifest = await _ops_thread(delegation_live.read_manifest, home, delegation_id)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except FileNotFoundError as exc:
        return JSONResponse(status_code=404, content={"error": str(exc)})
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": f"manifest read failed: {exc}"})
    return {"object": "delegation.live.manifest", **manifest}


@app.get("/delegation/live/{delegation_id}/task/{task_index}")
async def get_delegation_live_task_log(delegation_id: str, task_index: int, request: Request):
    """Tail an append-only subagent live transcript log by byte offset."""
    home = _ops_home(request)
    try:
        offset = int(request.query_params.get("offset", "0"))
    except (TypeError, ValueError):
        offset = 0
    try:
        payload = await _ops_thread(
            delegation_live.tail_task_log,
            home,
            delegation_id,
            task_index,
            offset=offset,
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except FileNotFoundError as exc:
        return JSONResponse(status_code=404, content={"error": str(exc)})
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": f"log read failed: {exc}"})
    return {"object": "delegation.live.tail", **payload}


@app.get("/checkpoints")
async def get_checkpoints(request: Request):
    import hermes_ops
    workdir = request.query_params.get("workdir")
    return await _ops_thread(
        hermes_ops.get_checkpoints_status, _ops_home(request), workdir=workdir
    )


@app.post("/checkpoints/prune")
async def post_checkpoints_prune(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.prune_checkpoints, _ops_home(request))


@app.post("/checkpoints/restore")
async def post_checkpoints_restore(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "body must be an object"})
    index = body.get("index")
    if index is None:
        return JSONResponse(status_code=400, content={"error": "index is required"})
    workdir = body.get("workdir")
    try:
        result = await _ops_thread(
            hermes_ops.restore_checkpoint,
            index,
            workdir=str(workdir).strip() if workdir else None,
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    status = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status, content=result)


@app.get("/memory/status")
async def get_memory_status(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_memory_status, _ops_home(request))


@app.get("/curator/status")
async def get_curator_status(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_curator_status, _ops_home(request))


@app.post("/curator/run")
async def post_curator_run(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.run_curator, _ops_home(request))


@app.get("/computer-use/status")
async def get_computer_use_status(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_computer_use_status, _ops_home(request))


@app.get("/bundles")
async def get_bundles(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.list_skill_bundles, _ops_home(request))


@app.get("/bundles/{name}")
async def get_bundle_detail(request: Request, name: str):
    import hermes_ops
    try:
        result = hermes_ops.show_skill_bundle(name, hermes_home=_ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    if not result.get("ok"):
        return JSONResponse(status_code=404, content=result)
    return result


@app.post("/bundles/create")
async def post_bundles_create(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    name = str(body.get("name") or "").strip()
    skills_raw = body.get("skills") or body.get("skill_ids") or []
    skills = skills_raw if isinstance(skills_raw, list) else [skills_raw]
    try:
        return hermes_ops.create_skill_bundle(
            name,
            [str(s) for s in skills],
            description=body.get("description"),
            instruction=body.get("instruction"),
            force=bool(body.get("force")),
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.post("/bundles/delete")
async def post_bundles_delete(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        body = {}
    name = str((body or {}).get("name") or "").strip()
    try:
        return hermes_ops.delete_skill_bundle(name, hermes_home=_ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.post("/bundles/reload")
async def post_bundles_reload(request: Request):
    import hermes_ops
    return hermes_ops.reload_skill_bundles(_ops_home(request))


@app.get("/dashboard/url")
async def get_dashboard_url():
    import hermes_ops
    return hermes_ops.get_dashboard_url()


@app.get("/goals")
async def get_goals(request: Request):
    import hermes_ops
    home = _ops_home(request)
    cfg = _read_hermes_config(home)
    return {"object": "goals.config", **hermes_ops.get_goals_config(cfg)}


@app.put("/goals")
async def put_goals(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    home = _ops_home(request)
    dump, data = _load_hermes_config_editable(home)
    try:
        saved = hermes_ops.set_goals_config(data, body)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    dump()
    return {"object": "goals.config", **saved}


@app.get("/tool-search")
async def get_tool_search(request: Request):
    import hermes_ops
    home = _ops_home(request)
    cfg = _read_hermes_config(home)
    return {"object": "tool_search.config", **hermes_ops.get_tool_search_config(cfg)}


@app.put("/tool-search")
async def put_tool_search(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    home = _ops_home(request)
    dump, data = _load_hermes_config_editable(home)
    try:
        saved = hermes_ops.set_tool_search_config(data, body)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    dump()
    return {"object": "tool_search.config", **saved}


@app.get("/insights")
async def get_insights(request: Request):
    import hermes_ops
    days_raw = request.query_params.get("days", "7")
    try:
        days = int(days_raw)
    except (TypeError, ValueError):
        days = 7
    return await _ops_thread(
        hermes_ops.get_insights, days=days, hermes_home=_ops_home(request)
    )


@app.get("/journey")
async def get_journey(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_journey_graph, _ops_home(request))


@app.post("/computer-use/install")
async def post_computer_use_install(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.install_computer_use, _ops_home(request))


@app.get("/computer-use/doctor")
async def get_computer_use_doctor(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.doctor_computer_use, _ops_home(request))


@app.get("/pets")
async def get_pets(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_pets_status, _ops_home(request))


@app.get("/pets/gallery")
async def get_pets_gallery(request: Request):
    import hermes_ops
    limit_raw = request.query_params.get("limit", "40")
    try:
        limit = int(limit_raw)
    except (TypeError, ValueError):
        limit = 40
    return await _ops_thread(
        hermes_ops.list_pets_gallery, limit=limit, hermes_home=_ops_home(request)
    )


@app.post("/pets/select")
async def post_pets_select(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        body = {}
    pet_id = (body or {}).get("pet_id") or (body or {}).get("id") or ""
    try:
        return hermes_ops.select_pet(str(pet_id), hermes_home=_ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.post("/claw/migrate")
async def post_claw_migrate(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        body = {}
    dry_run = True if not isinstance(body, dict) else body.get("dry_run", True) is not False
    migrate_secrets = bool(body.get("migrate_secrets")) if isinstance(body, dict) else False
    yes = bool(body.get("yes")) if isinstance(body, dict) else False
    # Force dry_run unless explicitly applying with yes=true
    if not dry_run and not yes:
        return JSONResponse(
            status_code=400,
            content={"error": "Applying migration requires dry_run=false and yes=true"},
        )
    return hermes_ops.claw_migrate(
        dry_run=dry_run,
        migrate_secrets=migrate_secrets,
        yes=yes,
        hermes_home=_ops_home(request),
    )


@app.get("/auth/pool")
async def get_auth_pool(request: Request):
    import hermes_ops
    return hermes_ops.list_auth_pool(_ops_home(request))


@app.get("/auth/pool/{provider}/status")
async def get_auth_pool_provider_status(request: Request, provider: str):
    import hermes_ops
    try:
        return hermes_ops.get_auth_provider_status(provider, hermes_home=_ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.post("/auth/pool/reset")
async def post_auth_pool_reset(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict) or not body.get("provider"):
        return JSONResponse(status_code=400, content={"error": "provider is required"})
    try:
        return hermes_ops.reset_auth_pool_provider(
            str(body["provider"]),
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.post("/auth/pool/remove")
async def post_auth_pool_remove(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "body must be an object"})
    provider = body.get("provider")
    target = body.get("target") or body.get("index") or body.get("id")
    if not provider or target is None:
        return JSONResponse(
            status_code=400,
            content={"error": "provider and target (index, id, or label) are required"},
        )
    try:
        result = hermes_ops.remove_auth_pool_credential(
            str(provider),
            str(target),
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    status = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status, content=result)


@app.post("/auth/pool/add")
async def post_auth_pool_add(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "body must be an object"})
    provider = body.get("provider")
    api_key = body.get("api_key")
    if not provider or not api_key:
        return JSONResponse(
            status_code=400,
            content={"error": "provider and api_key are required"},
        )
    try:
        result = hermes_ops.add_auth_api_key(
            str(provider),
            str(api_key),
            label=body.get("label"),
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    status = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status, content=result)


@app.get("/portal/info")
async def get_portal_info_route(request: Request):
    import hermes_ops
    return hermes_ops.get_portal_info(_ops_home(request))


@app.get("/portal/status")
async def get_portal_status_route(request: Request):
    import hermes_ops
    return hermes_ops.get_portal_status(_ops_home(request))


@app.get("/portal/tools")
async def get_portal_tools_route(request: Request):
    import hermes_ops
    return hermes_ops.list_portal_tools(_ops_home(request))


@app.get("/portal/open-url")
async def get_portal_open_url_route(request: Request):
    import hermes_ops
    return hermes_ops.get_portal_open_url(_ops_home(request))


@app.get("/portal/open")
async def get_portal_open_route(request: Request):
    """Non-interactive browser launch via `hermes portal open` (subscription page)."""
    import hermes_ops
    return hermes_ops.open_portal_subscription(_ops_home(request))


@app.post("/portal/oauth/start")
async def portal_oauth_start_route(request: Request):
    """Start Nous Portal device-code OAuth (returns user_code + verification URL only)."""
    import hermes_ops
    result = hermes_ops.portal_oauth_start(_ops_home(request))
    status = 200 if result.get("ok") else 503
    return JSONResponse(status_code=status, content=result)


@app.get("/portal/oauth/poll/{session_id}")
async def portal_oauth_poll_route(session_id: str, request: Request):
    """Poll Nous Portal device-code OAuth session (masked status only)."""
    import hermes_ops
    try:
        result = hermes_ops.portal_oauth_poll(session_id, _ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    if result.get("status") == "not_found":
        return JSONResponse(status_code=404, content=result)
    return result


@app.get("/gateway/capabilities")
async def get_gateway_capabilities(request: Request):
    import hermes_ops
    base = (
        request.query_params.get("base_url")
        or os.environ.get("HERMES_API_BASE")
        or "http://127.0.0.1:8642"
    )
    try:
        hermes_ops.assert_safe_gateway_base_url(base)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return await _ops_thread(hermes_ops.probe_gateway_capabilities, base_url=base)


@app.post("/v1/runs/cancel")
async def cancel_gateway_run(request: Request):
    """Stop the active gateway /v1/runs job for a conversation (Spark Stop button)."""
    import hermes_runs as _hermes_runs

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    conversation_id = str(body.get("conversation_id") or "").strip()
    if not conversation_id:
        return JSONResponse(status_code=400, content={"error": "conversation_id is required"})
    cancelled = _hermes_runs.cancel_active_run(conversation_id)
    return JSONResponse(status_code=200, content={"cancelled": cancelled})


@app.post("/v1/runs/approve")
async def approve_gateway_run(request: Request):
    """Resolve a pending gateway run approval (/approve command on runs path)."""
    import hermes_runs as _hermes_runs

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    conversation_id = str(body.get("conversation_id") or "").strip()
    if not conversation_id:
        return JSONResponse(status_code=400, content={"error": "conversation_id is required"})
    choice = str(body.get("choice") or "approve").strip().lower() or "approve"
    resolve_all = bool(body.get("all") or body.get("resolve_all"))
    approved, status_code = _hermes_runs.approve_active_run(
        conversation_id,
        choice=choice,
        resolve_all=resolve_all,
    )
    if not approved:
        return JSONResponse(status_code=404, content={"approved": False, "error": "No active gateway run"})
    return JSONResponse(status_code=200, content={"approved": True, "status": status_code})


@app.post("/kanban/swarm")
async def post_kanban_swarm(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    goal = str(body.get("goal") or "").strip()
    workers = body.get("workers")
    if workers is not None and not isinstance(workers, list):
        workers = None
    try:
        return hermes_ops.kanban_swarm_create(
            goal,
            workers=workers,
            verifier=str(body.get("verifier") or "reviewer"),
            synthesizer=str(body.get("synthesizer") or "writer"),
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.get("/projects")
async def get_projects(request: Request):
    import hermes_ops
    include_archived = request.query_params.get("all", "").lower() in ("1", "true", "yes")
    return hermes_ops.list_projects(
        hermes_home=_ops_home(request),
        include_archived=include_archived,
    )


@app.post("/projects")
async def post_projects_create(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    name = str(body.get("name") or "").strip()
    primary = body.get("primary_folder") or body.get("primary") or body.get("path")
    use = body.get("use", True) is not False
    try:
        return hermes_ops.create_project(
            name,
            primary_folder=str(primary).strip() if primary else None,
            use=use,
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.post("/projects/use")
async def post_projects_use(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        body = {}
    project = None
    if isinstance(body, dict):
        raw = body.get("project") or body.get("slug") or body.get("id")
        if raw is not None and str(raw).strip():
            project = str(raw).strip()
    try:
        return hermes_ops.use_project(project, hermes_home=_ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.post("/projects/bind-board")
async def post_projects_bind_board(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    project = str(body.get("project") or body.get("slug") or "").strip()
    board = body.get("board") or body.get("board_slug")
    try:
        return hermes_ops.bind_board(
            project,
            str(board).strip() if board is not None else None,
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.get("/security/audit")
async def get_security_audit(request: Request):
    import hermes_ops
    skip_venv = request.query_params.get("skip_venv", "").lower() in ("1", "true", "yes")
    return await _ops_thread(
        hermes_ops.run_security_audit, _ops_home(request), skip_venv=skip_venv
    )


@app.get("/secrets/status")
async def get_secrets_status(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_secrets_status, _ops_home(request))


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = DEFAULT_MODEL
    messages: list[ChatMessage] = Field(default_factory=list)
    temperature: float = 0.7
    top_p: float = 0.9
    max_tokens: int = 16384
    stream: bool = True
    # Accept and ignore extra fields from AI SDK
    model_config = {"extra": "allow"}


def sse_chunk(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _find_moa_shortcut(messages: list[dict]) -> Optional[tuple[int, str]]:
    for idx in range(len(messages) - 1, -1, -1):
        message = messages[idx]
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if not isinstance(content, str):
            continue
        stripped = content.strip()
        if stripped == "/moa":
            return idx, ""
        if stripped.startswith("/moa "):
            return idx, stripped[5:].strip()
        # Keep scanning older user messages — a later non-/moa turn must not
        # cancel an earlier /moa shortcut in the same request payload.
        continue
    return None


def _single_message_sse(model: str, text: str) -> StreamingResponse:
    chunk_id = f"chatcmpl-hermes-{os.urandom(8).hex()}"

    async def stream():
        yield sse_chunk(make_delta_chunk(chunk_id, model, {"role": "assistant"}))
        yield sse_chunk(make_delta_chunk(chunk_id, model, {"content": text}))
        yield sse_chunk(make_delta_chunk(chunk_id, model, {}, finish_reason="stop"))
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


# Friendly display names for tool activity in the chat stream
_TOOL_DISPLAY_NAMES: dict[str, str] = {
    "web_search": "Searching the web",
    "browse_url": "Reading webpage",
    "run_command": "Running command",
    "read_file": "Reading file",
    "write_file": "Writing file",
    "execute_python": "Running Python",
    "list_user_repos": "Listing repositories",
    "read_repo_file": "Reading file",
    "edit_repo_file": "Editing file",
    "create_repo_file": "Creating file",
    "delete_repo_file": "Deleting file",
    "batch_edit_repo_files": "Editing files",
    "computer_use": "Computer use",
    "computer": "Computer use",
    "git_log": "Viewing commit history",
    "git_show": "Showing commit",
    "git_diff": "Comparing refs",
}

# Tools that modify repository state — brain_claim protection applied in on_tool_start/end
REPO_EDIT_TOOL_NAMES = frozenset({
    "edit_repo_file",
    "create_repo_file",
    "delete_repo_file",
    "batch_edit_repo_files",
})


def _get_stream_chunk_size(text: str) -> int:
    """Use larger chunks for bulky payloads to avoid SSE event floods."""
    if len(text) > 4000:
        return 1024
    if len(text) > 1000:
        return 256
    return 20


def _format_tool_start_text(tool_name: str, tool_input: str) -> str:
    """Format a tool_start event as a concise markdown indicator.

    Instead of dumping raw JSON args (which can contain entire file contents),
    extract only the meaningful summary — e.g. the file path or search query.
    """
    # MoA events already stream full advisor text via tool_activity; keep chat
    # chrome to a single dense line so the transcript stays readable.
    if tool_name == "moa.reference":
        try:
            args = json.loads(tool_input) if tool_input else {}
        except (json.JSONDecodeError, TypeError):
            args = {}
        label = str(args.get("label") or "advisor")
        idx = args.get("index")
        count = args.get("count")
        progress = ""
        if idx is not None and count is not None:
            try:
                progress = f" ({int(idx) + 1}/{int(count)})"
            except (TypeError, ValueError):
                progress = ""
        return f"\n\n> **MoA advisor** — `{label}`{progress}\n\n"
    if tool_name == "moa.aggregating":
        try:
            args = json.loads(tool_input) if tool_input else {}
        except (json.JSONDecodeError, TypeError):
            args = {}
        aggregator = str(args.get("aggregator") or "aggregator")
        return f"\n\n> **MoA aggregating** — `{aggregator}`\n\n"

    display = _TOOL_DISPLAY_NAMES.get(tool_name, tool_name)
    summary = ""
    try:
        args = json.loads(tool_input) if tool_input else {}
    except (json.JSONDecodeError, TypeError):
        args = {}

    if tool_name in ("read_repo_file", "edit_repo_file", "create_repo_file",
                      "delete_repo_file", "read_file", "write_file"):
        path = args.get("path", "")
        if path:
            summary = f"`{path}`"
    elif tool_name == "batch_edit_repo_files":
        changes = args.get("changes", [])
        if isinstance(changes, list) and changes:
            paths = [c.get("path", "?") for c in changes[:5] if isinstance(c, dict)]
            summary = ", ".join(f"`{p}`" for p in paths)
            if len(changes) > 5:
                summary += f" +{len(changes) - 5} more"
    elif tool_name == "web_search":
        query = args.get("query", "")
        if query:
            summary = f'"{query}"'
    elif tool_name == "browse_url":
        url = args.get("url", "")
        if url:
            summary = f"`{url[:80]}{'…' if len(url) > 80 else ''}`"
    elif tool_name == "run_command":
        cmd = args.get("command", "")
        if cmd:
            summary = f"`{cmd[:80]}{'…' if len(cmd) > 80 else ''}`"
    elif tool_name == "execute_python":
        code = args.get("code", "")
        first_line = code.split("\n")[0][:60] if code else ""
        if first_line:
            summary = f"`{first_line}{'…' if len(code) > 60 else ''}`"
    elif tool_name in ("computer_use", "computer"):
        try:
            from computer_use_frames import format_computer_use_action_label

            label = format_computer_use_action_label(args)
            if label:
                summary = label
        except Exception:
            action = args.get("action", "")
            if action:
                summary = str(action)

    if summary:
        return f"\n\n> **{display}** — {summary}\n\n"
    return f"\n\n> **{display}**\n\n"


def _format_tool_end_text(tool_name: str, tool_output: str) -> str:
    """Format a tool_end event as a brief completion note.

    Only shows a short, meaningful summary — never raw file contents.
    """
    # Full advisor text lives in tool_activity — don't reprint it in the chat.
    if tool_name == "moa.reference":
        return "> *Advisor ready*\n\n"
    if tool_name == "moa.aggregating":
        return "> *Aggregating…*\n\n"

    display = _TOOL_DISPLAY_NAMES.get(tool_name, tool_name)
    normalized_output = (tool_output or "").strip()

    if normalized_output.lower().startswith(("error:", "failed:")):
        preview = normalized_output.split("\n", 1)[0][:120]
        return f"> *Failed:* `{preview}`\n\n"

    if tool_name in ("read_repo_file", "read_file"):
        char_count = len(tool_output) if tool_output else 0
        return f"> *Done — read {char_count:,} chars*\n\n"
    if tool_name in ("write_file",):
        return f"> *Done — {tool_output[:100]}*\n\n"
    if tool_name == "web_search":
        # Count results (JSON array)
        try:
            results = json.loads(tool_output) if tool_output else []
            count = len(results) if isinstance(results, list) else 0
            return f"> *Found {count} result{'s' if count != 1 else ''}*\n\n"
        except (json.JSONDecodeError, TypeError):
            return f"> *Search complete*\n\n"
    if tool_name == "browse_url":
        char_count = len(tool_output) if tool_output else 0
        return f"> *Fetched {char_count:,} chars*\n\n"
    if tool_name in ("run_command", "execute_python"):
        # Show a short preview of output
        preview = (tool_output or "").strip().split("\n")[0][:120]
        if preview:
            return f"> *Done:* `{preview}`\n\n"
        return f"> *Done (no output)*\n\n"

    if tool_name == "todo":
        try:
            payload = json.loads(tool_output) if tool_output else {}
            cli_text = payload.get("cli", "")
            if cli_text:
                return f"\n\n```\n{cli_text}\n```\n\n"
            summary = payload.get("summary", {})
            total = summary.get("total", 0)
            if total == 0:
                return "> *No tasks*\n\n"
            return f"> *{total} tasks*\n\n"
        except (json.JSONDecodeError, TypeError):
            return "> *todo — done*\n\n"

    # Fallback: just say it's done
    return f"> *{display} — done*\n\n"


def make_delta_chunk(chunk_id: str, model: str, delta: dict, finish_reason: Optional[str] = None) -> dict:
    chunk: dict = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }],
    }
    # Include usage in the final chunk so the AI SDK's OpenAI-compatible
    # parser recognises this as a proper completion and maps finish_reason
    # to finishReason instead of defaulting to 'unknown'.
    if finish_reason is not None:
        chunk["usage"] = usage_event(0, 0, 0)
    return chunk


def _build_passthrough_payload(body: ChatCompletionRequest) -> dict:
    payload = body.model_dump()
    payload.update(body.model_extra or {})
    return payload


def _passthrough_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://cloud-chat-hub.local",
        "X-Title": "Hermes Agent",
    }


def _passthrough_error_response(status_code: int, response_body: bytes) -> JSONResponse:
    if not response_body:
        return JSONResponse(status_code=status_code, content={"error": {"message": "Upstream provider error"}})
    try:
        return JSONResponse(status_code=status_code, content=json.loads(response_body.decode("utf-8")))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(
            status_code=status_code,
            content={"error": {"message": response_body.decode("utf-8", errors="replace")}},
        )


async def _passthrough_chat_completions(
    body: ChatCompletionRequest,
    api_key: str,
    *,
    base_url: str = "https://openrouter.ai/api/v1",
    finalize_request=None,
):
    payload = _build_passthrough_payload(body)
    request_headers = _passthrough_headers(api_key)
    client = httpx.AsyncClient(timeout=PASSTHROUGH_TIMEOUT_SECONDS)

    async def _finalize(success: bool):
        if finalize_request is None:
            return
        try:
            finalize_request(success)
        except Exception:
            pass

    async def _close_client():
        close = getattr(client, "aclose", None)
        if close is None:
            return
        maybe_awaitable = close()
        if asyncio.iscoroutine(maybe_awaitable):
            await maybe_awaitable

    try:
        upstream_url = f"{base_url.rstrip('/')}/chat/completions"
        request = client.build_request(
            "POST",
            upstream_url,
            headers=request_headers,
            json=payload,
        )
        upstream = await client.send(request, stream=bool(payload.get("stream", True)))
        if upstream.status_code >= 400:
            error_body = await upstream.aread()
            await upstream.aclose()
            await _close_client()
            if "minimax" in body.model.lower():
                _get_circuit("minimax").record_failure()
            elif body.model.startswith(NOUS_MODEL_PREFIX):
                _get_circuit("nous").record_failure()
            else:
                _get_circuit("openrouter").record_failure()
            await _finalize(False)
            return _passthrough_error_response(upstream.status_code, error_body)

        if "minimax" in body.model.lower():
            _get_circuit("minimax").record_success()
        elif body.model.startswith(NOUS_MODEL_PREFIX):
            _get_circuit("nous").record_success()
        else:
            _get_circuit("openrouter").record_success()

        media_type = upstream.headers.get("content-type", "text/event-stream")
        if not payload.get("stream", True) or not media_type.startswith("text/event-stream"):
            response_body = await upstream.aread()
            await upstream.aclose()
            await _close_client()
            await _finalize(True)
            try:
                return JSONResponse(status_code=upstream.status_code, content=json.loads(response_body.decode("utf-8")))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return JSONResponse(
                    status_code=upstream.status_code,
                    content={"error": {"message": response_body.decode("utf-8", errors="replace")}},
                )

        async def stream_bytes():
            success = False
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
                success = True
            finally:
                await upstream.aclose()
                await _close_client()
                await _finalize(success)

        return StreamingResponse(stream_bytes(), media_type=media_type)
    except Exception:
        await _close_client()
        await _finalize(False)
        raise


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, body: ChatCompletionRequest):
    try:
        if hasattr(asyncio, "timeout"):
            async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
                return await _chat_completions_impl(request, body)
        return await asyncio.wait_for(
            _chat_completions_impl(request, body),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={
                "error": {
                    "message": f"Request timed out after {REQUEST_TIMEOUT_SECONDS} seconds. The agent took too long to respond.",
                    "code": "REQUEST_TIMEOUT",
                }
            },
        )
    except Exception as e:
        import traceback as _tb
        tb_str = _tb.format_exc()
        print(f"[hermes-bridge] UNHANDLED ERROR in chat_completions: {e}\n{tb_str}", flush=True)
        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(e), "traceback": tb_str}},
        )


def _resolve_workspace_id(request: Request, body) -> str:
    """Derive a workspace ID from conversation_id (body or header) for per-conversation cache isolation."""
    extra = body.model_extra or {}
    raw = getattr(body, 'conversation_id', None) or extra.get('conversation_id') or request.headers.get('x-hermes-conversation-id', '')
    text = str(raw or '').strip()
    return text or f"sess-{uuid.uuid4().hex[:12]}"


def _set_session_title_if_empty(session_id: str, title: str) -> None:
    """Fill the state.db sessions.title when empty (hermes-desktop way: titled sessions)."""
    if not title or not session_id:
        return
    try:
        profile_name = _read_active_profile_name()
        state_db_path = _state_db_path(_resolve_hermes_home(profile_name))
        if not state_db_path.exists():
            return
        clean = " ".join(title.split())[:80]
        with sqlite3.connect(str(state_db_path)) as conn:
            row = conn.execute("SELECT title FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row and not (row[0] or "").strip():
                conn.execute("UPDATE sessions SET title = ? WHERE id = ?", (clean, session_id))
    except Exception:
        pass  # Best-effort; don't break request handling


def _finalize_tracked_session(
    session_id: str,
    *,
    success: bool,
    error_message: Optional[str] = None,
    persist_stub: bool = True,
) -> None:
    """Mark a chat session completed/error without requiring the nested finalize closure."""
    with _sessions_lock:
        session = _sessions.get(session_id)
        if not session:
            return
        session["status"] = "completed" if success else "error"
        session["messages"] = len(session.get("chat", []))
        session["updated_at"] = _now_iso()
        session["error"] = error_message if error_message else None
        # The real hermes agent owns the state.db row (source=cloudchat, full
        # transcript). Writing the bridge stub here would INSERT OR REPLACE the
        # same id and clobber the real row (and cascade-delete its messages).
        if persist_stub:
            _save_session_to_db(session)
        elif success:
            _set_session_title_if_empty(session_id, session.get("firstUserMessage") or "")


async def _chat_completions_impl(request: Request, body: ChatCompletionRequest):
    toolsets_header = request.headers.get("x-hermes-toolsets", DEFAULT_TOOLSETS)
    enabled_toolsets = [t.strip() for t in toolsets_header.split(",") if t.strip()]
    # Plan mode: mutating tools are stripped before the agent is built (the
    # server sends this in the request extra fields for the streamText path).
    plan_mode = bool((body.model_extra or {}).get("plan_mode"))
    if plan_mode:
        print(f"[hermes-bridge] plan_mode: stripping mutating toolsets from {enabled_toolsets}", flush=True)
    # Wall-clock run budget (seconds) — optional request extra, forwarded to
    # the real AIAgent (agent.run_budget_seconds). 0/absent = unlimited.
    _raw_budget = (body.model_extra or {}).get("run_budget_seconds")
    try:
        run_budget_seconds = max(0, int(_raw_budget)) if _raw_budget else None
    except (TypeError, ValueError):
        run_budget_seconds = None
    execution_mode = request.headers.get("x-hermes-execution-mode", "agent-loop").strip().lower() or "agent-loop"
    request_profile = _resolve_profile_name(request)
    repo_owner = request.headers.get("x-hermes-repo-owner", "")
    repo_name = request.headers.get("x-hermes-repo-name", "")
    github_pat = request.headers.get("x-hermes-github-pat", "")
    repo_edit_intent = request.headers.get("x-hermes-repo-edit-intent", "") == "1"
    repo_root_header = request.headers.get("x-hermes-repo-root", "").strip()
    from worktree_support import (
        worktree_requested,
        maybe_setup_worktree,
        adjust_toolsets_for_worktree,
        cleanup_worktree,
    )

    use_worktree = worktree_requested(request.headers.get("x-hermes-worktree"))
    request_messages = _normalize_chat_messages(body.messages, model=body.model, strip_images=True)

    # Resolve workspace_id from conversation_id (header or body) for per-conversation isolation
    workspace_id = _resolve_workspace_id(request, body)

    # Resolve the agent class early: whether we run the real hermes agent
    # (hermes_adapter) decides if the bridge writes its own stub session row.
    # The real agent creates and owns the state.db session itself.
    AIAgent, _using_real_agent = _resolve_chat_agent_class()

    # Session tracking for Hermes Chats view
    session_id = workspace_id
    last_user_msg = ""
    initial_chat: list[dict] = []
    for m in request_messages:
        role = m["role"]
        content = (m["content"] or "").strip()
        if content:
            initial_chat.append(
                {
                    "role": role,
                    "content": _trim_session_message_content(content),
                }
            )
        if role == "user":
            last_user_msg = content

    created_at = _now_iso()
    with _sessions_lock:
        _sessions[session_id] = {
            "id": session_id,
            "profile": request_profile,
            "model": body.model,
            "status": "active",
            "created_at": created_at,
            "updated_at": created_at,
            "messages": len(initial_chat),
            "toolsets": enabled_toolsets,
            "repo": f"{repo_owner}/{repo_name}" if repo_owner and repo_name else None,
            "firstUserMessage": last_user_msg[:100] if last_user_msg else "",
            "chat": initial_chat[-_MAX_SESSION_CHAT_MESSAGES:],
            "error": None,
        }
    # Only the legacy fallback agent needs a bridge-owned stub row: the real
    # hermes agent creates its own state.db session (source=cloudchat, full
    # transcript) keyed on the same session_id. Writing a stub here would
    # INSERT OR REPLACE over it.
    if not _using_real_agent:
        _save_session_to_db(_sessions[session_id])

    # If the latest user message is a hermes-agent skill command (/skill ...),
    # expand it in place into the skill's invocation prompt so the agent loop
    # actually runs the skill. The session record above keeps the original
    # slash command for display.
    _maybe_expand_skill_command(request_messages)
    moa_shortcut = _find_moa_shortcut(request_messages)
    if moa_shortcut:
        shortcut_index, shortcut_prompt = moa_shortcut
        if not shortcut_prompt:
            _finalize_tracked_session(
                session_id,
                success=True,
                persist_stub=not _using_real_agent,
            )
            return _single_message_sse(
                body.model,
                "Usage: /moa <prompt>\n\nRun one prompt through the default Mixture of Agents preset.",
            )
        request_messages[shortcut_index]["content"] = shortcut_prompt

    def _finalize_session(success: bool, error_message: Optional[str] = None):
        _finalize_tracked_session(
            session_id,
            success=success,
            error_message=error_message,
            persist_stub=not _using_real_agent,
        )

    # Detect repo mode from either the request body tools OR the repo headers.
    # In agent-loop mode the server sends repo info via headers (not body tools),
    # so we must check both sources to enable repo_mode correctly.
    has_repo_tools = False
    extra = body.model_extra or {}
    tools_list = extra.get("tools")
    if isinstance(tools_list, (list, dict)):
        tool_names = set()
        if isinstance(tools_list, list):
            for fn in tools_list:
                name = fn.get("name", "") if isinstance(fn, dict) else ""
                if name:
                    tool_names.add(name)
        has_repo_tools = "edit_repo_file" in tool_names
    # Also enable repo mode when repo headers are present (agent-loop proxy path).
    # Enable even without a PAT so the agent gets the repo system prompt
    # (which explains the limitation) instead of being told about a repo
    # in the server system prompt with no tools to access it.
    if not has_repo_tools and repo_owner and repo_name:
        has_repo_tools = True

    # Key priority: 1. Explicit Authorization header, 2. HERMES_OPENROUTER_KEY env var,
    # 3. OpenRouter keys from hermes auth.json credential pool, 4. Local gateway token fallback.
    # Strip whitespace/placeholders — Spark used to send `Bearer ` / `Bearer undefined`,
    # which is truthy and blocked the env/config fallbacks (and produced misleading 401s).
    auth_header = request.headers.get("authorization", "") or ""
    header_key = ""
    if auth_header.lower().startswith("bearer "):
        header_key = auth_header[7:].strip()
    if header_key.lower() in {"", "undefined", "null", "none"}:
        header_key = ""
    api_key = (
        header_key
        or OPENROUTER_KEY
        or _get_openrouter_key_from_hermes_creds()
        or _get_local_gateway_key()
        or ""
    )
    if isinstance(api_key, str):
        api_key = api_key.strip()
    if not api_key or str(api_key).lower() in {"undefined", "null", "none"}:
        api_key = ""

    # ── Provider Routing ──────────────────────────────────────────────────
    # Priority, strongest first:
    #   1. model-name prefix match in MODEL_PREFIX_TO_PROVIDER (e.g. anthropic/* → Anthropic)
    #   2. config.yaml model.provider (explicit CLI declaration via `hermes model`)
    #   3. config.yaml model.base_url is a custom non-known host → custom passthrough
    #   4. auth.json active_provider (legacy fallback)
    #   5. OpenRouter (default)
    active_provider = _get_active_provider()

    # Explicit provider selection via header wins over all other resolution.
    explicit_provider = (request.headers.get("x-hermes-provider", "") or "").strip().lower()
    if explicit_provider in ("", "auto", "default"):
        explicit_provider = ""
    moa_config = _load_moa_config(_resolve_hermes_home(request_profile))
    if moa_shortcut:
        explicit_provider = MOA_PROVIDER_ID
        body.model = str(moa_config.get("default_preset") or "default")
    elif isinstance(body.model, str) and body.model.lower().startswith("moa:"):
        explicit_provider = MOA_PROVIDER_ID
        body.model = body.model.split(":", 1)[1].strip() or str(moa_config.get("default_preset") or "default")

    cli_cfg = _load_cli_model_config(_resolve_hermes_home(request_profile))
    cli_base_url = (cli_cfg.get("base_url") or "").strip()
    cli_provider = (cli_cfg.get("provider") or "").strip().lower()
    cli_api_key = (cli_cfg.get("api_key") or "").strip()

    # Detect custom (non-whitelisted) base_urls
    cli_is_custom = bool(cli_base_url) and not any(h in cli_base_url for h in _KNOWN_HOSTS)

    # Resolve provider from model prefix
    def _resolve_provider_from_model(model: str) -> Optional[str]:
        model_lower = model.lower()
        for prefix, provider_id in sorted(_MODEL_PREFIX_TO_PROVIDER.items(), key=lambda x: -len(x[0])):
            if not model_lower.startswith(prefix):
                continue
            # A vendor-style prefix (e.g. "deepseek/") is a *namespace*, not proof
            # of the native provider: aggregators (nous, opencode-zen, openrouter)
            # serve "deepseek/deepseek-v4-flash" too. Only let the prefix force the
            # native provider when that provider actually offers this exact model
            # id. If we have a non-empty catalog for it and the id isn't in it,
            # fall through so routing defers to the caller's active_provider/config
            # instead of 401-ing at the native API with an unknown model.
            known = _models_for_provider(provider_id)
            if known and not any(model_lower == m.lower() for m in known):
                continue
            return provider_id
        return None

    #   0. Explicit provider header (strongest — caller named the provider)
    model_prefix_provider = _resolve_provider_from_model(body.model)
    # A vendor prefix only names the provider when we can verify it against a
    # catalog. When the catalog is empty/unknown (no hermes_cli.models import,
    # fresh installs, CI), the prefix is unverified guesswork — an explicit
    # config.yaml provider or auth.json active_provider naming a DIFFERENT
    # provider must win instead of 401-ing at the guessed native API.
    if (
        model_prefix_provider
        and not _models_for_provider(model_prefix_provider)
        and (
            (cli_provider and cli_provider in _PROVIDER_CONFIG and cli_provider != model_prefix_provider)
            or (active_provider and active_provider in _PROVIDER_CONFIG and active_provider != model_prefix_provider)
        )
    ):
        model_prefix_provider = None
    # Synthetic CLI custom id from /v1/providers (e.g. custom:api.bullinf.fun).
    # Treat as an explicit request to use config.yaml's custom base_url — NOT openrouter.
    cli_custom_id = _synthetic_cli_provider_id(cli_cfg) if cli_is_custom else ""
    if explicit_provider == MOA_PROVIDER_ID:
        resolved_provider = MOA_PROVIDER_ID
        route_source = "explicit-header"
    elif (
        explicit_provider
        and cli_is_custom
        and explicit_provider in {cli_custom_id, "custom", cli_provider}
    ):
        # UI picked the CLI custom endpoint row — keep custom routing, don't force openrouter.
        resolved_provider = "custom"
        route_source = "explicit-custom"
    elif explicit_provider and explicit_provider in _PROVIDER_CONFIG:
        resolved_provider = explicit_provider
        route_source = "explicit-header"
    #   1. Model prefix match (strongest signal — the model identifier names the provider)
    elif model_prefix_provider:
        resolved_provider = model_prefix_provider
        route_source = "model-prefix"
    #   2. CLI config.yaml provider
    elif cli_provider == MOA_PROVIDER_ID:
        resolved_provider = MOA_PROVIDER_ID
        route_source = "config.yaml"
    elif cli_provider and cli_provider in _PROVIDER_CONFIG:
        resolved_provider = cli_provider
        route_source = "config.yaml"
    elif cli_is_custom:
        # provider: custom / unknown with a non-hardcoded base_url — do NOT fall
        # through to openrouter (that produces a misleading HERMES_OPENROUTER_KEY 401).
        resolved_provider = "custom"
        route_source = "config.yaml-custom"
    #   3. auth.json active_provider
    elif active_provider and active_provider in _PROVIDER_CONFIG:
        resolved_provider = active_provider
        route_source = "auth.json"
    #   4. Default
    else:
        resolved_provider = "openrouter"
        route_source = "default"

    pool_custom_route: Optional[tuple[str, str, str]] = None
    if route_source != "explicit-header" and not cli_is_custom:
        native_needs_pool = (
            resolved_provider not in _AGGREGATOR_PROVIDERS
            and resolved_provider in _PROVIDER_CONFIG
            and (
                not _provider_has_credentials(resolved_provider)
                or _native_provider_cannot_serve_model(resolved_provider, body.model)
            )
        )
        if native_needs_pool:
            pool_custom_route = _resolve_custom_credential_pool_route(
                prefer_providers=[cli_provider, active_provider],
                model=body.model,
            )

    # Credential-aware reroute: if the resolved provider can't be served (no usable
    # credential) but the gateway IS authed for another provider that serves this
    # model, switch to it so a running, credentialed Hermes gateway "just works"
    # instead of 401-ing at an uncredentialed native API (e.g. deepseek-v4-flash
    # name-routes to native DeepSeek, but only Nous is credentialed and serves it
    # as deepseek/deepseek-v4-flash). The caller's explicit provider header and an
    # explicit custom base_url both still win — only auto-resolved routes reroute.
    if (
        not pool_custom_route
        and route_source != "explicit-header"
        and not cli_is_custom
        and resolved_provider != MOA_PROVIDER_ID
        and (
            resolved_provider not in _PROVIDER_CONFIG
            or not _provider_has_credentials(resolved_provider)
        )
    ):
        candidates = []
        if active_provider and active_provider in _PROVIDER_CONFIG:
            candidates.append(active_provider)
        candidates += [p for p in _PROVIDER_CONFIG if p not in candidates]
        for cand in candidates:
            if not _provider_has_credentials(cand):
                continue
            remapped = _match_model_for_provider(cand, body.model)
            if not remapped:
                continue
            print(
                f"[hermes-bridge] Credential-aware reroute: {resolved_provider} → {cand} "
                f"(model {body.model} → {remapped}); source was {route_source}",
                flush=True,
            )
            if remapped != body.model:
                body.model = remapped
            resolved_provider = cand
            route_source = "credential-fallback"
            break

    # If the UI pinned OpenRouter (often from a stale picker default when the
    # CLI is actually on a custom endpoint) but OpenRouter is not credentialed
    # and config.yaml has a custom base_url, always prefer the CLI endpoint.
    # Do NOT require the Authorization header to be empty — Spark always sends
    # `Bearer ${apiKey}` (often empty or a placeholder), and treating that as
    # an OpenRouter key produced the misleading HERMES_OPENROUTER_KEY 401.
    # IMPORTANT: use native OpenRouter credentials only — a local OpenClaw
    # gateway token must NOT count as OpenRouter auth or demotion never runs
    # on typical Hermes+OpenClaw installs.
    openrouter_credentialed = bool(
        OPENROUTER_KEY
        or _get_openrouter_key_from_hermes_creds()
        or _provider_has_native_credentials("openrouter")
    )
    if (
        resolved_provider == "openrouter"
        and cli_is_custom
        and not openrouter_credentialed
        and (
            cli_api_key
            or _get_credential_pool_key(cli_provider)
            or _get_credential_pool_key(cli_custom_id)
            or _cli_custom_endpoint_credentialed(cli_cfg, _resolve_hermes_home(request_profile))
            # Gateway alone is still a last-resort route signal so demotion can
            # attempt custom base_url rather than hard-401ing OpenRouter.
            or _get_local_gateway_key()
        )
    ):
        print(
            "[hermes-bridge] Ignoring uncredentialed openrouter pin — "
            f"using CLI custom base_url={cli_base_url} model={body.model} "
            f"(was source={route_source})",
            flush=True,
        )
        resolved_provider = "custom"
        route_source = "config.yaml-custom-override"

    # Custom non-hardcoded base_url overrides the resolved provider — UNLESS the
    # caller explicitly named a provider (UI picker), which always wins so the
    # selection isn't silently hijacked by a custom base_url in config.yaml.
    if resolved_provider == MOA_PROVIDER_ID:
        preset_name = (body.model or "").strip() or str(moa_config.get("default_preset") or "default")
        presets = moa_config.get("presets") if isinstance(moa_config.get("presets"), dict) else {}
        preset = presets.get(preset_name) if isinstance(presets, dict) else None
        if not preset or preset.get("enabled") is False:
            available = ", ".join(_enabled_moa_preset_names(moa_config)) or "none"
            _finalize_tracked_session(
                session_id,
                success=False,
                error_message=f"MoA preset '{preset_name}' is not configured or is disabled",
            )
            return JSONResponse(
                status_code=400,
                content={
                    "error": {
                        "message": (
                            f"MoA preset '{preset_name}' is not configured or is disabled. "
                            f"Available presets: {available}. Configure `moa.presets` in ~/.hermes/config.yaml."
                        ),
                        "code": "MOA_PRESET_NOT_FOUND",
                    }
                },
            )
        body.model = preset_name
        agent_base_url = "virtual://moa"
        agent_api_key = api_key or "moa"
        print(
            f"[hermes-bridge] Routing via native Hermes MoA preset. preset={preset_name}",
            flush=True,
        )
    elif cli_is_custom and (
        route_source in {
            "explicit-custom",
            "config.yaml-custom",
            "config.yaml-custom-override",
        }
        # After the openrouter demotion above, always honor custom base_url.
        or resolved_provider == "custom"
        or (
            # Legacy path: custom base_url with unknown provider id.
            # Do NOT hijack when model-prefix/credential-fallback already
            # resolved a real native provider (e.g. MiniMax-M2.7 → minimax).
            cli_provider not in _PROVIDER_CONFIG
            and resolved_provider not in _PROVIDER_CONFIG
            and resolved_provider != MOA_PROVIDER_ID
            and route_source not in {
                "explicit-header",
                "model-prefix",
                "credential-fallback",
            }
        )
    ):
        # Credential priority for a custom base_url: the api_key configured
        # alongside the model in ~/.hermes/config.yaml wins (the user set it
        # there explicitly), then the auth.json credential pool, then a key
        # forwarded by the client, then the local gateway token. Without the
        # config.yaml fallback the bridge ignored a perfectly good key and
        # returned 401 — e.g. deepseek-v4-pro via opencode-go.
        cli_key = (
            cli_api_key
            or _get_credential_pool_key(cli_provider)
            or _get_credential_pool_key(cli_custom_id)
            or (api_key if api_key and api_key.lower() not in {"undefined", "null", "none"} else "")
            or _get_local_gateway_key()
        )
        if not cli_key:
            return _no_api_key_error(cli_provider or "cli-config")
        agent_base_url = cli_base_url
        agent_api_key = cli_key
        # `auto`/`fast` are router aliases some gateways accept for plain chat
        # but reject (or 500) when tools are attached. Prefer a concrete model
        # from the matching custom_providers entry so agent-loop can run.
        # Prefer a known-good id that appears in the catalog over the first
        # listed entry — catalogs often lead with e2ee-* / offline models that
        # 404 with "no chat offers" (BullInf).
        model_lower = (body.model or "").strip().lower()
        if model_lower in {"", "auto", "fast", "default"}:
            catalog = [
                mid.strip()
                for mid in _models_for_custom_base_url(
                    cli_base_url, _resolve_hermes_home(request_profile)
                )
                if isinstance(mid, str) and mid.strip()
                and mid.strip().lower() not in {"", "auto", "fast", "default"}
            ]
            catalog_by_lower = {m.lower(): m for m in catalog}
            # Prefer known-good ids *when they appear in the catalog* — never
            # invent a BullInf-specific id for an empty/unrelated custom host.
            preferred_order = (
                "deepseek-v4-flash",
                "mimo-v2.5",
                "mimo-v2.5-pro",
                "gpt-5.4-mini",
                "minimax-m2.5",
                "minimax-m2.1",
                "deepseek-v4-pro",
            )
            concrete = None
            for preferred in preferred_order:
                hit = catalog_by_lower.get(preferred.lower())
                if hit:
                    concrete = hit
                    break
            if not concrete:
                # Skip e2ee-* / private-prefix entries when a public model exists.
                for mid in catalog:
                    if not mid.lower().startswith("e2ee-"):
                        concrete = mid
                        break
            if not concrete and catalog:
                concrete = catalog[0]
            # Fall back to config.yaml model.default when it is a concrete id.
            if not concrete:
                cfg_default = (cli_cfg.get("default") or "").strip()
                if cfg_default and cfg_default.lower() not in {"", "auto", "fast", "default"}:
                    concrete = cfg_default
            # Do NOT invent preferred_order[0] when catalog is empty — that
            # hard-coded BullInf id 404s on generic custom base_urls.
            if concrete:
                print(
                    f"[hermes-bridge] Resolving model {body.model!r} → {concrete!r} "
                    f"for custom base_url (agent/tool compatible)",
                    flush=True,
                )
                body.model = concrete
        print(
            f"[hermes-bridge] Routing via ~/.hermes/config.yaml custom base_url. "
            f"provider={cli_provider} base_url={cli_base_url} model={body.model} "
            f"source={route_source}",
            flush=True,
        )
    elif pool_custom_route:
        pool_provider, agent_base_url, agent_api_key = pool_custom_route
        print(
            f"[hermes-bridge] Routing via credential_pool. "
            f"provider={pool_provider} base_url={agent_base_url} model={body.model} "
            f"(native {resolved_provider} does not serve this model id)",
            flush=True,
        )
    else:
        # Resolve provider from the central config table
        provider_cfg = _PROVIDER_CONFIG.get(resolved_provider)
        if not provider_cfg:
            # Unknown provider — fall back to OpenRouter
            provider_cfg = _PROVIDER_CONFIG["openrouter"]
            resolved_provider = "openrouter"
            route_source = "fallback"

        circuit = _get_circuit(resolved_provider)
        if not circuit.is_available():
            return _circuit_open_error(provider_cfg["name"])

        # Resolve API key — try credential pool first, then env var, then gateway
        agent_api_key = ""
        if resolved_provider == "nous":
            agent_api_key = _get_nous_agent_key() or ""
        elif resolved_provider == "openrouter":
            agent_api_key = api_key or ""
        elif resolved_provider == "minimax":
            agent_api_key = (
                request.headers.get("x-hermes-minimax-key", "").strip()
                or getattr(body, "hermes_minimax_key", "").strip()
                or MINIMAX_KEY
                or ""
            )
        else:
            # Generic provider: try credential pool first, then env var.
            # Pool-only providers (opencode-go, opencode-zen, custom:*) aren't
            # in _PROVIDER_CONFIG, so provider_cfg.get("env_var", "") is "" —
            # fall back to the well-known OPENCODE_* env vars by resolved_provider.
            auth_provider = provider_cfg.get("auth_json_provider", resolved_provider)
            env_var = provider_cfg.get("env_var", "")
            if not env_var:
                if resolved_provider in ("opencode-go", "custom:opencode-go"):
                    env_var = "OPENCODE_GO_API_KEY"
                elif resolved_provider in ("opencode-zen", "custom:opencode-zen", "custom:opencode.ai"):
                    env_var = "OPENCODE_API_KEY"
            agent_api_key = (
                _get_credential_pool_key(auth_provider)
                or os.environ.get(env_var, "")
                or (os.environ.get("OPENCODE_API_KEY") or os.environ.get("OPENCODE_GO_API_KEY")
                    if resolved_provider.startswith("opencode") or resolved_provider.startswith("custom:opencode")
                    else "")
                or _get_local_gateway_key()
                or ""
            )

        if not agent_api_key:
            return _no_api_key_error(resolved_provider)

        agent_base_url = provider_cfg["base_url"]
        print(
            f"[hermes-bridge] Routing via {provider_cfg['name']}. "
            f"source={route_source} model={body.model} base_url={agent_base_url}",
            flush=True,
        )


    active_job_meta = _mark_request_started(
        model=body.model,
        enabled_toolsets=enabled_toolsets,
        repo_mode=has_repo_tools,
        repo_owner=repo_owner,
        repo_name=repo_name,
        repo_edit_intent=repo_edit_intent,
    )

    if execution_mode == "swarm":
        if resolved_provider == MOA_PROVIDER_ID:
            _mark_request_finished(
                model=body.model,
                success=False,
                summary=f"model={body.model} mode=swarm error=moa-not-supported",
            )
            _finalize_session(False, "MoA is not supported in swarm mode yet.")
            return JSONResponse(
                status_code=400,
                content={"error": {"message": "MoA presets currently run through the normal Hermes agent loop, not swarm mode."}},
            )
        # Redirect to the dedicated swarm endpoint handler
        print(f"[hermes-bridge] Swarm mode. model={body.model} msgs={len(request_messages)}", flush=True)
        swarm_body = SwarmRequest(
            model=body.model,
            messages=request_messages,
            stream=body.stream,
            **(body.model_extra or {}),
        )
        return await swarm_endpoint(request, swarm_body)

    if execution_mode == "passthrough":
        if resolved_provider == MOA_PROVIDER_ID:
            _mark_request_finished(
                model=body.model,
                success=False,
                summary=f"model={body.model} mode=passthrough error=moa-not-supported",
            )
            _finalize_session(False, "MoA is not supported in passthrough mode.")
            return JSONResponse(
                status_code=400,
                content={"error": {"message": "MoA presets require the Hermes agent loop so the aggregator can use tools."}},
            )
        print(
            f"[hermes-bridge] Passthrough mode. model={body.model} msgs={len(request_messages)} extra_keys={list((body.model_extra or {}).keys())}",
            flush=True,
        )
        return await _passthrough_chat_completions(
            body,
            agent_api_key,
            base_url=agent_base_url,
            finalize_request=lambda success: (
                _finalize_session(success),
                _mark_request_finished(
                    model=body.model,
                    success=success,
                    summary=f"model={body.model} mode=passthrough success={str(success).lower()}",
                ),
            ),
        )

    if execution_mode == "acp":
        # ACP transport — drive the REAL hermes-agent via Agent Client
        # Protocol (hermes-acp) instead of the reimplemented agent loop.
        return await _acp_chat_completions_impl(request, body)

    # AIAgent/_using_real_agent already resolved at the top of
    # _chat_completions_impl (right after workspace_id).
    if resolved_provider == MOA_PROVIDER_ID and not _using_real_agent:
        return _moa_native_adapter_required_error(
            model=body.model,
            finalize_session=_finalize_session,
        )

    import hermes_runs as _hermes_runs

    _use_runs_flag = _hermes_runs.parse_use_runs_flag(
        env_value=os.environ.get("HERMES_USE_RUNS"),
        header_value=request.headers.get("x-hermes-use-runs"),
        body_value=(body.model_extra or {}).get("hermes_use_runs"),
    )
    _gateway_base = _hermes_runs.resolve_gateway_base_url()
    _gateway_key = (
        api_key
        or os.environ.get("HERMES_API_KEY", "").strip()
        or os.environ.get("API_SERVER_KEY", "").strip()
        or (_get_local_gateway_key() or "")
    )
    _runs_parity = _hermes_runs.runs_parity_available(
        base_url=_gateway_base,
        api_key=_gateway_key or None,
    )
    _route_via_runs = _hermes_runs.should_route_via_runs(
        flag_enabled=_use_runs_flag,
        provider=resolved_provider,
        moa_provider_id=MOA_PROVIDER_ID,
        base_url=_gateway_base,
        api_key=_gateway_key or None,
        runs_moa_flag=_hermes_runs.parse_runs_moa_flag(),
        enabled_toolsets=enabled_toolsets,
    )
    if (
        _use_runs_flag
        and not _route_via_runs
        and _hermes_runs.enabled_toolsets_need_agent_loop_parity(enabled_toolsets)
    ):
        print(
            "[hermes-bridge] HERMES_USE_RUNS set; computer_use uses agent-loop "
            "(gateway runs tool.completed has no screenshot result)",
            flush=True,
        )
    elif _use_runs_flag and resolved_provider == MOA_PROVIDER_ID and not _route_via_runs:
        print(
            "[hermes-bridge] HERMES_USE_RUNS set; MoA using agent-loop "
            "(set HERMES_RUNS_MOA=1 or wait for gateway moa_runs capability)",
            flush=True,
        )
    elif _route_via_runs and resolved_provider == MOA_PROVIDER_ID:
        print(
            f"[hermes-bridge] Routing MoA via gateway /v1/runs. model={body.model} session={workspace_id}",
            flush=True,
        )
    elif _route_via_runs:
        print(
            f"[hermes-bridge] Routing via gateway /v1/runs. model={body.model} session={workspace_id}",
            flush=True,
        )
    _transport_label = "Starting Hermes gateway run..." if _route_via_runs else "Starting Hermes agent loop..."
    _transport_reason = None
    if _use_runs_flag and not _route_via_runs:
        if _hermes_runs.enabled_toolsets_need_agent_loop_parity(enabled_toolsets):
            _transport_reason = "Computer Use still requires the agent loop because gateway runs events do not include screenshot results."
        elif resolved_provider == MOA_PROVIDER_ID:
            _transport_reason = "Mixture of Agents still needs the agent loop unless gateway MoA runs support is enabled."
        else:
            _requested_custom_tools = (body.model_extra or {}).get("custom_tools")
            _needs_loop, _needs_loop_reason = _hermes_runs.needs_agent_loop_parity(
                runs_parity_available=_runs_parity,
                worktree_active=use_worktree,
                explicit_provider=resolved_provider,
                moa_provider_id=MOA_PROVIDER_ID,
                moa_runs_allowed=_hermes_runs.parse_runs_moa_flag(),
                enabled_toolsets=enabled_toolsets,
                toolsets_overridden=toolsets_overridden,
                default_toolsets=default_toolsets,
                repo_mode=has_repo_tools,
                github_pat=github_pat or None,
                custom_tools=_requested_custom_tools if isinstance(_requested_custom_tools, list) else None,
                reasoning_effort=(body.model_extra or {}).get("reasoning_effort"),
                custom_cli_base_url=(
                    cli_base_url
                    if cli_is_custom and (
                        resolved_provider == "custom"
                        or (resolved_provider or "").startswith("custom:")
                        or route_source.startswith("config.yaml-custom")
                        or route_source == "explicit-custom"
                    )
                    else None
                ),
            )
            if _needs_loop and _needs_loop_reason:
                _transport_reason = _needs_loop_reason[:1].upper() + _needs_loop_reason[1:]

    chunk_id = f"chatcmpl-hermes-{os.urandom(8).hex()}"
    # Brain MCP: register per-request session so overseer can address it directly
    try:
        await _brain_rpc("tools/call", {"name": "brain_register", "arguments": {"name": f"hermes-request-{chunk_id}"}})
    except Exception:
        pass
    # Brain MCP: publish per-request job metadata keyed by chunk_id so the overseer
    # can correlate in-flight requests and inspect individual job state.
    try:
        _brain_set(f"bridge:active-request:{chunk_id}", active_job_meta)
    except Exception:
        pass
    # Thread-safe asyncio queue for all events (text and tool activity)
    # Replaces sync queue.Queue — now native async, no to_thread bridging needed
    event_queue: asyncio.Queue = asyncio.Queue()
    done_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    # Queue wrapper for safe thread → async put
    def _qput(item):
        loop.call_soon_threadsafe(event_queue.put_nowait, item)

    def _repo_claim_resources(tool_name: str, tool_input: str) -> list[str]:
        try:
            args = json.loads(tool_input) if tool_input else {}
        except (json.JSONDecodeError, TypeError):
            return []

        if tool_name == "batch_edit_repo_files":
            changes = args.get("changes", [])
            if not isinstance(changes, list):
                return []
            paths = [
                change.get("path", "")
                for change in changes
                if isinstance(change, dict)
            ]
        else:
            paths = [args.get("path", "")]

        resources: list[str] = []
        seen: set[str] = set()
        repo_prefix = f"{repo_owner}/{repo_name}" if repo_owner and repo_name else "unknown"
        for path in paths:
            if not isinstance(path, str) or not path:
                continue
            resource = f"hermes-bridge:repo:{repo_prefix}:{path}"
            if resource in seen:
                continue
            seen.add(resource)
            resources.append(resource)
        return resources

    # Structured tool-call state for the agent-loop transport (worker-thread
    # callbacks may fire from parallel tool execution, hence the lock).
    tool_state_lock = threading.Lock()
    _active_tool_state: dict = {}  # call_id -> {"ts": monotonic, "name": tool}
    _pending_tool_ids: dict[str, list] = {}  # tool_name -> [call_ids] (FIFO fallback)

    def on_tool_start(tool_name: str, tool_input: str, call_id: Optional[str] = None):
        # Record MCP tool activity for the MCP dashboard (no-op for non-mcp_ tools).
        mcp_telemetry.record_tool_start(tool_name, tool_input)
        # Structured tool_call_begin: stable call_id across begin/delta/end.
        # Agents that know the provider's tool_call id pass it through; the
        # bridge generates one otherwise and pairs begin/end FIFO per tool.
        with tool_state_lock:
            if call_id is None:
                call_id = f"hermes-{uuid.uuid4().hex[:16]}"
                _pending_tool_ids.setdefault(tool_name, []).append(call_id)
            _active_tool_state[call_id] = {"ts": time.monotonic(), "name": tool_name}
        _qput(("tool_call_begin", tool_call_begin_event(call_id, tool_name)))
        # Emit tool start as visible text so user sees activity
        _qput(("tool_start", tool_name, tool_input))
        _append_session_chat_chunk(
            session_id,
            "assistant",
            _format_tool_start_text(tool_name, tool_input),
        )
        # Brain MCP: claim resource for edit operations to prevent conflicts
        if tool_name in REPO_EDIT_TOOL_NAMES:
            for resource in _repo_claim_resources(tool_name, tool_input):
                _brain_claim(resource, ttl=120)

    def on_tool_end(
        tool_name: str,
        tool_input: str,
        tool_output: str,
        call_id: Optional[str] = None,
        exit_code: Optional[int] = None,
        output_truncated: bool = False,
        output_truncated_lines: int = 0,
    ):
        # The composer task panel parses these tools' JSON output (todo lists,
        # subagent results, background process previews) — a 500-char cap
        # truncates the JSON mid-document, so give them more headroom.
        cap = 4000 if tool_name in ("todo", "delegate_task", "process", "terminal") else 500
        # Record MCP tool completion (latency, ok/err) for the MCP dashboard.
        mcp_telemetry.record_tool_end(tool_name, tool_output)
        # Pair the end with the matching begin (agent-provided id wins).
        with tool_state_lock:
            if call_id is None:
                pending = _pending_tool_ids.get(tool_name) or []
                call_id = pending.pop(0) if pending else f"hermes-{uuid.uuid4().hex[:16]}"
            state = _active_tool_state.pop(call_id, {})
        started_ts = state.get("ts")
        duration_ms = int((time.monotonic() - started_ts) * 1000) if started_ts else 0
        if not output_truncated:
            output_truncated, output_truncated_lines = output_truncation_info(tool_output, cap)
        success = not (tool_output or "").strip().lower().startswith(("error:", "failed:"))
        _qput(("tool_call_end", tool_call_end_event(
            call_id,
            tool_name,
            success=success,
            exit_code=exit_code,
            duration_ms=duration_ms,
            output_truncated=output_truncated,
            output_truncated_lines=output_truncated_lines,
        )))
        _qput(("tool_end", tool_name, tool_output[:cap]))
        _append_session_chat_chunk(
            session_id,
            "assistant",
            _format_tool_end_text(tool_name, tool_output),
        )
        # Brain MCP: release resource for edit operations
        if tool_name in REPO_EDIT_TOOL_NAMES:
            for resource in _repo_claim_resources(tool_name, tool_input):
                _brain_release(resource)
        # Plan mode-ish: the hermes ``todo`` tool carries a checklist — surface
        # it as a structured plan_update when parseable (agent-loop path).
        if tool_name == "todo":
            steps = todo_plan_steps(tool_output)
            if steps:
                _qput(("plan_update", {"type": "plan_update", "steps": steps}))

    def on_text(text: str):
        _append_session_chat_chunk(session_id, "assistant", text)
        # Stream normal text in small chunks for responsiveness
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            _qput(("text", text[i:i + chunk_size]))

    def on_thinking(iteration: int):
        _qput(("thinking", iteration))
        # Brain MCP: pulse every 5 iterations (not every iteration — avoids noise)
        if iteration % 5 == 0:
            _brain_pulse("working", f"iteration={iteration} model={body.model}")

    def on_reasoning(text: str):
        # Stream reasoning in small chunks for responsiveness
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            _qput(("reasoning", text[i:i + chunk_size]))

    def on_server_tool_event(event: dict):
        _qput(("server_tool_event", event))

    def on_fallback_switch(provider: str, model: str):
        _qput(("fallback_switch", fallback_switch_event(provider, model)))

    def on_transport_status(requested: str, actual: str, reason: str | None = None):
        _qput(("transport_status", transport_status_event(requested, actual, reason)))

    def on_stream_retry(attempt: int, max_attempts: int, reason: str, delay_ms: int):
        # The agent-loop retried an upstream stream — surface it once per retry.
        _qput(("stream_retry", stream_retry_event(attempt, max_attempts, reason, delay_ms)))

    def on_computer_use_frame(frame: dict):
        _qput(("computer_use_frame", frame))

    def on_notice(notice: dict):
        # Structured AgentNotice (credits warnings, run-budget wrap-up) from
        # the real hermes agent — surfaced as an SSE agent_notice event.
        _qput(("agent_notice", notice))

    def on_notice_clear(key: str):
        _qput(("agent_notice_clear", agent_notice_clear_event(key)))

    def _run_agent_sync():
        wt_info = None
        worktree_active = False
        try:
            if use_worktree:
                wt_info = maybe_setup_worktree(repo_root_header or None)
                worktree_active = bool(wt_info)
                if wt_info:
                    print(
                        f"[hermes-bridge] Worktree session active: {wt_info.get('path')}",
                        flush=True,
                    )
                else:
                    print(
                        "[hermes-bridge] Worktree requested but setup failed — continuing in original cwd",
                        flush=True,
                    )
            on_transport_status(
                "runs" if _use_runs_flag else "agent-loop",
                "runs" if _route_via_runs else "agent-loop",
                _transport_reason,
            )
            print(f"[hermes-bridge] Using {'real' if _using_real_agent else 'custom'} Hermes agent", flush=True)
            # Log message roles for debugging system prompt delivery
            msg_roles = [m["role"] for m in request_messages]
            has_extra_system = bool((body.model_extra or {}).get("system"))
            print(f"[hermes-bridge] Starting agent. mode={execution_mode} model={body.model} repo_mode={has_repo_tools} has_github={'yes' if github_pat else 'no'} repo={repo_owner}/{repo_name} toolsets={enabled_toolsets} msgs={len(request_messages)} roles={msg_roles} extra_system={has_extra_system}", flush=True)
            if has_repo_tools and not github_pat:
                print(f"[hermes-bridge] WARNING: repo_mode is active but no GitHub PAT provided — read_repo_file will fail", flush=True)
            # Extract repo file tree from request body (sent by server for Hermes agent-loop)
            repo_file_tree_raw = (body.model_extra or {}).get("repo_file_tree")
            repo_file_tree = (
                [p for p in repo_file_tree_raw if isinstance(p, str) and p.strip()]
                if isinstance(repo_file_tree_raw, list)
                else []
            )
            if repo_file_tree:
                print(f"[hermes-bridge] Received repo file tree: {len(repo_file_tree)} paths", flush=True)
            # Extract custom MCP tool definitions from request body
            custom_tools_raw = (body.model_extra or {}).get("custom_tools")
            custom_tools = (
                [t for t in custom_tools_raw if isinstance(t, dict)]
                if isinstance(custom_tools_raw, list)
                else []
            )
            if custom_tools:
                print(f"[hermes-bridge] Received {len(custom_tools)} custom MCP tool(s)", flush=True)
            # Reasoning effort from the CloudChat Effort slider (Faster ↔ Smarter)
            reasoning_effort_raw = (body.model_extra or {}).get("reasoning_effort")
            reasoning_effort = (
                reasoning_effort_raw.strip().lower()
                if isinstance(reasoning_effort_raw, str)
                and reasoning_effort_raw.strip().lower() in {
                    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
                }
                else None
            )
            if reasoning_effort:
                print(f"[hermes-bridge] Reasoning effort: {reasoning_effort}", flush=True)

            conversation_history = [dict(m) for m in request_messages]

            # The AI SDK may send the system prompt as a separate top-level
            # "system" field instead of (or in addition to) a system message
            # in the messages array.  Merge it if present.
            extra = body.model_extra or {}
            extra_system = extra.get("system")
            if isinstance(extra_system, str) and extra_system.strip():
                # Check if there's already a system message
                has_system = any(m.get("role") == "system" for m in conversation_history)
                if has_system:
                    for m in conversation_history:
                        if m.get("role") == "system":
                            m["content"] = extra_system + "\n\n" + (m["content"] or "")
                            break
                else:
                    conversation_history.insert(0, {"role": "system", "content": extra_system})

            # Find the last user message and pass everything before it
            # (including all assistant messages) as history.  Previous code
            # blindly took conversation_history[-1] which could strip an
            # assistant response when the SDK appends messages after it,
            # or — more critically — drop the assistant's analysis from
            # history when the last user message sits right after it.
            last_user_idx = None
            for i in range(len(conversation_history) - 1, -1, -1):
                if conversation_history[i]["role"] == "user":
                    last_user_idx = i
                    break

            if last_user_idx is not None:
                user_message = conversation_history[last_user_idx]["content"]
                # History = everything except the last user message itself.
                # This keeps all prior assistant messages (with their issue
                # analysis, etc.) in context for follow-up requests.
                history = conversation_history[:last_user_idx] + conversation_history[last_user_idx + 1:]
            else:
                user_message = ""
                history = list(conversation_history)

            agent_toolsets = (
                adjust_toolsets_for_worktree(enabled_toolsets)
                if worktree_active
                else enabled_toolsets
            )
            if plan_mode:
                agent_toolsets = filter_toolsets_for_plan_mode(agent_toolsets)
            agent_repo_mode = has_repo_tools and not worktree_active
            if worktree_active and has_repo_tools:
                print(
                    "[hermes-bridge] Worktree active — local file tools enabled, "
                    "GitHub API repo tools disabled for this run",
                    flush=True,
                )

            route_runs = _route_via_runs
            if route_runs:
                moa_runs_allowed = (
                    resolved_provider == MOA_PROVIDER_ID and _route_via_runs
                )
                needs_loop, parity_reason = _hermes_runs.needs_agent_loop_parity(
                    runs_parity_available=_runs_parity,
                    worktree_active=worktree_active,
                    # Use resolved_provider so demoted openrouter → custom still
                    # forces agent-loop; header-only would miss that path.
                    explicit_provider=(explicit_provider or resolved_provider or None),
                    moa_provider_id=MOA_PROVIDER_ID,
                    moa_runs_allowed=moa_runs_allowed,
                    enabled_toolsets=agent_toolsets,
                    toolsets_overridden=request.headers.get("x-hermes-toolsets") is not None,
                    default_toolsets=[t.strip() for t in DEFAULT_TOOLSETS.split(",") if t.strip()],
                    repo_mode=agent_repo_mode,
                    github_pat=github_pat if github_pat else None,
                    custom_tools=custom_tools or None,
                    reasoning_effort=reasoning_effort,
                    custom_cli_base_url=(
                        cli_base_url
                        if cli_is_custom and (
                            resolved_provider == "custom"
                            or str(resolved_provider or "").startswith("custom:")
                            or (agent_base_url and agent_base_url == cli_base_url)
                        )
                        else None
                    ),
                )
                if needs_loop:
                    print(
                        f"[hermes-bridge] Gateway /v1/runs cannot honor request — "
                        f"{parity_reason}; using agent-loop",
                        flush=True,
                    )
                    route_runs = False

            if route_runs:
                print(
                    f"[hermes-bridge] User message (runs): {user_message[:100]}... history_msgs={len(history)}",
                    flush=True,
                )
                system_msgs = [m["content"] for m in history if m.get("role") == "system"]
                non_system_history = [
                    {"role": m["role"], "content": m["content"]}
                    for m in history
                    if m.get("role") in {"user", "assistant"} and (m.get("content") or "").strip()
                ]
                instructions = "\n\n".join(system_msgs) if system_msgs else None
                run_provider = (explicit_provider or resolved_provider or "").strip().lower()
                if run_provider in {"", "auto", "default"}:
                    run_provider = None
                worktree_cwd = None
                if worktree_active and wt_info and _runs_parity:
                    worktree_cwd = str(wt_info.get("path") or "").strip() or None
                status_code, run_payload = _hermes_runs.submit_run(
                    base_url=_gateway_base,
                    api_key=_gateway_key or None,
                    input_text=user_message,
                    session_id=workspace_id,
                    conversation_history=non_system_history,
                    instructions=instructions,
                    model=body.model,
                    session_key=request.headers.get("x-hermes-session-key"),
                    cwd=worktree_cwd,
                    enabled_toolsets=agent_toolsets if _runs_parity else None,
                    provider=run_provider,
                    reasoning_effort=reasoning_effort,
                    include_parity_fields=_runs_parity,
                )
                if status_code != 202:
                    if (
                        resolved_provider == MOA_PROVIDER_ID
                        and _hermes_runs.is_moa_runs_rejection(status_code, run_payload)
                    ):
                        err = _hermes_runs.extract_gateway_error_text(run_payload)
                        print(
                            "[hermes-bridge] Gateway /v1/runs rejected provider=moa "
                            f"({status_code}: {err}) — falling back to agent-loop",
                            flush=True,
                        )
                        route_runs = False
                    else:
                        err = run_payload.get("error")
                        if isinstance(err, dict):
                            err = err.get("message") or json.dumps(err)
                        raise RuntimeError(f"Gateway /v1/runs failed ({status_code}): {err}")

            if route_runs:
                run_id = str(run_payload.get("run_id") or "").strip()
                if not run_id:
                    raise RuntimeError("Gateway /v1/runs returned no run_id")

                _hermes_runs.register_active_run(
                    workspace_id,
                    run_id=run_id,
                    base_url=_gateway_base,
                    api_key=_gateway_key or None,
                )
                _qput((
                    "server_tool_event",
                    hermes_run_server_tool_event(run_id, workspace_id),
                ))

                def _emit_run_event(*args):
                    _qput(args)

                try:
                    _hermes_runs.pump_run_events(
                        base_url=_gateway_base,
                        api_key=_gateway_key or None,
                        run_id=run_id,
                        emit=_emit_run_event,
                        should_stop=lambda: _hermes_runs.is_run_cancelled(workspace_id),
                    )
                finally:
                    # Pass run_id so a late-finishing run cannot delete a newer
                    # overlapping run's cancel handle for the same conversation.
                    _hermes_runs.unregister_active_run(workspace_id, run_id)
                print(f"[hermes-bridge] Gateway run completed. run_id={run_id}", flush=True)
                _brain_pulse("working", "completed")
                _update_bridge_metrics(success=True, decrement_active=True)
                _finalize_session(True)
                _mark_request_finished(
                    model=body.model,
                    success=True,
                    summary=f"model={body.model} mode=runs run_id={run_id}",
                )
                return

            agent_kwargs: dict = {
                "base_url": agent_base_url,
                "api_key": agent_api_key,
                "model": body.model,
                "max_iterations": MAX_AGENT_ITERATIONS,
                "enabled_toolsets": agent_toolsets,
                "repo_mode": agent_repo_mode,
                "worktree_mode": worktree_active,
                "repo_edit_intent": repo_edit_intent,
                "github_pat": github_pat if github_pat else None,
                "github_repo_owner": repo_owner if repo_owner else None,
                "github_repo_name": repo_name if repo_name else None,
                "repo_file_tree": repo_file_tree,
                "custom_tools": custom_tools,
                "workspace_id": workspace_id,
                "reasoning_effort": reasoning_effort,
                "plan_mode": plan_mode,
                "on_tool_start": on_tool_start,
                "on_tool_end": on_tool_end,
                "on_text": on_text,
                "on_server_tool_event": on_server_tool_event,
                "on_stream_retry": on_stream_retry,
            }
            if _using_real_agent:
                agent_kwargs["on_fallback_switch"] = on_fallback_switch
                agent_kwargs["on_computer_use_frame"] = on_computer_use_frame
                # Structured notices (credits/run-budget) — real-agent only.
                agent_kwargs["on_notice"] = on_notice
                agent_kwargs["on_notice_clear"] = on_notice_clear
                # Real-agent only: run_agent.AIAgent's fallback signature does not
                # accept this. Tells the adapter which profile's config.yaml to
                # read instead of the hard-coded ~/.hermes (B9).
                agent_kwargs["hermes_home"] = str(_resolve_hermes_home(request_profile))
                if run_budget_seconds:
                    agent_kwargs["run_budget_seconds"] = run_budget_seconds
            if resolved_provider == MOA_PROVIDER_ID:
                agent_kwargs["provider_override"] = MOA_PROVIDER_ID
            agent = AIAgent(**agent_kwargs)
            agent.on_thinking = on_thinking
            agent.on_reasoning = on_reasoning

            print(f"[hermes-bridge] User message: {user_message[:100]}... history_msgs={len(history)} has_system={any(m.get('role') == 'system' for m in history)}", flush=True)
            agent.run_conversation(
                user_message=user_message,
                conversation_history=history,
            )
            print(f"[hermes-bridge] Agent conversation completed.", flush=True)
            # Brain MCP: pulse on successful completion
            _brain_pulse("working", "completed")
            # Update bridge health metrics (decrement active request counter)
            _update_bridge_metrics(success=True, decrement_active=True)
            _finalize_session(True)
        except Exception as e:
            error_message = str(e)
            print(f"[hermes-bridge] Agent error: {error_message}", flush=True)
            _append_session_chat_chunk(session_id, "assistant", f"\n\n[Error: {error_message}]")
            _qput(("text", f"\n\n[Error: {error_message}]"))
            # Brain MCP: report failure
            _brain_pulse("failed", f"error={error_message[:100]}")
            _update_bridge_metrics(success=False, decrement_active=True)
            _finalize_session(False, error_message=error_message)
        finally:
            if worktree_active and wt_info:
                try:
                    cleanup_worktree(wt_info)
                except Exception as wt_cleanup_err:
                    print(f"[hermes-bridge] Worktree cleanup error: {wt_cleanup_err}", flush=True)
            # Brain MCP: clean up per-request state to prevent zombies
            try:
                # Delete the active request key for this chunk
                _brain_set(f"bridge:active-request:{chunk_id}", "")
                # Release all claimed resources for this request's repo prefix
                # (TTL=120 auto-releases on crash; explicit release on clean exit)
                repo_prefix = f"hermes-bridge:repo:{repo_owner}/{repo_name}:" if repo_owner and repo_name else None
                with _claimed_resources_lock:
                    to_release = [r for r in list(_claimed_resources) if repo_prefix is None or r.startswith(repo_prefix)]
                    for r in to_release:
                        _claimed_resources.discard(r)
                for r in to_release:
                    _brain_release(r)
                # Pulse done status
                _brain_pulse("done", f"completed chunk={chunk_id}")
            except Exception:
                pass  # Best-effort cleanup
            loop.call_soon_threadsafe(done_event.set)

    async def event_stream():
        # Role chunk
        print(f"[hermes-bridge] SSE stream started. chunk_id={chunk_id}", flush=True)
        stream_started_at = time.monotonic()
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"role": "assistant"}))
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
            "agent_status": agent_status_event(
                phase="starting",
                label=_transport_label,
                started_at=stream_started_at,
            ),
        }))

        agent_task = asyncio.ensure_future(asyncio.to_thread(_run_agent_sync))
        event_count = 0
        idle_ticks = 0  # counts consecutive empty polls (~50ms each)
        HEARTBEAT_INTERVAL = 60  # ticks ≈ 3 seconds of silence

        while not done_event.is_set() or not event_queue.empty():
            drained = False
            while not event_queue.empty():
                drained = True
                idle_ticks = 0
                try:
                    event = event_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break

                event_count += 1
                if event[0] == "text":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": event[1]}))
                elif event[0] == "tool_start":
                    tool_name, tool_input = event[1], event[2]
                    # Emit as both visible text and structured tool_activity
                    text = _format_tool_start_text(tool_name, tool_input)
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": tool_activity_event(tool_name, "running", tool_input, None)
                    }))
                elif event[0] == "tool_end":
                    tool_name, tool_output = event[1], event[2]
                    text = _format_tool_end_text(tool_name, tool_output)
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": tool_activity_event(tool_name, "completed", "", tool_output)
                    }))
                elif event[0] == "tool_call_begin":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"tool_call_begin": event[1]}))
                elif event[0] == "tool_call_delta":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"tool_call_delta": event[1]}))
                elif event[0] == "tool_call_end":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"tool_call_end": event[1]}))
                elif event[0] == "stream_retry":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"stream_retry": event[1]}))
                elif event[0] == "plan_update":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"plan_update": event[1]}))
                elif event[0] == "thinking":
                    iteration = event[1]
                    status_label = (
                        "Analyzing repository context..."
                        if has_repo_tools and iteration == 1
                        else "Analyzing your request..."
                        if iteration == 1
                        else f"Planning iteration {iteration}..."
                    )
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "agent_status": agent_status_event(
                            phase="thinking",
                            label=status_label,
                            started_at=stream_started_at,
                            iteration=iteration,
                        ),
                    }))
                    if iteration > 1:
                        # Show a thinking indicator between iterations so the
                        # user knows the agent is still working
                        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                            "content": "\n\n> *Thinking...*\n\n"
                        }))
                elif event[0] == "reasoning":
                    reasoning_text = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "reasoning": reasoning_text
                    }))
                elif event[0] == "transport_status":
                    status_event = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "transport_status": status_event
                    }))
                elif event[0] == "server_tool_event":
                    switch = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "fallback_switch": switch
                    }))
                elif event[0] == "computer_use_frame":
                    frame = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "computer_use_frame": frame
                    }))
                elif event[0] == "agent_notice":
                    notice = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "agent_notice": notice
                    }))
                elif event[0] == "agent_notice_clear":
                    clear = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "agent_notice_clear": clear
                    }))

            if not done_event.is_set():
                idle_ticks += 1
                # Send SSE comment as keepalive to prevent connection timeout
                if idle_ticks % HEARTBEAT_INTERVAL == 0:
                    yield ": heartbeat\n\n"
                await asyncio.sleep(0.05)

        # Final chunk
        print(f"[hermes-bridge] SSE stream ending. Total events emitted: {event_count}", flush=True)
        # Brain MCP: post completion status and update metrics
        elapsed_ms = int((time.monotonic() - stream_started_at) * 1000)
        _brain_post(f"hermes-bridge completed: model={body.model} events={event_count} elapsed_ms={elapsed_ms}", channel="hermes-bridge")
        _brain_set("hermes-bridge:active_request", "")
        _brain_set("hermes-bridge:active_sessions", str(_bridge_active_requests), "global")
        _brain_set("hermes-bridge:last_completion", f"model={body.model} events={event_count} elapsed_ms={elapsed_ms}", "global")
        # Bridge metrics — publish final state via _update_bridge_metrics (called from
        # _run_agent_sync) plus api_calls for the completed request
        _brain_set("bridge:metrics", json.dumps({
            "active_requests": _bridge_active_requests,
            "error_rate": round(_bridge_error_count / max(_bridge_total_requests, 1), 4),
            "uptime": round(time.time() - _bridge_start_time, 1) if _bridge_start_time > 0 else 0.0,
            "start_time": _bridge_start_time,
            "total_requests": _bridge_total_requests,
            "error_count": _bridge_error_count,
            "api_calls": event_count,
            "estimated_cost_usd": round(event_count * 0.001, 4),
        }))
        # Brain MCP: per-request metrics keyed by chunk_id for per-request auditing
        try:
            _brain_set(f"bridge:metrics:{chunk_id}", json.dumps({
                "tokens": 0,
                "api_calls": event_count,
                "cost": round(event_count * 0.001, 4),
                "elapsed_ms": elapsed_ms,
                "model": body.model,
                "repo_mode": has_repo_tools,
            }))
        except Exception:
            pass
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {}, finish_reason="stop"))
        yield "data: [DONE]\n\n"

        await agent_task

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ------------------------------------------------------------------
# ACP transport — drive the REAL hermes-agent via Agent Client Protocol
# ------------------------------------------------------------------
# ``x-hermes-execution-mode: acp`` spawns ``hermes-acp`` (hermes-agent's ACP
# stdio server) per conversation and relays its ``task/update`` notifications
# into the same SSE shapes the agent-loop transport emits, so the UI renders
# real hermes tools without any UI changes. The reimplemented loop in
# run_agent.py is not used on this path.

_acp_reaper_task = None


def _ensure_acp_reaper() -> None:
    """Start the idle-session reaper once (called from the first ACP request)."""
    global _acp_reaper_task
    if _acp_reaper_task is None or _acp_reaper_task.done():
        _acp_reaper_task = asyncio.create_task(_acp_reaper_loop())


async def _acp_reaper_loop() -> None:
    while True:
        try:
            await asyncio.sleep(60)
            import acp_transport

            closed = await acp_transport.reap_idle_sessions()
            if closed:
                print(f"[hermes-bridge] ACP idle reaper closed {closed} session(s)", flush=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass


@app.post("/v1/approvals/{approval_id}")
async def acp_approval_route(approval_id: str, body: dict = None):
    """Resolve a pending ACP permission request with the user's decision.

    Body: ``{"option_id": "allow_once" | "allow_session" | "allow_always" | "deny"}``
    Mirrors the UI's once/session/always scopes; the hermes ACP adapter maps
    these onto its own approval semantics.
    """
    try:
        import acp_transport

        option_id = ""
        if isinstance(body, dict):
            option_id = str(body.get("option_id") or "").strip()
        if not option_id:
            return JSONResponse(status_code=400, content={"error": {"message": "option_id is required"}})
        delivered = await acp_transport.resolve_approval(approval_id, option_id)
        if not delivered:
            return JSONResponse(status_code=404, content={"error": {"message": f"Unknown or expired approval: {approval_id}"}})
        return {"ok": True, "approval_id": approval_id, "option_id": option_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": {"message": str(e)}})


def _content_to_text(content) -> str:
    """Coerce a normalized message content (str or multimodal list) to text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    parts.append(block["text"])
                elif isinstance(block.get("content"), str):
                    parts.append(block["content"])
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return str(content or "")


def _format_plan_text(entries) -> str:
    """Render ACP ``plan_update`` entries as markdown text for the chat stream.

    The SSE protocol has no dedicated plan event (frontend HermesEvent types
    are text / tool_activity / agent_status / reasoning / server_tool_event),
    so the plan is forwarded as visible content — the same way the swarm path
    streams its plan summary.
    """
    if not entries:
        return ""
    lines = ["\n### Plan"]
    for entry in entries:
        text = str(getattr(entry, "content", "") or "").strip()
        if not text:
            continue
        status = str(getattr(entry, "status", "") or "")
        marker = {"completed": "- [x]", "in_progress": "- [ ]", "pending": "- [ ]"}.get(status, "-")
        lines.append(f"{marker} {text}")
    return "\n".join(lines) + "\n" if len(lines) > 1 else ""


# Cap for the repo file-tree preview injected into the ACP prompt (bounds the
# added tokens while still giving the model real paths on attempt #1).
_ACP_REPO_TREE_PREVIEW_LIMIT = 150

# Managed local checkouts (see server/repo-clone-manager.ts MANAGED_REPOS_ROOT).
_MANAGED_REPOS_ROOT = os.path.join(os.path.expanduser("~"), ".cloudchat", "repos")

# Owner/name segments must be single plain directory names — never a traversal.
_SAFE_REPO_SEGMENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*\Z")


def _resolve_acp_repo_root(
    repo_root_header: str = "",
    repo_owner: str = "",
    repo_name: str = "",
) -> str:
    """Resolve the ACP session cwd to a real repo checkout.

    Preference: explicit X-Hermes-Repo-Root header (when it exists on disk),
    then the managed clone at ~/.cloudchat/repos/<owner>/<name> (covers turns
    where the client sent owner/name but no root — previously these fell back
    to the bridge process cwd, so every relative read/search missed and the
    model probed blind). Returns "" when nothing resolves; callers fall back
    to getcwd()/home as before.
    """
    header = (repo_root_header or "").strip()
    if header and os.path.isdir(header):
        return header
    owner = (repo_owner or "").strip()
    name = (repo_name or "").strip()
    if (
        owner
        and name
        and _SAFE_REPO_SEGMENT_RE.fullmatch(owner)
        and _SAFE_REPO_SEGMENT_RE.fullmatch(name)
    ):
        candidate = os.path.join(_MANAGED_REPOS_ROOT, owner, name)
        if os.path.isdir(candidate):
            return candidate
    return ""


def _build_acp_repo_context_prefix(
    *,
    repo_owner: str = "",
    repo_name: str = "",
    repo_root: str = "",
    repo_file_tree: Optional[list] = None,
) -> str:
    """Build a short repo-context preamble for the ACP user prompt.

    The ACP transport forwards only the last user message to hermes-acp, so
    without this the model starts repo turns blind (no checkout path, no file
    list) and its first tool batch is context-free probing — e.g. reads with
    empty args that render as ``read: ?`` and fail. Returns "" when there is
    no repo signal so non-repo turns are byte-identical to before.
    """
    owner = (repo_owner or "").strip()
    name = (repo_name or "").strip()
    root = (repo_root or "").strip()
    tree = [p for p in (repo_file_tree or []) if isinstance(p, str) and p.strip()]
    if not owner and not name and not root and not tree:
        return ""
    label = f"{owner}/{name}" if owner and name else (owner or name or "attached repo")
    lines = [f"[Repo context: {label}."]
    if root:
        lines.append(f"Local checkout at: {root} (this is your working directory).")
        # Name the real session tools with exact arg shapes. The server-side
        # repo prompt teaches `read_repo_file` (a loop/SDK tool that does not
        # exist in this ACP session); without this mapping the model emits
        # empty-path `read` calls that render as `read: ?` and fail, and never
        # discovers file search at all.
        lines.append(
            "File tools in this session: `read_file` {path} reads a file; "
            "`search_files` {pattern, path} searches contents (ripgrep-backed — "
            "use it instead of grep). If your instructions mention "
            "`read_repo_file`, that is `read_file` here: always pass a real "
            "`path` from the list below, never an empty one."
        )
    if tree:
        shown = tree[:_ACP_REPO_TREE_PREVIEW_LIMIT]
        lines.append(f"Known files ({len(tree)} total{', showing ' + str(len(shown)) if len(tree) > len(shown) else ''}):")
        lines.extend(f"- {path}" for path in shown)
    lines.append("Read real paths from the list above; do not guess blind paths.]")
    return "\n".join(lines)


async def _acp_chat_completions_impl(request: Request, body: ChatCompletionRequest):
    """Chat completions via the ACP transport (real hermes-agent)."""
    import acp_transport

    available, reason = acp_transport.acp_available()
    if not available:
        print(f"[hermes-bridge] ACP mode requested but unavailable: {reason}", flush=True)
        # `_mark_request_started` already ran (before the mode branch) — close
        # the accounting here or the active-request metric leaks.
        _mark_request_finished(
            model=body.model,
            success=False,
            summary=f"model={body.model} mode=acp error=acp-unavailable",
        )
        return JSONResponse(
            status_code=400,
            content={"error": {"message": f"ACP transport unavailable: {reason}"}},
        )
    _ensure_acp_reaper()

    request_profile = _resolve_profile_name(request)
    repo_owner = request.headers.get("x-hermes-repo-owner", "")
    repo_name = request.headers.get("x-hermes-repo-name", "")
    repo_root_header = request.headers.get("x-hermes-repo-root", "").strip()
    provider = request.headers.get("x-hermes-provider", "").strip().lower()
    if provider in ("", "auto", "default"):
        provider = None
    # A stale UI pin (e.g. `custom:inference-api.nousresearch.com` saved when
    # the CLI config was last a custom endpoint) must not reach hermes-acp's
    # set_session_model: parse_model_input there doesn't know the synthetic id,
    # so it resolves (provider="custom", model="inference-api...:stealth/ox-alpha")
    # and the real agent routes to OpenRouter with an empty key →
    # "HTTP 400: <host>:<model> is not a valid model ID". When the pinned id is
    # no longer exposed by /v1/providers, drop the pin and let routing follow
    # config.yaml — same policy the agent-loop path applies via cli_is_custom.
    if provider and provider not in _provider_ids_for_chat_routing(
        _resolve_hermes_home(request_profile)
    ):
        print(
            f"[hermes-bridge] Dropping stale provider pin {provider!r} "
            "(not in current provider list) — falling back to CLI routing",
            flush=True,
        )
        provider = None

    workspace_id = _resolve_workspace_id(request, body)
    session_id = workspace_id
    # Resolve the session cwd to a real checkout: explicit header first, then
    # the managed clone for owner/name, then the historical fallbacks. (The
    # bridge process can outlive its original working directory — a build or
    # cleanup step may delete it. os.getcwd() then raises FileNotFoundError
    # and every chat request 500s — fall back to the home directory so
    # requests keep working regardless of what happens to the launch cwd.)
    resolved_repo_root = _resolve_acp_repo_root(
        repo_root_header, repo_owner, repo_name
    )
    try:
        cwd = resolved_repo_root or os.getcwd()
    except OSError:
        cwd = resolved_repo_root or os.path.expanduser("~")
    # Plan mode: passed to hermes-acp as an env hint + prompt suffix (the real
    # agent owns its tool registration; this is best-effort enforcement).
    plan_mode = bool((body.model_extra or {}).get("plan_mode"))

    request_messages = _normalize_chat_messages(body.messages, model=body.model, strip_images=True)
    last_user_idx = None
    for i in range(len(request_messages) - 1, -1, -1):
        if request_messages[i]["role"] == "user":
            last_user_idx = i
            break
    user_message = (
        _content_to_text(request_messages[last_user_idx]["content"])
        if last_user_idx is not None
        else ""
    )
    # The ACP session only receives this one prompt string (history lives in
    # the hermes-acp session server-side), so repo signals that the server
    # sent as headers/body must be inlined here — otherwise the model starts
    # repo turns with no checkout path and no file list.
    repo_file_tree_raw = (body.model_extra or {}).get("repo_file_tree")
    repo_context_prefix = _build_acp_repo_context_prefix(
        repo_owner=repo_owner,
        repo_name=repo_name,
        # Resolved root (not just the header): the prefix must describe the
        # checkout the session actually runs in. Non-repo turns still get ""
        # (no owner/name/root/tree), so they stay byte-identical to before.
        repo_root=resolved_repo_root,
        repo_file_tree=repo_file_tree_raw if isinstance(repo_file_tree_raw, list) else None,
    )
    if repo_context_prefix and user_message.strip():
        user_message = f"{repo_context_prefix}\n\n{user_message}"
    if not user_message.strip():
        _mark_request_finished(model=body.model, success=False, summary=f"model={body.model} mode=acp error=empty-prompt")
        return _single_message_sse(body.model, "Nothing to run — the latest user message is empty.")

    # Session tracking for Hermes Chats view (same shape as the agent-loop path)
    created_at = _now_iso()
    with _sessions_lock:
        _sessions[session_id] = {
            "id": session_id,
            "profile": request_profile,
            "model": body.model,
            "status": "active",
            "created_at": created_at,
            "updated_at": created_at,
            "messages": len(request_messages),
            "toolsets": [],
            "repo": f"{repo_owner}/{repo_name}" if repo_owner and repo_name else None,
            "firstUserMessage": user_message[:100],
            "chat": [{"role": "user", "content": user_message[:400]}],
            "error": None,
        }
    # ACP drives the REAL hermes-agent, which owns the state.db session row.
    # No bridge stub here — writing one would create a phantom duplicate.

    def _finalize_session(success: bool, error_message: Optional[str] = None):
        _finalize_tracked_session(
            session_id,
            success=success,
            error_message=error_message,
            persist_stub=False,  # ACP is always the real agent
        )

    chunk_id = f"chatcmpl-acp-{os.urandom(8).hex()}"
    started_at = time.monotonic()
    event_queue: asyncio.Queue = asyncio.Queue()
    done_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _qput(item):
        loop.call_soon_threadsafe(event_queue.put_nowait, item)

    def on_text(text: str):
        _append_session_chat_chunk(session_id, "assistant", text)
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            _qput(("text", text[i:i + chunk_size]))

    def on_tool_start(tool_name: str, tool_input: str):
        _qput(("tool_start", tool_name, tool_input))
        _append_session_chat_chunk(session_id, "assistant", _format_tool_start_text(tool_name, tool_input))

    def on_tool_end(tool_name: str, tool_input: str, tool_output: str):
        _qput(("tool_end", tool_name, tool_input, tool_output))
        _append_session_chat_chunk(session_id, "assistant", _format_tool_end_text(tool_name, tool_output))

    def on_reasoning(text: str):
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            _qput(("reasoning", text[i:i + chunk_size]))

    def on_approval_request(event: dict):
        _qput(("approval_request", event))

    def _acp_emit(kind: str, *payload):
        if kind == "text":
            on_text(payload[0])
        elif kind == "reasoning":
            on_reasoning(payload[0])
        elif kind == "tool_start":
            on_tool_start(payload[0], payload[1])
        elif kind == "tool_end":
            on_tool_end(payload[0], payload[1], payload[2])
        elif kind == "approval_request":
            on_approval_request(payload[0])
        elif kind == "plan":
            _qput(("plan", payload[0]))
        elif kind == "tool_call_begin":
            _qput(("tool_call_begin", payload[0]))
        elif kind == "tool_call_delta":
            _qput(("tool_call_delta", payload[0]))
        elif kind == "tool_call_end":
            _qput(("tool_call_end", payload[0]))
        elif kind == "stream_retry":
            _qput(("stream_retry", payload[0]))

    request_outcome = {"success": True, "error": None}

    def _run_acp_sync():
        try:
            acp_transport.run_prompt_blocking(
                loop=loop,
                conversation_id=workspace_id,
                cwd=cwd,
                user_message=user_message,
                emit=_acp_emit,
                provider=provider,
                model=body.model,
                plan_mode=plan_mode,
            )
            print(f"[hermes-bridge] ACP conversation completed. conversation={workspace_id}", flush=True)
            _finalize_session(True)
        except Exception as e:
            error_message = str(e)
            request_outcome["success"] = False
            request_outcome["error"] = error_message
            print(f"[hermes-bridge] ACP error: {error_message}", flush=True)
            _append_session_chat_chunk(session_id, "assistant", f"\n\n[Error: {error_message}]")
            _qput(("text", f"\n\n[Error: {error_message}]"))
            _finalize_session(False, error_message=error_message)
        finally:
            loop.call_soon_threadsafe(done_event.set)

    async def event_stream():
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"role": "assistant"}))
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
            "agent_status": agent_status_event(
                phase="starting",
                label="Starting Hermes agent (ACP)...",
                started_at=started_at,
            ),
        }))

        agent_task = asyncio.ensure_future(asyncio.to_thread(_run_acp_sync))
        event_count = 0
        # Wall-clock keepalive: heartbeat after ACP_SSE_HEARTBEAT_SECONDS of
        # silence, not after N idle poll iterations (~50ms each). Must stay
        # below the Express proxy's 30s activity timeout.
        last_heartbeat = time.monotonic()
        heartbeat_interval = ACP_SSE_HEARTBEAT_SECONDS
        while not done_event.is_set() or not event_queue.empty():
            drained = False
            while not event_queue.empty():
                drained = True
                last_heartbeat = time.monotonic()
                try:
                    event = event_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                event_count += 1
                if event[0] == "text":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": event[1]}))
                elif event[0] == "tool_start":
                    tool_name, tool_input = event[1], event[2]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": _format_tool_start_text(tool_name, tool_input)}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": tool_activity_event(tool_name, "running", tool_input, None)
                    }))
                elif event[0] == "tool_end":
                    tool_name, tool_input, tool_output = event[1], event[2], event[3]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": _format_tool_end_text(tool_name, tool_output)}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": tool_activity_event(tool_name, "completed", tool_input, tool_output)
                    }))
                elif event[0] == "tool_call_begin":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"tool_call_begin": event[1]}))
                elif event[0] == "tool_call_delta":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"tool_call_delta": event[1]}))
                elif event[0] == "tool_call_end":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"tool_call_end": event[1]}))
                elif event[0] == "stream_retry":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"stream_retry": event[1]}))
                elif event[0] == "plan_update":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"plan_update": event[1]}))
                elif event[0] == "reasoning":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"reasoning": event[1]}))
                elif event[0] == "thinking":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "agent_status": agent_status_event(
                            phase="thinking",
                            label="Planning...",
                            started_at=started_at,
                            iteration=1,
                        ),
                    }))
                elif event[0] == "approval_request":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"approval_request": event[1]}))
                elif event[0] == "plan":
                    # Keep the legacy markdown flattening (backward compat) and
                    # ALSO emit the structured checklist for the UI.
                    source = event[1]
                    entries = source if isinstance(source, list) else []
                    plan_text = _format_plan_text(entries)
                    if plan_text:
                        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": plan_text}))
                    plan_update = build_plan_update_event(source)
                    if plan_update:
                        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"plan_update": plan_update}))

            if not done_event.is_set():
                now = time.monotonic()
                if now - last_heartbeat >= heartbeat_interval:
                    last_heartbeat = now
                    yield ": heartbeat\n\n"
                await asyncio.sleep(0.05)

        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        _mark_request_finished(
            model=body.model,
            success=request_outcome["success"],
            summary=(
                f"model={body.model} mode=acp success={str(request_outcome['success']).lower()} "
                f"events={event_count} elapsed_ms={elapsed_ms}"
                + (f" error={request_outcome['error'][:80]}" if request_outcome["error"] else "")
            ),
        )
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {}, finish_reason="stop"))
        yield "data: [DONE]\n\n"
        await agent_task

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ------------------------------------------------------------------
# Swarm endpoint — Architect → Implementor → Reviewer pipeline
# ------------------------------------------------------------------

class SwarmRequest(BaseModel):
    """Request body for the /v1/swarm endpoint."""
    model: str = DEFAULT_MODEL
    messages: list[ChatMessage] = Field(default_factory=list)
    stream: bool = True
    model_config = {"extra": "allow"}


@app.post("/v1/swarm")
async def swarm_endpoint(request: Request, body: SwarmRequest):
    """Run the 3-phase swarm pipeline and stream SSE progress events."""
    from swarm_pattern import run_swarm

    toolsets_header = request.headers.get("x-hermes-toolsets", DEFAULT_TOOLSETS)
    enabled_toolsets = [t.strip() for t in toolsets_header.split(",") if t.strip()]
    repo_owner = request.headers.get("x-hermes-repo-owner", "")
    repo_name = request.headers.get("x-hermes-repo-name", "")
    github_pat = request.headers.get("x-hermes-github-pat", "")
    workspace_id = _resolve_workspace_id(request, body)

    extra = body.model_extra or {}
    custom_tools = [t for t in extra.get("custom_tools", []) if isinstance(t, dict)]
    repo_file_tree_raw = extra.get("repo_file_tree", [])
    repo_file_tree = [p for p in repo_file_tree_raw if isinstance(p, str) and p.strip()] if isinstance(repo_file_tree_raw, list) else []

    repo_mode = bool(repo_owner and repo_name)

    # Extract last user message
    conversation_history = _normalize_chat_messages(body.messages, model=body.model, strip_images=True)
    last_user_idx = None
    for i in range(len(conversation_history) - 1, -1, -1):
        if conversation_history[i]["role"] == "user":
            last_user_idx = i
            break
    user_message = conversation_history[last_user_idx]["content"] if last_user_idx is not None else ""

    chunk_id = f"chatcmpl-swarm-{os.urandom(8).hex()}"
    started_at = time.monotonic()

    async def swarm_stream():
        # Opening role chunk
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"role": "assistant"}))
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
            "agent_status": agent_status_event(
                phase="swarm_starting",
                label="Starting swarm pipeline...",
                started_at=started_at,
            ),
        }))
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
            "content": "\n\n> **Swarm Pipeline** — Architect → Implementor → Reviewer\n\n"
        }))

        try:
            result = await run_swarm(
                user_message=user_message,
                conversation_history=conversation_history,
                enabled_toolsets=enabled_toolsets,
                repo_mode=repo_mode,
                repo_owner=repo_owner or None,
                repo_name=repo_name or None,
                github_pat=github_pat or None,
                custom_tools=custom_tools,
                repo_file_tree=repo_file_tree,
            )

            # Stream the result summary
            verdict = result.get("verdict", "unknown")
            review_notes = result.get("review_notes", "")
            plan = result.get("plan", [])
            staged = result.get("staged_files", {})
            elapsed_ms = result.get("elapsed_ms", 0)
            success = result.get("success", False)

            # Plan summary
            if plan:
                plan_text = "\n### Plan\n"
                for step in plan:
                    plan_text += f"- [{step.get('action')}] `{step.get('path')}` — {step.get('description')}\n"
                yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": plan_text}))

            # Staged files summary
            if staged:
                staged_text = f"\n### Staged Files ({len(staged)})\n"
                for path in staged:
                    staged_text += f"- `{path}`\n"
                yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": staged_text}))

            # Verdict
            verdict_text = f"\n### Verdict: {'Approved' if verdict == 'approved' else 'Changes Requested'}\n"
            if review_notes:
                verdict_text += f"\n{review_notes}\n"
            verdict_text += f"\n*Completed in {elapsed_ms}ms*\n"
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": verdict_text}))

            # Structured swarm result as data event
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                "agent_status": agent_status_event(
                    phase="swarm_done",
                    label=f"Swarm {'approved' if success else 'needs changes'}",
                    started_at=started_at,
                ),
            }))

            # Include the full result in a server_tool_event so the frontend can access it
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                "server_tool_event": swarm_result_server_tool_event(
                    success=success,
                    verdict=verdict,
                    review_notes=review_notes,
                    staged_files=list(staged.keys()),
                    plan=plan,
                    elapsed_ms=elapsed_ms,
                ),
            }))
            _mark_request_finished(
                model=body.model,
                success=success,
                summary=f"model={body.model} mode=swarm verdict={verdict} elapsed_ms={elapsed_ms}",
            )
            _finalize_session(success)

        except Exception as e:
            error_text = f"\n\n**Swarm Pipeline Error:** {str(e)}\n"
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": error_text}))
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                "agent_status": agent_status_event(
                    phase="swarm_error",
                    label=f"Pipeline error: {str(e)[:60]}",
                    started_at=started_at,
                ),
            }))
            _mark_request_finished(
                model=body.model,
                success=False,
                summary=f"model={body.model} mode=swarm error={str(e)[:80]}",
            )
            _finalize_session(False)

        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {}, finish_reason="stop"))
        yield "data: [DONE]\n\n"

    return StreamingResponse(swarm_stream(), media_type="text/event-stream")


# ------------------------------------------------------------------
# Cron job storage (persistent JSON file + in-memory cache)
# ------------------------------------------------------------------
_cron_jobs: dict[str, dict] = {}
_cron_run_history: dict[str, list[dict]] = {}  # job_id -> list of run records
MAX_RUN_HISTORY = 20

import os as _os
import json as _json
import tempfile as _tempfile

_CRON_DATA_DIR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "data")
_CRON_JOBS_FILE = _os.path.join(_CRON_DATA_DIR, "cron_jobs.json")
_CRON_HISTORY_FILE = _os.path.join(_CRON_DATA_DIR, "cron_history.json")
_cron_lock = threading.Lock()


def _ensure_data_dir():
    """Create the data directory if it doesn't exist."""
    try:
        _os.makedirs(_CRON_DATA_DIR, exist_ok=True)
    except OSError as e:
        print(f"[cron-persist] Error creating data dir: {e}", flush=True)


def _atomic_write_json(filepath: str, data):
    """Write JSON to a file atomically (write to temp, then rename)."""
    dir_name = _os.path.dirname(filepath)
    fd = None
    tmp_path = None
    try:
        fd, tmp_path = _tempfile.mkstemp(dir=dir_name, suffix=".tmp")
        with _os.fdopen(fd, "w") as f:
            fd = None  # fdopen took ownership
            _json.dump(data, f, ensure_ascii=False, indent=2)
        _os.replace(tmp_path, filepath)
        tmp_path = None  # successfully renamed
    except Exception as e:
        print(f"[cron-persist] Error writing {filepath}: {e}", flush=True)
        if tmp_path and _os.path.exists(tmp_path):
            try:
                _os.unlink(tmp_path)
            except OSError:
                pass
        raise


def _load_cron_data():
    """Load cron jobs and history from disk into memory."""
    global _cron_jobs, _cron_run_history
    _ensure_data_dir()
    # Load jobs
    try:
        if _os.path.exists(_CRON_JOBS_FILE):
            with open(_CRON_JOBS_FILE, "r") as f:
                data = _json.load(f)
            if isinstance(data, dict):
                _cron_jobs = data
                print(f"[cron-persist] Loaded {len(_cron_jobs)} cron jobs from disk", flush=True)
    except Exception as e:
        print(f"[cron-persist] Error loading cron jobs: {e}", flush=True)
        _cron_jobs = {}
    # Load history
    try:
        if _os.path.exists(_CRON_HISTORY_FILE):
            with open(_CRON_HISTORY_FILE, "r") as f:
                data = _json.load(f)
            if isinstance(data, dict):
                _cron_run_history = data
                print(f"[cron-persist] Loaded run history for {len(_cron_run_history)} jobs", flush=True)
    except Exception as e:
        print(f"[cron-persist] Error loading cron history: {e}", flush=True)
        _cron_run_history = {}


def _save_cron_jobs():
    """Persist current cron jobs to disk (thread-safe, atomic)."""
    with _cron_lock:
        try:
            _ensure_data_dir()
            _atomic_write_json(_CRON_JOBS_FILE, _cron_jobs)
        except Exception as e:
            print(f"[cron-persist] Error saving cron jobs: {e}", flush=True)


def _save_cron_history():
    """Persist current cron run history to disk (thread-safe, atomic)."""
    with _cron_lock:
        try:
            _ensure_data_dir()
            _atomic_write_json(_CRON_HISTORY_FILE, _cron_run_history)
        except Exception as e:
            print(f"[cron-persist] Error saving cron history: {e}", flush=True)

try:
    from croniter import croniter as _croniter_cls
except ImportError:
    _croniter_cls = None


def _compute_next_run(schedule: str) -> Optional[str]:
    """Compute next run time from a cron expression. Returns ISO string or None."""
    if not _croniter_cls:
        return None
    try:
        now = datetime.now(timezone.utc)
        cron = _croniter_cls(schedule, now)
        return cron.get_next(datetime).isoformat()
    except Exception:
        return None


@app.get("/cron")
async def list_cron_jobs(request: Request):
    if _HERMES_CRON_AVAILABLE:
        conversation_id = _cron_query_value(request, "conversation_id")
        hermes_jobs = await _ops_thread(_hermes_list_jobs, include_disabled=True)
        jobs = [_map_hermes_job(job) for job in hermes_jobs]
        if conversation_id:
            jobs = [job for job in jobs if job.get("conversation_id") == conversation_id]
        jobs.sort(key=lambda item: item.get("created_at") or "", reverse=True)
        return JSONResponse(content={"jobs": jobs})

    return JSONResponse(content={"jobs": list(_cron_jobs.values())})


@app.post("/cron")
async def create_cron_job(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})

    schedule = body.get("schedule")
    prompt = body.get("prompt")
    name = body.get("name", "")

    if not schedule or not prompt:
        return JSONResponse(status_code=400, content={"error": "schedule and prompt are required"})

    if _HERMES_CRON_AVAILABLE:
        origin = _cloudchat_origin_from_body(body)
        job = await _ops_thread(
            _hermes_create_job,
            prompt=str(prompt),
            schedule=str(schedule),
            name=str(name).strip() or None,
            deliver="local",
            origin=origin,
        )
        return JSONResponse(status_code=201, content={"job": _map_hermes_job(job)})

    job_id = str(uuid.uuid4())[:8]
    now = datetime.now(timezone.utc).isoformat()
    next_run = _compute_next_run(schedule)
    job = {
        "id": job_id,
        "name": name or f"job-{job_id}",
        "schedule": schedule,
        "prompt": prompt,
        "status": "active",
        "created_at": now,
        "last_run": None,
        "next_run": next_run,
    }
    _cron_jobs[job_id] = job
    _save_cron_jobs()
    return JSONResponse(status_code=201, content={"job": job})


@app.delete("/cron/{job_id}")
async def delete_cron_job(job_id: str):
    if _HERMES_CRON_AVAILABLE:
        if not await _ops_thread(_hermes_remove_job, job_id):
            return JSONResponse(status_code=404, content={"error": "not found"})
        return JSONResponse(content={"ok": True})

    if job_id not in _cron_jobs:
        return JSONResponse(status_code=404, content={"error": "not found"})
    _cron_jobs.pop(job_id)
    _cron_run_history.pop(job_id, None)
    _save_cron_jobs()
    _save_cron_history()
    return JSONResponse(content={"ok": True})


@app.post("/cron/{job_id}/pause")
async def pause_cron_job(job_id: str):
    if _HERMES_CRON_AVAILABLE:
        updated = await _ops_thread(_hermes_pause_job, job_id)
        if not updated:
            return JSONResponse(status_code=404, content={"error": "not found"})
        return JSONResponse(content={"job": _map_hermes_job(updated)})

    if job_id not in _cron_jobs:
        return JSONResponse(status_code=404, content={"error": "not found"})
    _cron_jobs[job_id]["status"] = "paused"
    _save_cron_jobs()
    return JSONResponse(content={"job": _cron_jobs[job_id]})


@app.post("/cron/{job_id}/resume")
async def resume_cron_job(job_id: str):
    if _HERMES_CRON_AVAILABLE:
        updated = await _ops_thread(_hermes_resume_job, job_id)
        if not updated:
            return JSONResponse(status_code=404, content={"error": "not found"})
        return JSONResponse(content={"job": _map_hermes_job(updated)})

    if job_id not in _cron_jobs:
        return JSONResponse(status_code=404, content={"error": "not found"})
    _cron_jobs[job_id]["status"] = "active"
    _save_cron_jobs()
    return JSONResponse(content={"job": _cron_jobs[job_id]})


def _run_cron_agent(job: dict, run_record: dict):
    """Background thread: run the agent for a cron job and collect output."""
    try:
        # Import AIAgent here to avoid circular issues
        from hermes_adapter import HermesAgentAdapter as AIAgent

        output_chunks: list[str] = []
        tool_log: list[dict] = []

        def on_text(text: str):
            output_chunks.append(text)

        def on_tool_start(name: str, inp: str):
            tool_log.append({"type": "tool_start", "name": name, "input": inp[:500]})

        def on_tool_end(name: str, out: str):
            tool_log.append({"type": "tool_end", "name": name, "output": out[:500]})

        def on_thinking(iteration: int):
            tool_log.append({"type": "thinking", "iteration": iteration})

        def on_reasoning(text: str):
            pass  # skip reasoning in cron output

        def on_server_tool_event(event: dict):
            pass  # skip server tool events in cron

        agent = AIAgent(
            base_url="https://openrouter.ai/api/v1",
            api_key=os.environ.get("HERMES_OPENROUTER_KEY", ""),
            model=job.get("model") or os.environ.get("HERMES_DEFAULT_MODEL", "meta-llama/llama-4-maverick"),
            max_iterations=int(os.environ.get("HERMES_MAX_ITERATIONS", "30")),
            enabled_toolsets=job.get("toolsets") or os.environ.get("HERMES_TOOLSETS", "web,browser,terminal"),
            on_tool_start=on_tool_start,
            on_tool_end=on_tool_end,
            on_text=on_text,
            on_server_tool_event=on_server_tool_event,
        )
        agent.on_thinking = on_thinking
        agent.on_reasoning = on_reasoning

        # Build a minimal system context from the job prompt
        conversation_history = [{"role": "system", "content": f"You are executing a scheduled cron job named '{job.get('name', job['id'])}'. Follow the instructions below."}]

        agent.run_conversation(
            user_message=job["prompt"],
            conversation_history=conversation_history,
        )

        run_record["status"] = "completed"
        run_record["output"] = "".join(output_chunks)
        run_record["tool_log"] = tool_log
    except Exception as e:
        run_record["status"] = "failed"
        run_record["error"] = str(e)
        run_record["output"] = "".join(output_chunks) if 'output_chunks' in dir() else ""
    finally:
        run_record["completed_at"] = datetime.now(timezone.utc).isoformat()
        _save_cron_history()


@app.post("/cron/{job_id}/run")
async def run_cron_job(job_id: str):
    if _HERMES_CRON_AVAILABLE:
        job = await _ops_thread(_hermes_get_job, job_id)
        if not job:
            return JSONResponse(status_code=404, content={"error": "not found"})
        updated = await _ops_thread(_hermes_trigger_job, job_id)
        threading.Thread(target=_run_hermes_tick_now, daemon=True).start()
        return JSONResponse(content={
            "ok": True,
            "status": "queued",
            "job": _map_hermes_job(updated or job),
        })

    if job_id not in _cron_jobs:
        return JSONResponse(status_code=404, content={"error": "not found"})
    job = _cron_jobs[job_id]
    run_time = datetime.now(timezone.utc).isoformat()
    job["last_run"] = run_time
    # Compute next_run from schedule
    job["next_run"] = _compute_next_run(job.get("schedule", ""))

    run_id = str(uuid.uuid4())[:8]
    run_record = {
        "run_id": run_id,
        "job_id": job_id,
        "started_at": run_time,
        "completed_at": None,
        "status": "running",
        "output": "",
        "error": None,
        "tool_log": [],
    }

    # Store in history
    history = _cron_run_history.setdefault(job_id, [])
    history.insert(0, run_record)
    if len(history) > MAX_RUN_HISTORY:
        _cron_run_history[job_id] = history[:MAX_RUN_HISTORY]
    _save_cron_jobs()
    _save_cron_history()

    # Spawn background thread
    t = threading.Thread(target=_run_cron_agent, args=(job, run_record), daemon=True)
    t.start()

    return JSONResponse(content={
        "ok": True,
        "run_id": run_id,
        "status": "running",
    })


@app.get("/cron/{job_id}/history")
async def get_cron_history(job_id: str):
    if not _JOB_ID_RE.match(job_id or ""):
        return JSONResponse(status_code=422, content={"error": "invalid job_id"})
    if _HERMES_CRON_AVAILABLE:
        if not await _ops_thread(_hermes_get_job, job_id):
            return JSONResponse(status_code=404, content={"error": "not found"})
        return JSONResponse(content={"job_id": job_id, "runs": _build_hermes_run_history(job_id)})

    if job_id not in _cron_jobs:
        return JSONResponse(status_code=404, content={"error": "not found"})
    history = _cron_run_history.get(job_id, [])
    return JSONResponse(content={"job_id": job_id, "runs": history})


# ------------------------------------------------------------------
# Session endpoints for Hermes Chats view
# ------------------------------------------------------------------

@app.get("/sessions")
async def list_sessions(
    request: Request,
    limit: Optional[int] = None,
    offset: int = 0,
    q: Optional[str] = None,
):
    """List session summaries, newest first.

    Supports server-side search (``q``) and pagination (``limit``/``offset``)
    so clients never have to download the full session history (which can be
    tens of thousands of rows). When ``limit`` is omitted the full set is
    returned for backward compatibility. The response always includes the
    post-filter ``total`` and aggregate ``counts`` so the client can show
    accurate totals and status pills without holding every row.
    """
    profile_name = _resolve_profile_name(request)
    hermes_home = _resolve_hermes_home(profile_name)
    with _sessions_lock:
        summaries = [
            _session_summary(session)
            for session in _sessions.values()
            if _normalize_profile_name(session.get("profile")) == profile_name
        ]
    # Merge in sessions from state.db (CLI / cron sessions)
    db_sessions = _load_state_db_sessions(hermes_home=hermes_home)
    in_memory_ids = {s["id"] for s in summaries}
    for db_session in db_sessions:
        if db_session["id"] not in in_memory_ids:
            summaries.append(db_session)
    summaries.sort(key=lambda item: item.get("created_at", ""), reverse=True)

    # Server-side search across the same fields the client used to filter on.
    needle = (q or "").strip().lower()
    if needle:
        def _matches(item: dict) -> bool:
            for field in ("firstUserMessage", "id", "model", "repo"):
                value = item.get(field)
                if value and needle in str(value).lower():
                    return True
            return False

        summaries = [item for item in summaries if _matches(item)]

    # Aggregate counts over the full (post-search) set, before pagination.
    counts = {"active": 0, "completed": 0, "error": 0, "total": len(summaries)}
    for item in summaries:
        status = item.get("status")
        if status in ("active", "completed", "error"):
            counts[status] += 1

    total = len(summaries)
    if limit is not None:
        start = max(offset, 0)
        summaries = summaries[start : start + max(limit, 0)]

    return JSONResponse(content={"sessions": summaries, "total": total, "counts": counts})


@app.get("/sessions/{session_id}")
async def get_session(session_id: str, request: Request):
    profile_name = _resolve_profile_name(request)
    hermes_home = _resolve_hermes_home(profile_name)
    with _sessions_lock:
        session = _sessions.get(session_id)
        if session and _normalize_profile_name(session.get("profile")) == profile_name:
            payload = dict(session)
            payload.pop("profile", None)
            return JSONResponse(content=payload)
    # Fall back to state.db for CLI / cron sessions
    rows = _query_state_db(
        "SELECT id, source, model, started_at, ended_at, end_reason, message_count, title "
        "FROM sessions WHERE id = ?",
        (session_id,),
        hermes_home=hermes_home,
    )
    if not rows:
        return JSONResponse(status_code=404, content={"error": "not found"})
    row = dict(rows[0])
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
    payload = {
        "id": row["id"],
        "created_at": created_at,
        "updated_at": updated_at,
        "messages": row.get("message_count") or 0,
        "model": row.get("model") or "",
        "status": status,
        "toolsets": [f"source:{row.get('source') or 'cli'}"],
        "repo": None,
        "firstUserMessage": row.get("title") or "",
        "chat": _load_session_messages(session_id, hermes_home=hermes_home),
    }
    return JSONResponse(content=payload)


_MAX_SESSION_CHAT_MESSAGES = 200


def _load_session_messages(session_id: str, *, hermes_home: Optional[Path] = None) -> list[dict]:
    """Load messages for a session from state.db, mapped to HermesSessionMessage format."""
    rows = _query_state_db(
        "SELECT role, content FROM messages "
        "WHERE session_id = ? ORDER BY timestamp ASC "
        "LIMIT ?",
        (session_id, _MAX_SESSION_CHAT_MESSAGES),
        hermes_home=hermes_home,
    )
    return [
        {"role": row["role"], "content": row["content"] or ""}
        for row in rows
    ]


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str, request: Request):
    profile_name = _resolve_profile_name(request)
    with _sessions_lock:
        session = _sessions.get(session_id)
        if session and _normalize_profile_name(session.get("profile")) == profile_name:
            _sessions.pop(session_id, None)
    return JSONResponse(content={"ok": True})


@app.post("/sessions/{session_id}/fork")
async def fork_session(session_id: str, request: Request):
    """Proxy native Hermes gateway session fork (POST /api/sessions/{id}/fork)."""
    import hermes_ops

    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    title = body.get("title")
    if title is not None:
        title = str(title).strip() or None
    base = os.environ.get("HERMES_API_BASE") or "http://127.0.0.1:8642"
    api_key = (
        os.environ.get("HERMES_API_KEY")
        or os.environ.get("API_SERVER_KEY")
        or _get_local_gateway_key()
        or None
    )
    try:
        status, payload = hermes_ops.fork_gateway_session(
            session_id,
            base_url=base,
            api_key=api_key,
            title=title,
        )
        return JSONResponse(content=payload, status_code=status)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


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
    except Exception as e:
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
    except Exception as e:
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
    except Exception as e:
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
    except Exception as e:
        print(f"[hermes-bridge] skill command expansion failed: {e}", flush=True)


@app.get("/workspace/commands")
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


@app.get("/workspace/auth-providers")
async def workspace_auth_providers(request: Request):
    """List providers the user has saved/authenticated in their hermes-agent."""
    return JSONResponse(content={"providers": _load_hermes_saved_providers()})


@app.get("/bridges/cursor-composer")
async def cursor_composer_bridge_status(request: Request):
    """Status for the local Hermes → Cursor Composer bridge (:8790)."""
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    return JSONResponse(content=_cursor_composer_integration_status(hermes_home=hermes_home))


@app.get("/workspace/overview")
async def workspace_overview(request: Request):
    profile_name = _resolve_profile_name(request)
    hermes_home = _resolve_hermes_home(profile_name)
    return JSONResponse(content=_workspace_overview_payload(hermes_home=hermes_home, profile_name=profile_name))


@app.get("/workspace/usage")
async def workspace_usage(request: Request):
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    return JSONResponse(content=_workspace_usage_payload(hermes_home=hermes_home))


@app.get("/workspace/files")
async def workspace_files(request: Request):
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    return JSONResponse(content={"files": _list_canonical_files(hermes_home=hermes_home)})


@app.get("/workspace/files/{file_key}")
async def workspace_file_detail(file_key: str, request: Request):
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    entry = _canonical_file_entry(file_key.lower(), hermes_home=hermes_home, include_content=True)
    if not entry:
        return JSONResponse(status_code=404, content={"error": "unsupported file"})
    return JSONResponse(content={"file": entry})


@app.put("/workspace/files/{file_key}")
async def workspace_file_update(file_key: str, payload: HermesWorkspaceFileUpdate, request: Request):
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
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


# ------------------------------------------------------------------
# MCP servers — surface the agent's installed MCP servers (read from
# ~/.hermes/config.yaml `mcp_servers`) and one-click install/uninstall
# from a small curated catalog. Writes are additive and backed up; the
# agent's MCP layer is reloaded in-process when possible.
# ------------------------------------------------------------------

# Curated, intentionally-small set of one-click installable MCP servers.
# Server-side is the source of truth so the install endpoint never writes a
# client-supplied command. None of these require secrets.
_MCP_CATALOG: list[dict] = [
    {
        "id": "filesystem",
        "name": "filesystem",
        "description": "Read and write files within a directory you choose.",
        "transport": "stdio",
        "runtime": "node",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "{param}"],
        "requires_param": {"key": "root", "label": "Root directory", "placeholder": "~/", "default": "~"},
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    },
    {
        "id": "fetch",
        "name": "fetch",
        "description": "Fetch a URL and return clean, readable markdown.",
        "transport": "stdio",
        "runtime": "python",
        "command": "uvx",
        "args": ["mcp-server-fetch"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    },
    {
        "id": "git",
        "name": "git",
        "description": "Inspect and operate on a local git repository.",
        "transport": "stdio",
        "runtime": "python",
        "command": "uvx",
        "args": ["mcp-server-git", "--repository", "{param}"],
        "requires_param": {"key": "repo", "label": "Repository path", "placeholder": "~/code/my-repo", "default": "."},
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    },
    {
        "id": "memory",
        "name": "memory",
        "description": "A persistent knowledge-graph memory the agent can read and write.",
        "transport": "stdio",
        "runtime": "node",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-memory"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    },
    {
        "id": "sequential-thinking",
        "name": "sequential-thinking",
        "description": "A structured step-by-step reasoning scratchpad for hard problems.",
        "transport": "stdio",
        "runtime": "node",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    },
    {
        "id": "playwright",
        "name": "playwright",
        "description": "Drive a real browser — navigate, click, read, and screenshot pages.",
        "transport": "stdio",
        "runtime": "node",
        "command": "npx",
        "args": ["-y", "@playwright/mcp@latest"],
        "docs_url": "https://github.com/microsoft/playwright-mcp",
    },
]

_MCP_CATALOG_BY_ID = {entry["id"]: entry for entry in _MCP_CATALOG}


def _hermes_config_path(hermes_home: Path) -> Path:
    return Path(hermes_home) / "config.yaml"


def _read_hermes_config(hermes_home: Path) -> dict:
    """Load the full config.yaml as a plain dict (empty on any error)."""
    try:
        import yaml
        path = _hermes_config_path(hermes_home)
        if not path.is_file():
            return {}
        with open(path) as f:
            cfg = yaml.safe_load(f)
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def _normalize_mcp_server_entry(name: str, cfg: dict) -> dict:
    """Map a raw mcp_servers entry to a safe, display-friendly dict.

    Secrets are never returned: env *values* are dropped (names only) and
    HTTP `headers` (which often carry auth tokens) are omitted entirely.
    """
    cfg = cfg if isinstance(cfg, dict) else {}
    url = cfg.get("url")
    transport = "http" if url else "stdio"
    args = cfg.get("args")
    env = cfg.get("env")
    tools = cfg.get("tools")
    return {
        "name": name,
        "transport": transport,
        "command": str(cfg.get("command") or ""),
        "args": [str(a) for a in args] if isinstance(args, list) else [],
        "url": str(url) if isinstance(url, str) else "",
        "enabled": cfg.get("enabled", True) is not False,
        "env_keys": sorted(env.keys()) if isinstance(env, dict) else [],
        "tool_count": len(tools) if isinstance(tools, dict) else 0,
        "catalog_id": name if name in _MCP_CATALOG_BY_ID else None,
    }


def _load_hermes_mcp_servers(hermes_home: Path) -> list[dict]:
    """List the agent's installed MCP servers from config.yaml (secrets redacted)."""
    servers = _read_hermes_config(hermes_home).get("mcp_servers")
    if not isinstance(servers, dict):
        return []
    return [_normalize_mcp_server_entry(name, entry) for name, entry in sorted(servers.items())]


def _mcp_catalog_payload() -> list[dict]:
    """Display-only view of the curated catalog (no internal arg templating)."""
    return [
        {
            "id": e["id"],
            "name": e["name"],
            "description": e["description"],
            "transport": e["transport"],
            "runtime": e.get("runtime", ""),
            "requires_param": e.get("requires_param"),
            "docs_url": e.get("docs_url", ""),
        }
        for e in _MCP_CATALOG
    ]


def _build_mcp_entry_from_catalog(entry: dict, param: Optional[str]) -> dict:
    """Build a config.yaml mcp_servers entry from a catalog template + param."""
    req = entry.get("requires_param") or {}
    resolved: list[str] = []
    for arg in entry.get("args", []):
        if arg == "{param}":
            value = (param or "").strip() or req.get("default", "")
            resolved.append(os.path.expanduser(value))
        else:
            resolved.append(arg)
    built: dict = {"command": entry["command"], "enabled": True}
    if resolved:
        built["args"] = resolved
    return built


def _backup_hermes_config(path: Path) -> None:
    if path.is_file():
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        path.with_name(f"config.yaml.bak-{ts}").write_text(
            path.read_text(encoding="utf-8"), encoding="utf-8"
        )


def _load_hermes_config_editable(hermes_home: Path):
    """Load config.yaml for editing. Returns ``(dump, data)`` where ``dump()``
    backs up the file and writes ``data`` back. Uses ruamel round-trip when
    available (preserves comments/format), else PyYAML (comments lost)."""
    path = _hermes_config_path(hermes_home)
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    try:
        from ruamel.yaml import YAML
        from ruamel.yaml.comments import CommentedMap

        yaml_rt = YAML()
        yaml_rt.preserve_quotes = True
        # Don't fold long scalars (e.g. absolute command paths) across lines.
        yaml_rt.width = 4096
        data = yaml_rt.load(text) if text.strip() else CommentedMap()
        if data is None:
            data = CommentedMap()

        def _dump():
            _backup_hermes_config(path)
            with open(path, "w") as f:
                yaml_rt.dump(data, f)

        return _dump, data
    except Exception:
        import yaml

        data = (yaml.safe_load(text) if text.strip() else {}) or {}

        def _dump():
            _backup_hermes_config(path)
            with open(path, "w") as f:
                yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

        return _dump, data


def _reload_agent_mcp() -> bool:
    """Best-effort in-process reload of the installed agent's MCP layer so a
    freshly-installed server connects without a full bridge restart."""
    try:
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers
        from tools.mcp_tool_discovery import discover_mcp_tools

        shutdown_mcp_servers()
        discover_mcp_tools()
        return True
    except Exception as exc:
        print(f"[hermes-bridge] MCP reload skipped: {exc}", flush=True)
        return False


def _build_mcp_tool_index(hermes_home: Path) -> list[dict]:
    """Flatten registered MCP tools for the Spark searchable tool index."""
    servers_cfg = _read_hermes_config(hermes_home).get("mcp_servers")
    if not isinstance(servers_cfg, dict):
        servers_cfg = {}

    server_enabled = {
        name: (cfg.get("enabled", True) is not False if isinstance(cfg, dict) else True)
        for name, cfg in servers_cfg.items()
    }

    try:
        from tools.mcp_tool_discovery import discover_mcp_tools
        from tools.mcp_tool import _mcp_tool_server_names, _lock as _agent_lock
        from tools.registry import registry

        discover_mcp_tools()
        with _agent_lock:
            pairs = list(_mcp_tool_server_names.items())
    except Exception:
        pairs = []
        registry = None  # type: ignore[assignment]

    out: list[dict] = []
    for tool_name, server in pairs:
        if not server_enabled.get(server, True):
            continue
        description = ""
        if registry is not None:
            schema = registry.get_schema(tool_name) or {}
            description = str(schema.get("description") or "")
        out.append({
            "server": server,
            "name": tool_name,
            "description": description,
        })
    out.sort(key=lambda e: (e["server"].lower(), e["name"].lower()))
    return out


class McpInstallRequest(BaseModel):
    id: str
    param: Optional[str] = None


@app.get("/workspace/mcp-servers")
async def workspace_mcp_servers(request: Request):
    """List the MCP servers installed in the hermes-agent's config.yaml."""
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    return JSONResponse(content={"servers": _load_hermes_mcp_servers(hermes_home)})


@app.get("/workspace/mcp-catalog")
async def workspace_mcp_catalog(request: Request):
    """The curated set of one-click installable MCP servers."""
    return JSONResponse(content={"catalog": _mcp_catalog_payload()})


@app.post("/workspace/mcp-servers/install")
async def workspace_mcp_install(request: Request, body: McpInstallRequest):
    """Install a curated MCP server into config.yaml and reload the agent."""
    entry = _MCP_CATALOG_BY_ID.get(body.id)
    if not entry:
        return JSONResponse(status_code=400, content={"error": f"Unknown MCP id: {body.id}"})
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    dump, data = _load_hermes_config_editable(hermes_home)
    servers = data.get("mcp_servers")
    if not isinstance(servers, dict):
        servers = {}
        data["mcp_servers"] = servers
    name = entry["name"]
    if name in servers:
        return JSONResponse(status_code=409, content={"error": f"'{name}' is already installed"})
    servers[name] = _build_mcp_entry_from_catalog(entry, body.param)
    try:
        dump()
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to write config: {e}"})
    reloaded = _reload_agent_mcp()
    print(f"[hermes-bridge] Installed MCP server '{name}' (reloaded={reloaded})", flush=True)
    return JSONResponse(content={"ok": True, "installed": name, "reloaded": reloaded})


@app.delete("/workspace/mcp-servers/{name}")
async def workspace_mcp_uninstall(name: str, request: Request):
    """Remove a store-installed MCP server. Agent-managed servers stay read-only."""
    if name not in _MCP_CATALOG_BY_ID:
        return JSONResponse(status_code=403, content={"error": "Only store-installed servers can be removed here"})
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    dump, data = _load_hermes_config_editable(hermes_home)
    servers = data.get("mcp_servers")
    if not isinstance(servers, dict) or name not in servers:
        return JSONResponse(status_code=404, content={"error": f"'{name}' is not installed"})
    del servers[name]
    try:
        dump()
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to write config: {e}"})
    reloaded = _reload_agent_mcp()
    print(f"[hermes-bridge] Removed MCP server '{name}' (reloaded={reloaded})", flush=True)
    return JSONResponse(content={"ok": True, "removed": name, "reloaded": reloaded})


@app.get("/workspace/mcp-telemetry")
async def workspace_mcp_telemetry(request: Request):
    """Live MCP dashboard snapshot: per-server connection status, tool-call
    metrics (counts, latency, errors), minute-bucketed activity, and a recent
    global activity feed. Metrics persist across bridge restarts via SQLite."""
    try:
        snap = mcp_telemetry.snapshot()
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"telemetry unavailable: {e}"})
    return JSONResponse(content=snap)


@app.get("/workspace/mcp-tool-index")
async def workspace_mcp_tool_index(request: Request):
    """Searchable MCP tool index: flattened tool names + descriptions from the
    in-process agent registry (enabled servers only)."""
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    try:
        tools = _build_mcp_tool_index(hermes_home)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"tool index unavailable: {e}"})
    return JSONResponse(content={"tools": tools, "total": len(tools)})


@app.get("/workspace/mcp-servers/{name}/logs")
async def workspace_mcp_server_logs(name: str, request: Request):
    """Tail the shared MCP stderr log for a single server (most recent lines)."""
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    try:
        limit = int(request.query_params.get("limit", "200"))
    except (TypeError, ValueError):
        limit = 200
    try:
        lines = mcp_telemetry.read_server_logs(hermes_home, name, limit=limit)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"could not read logs: {e}"})
    return JSONResponse(content={"server": name, "lines": lines})


@app.get("/workspace/skills")
async def workspace_skills(request: Request):
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    return JSONResponse(content={"skills": _list_skills(hermes_home=hermes_home)})


@app.get("/workspace/skills/content")
async def workspace_skill_detail(request: Request):
    skill_id = request.query_params.get("id", "")
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    detail = _skill_detail(skill_id, hermes_home=hermes_home)
    if not detail:
        return JSONResponse(status_code=404, content={"error": "skill not found"})
    return JSONResponse(content={"skill": detail})


@app.get("/workspace/skills/hub")
async def workspace_skills_hub(request: Request):
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    try:
        skills = await _ops_thread(_list_skills_hub, hermes_home=hermes_home)
        return JSONResponse(content={"skills": skills})
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "skills hub request timed out"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/workspace/skills/hub/install")
async def workspace_skill_install(payload: HermesHubSkillInstallRequest, request: Request):
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    try:
        result = await _ops_thread(_install_hub_skill, payload.name, hermes_home=hermes_home)
        return JSONResponse(content=result)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "skill install timed out"})
    except FileNotFoundError:
        return JSONResponse(status_code=500, content={"error": "hermes command not found"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/workspace/skills")
async def workspace_skill_uninstall(request: Request):
    body = await request.json()
    skill_id = body.get("id", "")
    if not skill_id:
        return JSONResponse(status_code=400, content={"error": "skill id is required"})

    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    skills_dir = _skills_dir(hermes_home)
    try:
        skill_path = (skills_dir / skill_id).resolve()
        skill_path.relative_to(skills_dir.resolve())
    except Exception:
        return JSONResponse(status_code=404, content={"error": "skill not found"})

    if skill_path.is_dir():
        skill_path = skill_path / "SKILL.md"

    if skill_path.name != "SKILL.md" or not skill_path.exists():
        return JSONResponse(status_code=404, content={"error": "skill not found"})

    # Use hermes skills uninstall command
    skill_name = skill_path.parent.name

    def _uninstall_skill() -> dict:
        command_env = os.environ.copy()
        command_env["HERMES_HOME"] = str(hermes_home)
        return subprocess.run(
            ["hermes", "skills", "uninstall", skill_name],
            capture_output=True,
            text=True,
            timeout=60,
            env=command_env,
        )

    try:
        result = await _ops_thread(_uninstall_skill)
        if result.returncode != 0:
            return JSONResponse(
                status_code=500,
                content={"error": f"uninstall failed: {result.stderr.strip()}"},
            )
        return JSONResponse(content={"success": True, "message": f"Skill '{skill_name}' uninstalled"})
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "uninstall timed out"})
    except FileNotFoundError:
        return JSONResponse(status_code=500, content={"error": "hermes command not found"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ------------------------------------------------------------------
# Messaging Platform Configuration
# ------------------------------------------------------------------

from messaging_platforms import (
    list_platforms as _list_platforms,
    get_platform as _get_platform,
    update_platform_env as _update_platform_env,
    update_platform_config as _update_platform_config,
    disconnect_platform as _disconnect_platform,
    test_platform_connection as _test_platform_connection,
    get_oauth_status as _get_oauth_status,
    complete_oauth as _complete_oauth,
)


@app.get("/messaging/platforms")
async def messaging_list_platforms():
    try:
        return JSONResponse(content={"platforms": _list_platforms()})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/messaging/platforms/{platform_id}")
async def messaging_get_platform(platform_id: str):
    result = _get_platform(platform_id)
    if not result:
        return JSONResponse(status_code=404, content={"error": f"Platform '{platform_id}' not found"})
    return JSONResponse(content={"platform": result})


@app.put("/messaging/platforms/{platform_id}/env")
async def messaging_update_env(platform_id: str, request: Request):
    try:
        body = await request.json()
        updates = body.get("env", {})
        if not isinstance(updates, dict):
            return JSONResponse(status_code=400, content={"error": "'env' must be a dict"})
        result = _update_platform_env(platform_id, updates)
        return JSONResponse(content={"platform": result})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.put("/messaging/platforms/{platform_id}/config")
async def messaging_update_config(platform_id: str, request: Request):
    try:
        body = await request.json()
        updates = body.get("config", {})
        if not isinstance(updates, dict):
            return JSONResponse(status_code=400, content={"error": "'config' must be a dict"})
        result = _update_platform_config(platform_id, updates)
        return JSONResponse(content={"platform": result})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/messaging/platforms/{platform_id}")
async def messaging_disconnect_platform(platform_id: str):
    try:
        result = _disconnect_platform(platform_id)
        return JSONResponse(content={"platform": result})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/messaging/platforms/{platform_id}/test")
async def messaging_test_platform(platform_id: str):
    try:
        result = _test_platform_connection(platform_id)
        return JSONResponse(content=result)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/messaging/platforms/{platform_id}/restart-gateway")
async def messaging_restart_gateway(platform_id: str):
    """Restart the gateway for a specific platform."""
    try:
        result = await _ops_thread(
            subprocess.run,
            ["hermes", "gateway", "restart", "--platform", platform_id],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            return JSONResponse(
                status_code=500,
                content={"error": f"restart failed: {result.stderr.strip()}"},
            )
        return JSONResponse(content={"success": True, "message": f"Gateway restarted for platform {platform_id}"})
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "restart timed out"})
    except FileNotFoundError:
        return JSONResponse(status_code=500, content={"error": "hermes command not found"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ─── OAuth 1-Click Setup ──────────────────────────────────────────────────

@app.get("/messaging/platforms/{platform_id}/oauth")
async def messaging_oauth_status(platform_id: str):
    """Return OAuth setup status and auth URL for a platform."""
    try:
        result = _get_oauth_status(platform_id)
        return JSONResponse(content=result)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/messaging/platforms/{platform_id}/oauth/complete")
async def messaging_oauth_complete(platform_id: str, request: Request):
    """Exchange an OAuth code for tokens and save them."""
    try:
        body = await request.json()
        code = body.get("code")
        if not code:
            return JSONResponse(status_code=400, content={"error": "Missing 'code' in request body"})
        result = _complete_oauth(platform_id, code)
        return JSONResponse(content=result)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ─── OAuth Callback (used when user clicks "Authorize" in popup) ───────────
# This route is hit by the OAuth provider after the user authorizes.
# It exchanges the code for tokens server-side and shows a success page
# that closes the popup and signals the opener.

@app.get("/discord/callback")
async def discord_oauth_callback(request: Request):
    from fastapi.responses import HTMLResponse
    code = request.query_params.get("code")
    error = request.query_params.get("error")
    if error or not code:
        return HTMLResponse(
            status_code=400,
            content="<html><body><h2>Discord authorization failed</h2>"
            f"<p>{error or 'No code received'}</p>"
            "<script>window.close()</script></body></html>",
        )
    try:
        _complete_oauth("discord", code)
        return HTMLResponse(
            status_code=200,
            content="<html><body>"
            "<h2> Discord connected!</h2>"
            "<p>You can close this window now.</p>"
            "<script>"
            "if (window.opener) { window.opener.postMessage('oauth-success:discord', '*'); }"
            "setTimeout(() => window.close(), 1500);"
            "</script></body></html>",
        )
    except Exception as e:
        return HTMLResponse(
            status_code=500,
            content=f"<html><body><h2>Error</h2><p>{str(e)}</p>"
            "<script>setTimeout(() => window.close(), 3000)</script></body></html>",
        )


@app.get("/slack/callback")
async def slack_oauth_callback(request: Request):
    from fastapi.responses import HTMLResponse
    code = request.query_params.get("code")
    error = request.query_params.get("error")
    if error or not code:
        return HTMLResponse(
            status_code=400,
            content="<html><body><h2>Slack authorization failed</h2>"
            f"<p>{error or 'No code received'}</p>"
            "<script>window.close()</script></body></html>",
        )
    try:
        _complete_oauth("slack", code)
        return HTMLResponse(
            status_code=200,
            content="<html><body>"
            "<h2> Slack connected!</h2>"
            "<p>You can close this window now.</p>"
            "<script>"
            "if (window.opener) { window.opener.postMessage('oauth-success:slack', '*'); }"
            "setTimeout(() => window.close(), 1500);"
            "</script></body></html>",
        )
    except Exception as e:
        return HTMLResponse(
            status_code=500,
            content=f"<html><body><h2>Error</h2><p>{str(e)}</p>"
            "<script>setTimeout(() => window.close(), 3000)</script></body></html>",
        )


# ------------------------------------------------------------------
# Background cron scheduler
# ------------------------------------------------------------------

async def _cron_scheduler_loop():
    """Background task: check active cron jobs every 30s and trigger them."""
    while True:
        try:
            if _HERMES_CRON_AVAILABLE:
                _run_hermes_tick_now()
                await asyncio.sleep(30)
                continue

            now = datetime.now(timezone.utc)
            for job_id, job in list(_cron_jobs.items()):
                if job.get("status") != "active":
                    continue
                next_run_str = job.get("next_run")
                if not next_run_str:
                    continue
                try:
                    next_run_dt = datetime.fromisoformat(next_run_str)
                    if next_run_dt.tzinfo is None:
                        next_run_dt = next_run_dt.replace(tzinfo=timezone.utc)
                except (ValueError, TypeError):
                    continue
                if now >= next_run_dt:
                    print(f"[cron-scheduler] Triggering job {job_id} ({job.get('name', '')})", flush=True)
                    try:
                        run_time = now.isoformat()
                        job["last_run"] = run_time
                        job["next_run"] = _compute_next_run(job.get("schedule", ""))

                        run_id = str(uuid.uuid4())[:8]
                        run_record = {
                            "run_id": run_id,
                            "job_id": job_id,
                            "started_at": run_time,
                            "completed_at": None,
                            "status": "running",
                            "output": "",
                            "error": None,
                            "tool_log": [],
                        }
                        history = _cron_run_history.setdefault(job_id, [])
                        history.insert(0, run_record)
                        if len(history) > MAX_RUN_HISTORY:
                            _cron_run_history[job_id] = history[:MAX_RUN_HISTORY]
                        _save_cron_jobs()
                        _save_cron_history()

                        t = threading.Thread(target=_run_cron_agent, args=(job, run_record), daemon=True)
                        t.start()
                    except Exception as e:
                        print(f"[cron-scheduler] Error triggering job {job_id}: {e}", flush=True)
        except Exception as e:
            print(f"[cron-scheduler] Scheduler loop error: {e}", flush=True)
        await asyncio.sleep(30)


def _init_mcp_telemetry():
    """Restore persisted MCP dashboard telemetry so metrics survive restarts.

    Called from the lifespan, not from @app.on_event("startup"): FastAPI skips
    on_event handlers entirely whenever `lifespan=` is supplied, so the decorated
    version of this function never ran.
    """
    try:
        db_path = _HERMES_HOME / "mcp-telemetry.db"
        ok = mcp_telemetry.init_persistence(db_path)
        print(f"[mcp-telemetry] persistence {'enabled' if ok else 'unavailable'} ({db_path})", flush=True)
    except Exception as e:
        print(f"[mcp-telemetry] startup init failed: {e}", flush=True)


def _start_cron_scheduler() -> asyncio.Task:
    """Start the cron scheduler loop and return its task handle.

    Returns the task so the lifespan can cancel and await it on shutdown — the
    old fire-and-forget create_task() left the loop running past app teardown, and
    gave tests no way to assert the scheduler was actually alive.
    """
    if _HERMES_CRON_AVAILABLE:
        try:
            job_count = len(_hermes_list_jobs(include_disabled=True))
        except Exception as e:
            job_count = 0
            print(f"[cron] Failed to inspect Hermes jobs on startup: {e}", flush=True)
        print(f"[cron] Hermes-backed scheduler starting with {job_count} jobs", flush=True)
        return asyncio.create_task(_cron_scheduler_loop())

    # Load persisted cron data from disk
    _load_cron_data()
    # Recompute next_run for active jobs (they may have been offline)
    for job_id, job in _cron_jobs.items():
        if job.get("status") == "active" and job.get("schedule"):
            job["next_run"] = _compute_next_run(job["schedule"])
    if _cron_jobs:
        _save_cron_jobs()
    print(f"[cron] Scheduler starting with {len(_cron_jobs)} jobs", flush=True)
    return asyncio.create_task(_cron_scheduler_loop())


# Handle for the running cron scheduler, owned by the lifespan so shutdown can
# cancel it and tests can assert it is alive. None means "not started".
_cron_scheduler_task: Optional[asyncio.Task] = None


if __name__ == "__main__":
    # Belt-and-braces for the module-identity problem. Running `python main.py`
    # binds this file to the `__main__` object, so any `import main` elsewhere
    # would execute it a second time under a second module object with its own,
    # disconnected globals. Registering this module under the name "main" means
    # such an import resolves here instead of re-executing.
    #
    # brain_client.py is the real fix — nothing needs to import main any more —
    # but this keeps any third-party or legacy `import main` honest.
    sys.modules.setdefault("main", sys.modules["__main__"])

    import uvicorn
    try:
        print(
            f"[bridge] listening on {HERMES_BRIDGE_HOST}:{HERMES_PORT} "
            f"(token={'set' if HERMES_BRIDGE_TOKEN else 'unset'})",
            flush=True,
        )
        uvicorn.run(app, host=HERMES_BRIDGE_HOST, port=HERMES_PORT)
    except KeyboardInterrupt:
        pass
