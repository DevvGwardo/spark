"""Chat request models, SSE chunk helpers, passthrough proxying and session finalize helpers.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import asyncio
import json
import os
import sqlite3
import time
import uuid
from typing import Optional

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import bridge_workspace
from bridge_events import usage_event
from bridge_providers import DEFAULT_MODEL, PASSTHROUGH_TIMEOUT_SECONDS
from bridge_workspace import (
    _read_active_profile_name,
    _save_session_to_db,
    _state_db_path,
)
from provider_config import _get_circuit, NOUS_MODEL_PREFIX
from session_tracker import _now_iso, _sessions, _sessions_lock


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


def make_delta_chunk(
    chunk_id: str,
    model: str,
    delta: dict,
    finish_reason: Optional[str] = None,
    usage: Optional[dict] = None,
) -> dict:
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
    # to finishReason instead of defaulting to 'unknown'. Transports that
    # collect per-turn usage (spec 4.5) pass it; the rest report zeros.
    if finish_reason is not None:
        chunk["usage"] = usage if usage is not None else usage_event(0, 0, 0)
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
        state_db_path = _state_db_path(bridge_workspace._resolve_hermes_home(profile_name))
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
