import os
import json
import asyncio
import time
import threading
import subprocess
import uuid
import sys
import hashlib
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
import httpx
import pricing
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

app: FastAPI = None  # created after brain-lifespan is defined

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


def _build_hermes_run_history(job_id: str) -> list[dict]:
    if not _HERMES_CRON_AVAILABLE:
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
# Uses MCP Python SDK to spawn brain-mcp server as a stdio subprocess.
# All brain calls are fire-and-forget — bridge continues if brain is unavailable.
try:
    from mcp.client.stdio import StdioServerParameters, stdio_client
    from mcp import ClientSession

    _brain_session: Optional[ClientSession] = None
    _brain_initialized = False
    _brain_ctx_stack = None  # holds the raw context manager object

    # --- Raw JSON-RPC over subprocess (bypasses MCP SDK's broken stdio transport) ---
    _brain_proc: asyncio.subprocess.Process = None
    _brain_reader_task: asyncio.Task = None
    _brain_pending: dict[int, asyncio.Future] = {}
    _brain_msg_id: int = 0
    _main_event_loop: Optional[asyncio.AbstractEventLoop] = None
    _heartbeat_task: Optional[asyncio.Task] = None
    _claimed_resources: set = set()
    _claimed_resources_lock = threading.Lock()

    async def _brain_reader():
        """Read JSON-RPC responses from brain-mcp and resolve pending futures."""
        import json
        while True:
            try:
                line = await _brain_proc.stdout.readline()
                if not line:
                    break
                msg = json.loads(line.decode())
                mid = msg.get("id")
                if mid is not None and mid in _brain_pending:
                    fut = _brain_pending.pop(mid)
                    if not fut.done():
                        fut.set_result(msg)
            except Exception:
                break

    async def _brain_rpc(method: str, params: dict) -> dict:
        """Send a JSON-RPC request and wait for response. Returns the result dict."""
        import json
        global _brain_msg_id
        if _brain_proc is None or _brain_proc.returncode is not None:
            return None
        mid = _brain_msg_id
        _brain_msg_id += 1
        msg = json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}) + "\n"
        fut: asyncio.Future = asyncio.Future()
        _brain_pending[mid] = fut
        try:
            _brain_proc.stdin.write(msg.encode())
            await _brain_proc.stdin.drain()
            result = await asyncio.wait_for(fut, timeout=10)
            return result.get("result")
        except Exception:
            _brain_pending.pop(mid, None)
            return None

    async def _bridge_heartbeat():
        """Background task: pulse brain with bridge health every 30 seconds."""
        while True:
            try:
                await asyncio.sleep(30)
                uptime = int(time.time() - _bridge_start_time) if _bridge_start_time > 0 else 0
                # Use a local lock to snapshot active count for the pulse message
                with _claimed_resources_lock:
                    active = _bridge_active_requests
                    claimed = len(_claimed_resources)
                pulse_msg = f"uptime={uptime}s active={active} claimed={claimed}"
                _brain_pulse("working", pulse_msg)
                health = {
                    "uptime": uptime,
                    "active_requests": _bridge_active_requests,
                    "total_requests": _bridge_total_requests,
                    "error_count": _bridge_error_count,
                    "claimed_resources": claimed,
                }
                _brain_set("bridge:health", json.dumps(health))
            except asyncio.CancelledError:
                break
            except Exception:
                pass  # Silently continue on errors

    async def _brain_lifespan(app):
        """FastAPI lifespan — spawns brain-mcp as async subprocess, shuts down cleanly."""
        global _brain_proc, _brain_reader_task, _brain_initialized, _bridge_start_time, _bridge_total_requests, _bridge_error_count
        try:
            brain_path = os.path.expanduser("~/brain-mcp/dist/index.js")
            if not os.path.exists(brain_path):
                brain_path = "/Users/devgwardo/brain-mcp/dist/index.js"
            _brain_proc = await asyncio.create_subprocess_exec(
                "/opt/homebrew/bin/node", brain_path,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={
                    "BRAIN_ROOM": os.path.expanduser("~"),
                    "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
                },
            )
            _brain_reader_task = asyncio.create_task(_brain_reader())
            # Initialize MCP session
            await _brain_rpc("initialize", {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "hermes-bridge", "version": "1.0"},
            })
            # Register and set initial state
            await _brain_rpc("tools/call", {"name": "brain_register", "arguments": {"name": "hermes-bridge"}})
            await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "hermes-bridge:active_sessions", "value": "0", "scope": "global"}})
            await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "hermes-bridge:model", "value": DEFAULT_MODEL, "scope": "global"}})
            await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "hermes-bridge:toolsets", "value": DEFAULT_TOOLSETS, "scope": "global"}})
            # Publish bridge health metadata
            import platform, sys
            health_meta = json.dumps({
                "port": HERMES_PORT,
                "model": DEFAULT_MODEL,
                "toolsets": DEFAULT_TOOLSETS,
                "max_iterations": MAX_AGENT_ITERATIONS,
                "python": f"{sys.version_info.major}.{sys.version_info.minor}",
                "platform": platform.platform(),
            })
            await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "bridge:health", "value": health_meta, "scope": "global"}})
            # Publish bridge contracts (inter-agent interface agreements)
            _bridge_start_time = time.time()
            _bridge_total_requests = 0
            _bridge_error_count = 0
            _bridge_iterations_total = 0
            _bridge_request_count = 0
            contracts = json.dumps({
                "hermes-bridge:v1": {
                    "description": "Hermes agent bridge — OpenAI-compatible /v1/chat/completions proxy with repo tools",
                    "port": HERMES_PORT,
                    "model": DEFAULT_MODEL,
                    "toolsets": DEFAULT_TOOLSETS,
                    "max_iterations": MAX_AGENT_ITERATIONS,
                    "endpoints": ["/health", "/v1/models", "/v1/chat/completions", "/v1/swarm"],
                    "headers": {
                        "x-hermes-toolsets": "comma-separated toolset list",
                        "x-hermes-execution-mode": "agent-loop | passthrough | swarm",
                        "x-hermes-repo-owner": "GitHub repo owner (for repo mode)",
                        "x-hermes-repo-name": "GitHub repo name (for repo mode)",
                        "x-hermes-github-pat": "GitHub PAT for repo operations",
                        "x-hermes-repo-edit-intent": "1 to enable edit-mode tools",
                    },
                },
            })
            await _brain_rpc("tools/call", {"name": "brain_contract_set", "arguments": {"key": "hermes-bridge:contracts", "value": contracts, "scope": "global"}})
            metrics_contract = json.dumps({
                "description": "Bridge operational metrics published by hermes-bridge",
                "keys": {
                    "bridge:health": "JSON — port, model, toolsets, platform info",
                    "bridge:metrics": "JSON — api_calls, estimated_cost_usd, active_requests, error_rate, uptime, start_time",
                    "hermes-bridge:active_request": "Current request metadata (owner/repo/model/toolsets)",
                    "hermes-bridge:active_sessions": "Number of active sessions (global counter)",
                },
            })
            await _brain_rpc("tools/call", {"name": "brain_contract_set", "arguments": {"key": "bridge:metrics:contract", "value": metrics_contract, "scope": "global"}})
            # Publish swarm pattern contracts (3-phase pipeline interface)
            swarm_contract = json.dumps({
                "description": "Architect → Implementor → Reviewer swarm pipeline for hermes-bridge",
                "modules": {
                    "hermes-bridge/swarm_pattern.py": {
                        "SwarmCoordinator": {
                            "run_phase_architect": {"phase": "architect", "brain_keys": {"writes": ["request:<id>:ctx"], "polls": ["plan:<id>"]}},
                            "run_phase_implementor": {"phase": "implementor", "brain_keys": {"writes": ["request:<id>:phase", "staging:<id>:<filepath>"], "polls": ["request:<id>:staging_keys"]}},
                            "run_phase_reviewer": {"phase": "reviewer", "brain_keys": {"writes": ["request:<id>:verdict"], "polls": ["request:<id>:staging_keys"]}},
                            "_finish": {"phase": "done", "brain_keys": {"writes": ["request:<id>:status"], "polls": ["request:<id>:phase"]}},
                        },
                        "run_swarm": {
                            "params": ["user_message", "conversation_history", "enabled_toolsets", "repo_mode", "repo_owner", "repo_name", "github_pat"],
                            "returns": {"success": "bool", "verdict": "str", "review_notes": "str", "staged_files": "dict", "elapsed_ms": "int"},
                        },
                    },
                },
            })
            await _brain_rpc("tools/call", {"name": "brain_contract_set", "arguments": {"key": "swarm:contracts", "value": swarm_contract, "scope": "global"}})
            # Publish initial health metrics with uptime tracking
            health_metrics = json.dumps({
                "active_requests": 0,
                "error_rate": 0.0,
                "uptime": 0.0,
                "start_time": _bridge_start_time,
                "port": HERMES_PORT,
                "model": DEFAULT_MODEL,
                "toolsets": DEFAULT_TOOLSETS,
                "platform": platform.platform(),
                "python": f"{sys.version_info.major}.{sys.version_info.minor}",
            })
            await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "bridge:metrics", "value": health_metrics, "scope": "global"}})
            # Verify contracts are readable (contract check on self)
            try:
                result = await _brain_rpc("tools/call", {"name": "brain_contract_check", "arguments": {}})
                if result:
                    print(f"[hermes-bridge] Contract check passed: {result}", flush=True)
            except Exception:
                pass
            _brain_initialized = True
            # Capture the running event loop for thread-safe brain calls
            global _main_event_loop
            _main_event_loop = asyncio.get_running_loop()
            # Start background heartbeat task
            global _heartbeat_task
            _heartbeat_task = asyncio.create_task(_bridge_heartbeat())
            print(f"[hermes-bridge] Brain MCP connected PID={_brain_proc.pid}", flush=True)
        except Exception as e:
            print(f"[hermes-bridge] Brain MCP init failed: {e}", flush=True)
            _brain_initialized = False

        yield

        if _heartbeat_task:
            _heartbeat_task.cancel()
            try:
                await asyncio.wait_for(_heartbeat_task, timeout=2)
            except Exception:
                pass
        if _brain_reader_task:
            _brain_reader_task.cancel()
        if _brain_proc:
            try:
                _brain_proc.terminate()
                await asyncio.wait_for(_brain_proc.wait(), timeout=3)
            except Exception:
                pass
        _brain_initialized = False

    async def _brain_call_async(tool: str, args: dict):
        """Make a brain tool call, returns result dict or None."""
        return await _brain_rpc("tools/call", {"name": tool, "arguments": args})

    def _brain_get(key: str, scope: str = "global") -> Optional[str]:
        """Helper to read brain state text. Thread-safe via run_coroutine_threadsafe."""
        if not _brain_initialized or _brain_proc is None:
            return None
        try:
            if _main_event_loop and _main_event_loop.is_running():
                # Use run_coroutine_threadsafe to schedule on the main event loop
                future = asyncio.run_coroutine_threadsafe(
                    _brain_call_async("brain_get", {"key": key, "scope": scope}),
                    _main_event_loop,
                )
                result = future.result(timeout=5)
            else:
                result = None
        except Exception:
            return None
        if isinstance(result, dict):
            content = result.get("content") or result.get("value")
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        return item.get("text")
            if isinstance(content, str):
                return content
        return None

    def _brain_set(key: str, value: str, scope: str = "global"):
        """Helper to set brain state. Thread-safe via run_coroutine_threadsafe."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            if _main_event_loop and _main_event_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    _brain_call_async("brain_set", {"key": key, "value": value, "scope": scope}),
                    _main_event_loop,
                )
        except Exception:
            pass

    def _brain_post(content: str, channel: str = "general"):
        """Helper to post to brain channel. Thread-safe via run_coroutine_threadsafe."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            if _main_event_loop and _main_event_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    _brain_call_async("brain_post", {"content": content, "channel": channel}),
                    _main_event_loop,
                )
        except Exception:
            pass

    def _brain_pulse(status: str = "working", progress: str = ""):
        """Helper to send brain pulse. Thread-safe via run_coroutine_threadsafe."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            if _main_event_loop and _main_event_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    _brain_call_async("brain_pulse", {"status": status, "progress": progress}),
                    _main_event_loop,
                )
        except Exception:
            pass

    def _brain_claim(resource: str, ttl: int = 60):
        """Helper to claim a brain resource. Thread-safe via run_coroutine_threadsafe.
        Also tracks the resource in _claimed_resources for bulk cleanup."""
        if not _brain_initialized or _brain_proc is None:
            return None
        try:
            with _claimed_resources_lock:
                _claimed_resources.add(resource)
            if _main_event_loop and _main_event_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    _brain_call_async("brain_claim", {"resource": resource, "ttl": ttl}),
                    _main_event_loop,
                )
                return True  # Fire-and-forget from threads; claim will auto-expire via TTL
        except Exception:
            return None
        return None

    def _brain_release(resource: str):
        """Helper to release a brain resource. Thread-safe via run_coroutine_threadsafe."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            with _claimed_resources_lock:
                _claimed_resources.discard(resource)
            if _main_event_loop and _main_event_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    _brain_call_async("brain_release", {"resource": resource}),
                    _main_event_loop,
                )
        except Exception:
            pass

    def _brain_dm(target: str, content: str):
        """Helper to send a direct message to another agent via brain DM. Thread-safe."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            if _main_event_loop and _main_event_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    _brain_call_async("brain_dm", {"target": target, "content": content}),
                    _main_event_loop,
                )
        except Exception:
            pass

    def _brain_contract_set(key: str, value: str, scope: str = "global"):
        """Helper to publish a bridge contract. Thread-safe."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            if _main_event_loop and _main_event_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    _brain_call_async("brain_contract_set", {"key": key, "value": value, "scope": scope}),
                    _main_event_loop,
                )
        except Exception:
            pass

    def _brain_contract_get(key: str, scope: str = "global") -> Optional[str]:
        """Helper to read a published contract, returns value or None. Thread-safe."""
        if not _brain_initialized or _brain_proc is None:
            return None
        try:
            if _main_event_loop and _main_event_loop.is_running():
                future = asyncio.run_coroutine_threadsafe(
                    _brain_call_async("brain_contract_get", {"key": key, "scope": scope}),
                    _main_event_loop,
                )
                result = future.result(timeout=5)
            else:
                result = None
        except Exception:
            return None
        if isinstance(result, dict):
            content = result.get("content") or result.get("value")
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        return item.get("text")
            if isinstance(content, str):
                return content
        return None

    def _brain_contract_check(key: str, expected: str) -> bool:
        """Check that a published contract matches expected value. Returns True if match or brain unavailable."""
        val = _brain_contract_get(key)
        if val is None:
            return True  # brain unavailable — assume match
        return val == expected

    def _update_bridge_metrics(success: bool, increment_active: bool = False, decrement_active: bool = False):
        """Update bridge health metrics (active_requests, error_rate, uptime)."""
        global _bridge_total_requests, _bridge_error_count, _bridge_start_time, _bridge_active_requests
        if not _brain_initialized or _brain_proc is None:
            return
        if decrement_active:
            _bridge_active_requests = max(0, _bridge_active_requests - 1)
        if increment_active:
            _bridge_active_requests += 1
        if not success:
            _bridge_error_count += 1
        error_rate = round(_bridge_error_count / max(_bridge_total_requests, 1), 4)
        uptime = round(time.time() - _bridge_start_time, 1) if _bridge_start_time > 0 else 0.0
        metrics = json.dumps({
            "active_requests": _bridge_active_requests,
            "error_rate": error_rate,
            "uptime": uptime,
            "start_time": _bridge_start_time,
            "total_requests": _bridge_total_requests,
            "error_count": _bridge_error_count,
        })
        _brain_set("bridge:metrics", metrics)

