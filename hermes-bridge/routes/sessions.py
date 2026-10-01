"""Routes: /sessions (Hermes Chats view).

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import bridge_providers
import bridge_workspace
from bridge_workspace import (
    _load_state_db_sessions,
    _normalize_profile_name,
    _query_state_db,
)
from session_tracker import _session_summary, _sessions, _sessions_lock

router = APIRouter()


# ------------------------------------------------------------------
# Session endpoints for Hermes Chats view
# ------------------------------------------------------------------

@router.get("/sessions")
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
    profile_name = bridge_workspace._resolve_profile_name(request)
    hermes_home = bridge_workspace._resolve_hermes_home(profile_name)
    with _sessions_lock:
        summaries = [
            _session_summary(session)
            for session in _sessions.values()
            if _normalize_profile_name(session.get("profile")) == profile_name
        ]
    # Merge in sessions from state.db (CLI / cron sessions)
    db_sessions = await bridge_workspace._ops_thread(_load_state_db_sessions, hermes_home=hermes_home)
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


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, request: Request):
    profile_name = bridge_workspace._resolve_profile_name(request)
    hermes_home = bridge_workspace._resolve_hermes_home(profile_name)
    with _sessions_lock:
        session = _sessions.get(session_id)
        if session and _normalize_profile_name(session.get("profile")) == profile_name:
            payload = dict(session)
            payload.pop("profile", None)
            return JSONResponse(content=payload)
    # Fall back to state.db for CLI / cron sessions (sqlite: off the event loop).
    rows = await bridge_workspace._ops_thread(
        _query_state_db,
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
        "chat": await bridge_workspace._ops_thread(
            _load_session_messages, session_id, hermes_home=hermes_home
        ),
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


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, request: Request):
    profile_name = bridge_workspace._resolve_profile_name(request)
    with _sessions_lock:
        session = _sessions.get(session_id)
        if session and _normalize_profile_name(session.get("profile")) == profile_name:
            _sessions.pop(session_id, None)
    return JSONResponse(content={"ok": True})


@router.post("/sessions/{session_id}/fork")
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
        or await bridge_workspace._ops_thread(bridge_providers._get_local_gateway_key)
        or None
    )
    try:
        status, payload = await bridge_workspace._ops_thread(
            hermes_ops.fork_gateway_session,
            session_id,
            base_url=base,
            api_key=api_key,
            title=title,
        )
        return JSONResponse(content=payload, status_code=status)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
