"""ACP transport: drive the real hermes-agent via the Agent Client Protocol.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import asyncio
import os
import re
import time
from typing import Optional

from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

import bridge_workspace
from bridge_events import (
    agent_status_event,
    build_plan_update_event,
    tool_activity_event,
)
from bridge_providers import _provider_ids_for_chat_routing
from bridge_state import _mark_request_finished
from chat_common import (
    ChatCompletionRequest,
    _finalize_tracked_session,
    _format_tool_end_text,
    _format_tool_start_text,
    _get_stream_chunk_size,
    make_delta_chunk,
    _resolve_workspace_id,
    _single_message_sse,
    sse_chunk,
)
from session_tracker import (
    _append_session_chat_chunk,
    _normalize_chat_messages,
    _now_iso,
    _sessions,
    _sessions_lock,
)


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

    request_profile = bridge_workspace._resolve_profile_name(request)
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
        bridge_workspace._resolve_hermes_home(request_profile)
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