except ImportError:
    # mcp package not available, bridge runs without brain integration
    _brain_session = None
    _brain_initialized = False
    _brain_ctx_stack = None
    _brain_proc = None
    _brain_reader_task = None
    _brain_pending = {}
    _brain_msg_id = 0
    _bridge_start_time: float = 0.0
    _bridge_total_requests: int = 0
    _bridge_error_count: int = 0

    async def _brain_rpc(method: str, params: dict):
        return None
    async def _brain_reader():
        pass
    async def _brain_lifespan(app):
        yield
    async def _brain_call_async(*args, **kwargs):
        return None
    def _brain_get(*args, **kwargs):
        return None
    def _brain_set(*args, **kwargs):
        pass
    def _brain_post(*args, **kwargs):
        pass
    def _brain_pulse(*args, **kwargs):
        pass
    def _brain_claim(*args, **kwargs):
        return None
    def _brain_release(*args, **kwargs):
        pass
    def _brain_dm(*args, **kwargs):
        pass
    def _brain_contract_set(*args, **kwargs):
        pass
    def _brain_contract_get(*args, **kwargs):
        return None
    def _brain_contract_check(*args, **kwargs):
        return True
    def _update_bridge_metrics(*args, **kwargs):
        pass

HERMES_PORT = int(os.environ.get("HERMES_PORT", "3002"))
OPENROUTER_KEY = os.environ.get("HERMES_OPENROUTER_KEY", "")
MINIMAX_KEY = os.environ.get("HERMES_MINIMAX_KEY", "")
HERMES_BRIDGE_TOKEN = os.environ.get("HERMES_BRIDGE_TOKEN", "")
HERMES_BRIDGE_VERSION = os.environ.get("HERMES_BRIDGE_VERSION", "dev")
DEFAULT_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "web,browser,terminal")

