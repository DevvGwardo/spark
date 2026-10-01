"""AcpTransport: drive the REAL hermes-agent over the Agent Client Protocol.

``x-hermes-execution-mode: acp`` spawns ``hermes-acp`` per conversation (see
acp_transport.py) and relays its updates into the same SSE shapes the
agent-loop transport emits. Moved from acp_chat._acp_chat_completions_impl
(spec 4.2); the helpers it uses (repo-root resolution, prompt prefix, plan
text, reaper, heartbeat setting) stay in acp_chat.
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import TYPE_CHECKING, Iterable, Optional

from fastapi.responses import JSONResponse, StreamingResponse

import acp_chat
import bridge_workspace
from bridge_events import (
    agent_status_event,
    build_plan_update_event,
    tool_activity_event,
)
from bridge_providers import _provider_ids_for_chat_routing
from bridge_state import _mark_request_finished
from chat_common import (
    _finalize_tracked_session,
    _format_tool_end_text,
    _format_tool_start_text,
    _get_stream_chunk_size,
    _single_message_sse,
)
from chat_transports.base import BaseChatTransport, TransportCapabilities
from chat_transports.drain import (
    DrainStats,
    EventChannel,
    delta_frame,
    drain_to_sse,
    stop_frames,
)
from session_tracker import (
    _append_session_chat_chunk,
    _normalize_chat_messages,
    _now_iso,
    _sessions,
    _sessions_lock,
)

# Queue kinds forwarded unchanged under a delta key of the same name.
_PASSTHROUGH_KINDS = frozenset({
    "tool_call_begin",
    "tool_call_delta",
    "tool_call_end",
    "stream_retry",
    "plan_update",
    "reasoning",
    "approval_request",
})

if TYPE_CHECKING:  # fastapi is stubbed without Response in the unit tests
    from fastapi.responses import Response


# Spec 4.4: after Stop the SSE stream ends within this many seconds even if
# hermes-acp is slow to acknowledge session/cancel.
CANCEL_GRACE_SECONDS = 1.5


class AcpTransport(BaseChatTransport):
    name = "acp"
    # Approvals via session/request_permission, Stop via session/cancel.
    # No usage yet, no resume after reap (only the last message is sent).
    capabilities = TransportCapabilities(
        approvals=True,
        cancel=True,
        stops_on_client_disconnect=True,
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._channel = None

    async def cancel(self) -> bool:
        """ACP ``session/cancel`` for this conversation's in-flight prompt."""
        import acp_transport

        cancelled = await acp_transport.cancel_turn(self.ctx.workspace_id)
        channel = self._channel
        if channel is not None:
            channel.loop.call_later(CANCEL_GRACE_SECONDS, channel.close)
        return cancelled

    async def handle(self) -> Response:
        """Chat completions via the ACP transport (real hermes-agent)."""
        import acp_transport

        request = self.ctx.request
        body = self.ctx.body

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
        acp_chat._ensure_acp_reaper()

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

        # Resolved once in chat_impl: the registry, the ACP session and the
        # session tracker must all agree on the conversation id.
        workspace_id = self.ctx.workspace_id
        session_id = workspace_id
        # Resolve the session cwd to a real checkout: explicit header first, then
        # the managed clone for owner/name, then the historical fallbacks. (The
        # bridge process can outlive its original working directory — a build or
        # cleanup step may delete it. os.getcwd() then raises FileNotFoundError
        # and every chat request 500s — fall back to the home directory so
        # requests keep working regardless of what happens to the launch cwd.)
        resolved_repo_root = acp_chat._resolve_acp_repo_root(
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
            acp_chat._content_to_text(request_messages[last_user_idx]["content"])
            if last_user_idx is not None
            else ""
        )
        # The ACP session only receives this one prompt string (history lives in
        # the hermes-acp session server-side), so repo signals that the server
        # sent as headers/body must be inlined here — otherwise the model starts
        # repo turns with no checkout path and no file list.
        repo_file_tree_raw = (body.model_extra or {}).get("repo_file_tree")
        repo_context_prefix = acp_chat._build_acp_repo_context_prefix(
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
        loop = asyncio.get_running_loop()
        channel = EventChannel(loop)
        self._channel = channel
        _qput = channel.put

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
                self.unregister_run()
                channel.close()

        def render(event: tuple) -> Iterable[str]:
            kind = event[0]
            model = body.model
            if kind == "text":
                yield delta_frame(chunk_id, model, {"content": event[1]})
            elif kind == "tool_start":
                tool_name, tool_input = event[1], event[2]
                yield delta_frame(chunk_id, model, {"content": _format_tool_start_text(tool_name, tool_input)})
                yield delta_frame(chunk_id, model, {
                    "tool_activity": tool_activity_event(tool_name, "running", tool_input, None)
                })
            elif kind == "tool_end":
                tool_name, tool_input, tool_output = event[1], event[2], event[3]
                yield delta_frame(chunk_id, model, {"content": _format_tool_end_text(tool_name, tool_output)})
                yield delta_frame(chunk_id, model, {
                    "tool_activity": tool_activity_event(tool_name, "completed", tool_input, tool_output)
                })
            elif kind in _PASSTHROUGH_KINDS:
                yield delta_frame(chunk_id, model, {kind: event[1]})
            elif kind == "thinking":
                yield delta_frame(chunk_id, model, {
                    "agent_status": agent_status_event(
                        phase="thinking",
                        label="Planning...",
                        started_at=started_at,
                        iteration=1,
                    ),
                })
            elif kind == "plan":
                # Keep the legacy markdown flattening (backward compat) and
                # ALSO emit the structured checklist for the UI.
                source = event[1]
                entries = source if isinstance(source, list) else []
                plan_text = acp_chat._format_plan_text(entries)
                if plan_text:
                    yield delta_frame(chunk_id, model, {"content": plan_text})
                plan_update = build_plan_update_event(source)
                if plan_update:
                    yield delta_frame(chunk_id, model, {"plan_update": plan_update})

        async def event_stream():
            yield delta_frame(chunk_id, body.model, {"role": "assistant"})
            yield delta_frame(chunk_id, body.model, {
                "agent_status": agent_status_event(
                    phase="starting",
                    label="Starting Hermes agent (ACP)...",
                    started_at=started_at,
                ),
            })

            agent_task = asyncio.ensure_future(asyncio.to_thread(_run_acp_sync))
            stats = DrainStats()
            completed = False
            try:
                # Wall-clock keepalive below the Express proxy's 30s activity timeout.
                async for frame in drain_to_sse(
                    channel.queue,
                    render,
                    heartbeat_seconds=acp_chat.ACP_SSE_HEARTBEAT_SECONDS,
                    stats=stats,
                ):
                    yield frame
                async for frame in finish(agent_task, stats):
                    yield frame
                completed = True
            finally:
                # Spec 4.4: disconnect cancels unless background was requested.
                self.on_stream_closed(completed)

        async def finish(agent_task, stats: DrainStats):
            elapsed_ms = int((time.monotonic() - started_at) * 1000)
            _mark_request_finished(
                model=body.model,
                success=request_outcome["success"],
                summary=(
                    f"model={body.model} mode=acp success={str(request_outcome['success']).lower()} "
                    f"events={stats.events} elapsed_ms={elapsed_ms}"
                    + (f" error={request_outcome['error'][:80]}" if request_outcome["error"] else "")
                ),
            )
            for frame in stop_frames(chunk_id, body.model):
                yield frame
            if self.cancel_requested and not agent_task.done():
                # Stopped and hermes-acp has not acknowledged yet: don't hold
                # the response open for the worker.
                agent_task.add_done_callback(_consume_task_result)
                return
            await agent_task

        self.register_run(chunk_id)
        return StreamingResponse(event_stream(), media_type="text/event-stream")


def _consume_task_result(task) -> None:
    if not task.cancelled() and task.exception() is not None:
        print(f"[hermes-bridge] cancelled ACP worker ended with an error: {task.exception()}", flush=True)