def _load_cli_model_config() -> dict:
    """Read the `model:` block from ~/.hermes/config.yaml (Hermes CLI config).

    Returns a dict with keys: default, provider, base_url, api_key (each may be None).
    """
    result = {"default": None, "provider": None, "base_url": None, "api_key": None}
    try:
        config_path = Path.home() / ".hermes" / "config.yaml"
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


_cli_model_config = _load_cli_model_config()
_cli_default_model = _cli_model_config.get("default")
DEFAULT_MODEL = os.environ.get("HERMES_DEFAULT_MODEL", _cli_default_model or "meta-llama/llama-4-maverick")

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
}

# Build a reverse lookup: model_prefix → provider_id
_MODEL_PREFIX_TO_PROVIDER: dict[str, str] = {}
for _pid, _cfg in _PROVIDER_CONFIG.items():
    for _pfx in _cfg.get("model_prefixes", []):
        _MODEL_PREFIX_TO_PROVIDER[_pfx] = _pid

# Known hosts for custom base_url detection
_KNOWN_HOSTS: tuple[str, ...] = tuple(
    {u.split("://")[-1].split("/")[0].replace("api.", "").replace("www.", "")
     for u in [_c["base_url"] for _c in _PROVIDER_CONFIG.values()]}
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
    "openai": "openai-api", "xai": "xai", "kimi": "kimi-coding",
    "zai": "zai", "alibaba": "alibaba", "huggingface": "huggingface",
    "kilocode": "kilocode", "nous": "nous", "minimax": "minimax",
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

app = FastAPI(title="Hermes Bridge", lifespan=_brain_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/diag")
async def diag():
    return {
        "token": HERMES_BRIDGE_TOKEN,
        "pid": os.getpid(),
        "home": os.path.expanduser("~"),
        "bridge_version": HERMES_BRIDGE_VERSION,
    }


def _provider_has_credentials(pid: str) -> bool:
    """Whether a configured bridge provider has usable credentials.

    Mirrors the exact credential logic the /health endpoint reports.
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
        or bool(_get_local_gateway_key())
    )


def _default_model_credentialed() -> bool:
    """Whether the agent's configured default model can actually be served.

    `provider_credentials` only covers _PROVIDER_CONFIG, so a default model
    routed through a config.yaml custom base_url — e.g. deepseek-v4-pro via
    opencode-go, which is not a _PROVIDER_CONFIG entry — is invisible there.
    This mirrors the chat route's credential resolution for the configured
    model so /health doesn't under-report what the bridge can serve.
    """
    cfg = _load_cli_model_config()
    if (cfg.get("api_key") or "").strip():
        return True
    provider = (cfg.get("provider") or "").strip().lower()
    if provider in _PROVIDER_CONFIG and _provider_has_credentials(provider):
        return True
    if provider and _get_credential_pool_key(provider):
        return True
    return bool(_get_local_gateway_key())


@app.get("/health")
async def health():
    # Check credential availability for all configured providers
    provider_credentials: dict[str, bool] = {}
    for pid in _PROVIDER_CONFIG:
        provider_credentials[pid] = _provider_has_credentials(pid)

    cursor_composer = _cursor_composer_integration_status(hermes_home=_HERMES_HOME)

    return {
        "status": "ok",
        "has_openrouter_creds": provider_credentials.get("openrouter", False),
        "has_minimax_creds": provider_credentials.get("minimax", False),
        "provider_credentials": provider_credentials,
        "default_model_credentialed": _default_model_credentialed(),
        "cursor_composer_bridge": cursor_composer,
        "launch_token_present": bool(HERMES_BRIDGE_TOKEN),
        "brain_initialized": _brain_initialized,
        "active_requests": _bridge_active_requests,
        # Read ~/.hermes/config.yaml on every call so the Electron app observes
        # `hermes model` CLI changes without requiring a bridge restart. Falls
        # back to the startup-cached DEFAULT_MODEL if the config file is missing
        # or unreadable. The file read is tiny (~KB) and only happens on this
        # endpoint, which is polled at low rates by the UI.
        "hermes_default_model": _load_cli_default_model() or DEFAULT_MODEL,
    }


@app.get("/v1/models")
async def list_models():
    models = await _get_agent_models()
    return {"object": "list", "data": models}


@app.get("/v1/providers")
async def list_providers():
    """List configured providers with credential status and known models."""
    cfg_provider = (_load_cli_model_config().get("provider") or "").strip().lower()
    default_provider = cfg_provider if (cfg_provider and cfg_provider in _PROVIDER_CONFIG) else "openrouter"

    data = []
    for pid, cfg in _PROVIDER_CONFIG.items():
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

    # The agent's CLI-configured default model (config.yaml `model.default`),
    # read fresh so a model change in the terminal is reflected by clients that
    # follow the agent default. Mirrors /health's hermes_default_model.
    default_model = _load_cli_default_model() or DEFAULT_MODEL

    return {
        "object": "list",
        "default_provider": default_provider,
        "default_model": default_model,
        "data": data,
    }


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

    if summary:
        return f"\n\n> **{display}** — {summary}\n\n"
    return f"\n\n> **{display}**\n\n"


def _format_tool_end_text(tool_name: str, tool_output: str) -> str:
    """Format a tool_end event as a brief completion note.

    Only shows a short, meaningful summary — never raw file contents.
    """
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


def _build_agent_status(
    *,
    phase: str,
    label: str,
    started_at: float,
    iteration: Optional[int] = None,
) -> dict:
    status = {
        "phase": phase,
        "label": label,
        "elapsed_ms": max(0, int((time.monotonic() - started_at) * 1000)),
        "source": "hermes-bridge",
    }
    if iteration is not None:
        status["iteration"] = iteration
    return status


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
        chunk["usage"] = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
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


async def _chat_completions_impl(request: Request, body: ChatCompletionRequest):
    toolsets_header = request.headers.get("x-hermes-toolsets", DEFAULT_TOOLSETS)
    enabled_toolsets = [t.strip() for t in toolsets_header.split(",") if t.strip()]
    execution_mode = request.headers.get("x-hermes-execution-mode", "agent-loop").strip().lower() or "agent-loop"
    request_profile = _resolve_profile_name(request)
    repo_owner = request.headers.get("x-hermes-repo-owner", "")
    repo_name = request.headers.get("x-hermes-repo-name", "")
    github_pat = request.headers.get("x-hermes-github-pat", "")
    repo_edit_intent = request.headers.get("x-hermes-repo-edit-intent", "") == "1"
    request_messages = _normalize_chat_messages(body.messages, model=body.model, strip_images=True)

    # Resolve workspace_id from conversation_id (header or body) for per-conversation isolation
    workspace_id = _resolve_workspace_id(request, body)

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
    _save_session_to_db(_sessions[session_id])

    # If the latest user message is a hermes-agent skill command (/skill ...),
    # expand it in place into the skill's invocation prompt so the agent loop
    # actually runs the skill. The session record above keeps the original
    # slash command for display.
    _maybe_expand_skill_command(request_messages)

    def _finalize_session(success: bool, error_message: Optional[str] = None):
        with _sessions_lock:
            session = _sessions.get(session_id)
            if not session:
                return
            session["status"] = "completed" if success else "error"
            session["messages"] = len(session.get("chat", []))
            session["updated_at"] = _now_iso()
            session["error"] = error_message if error_message else None
            _save_session_to_db(session)

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
    auth_header = request.headers.get("authorization", "")
    api_key = (
        (auth_header[7:] if auth_header.startswith("Bearer ") else "")
        or OPENROUTER_KEY
        or _get_openrouter_key_from_hermes_creds()
        or _get_local_gateway_key()
    )

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

    cli_cfg = _load_cli_model_config()
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
    if explicit_provider and explicit_provider in _PROVIDER_CONFIG:
        resolved_provider = explicit_provider
        route_source = "explicit-header"
    #   1. Model prefix match (strongest signal — the model identifier names the provider)
    elif model_prefix_provider:
        resolved_provider = model_prefix_provider
        route_source = "model-prefix"
    #   2. CLI config.yaml provider
    elif cli_provider and cli_provider in _PROVIDER_CONFIG:
        resolved_provider = cli_provider
        route_source = "config.yaml"
    #   3. auth.json active_provider
    elif active_provider and active_provider in _PROVIDER_CONFIG:
        resolved_provider = active_provider
        route_source = "auth.json"
    #   4. Default
    else:
        resolved_provider = "openrouter"
        route_source = "default"

    # Credential-aware reroute: if the resolved provider can't be served (no usable
    # credential) but the gateway IS authed for another provider that serves this
    # model, switch to it so a running, credentialed Hermes gateway "just works"
    # instead of 401-ing at an uncredentialed native API (e.g. deepseek-v4-flash
    # name-routes to native DeepSeek, but only Nous is credentialed and serves it
    # as deepseek/deepseek-v4-flash). The caller's explicit provider header and an
    # explicit custom base_url both still win — only auto-resolved routes reroute.
    if route_source != "explicit-header" and not cli_is_custom and (
        resolved_provider not in _PROVIDER_CONFIG
        or not _provider_has_credentials(resolved_provider)
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

    # Custom non-hardcoded base_url overrides the resolved provider — UNLESS the
    # caller explicitly named a provider (UI picker), which always wins so the
    # selection isn't silently hijacked by a custom base_url in config.yaml.
    if cli_is_custom and cli_provider not in _PROVIDER_CONFIG and route_source != "explicit-header":
        # Credential priority for a custom base_url: the api_key configured
        # alongside the model in ~/.hermes/config.yaml wins (the user set it
        # there explicitly), then the auth.json credential pool, then a key
        # forwarded by the client, then the local gateway token. Without the
        # config.yaml fallback the bridge ignored a perfectly good key and
        # returned 401 — e.g. deepseek-v4-pro via opencode-go.
        cli_key = (
            cli_api_key
            or _get_credential_pool_key(cli_provider)
            or api_key
            or _get_local_gateway_key()
        )
        if not cli_key:
            return _no_api_key_error(cli_provider or "cli-config")
        agent_base_url = cli_base_url
        agent_api_key = cli_key
        print(
            f"[hermes-bridge] Routing via ~/.hermes/config.yaml custom base_url. "
            f"provider={cli_provider} base_url={cli_base_url} model={body.model}",
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
            # Generic provider: try credential pool first, then env var
            auth_provider = provider_cfg.get("auth_json_provider", resolved_provider)
            agent_api_key = (
                _get_credential_pool_key(auth_provider)
                or os.environ.get(provider_cfg.get("env_var", ""), "")
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

    try:
        from hermes_adapter import HermesAgentAdapter as AIAgent
        _using_real_agent = True
    except Exception as _adapter_err:
        print(f"[hermes-bridge] Adapter import failed: {_adapter_err}", flush=True)
        from run_agent import AIAgent
        _using_real_agent = False

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

    def on_tool_start(tool_name: str, tool_input: str):
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

    def on_tool_end(tool_name: str, tool_input: str, tool_output: str):
        _qput(("tool_end", tool_name, tool_output[:500]))
        _append_session_chat_chunk(
            session_id,
            "assistant",
            _format_tool_end_text(tool_name, tool_output),
        )
        # Brain MCP: release resource for edit operations
        if tool_name in REPO_EDIT_TOOL_NAMES:
            for resource in _repo_claim_resources(tool_name, tool_input):
                _brain_release(resource)

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

    def _run_agent_sync():
        try:
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
            agent = AIAgent(
                base_url=agent_base_url,
                api_key=agent_api_key,
                model=body.model,
                max_iterations=MAX_AGENT_ITERATIONS,
                enabled_toolsets=enabled_toolsets,
                repo_mode=has_repo_tools,
                repo_edit_intent=repo_edit_intent,
                github_pat=github_pat if github_pat else None,
                github_repo_owner=repo_owner if repo_owner else None,
                github_repo_name=repo_name if repo_name else None,
                repo_file_tree=repo_file_tree,
                custom_tools=custom_tools,
                workspace_id=workspace_id,
                on_tool_start=on_tool_start,
                on_tool_end=on_tool_end,
                on_text=on_text,
                on_server_tool_event=on_server_tool_event,
            )
            agent.on_thinking = on_thinking
            agent.on_reasoning = on_reasoning

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
            "agent_status": _build_agent_status(
                phase="starting",
                label="Starting Hermes agent loop...",
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
                        "tool_activity": {"tool": tool_name, "status": "running", "input": tool_input, "output": None}
                    }))
                elif event[0] == "tool_end":
                    tool_name, tool_output = event[1], event[2]
                    text = _format_tool_end_text(tool_name, tool_output)
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": {"tool": tool_name, "status": "completed", "input": "", "output": tool_output}
                    }))
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
                        "agent_status": _build_agent_status(
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
                elif event[0] == "server_tool_event":
                    event_data = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "server_tool_event": event_data
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
            "agent_status": _build_agent_status(
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
                "agent_status": _build_agent_status(
                    phase="swarm_done",
                    label=f"Swarm {'approved' if success else 'needs changes'}",
                    started_at=started_at,
                ),
            }))

            # Include the full result in a server_tool_event so the frontend can access it
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                "server_tool_event": {
                    "type": "swarm_result",
                    "success": success,
                    "verdict": verdict,
                    "review_notes": review_notes,
                    "staged_files": list(staged.keys()),
                    "plan": plan,
                    "elapsed_ms": elapsed_ms,
                },
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
                "agent_status": _build_agent_status(
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
        jobs = [_map_hermes_job(job) for job in _hermes_list_jobs(include_disabled=True)]
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
        job = _hermes_create_job(
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
        if not _hermes_remove_job(job_id):
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
        updated = _hermes_pause_job(job_id)
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
        updated = _hermes_resume_job(job_id)
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
        job = _hermes_get_job(job_id)
        if not job:
            return JSONResponse(status_code=404, content={"error": "not found"})
        updated = _hermes_trigger_job(job_id)
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
    if _HERMES_CRON_AVAILABLE:
        if not _hermes_get_job(job_id):
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
        from tools.mcp_tool import shutdown_mcp_servers, discover_mcp_tools

        shutdown_mcp_servers()
        discover_mcp_tools()
        return True
    except Exception as exc:
        print(f"[hermes-bridge] MCP reload skipped: {exc}", flush=True)
        return False


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
        skills = _list_skills_hub(hermes_home=hermes_home)
        return JSONResponse(content={"skills": skills})
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "skills hub request timed out"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/workspace/skills/hub/install")
async def workspace_skill_install(payload: HermesHubSkillInstallRequest, request: Request):
    hermes_home = _resolve_hermes_home(_resolve_profile_name(request))
    try:
        result = _install_hub_skill(payload.name, hermes_home=hermes_home)
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
    try:
        command_env = os.environ.copy()
        command_env["HERMES_HOME"] = str(hermes_home)
        result = subprocess.run(
            ["hermes", "skills", "uninstall", skill_name],
            capture_output=True,
            text=True,
            timeout=60,
            env=command_env,
        )
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
        result = subprocess.run(
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


@app.on_event("startup")
async def _start_cron_scheduler():
    if _HERMES_CRON_AVAILABLE:
        try:
            job_count = len(_hermes_list_jobs(include_disabled=True))
        except Exception as e:
            job_count = 0
            print(f"[cron] Failed to inspect Hermes jobs on startup: {e}", flush=True)
        print(f"[cron] Hermes-backed scheduler starting with {job_count} jobs", flush=True)
        asyncio.create_task(_cron_scheduler_loop())
        return

    # Load persisted cron data from disk
    _load_cron_data()
    # Recompute next_run for active jobs (they may have been offline)
    for job_id, job in _cron_jobs.items():
        if job.get("status") == "active" and job.get("schedule"):
            job["next_run"] = _compute_next_run(job["schedule"])
    if _cron_jobs:
        _save_cron_jobs()
    print(f"[cron] Scheduler starting with {len(_cron_jobs)} jobs", flush=True)
    asyncio.create_task(_cron_scheduler_loop())


if __name__ == "__main__":
    import uvicorn
    try:
        uvicorn.run(app, host="0.0.0.0", port=HERMES_PORT)
    except KeyboardInterrupt:
        pass
