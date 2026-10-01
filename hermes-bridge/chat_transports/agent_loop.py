"""AgentLoopTransport: run the Hermes agent loop in a worker thread.

The default transport. It builds ``HermesAgentAdapter`` (or the legacy
``run_agent.AIAgent`` fallback), wires its callbacks into an ``EventChannel``
and streams the queue through ``drain_to_sse``.

``RunsTransport`` (runs.py) subclasses this: it shares the worker setup,
callbacks, SSE rendering and teardown, and only replaces how the turn itself
runs (``_run_turn``), falling back to this class's agent loop when the gateway
cannot honor the request.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Iterable, Optional

from fastapi.responses import StreamingResponse

import approval_registry
import brain_client
import bridge_state
import bridge_workspace
import mcp_telemetry
from brain_client import _brain_post, _claimed_resources, _claimed_resources_lock
from bridge_events import (
    agent_notice_clear_event,
    agent_status_event,
    fallback_switch_event,
    filter_toolsets_for_plan_mode,
    output_truncation_info,
    stream_retry_event,
    todo_plan_steps,
    tool_activity_event,
    tool_call_begin_event,
    tool_call_end_event,
    transport_status_event,
)
from bridge_providers import MAX_AGENT_ITERATIONS, _moa_native_adapter_required_error
from bridge_state import _update_bridge_metrics
from chat_common import (
    REPO_EDIT_TOOL_NAMES,
    _format_tool_end_text,
    _format_tool_start_text,
    _get_stream_chunk_size,
)
from chat_transports.approvals import agent_loop_approvals_enabled, make_approval_callback
from chat_transports.base import BaseChatTransport, ChatContext, TransportCapabilities
from chat_transports.drain import (
    AGENT_LOOP_HEARTBEAT_SECONDS,
    DrainStats,
    EventChannel,
    delta_frame,
    drain_to_sse,
    stop_frames,
)
from chat_transports.runs_plan import RunsPlan
from moa_config import MOA_PROVIDER_ID
from session_tracker import _append_session_chat_chunk

# Queue kinds forwarded unchanged under a delta key of the same name.
_PASSTHROUGH_KINDS = frozenset({
    "tool_call_begin",
    "tool_call_delta",
    "tool_call_end",
    "stream_retry",
    "plan_update",
    "reasoning",
    "transport_status",
    "computer_use_frame",
    "agent_notice",
    "agent_notice_clear",
    # These two were crossed by d6b3f99: server_tool_event payloads went out
    # under the fallback_switch key and real fallback switches were dropped.
    "server_tool_event",
    "fallback_switch",
    # Spec 4.3: hermes approval prompts, same event the ACP transport emits.
    "approval_request",
})

# Spec 4.4: after Stop, the SSE stream ends within this many seconds even if
# the agent is inside a call it cannot interrupt; the worker finishes later.
CANCEL_GRACE_SECONDS = 1.5

if TYPE_CHECKING:  # fastapi is stubbed without Response in the unit tests
    from fastapi.responses import Response

logger = logging.getLogger(__name__)


@dataclass
class AgentTurn:
    """Inputs for one turn, prepared on the worker thread."""

    user_message: Any
    history: list
    agent_toolsets: list
    agent_repo_mode: bool
    repo_file_tree: list
    custom_tools: list
    reasoning_effort: Optional[str]
    wt_info: Optional[dict]
    worktree_active: bool


class AgentLoopTransport(BaseChatTransport):
    name = "agent-loop"
    # Approvals via hermes' approval callback (4.3), Stop via the real agent's
    # interrupt flag (4.4); resume works because the adapter keys state.db on
    # session_id. Usage is still hard-coded to 0 (4.5).
    capabilities = TransportCapabilities(
        approvals=True,
        cancel=True,
        stops_on_client_disconnect=True,
        session_resume=True,
    )

    def __init__(self, ctx: ChatContext, *, runs_plan: RunsPlan, **kwargs: Any):
        super().__init__(ctx, **kwargs)
        self.runs_plan = runs_plan
        self.chunk_id = ""
        self.channel: Optional[EventChannel] = None
        # Structured tool-call state (worker-thread callbacks may fire from
        # parallel tool execution, hence the lock).
        self._tool_state_lock = threading.Lock()
        self._active_tool_state: dict = {}  # call_id -> {"ts": monotonic, "name": tool}
        self._pending_tool_ids: dict[str, list] = {}  # tool_name -> [call_ids] (FIFO fallback)
        # The agent of the running turn (set on the worker thread) and the
        # guard that makes closing the channel idempotent (worker vs Stop).
        self._agent: Any = None
        self._agent_lock = threading.Lock()
        self._channel_closed = False

    # ── entry point ──────────────────────────────────────────────────────

    async def handle(self) -> Response:
        ctx = self.ctx
        body = ctx.body
        # AIAgent/_using_real_agent were resolved at the top of
        # _chat_completions_impl (right after workspace_id).
        if ctx.resolved_provider == MOA_PROVIDER_ID and not ctx.using_real_agent:
            return _moa_native_adapter_required_error(
                model=body.model,
                finalize_session=ctx.finalize_session,
            )

        self.chunk_id = chunk_id = f"chatcmpl-hermes-{os.urandom(8).hex()}"
        # Brain MCP: register per-request session so overseer can address it directly
        try:
            await brain_client._brain_rpc("tools/call", {"name": "brain_register", "arguments": {"name": f"hermes-request-{chunk_id}"}})
        except Exception:
            pass
        # Brain MCP: publish per-request job metadata keyed by chunk_id so the overseer
        # can correlate in-flight requests and inspect individual job state.
        try:
            brain_client._brain_set(f"bridge:active-request:{chunk_id}", ctx.active_job_meta)
        except Exception:
            pass
        # Bound per request (not at module import) so tests that patch
        # worktree_support reach this request, as before the split.
        from worktree_support import (
            adjust_toolsets_for_worktree,
            cleanup_worktree,
            maybe_setup_worktree,
        )

        self._worktree = (maybe_setup_worktree, adjust_toolsets_for_worktree, cleanup_worktree)
        self.channel = EventChannel(asyncio.get_running_loop())
        # Registered before the stream starts so a Stop that races the first
        # frame still reaches this turn.
        self.register_run(chunk_id)
        return StreamingResponse(self._event_stream(), media_type="text/event-stream")

    # ── cancel (spec 4.4) ────────────────────────────────────────────────

    async def cancel(self) -> bool:
        """Interrupt the running agent and end the stream promptly.

        The real agent checks its interrupt flag between API calls and tool
        steps. A parked approval is denied so the turn does not sit out the
        approval timeout. If the agent is inside a call it cannot interrupt,
        the stream still ends after ``CANCEL_GRACE_SECONDS``.
        """
        approval_registry.deny_all(self.ctx.workspace_id)
        with self._agent_lock:
            agent = self._agent
        if agent is not None:
            await asyncio.to_thread(_interrupt_agent, agent)
        channel = self.channel
        if channel is not None:
            channel.loop.call_later(CANCEL_GRACE_SECONDS, self._close_channel)
        return True

    def _close_channel(self) -> None:
        with self._agent_lock:
            if self._channel_closed:
                return
            self._channel_closed = True
        self.channel.close()

    # ── producer side: agent callbacks (worker thread) ──────────────────

    def _qput(self, item) -> None:
        self.channel.put(item)

    def _repo_claim_resources(self, tool_name: str, tool_input: str) -> list[str]:
        repo_owner, repo_name = self.ctx.repo_owner, self.ctx.repo_name
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

    def on_tool_start(self, tool_name: str, tool_input: str, call_id: Optional[str] = None):
        # Record MCP tool activity for the MCP dashboard (no-op for non-mcp_ tools).
        mcp_telemetry.record_tool_start(tool_name, tool_input)
        # Structured tool_call_begin: stable call_id across begin/delta/end.
        # Agents that know the provider's tool_call id pass it through; the
        # bridge generates one otherwise and pairs begin/end FIFO per tool.
        with self._tool_state_lock:
            if call_id is None:
                call_id = f"hermes-{uuid.uuid4().hex[:16]}"
                self._pending_tool_ids.setdefault(tool_name, []).append(call_id)
            self._active_tool_state[call_id] = {"ts": time.monotonic(), "name": tool_name}
        self._qput(("tool_call_begin", tool_call_begin_event(call_id, tool_name)))
        # Emit tool start as visible text so user sees activity
        self._qput(("tool_start", tool_name, tool_input))
        _append_session_chat_chunk(
            self.ctx.session_id,
            "assistant",
            _format_tool_start_text(tool_name, tool_input),
        )
        # Brain MCP: claim resource for edit operations to prevent conflicts
        if tool_name in REPO_EDIT_TOOL_NAMES:
            for resource in self._repo_claim_resources(tool_name, tool_input):
                brain_client._brain_claim(resource, ttl=120)

    def on_tool_end(
        self,
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
        with self._tool_state_lock:
            if call_id is None:
                pending = self._pending_tool_ids.get(tool_name) or []
                call_id = pending.pop(0) if pending else f"hermes-{uuid.uuid4().hex[:16]}"
            state = self._active_tool_state.pop(call_id, {})
        started_ts = state.get("ts")
        duration_ms = int((time.monotonic() - started_ts) * 1000) if started_ts else 0
        if not output_truncated:
            output_truncated, output_truncated_lines = output_truncation_info(tool_output, cap)
        success = not (tool_output or "").strip().lower().startswith(("error:", "failed:"))
        self._qput(("tool_call_end", tool_call_end_event(
            call_id,
            tool_name,
            success=success,
            exit_code=exit_code,
            duration_ms=duration_ms,
            output_truncated=output_truncated,
            output_truncated_lines=output_truncated_lines,
        )))
        self._qput(("tool_end", tool_name, tool_output[:cap]))
        _append_session_chat_chunk(
            self.ctx.session_id,
            "assistant",
            _format_tool_end_text(tool_name, tool_output),
        )
        # Brain MCP: release resource for edit operations
        if tool_name in REPO_EDIT_TOOL_NAMES:
            for resource in self._repo_claim_resources(tool_name, tool_input):
                brain_client._brain_release(resource)
        # Plan mode-ish: the hermes ``todo`` tool carries a checklist — surface
        # it as a structured plan_update when parseable (agent-loop path).
        if tool_name == "todo":
            steps = todo_plan_steps(tool_output)
            if steps:
                self._qput(("plan_update", {"type": "plan_update", "steps": steps}))

    def on_text(self, text: str):
        _append_session_chat_chunk(self.ctx.session_id, "assistant", text)
        # Stream normal text in small chunks for responsiveness
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            self._qput(("text", text[i:i + chunk_size]))

    def on_thinking(self, iteration: int):
        self._qput(("thinking", iteration))
        # Brain MCP: pulse every 5 iterations (not every iteration — avoids noise)
        if iteration % 5 == 0:
            brain_client._brain_pulse("working", f"iteration={iteration} model={self.ctx.body.model}")

    def on_reasoning(self, text: str):
        # Stream reasoning in small chunks for responsiveness
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            self._qput(("reasoning", text[i:i + chunk_size]))

    def on_server_tool_event(self, event: dict):
        self._qput(("server_tool_event", event))

    def on_fallback_switch(self, provider: str, model: str):
        self._qput(("fallback_switch", fallback_switch_event(provider, model)))

    def on_transport_status(self, requested: str, actual: str, reason: str | None = None):
        self._qput(("transport_status", transport_status_event(requested, actual, reason)))

    def on_stream_retry(self, attempt: int, max_attempts: int, reason: str, delay_ms: int):
        # The agent-loop retried an upstream stream — surface it once per retry.
        self._qput(("stream_retry", stream_retry_event(attempt, max_attempts, reason, delay_ms)))

    def on_computer_use_frame(self, frame: dict):
        self._qput(("computer_use_frame", frame))

    def on_notice(self, notice: dict):
        # Structured AgentNotice (credits warnings, run-budget wrap-up) from
        # the real hermes agent — surfaced as an SSE agent_notice event.
        self._qput(("agent_notice", notice))

    def on_notice_clear(self, key: str):
        self._qput(("agent_notice_clear", agent_notice_clear_event(key)))

    # ── worker thread ────────────────────────────────────────────────────

    def _run_sync(self):
        maybe_setup_worktree, adjust_toolsets_for_worktree, cleanup_worktree = self._worktree
        ctx = self.ctx
        plan = self.runs_plan
        wt_info = None
        worktree_active = False
        try:
            if ctx.use_worktree:
                wt_info = maybe_setup_worktree(ctx.repo_root_header or None)
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
            self.on_transport_status(
                "runs" if plan.use_runs_flag else "agent-loop",
                "runs" if plan.route_via_runs else "agent-loop",
                plan.transport_reason,
            )
            turn = self._prepare_turn(adjust_toolsets_for_worktree, wt_info, worktree_active)
            self._run_turn(turn)
        except Exception as e:
            error_message = str(e)
            print(f"[hermes-bridge] Agent error: {error_message}", flush=True)
            _append_session_chat_chunk(ctx.session_id, "assistant", f"\n\n[Error: {error_message}]")
            self._qput(("text", f"\n\n[Error: {error_message}]"))
            # Brain MCP: report failure
            brain_client._brain_pulse("failed", f"error={error_message[:100]}")
            _update_bridge_metrics(success=False, decrement_active=True)
            ctx.finalize_session(False, error_message=error_message)
        finally:
            if worktree_active and wt_info:
                try:
                    cleanup_worktree(wt_info)
                except Exception as wt_cleanup_err:
                    print(f"[hermes-bridge] Worktree cleanup error: {wt_cleanup_err}", flush=True)
            # Brain MCP: clean up per-request state to prevent zombies
            try:
                # Delete the active request key for this chunk
                brain_client._brain_set(f"bridge:active-request:{self.chunk_id}", "")
                # Release all claimed resources for this request's repo prefix
                # (TTL=120 auto-releases on crash; explicit release on clean exit)
                repo_owner, repo_name = ctx.repo_owner, ctx.repo_name
                repo_prefix = f"hermes-bridge:repo:{repo_owner}/{repo_name}:" if repo_owner and repo_name else None
                with _claimed_resources_lock:
                    to_release = [r for r in list(_claimed_resources) if repo_prefix is None or r.startswith(repo_prefix)]
                    for r in to_release:
                        _claimed_resources.discard(r)
                for r in to_release:
                    brain_client._brain_release(r)
                # Pulse done status
                brain_client._brain_pulse("done", f"completed chunk={self.chunk_id}")
            except Exception:
                pass  # Best-effort cleanup
            with self._agent_lock:
                self._agent = None
            self.unregister_run()
            self._close_channel()

    def _prepare_turn(self, adjust_toolsets_for_worktree, wt_info, worktree_active: bool) -> AgentTurn:
        ctx = self.ctx
        body = ctx.body
        request_messages = ctx.request_messages
        print(f"[hermes-bridge] Using {'real' if ctx.using_real_agent else 'custom'} Hermes agent", flush=True)
        # Log message roles for debugging system prompt delivery
        msg_roles = [m["role"] for m in request_messages]
        has_extra_system = bool((body.model_extra or {}).get("system"))
        print(f"[hermes-bridge] Starting agent. mode={ctx.execution_mode} model={body.model} repo_mode={ctx.has_repo_tools} has_github={'yes' if ctx.github_pat else 'no'} repo={ctx.repo_owner}/{ctx.repo_name} toolsets={ctx.enabled_toolsets} msgs={len(request_messages)} roles={msg_roles} extra_system={has_extra_system}", flush=True)
        if ctx.has_repo_tools and not ctx.github_pat:
            print("[hermes-bridge] WARNING: repo_mode is active but no GitHub PAT provided — read_repo_file will fail", flush=True)
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
            adjust_toolsets_for_worktree(ctx.enabled_toolsets)
            if worktree_active
            else ctx.enabled_toolsets
        )
        if ctx.plan_mode:
            agent_toolsets = filter_toolsets_for_plan_mode(agent_toolsets)
        agent_repo_mode = ctx.has_repo_tools and not worktree_active
        if worktree_active and ctx.has_repo_tools:
            print(
                "[hermes-bridge] Worktree active — local file tools enabled, "
                "GitHub API repo tools disabled for this run",
                flush=True,
            )
        return AgentTurn(
            user_message=user_message,
            history=history,
            agent_toolsets=agent_toolsets,
            agent_repo_mode=agent_repo_mode,
            repo_file_tree=repo_file_tree,
            custom_tools=custom_tools,
            reasoning_effort=reasoning_effort,
            wt_info=wt_info,
            worktree_active=worktree_active,
        )

    def _run_turn(self, turn: AgentTurn) -> None:
        """Run the turn through the Hermes agent loop (blocking)."""
        ctx = self.ctx
        body = ctx.body
        github_pat = ctx.github_pat
        agent_kwargs: dict = {
            "base_url": ctx.agent_base_url,
            "api_key": ctx.agent_api_key,
            "model": body.model,
            "max_iterations": MAX_AGENT_ITERATIONS,
            "enabled_toolsets": turn.agent_toolsets,
            "repo_mode": turn.agent_repo_mode,
            "worktree_mode": turn.worktree_active,
            "repo_edit_intent": ctx.repo_edit_intent,
            "github_pat": github_pat if github_pat else None,
            "github_repo_owner": ctx.repo_owner if ctx.repo_owner else None,
            "github_repo_name": ctx.repo_name if ctx.repo_name else None,
            "repo_file_tree": turn.repo_file_tree,
            "custom_tools": turn.custom_tools,
            "workspace_id": ctx.workspace_id,
            "reasoning_effort": turn.reasoning_effort,
            "plan_mode": ctx.plan_mode,
            "on_tool_start": self.on_tool_start,
            "on_tool_end": self.on_tool_end,
            "on_text": self.on_text,
            "on_server_tool_event": self.on_server_tool_event,
            "on_stream_retry": self.on_stream_retry,
        }
        if ctx.using_real_agent:
            agent_kwargs["on_fallback_switch"] = self.on_fallback_switch
            agent_kwargs["on_computer_use_frame"] = self.on_computer_use_frame
            # Structured notices (credits/run-budget) — real-agent only.
            agent_kwargs["on_notice"] = self.on_notice
            agent_kwargs["on_notice_clear"] = self.on_notice_clear
            # Real-agent only: run_agent.AIAgent's fallback signature does not
            # accept this. Tells the adapter which profile's config.yaml to
            # read instead of the hard-coded ~/.hermes (B9).
            agent_kwargs["hermes_home"] = str(bridge_workspace._resolve_hermes_home(ctx.request_profile))
            if ctx.run_budget_seconds:
                agent_kwargs["run_budget_seconds"] = ctx.run_budget_seconds
            if agent_loop_approvals_enabled():
                # Spec 4.3: real-agent only (the fallback agent has no gate).
                agent_kwargs["approval_callback"] = make_approval_callback(
                    loop=self.channel.loop,
                    conversation_id=ctx.workspace_id,
                    emit=lambda event: self._qput(("approval_request", event)),
                    is_cancelled=lambda: self.cancel_requested,
                    cwd=(turn.wt_info or {}).get("path") or ctx.repo_root_header or None,
                )
        if ctx.resolved_provider == MOA_PROVIDER_ID:
            agent_kwargs["provider_override"] = MOA_PROVIDER_ID
        agent = ctx.agent_class(**agent_kwargs)
        agent.on_thinking = self.on_thinking
        agent.on_reasoning = self.on_reasoning
        with self._agent_lock:
            self._agent = agent
        if self.cancel_requested:
            # Stop arrived while the turn was being set up: don't start it
            # (hermes clears a pending interrupt when a turn begins).
            print("[hermes-bridge] Turn cancelled before the agent started.", flush=True)
            _update_bridge_metrics(success=True, decrement_active=True)
            ctx.finalize_session(True)
            return

        history = turn.history
        print(f"[hermes-bridge] User message: {turn.user_message[:100]}... history_msgs={len(history)} has_system={any(m.get('role') == 'system' for m in history)}", flush=True)
        agent.run_conversation(
            user_message=turn.user_message,
            conversation_history=history,
        )
        print("[hermes-bridge] Agent conversation completed.", flush=True)
        # Brain MCP: pulse on successful completion
        brain_client._brain_pulse("working", "completed")
        # Update bridge health metrics (decrement active request counter)
        _update_bridge_metrics(success=True, decrement_active=True)
        ctx.finalize_session(True)

    # ── consumer side: SSE (event loop) ──────────────────────────────────

    def _thinking_label(self, iteration: int) -> str:
        return (
            "Analyzing repository context..."
            if self.ctx.has_repo_tools and iteration == 1
            else "Analyzing your request..."
            if iteration == 1
            else f"Planning iteration {iteration}..."
        )

    def _render(self, event: tuple, stream_started_at: float) -> Iterable[str]:
        chunk_id, model = self.chunk_id, self.ctx.body.model
        kind = event[0]
        if kind == "text":
            yield delta_frame(chunk_id, model, {"content": event[1]})
        elif kind == "tool_start":
            tool_name, tool_input = event[1], event[2]
            # Emit as both visible text and structured tool_activity
            yield delta_frame(chunk_id, model, {"content": _format_tool_start_text(tool_name, tool_input)})
            yield delta_frame(chunk_id, model, {
                "tool_activity": tool_activity_event(tool_name, "running", tool_input, None)
            })
        elif kind == "tool_end":
            tool_name, tool_output = event[1], event[2]
            yield delta_frame(chunk_id, model, {"content": _format_tool_end_text(tool_name, tool_output)})
            yield delta_frame(chunk_id, model, {
                "tool_activity": tool_activity_event(tool_name, "completed", "", tool_output)
            })
        elif kind in _PASSTHROUGH_KINDS:
            yield delta_frame(chunk_id, model, {kind: event[1]})
        elif kind == "thinking":
            iteration = event[1]
            yield delta_frame(chunk_id, model, {
                "agent_status": agent_status_event(
                    phase="thinking",
                    label=self._thinking_label(iteration),
                    started_at=stream_started_at,
                    iteration=iteration,
                ),
            })
            if iteration > 1:
                # Show a thinking indicator between iterations so the
                # user knows the agent is still working
                yield delta_frame(chunk_id, model, {
                    "content": "\n\n> *Thinking...*\n\n"
                })

    async def _event_stream(self):
        ctx = self.ctx
        body = ctx.body
        chunk_id = self.chunk_id
        # Role chunk
        print(f"[hermes-bridge] SSE stream started. chunk_id={chunk_id}", flush=True)
        stream_started_at = time.monotonic()
        yield delta_frame(chunk_id, body.model, {"role": "assistant"})
        yield delta_frame(chunk_id, body.model, {
            "agent_status": agent_status_event(
                phase="starting",
                label=self.runs_plan.transport_label,
                started_at=stream_started_at,
            ),
        })

        agent_task = asyncio.ensure_future(asyncio.to_thread(self._run_sync))
        stats = DrainStats()
        completed = False
        try:
            async for frame in drain_to_sse(
                self.channel.queue,
                lambda event: self._render(event, stream_started_at),
                heartbeat_seconds=AGENT_LOOP_HEARTBEAT_SECONDS,
                stats=stats,
            ):
                yield frame
            async for frame in self._finish_stream(agent_task, stats, stream_started_at):
                yield frame
            completed = True
        finally:
            # Spec 4.4: a client that leaves mid-turn cancels it unless the
            # request asked for background mode.
            self.on_stream_closed(completed)

    async def _finish_stream(self, agent_task, stats: DrainStats, stream_started_at: float):
        ctx = self.ctx
        body = ctx.body
        chunk_id = self.chunk_id
        event_count = stats.events

        # Final chunk
        print(f"[hermes-bridge] SSE stream ending. Total events emitted: {event_count}", flush=True)
        # Brain MCP: post completion status and update metrics
        elapsed_ms = int((time.monotonic() - stream_started_at) * 1000)
        _brain_post(f"hermes-bridge completed: model={body.model} events={event_count} elapsed_ms={elapsed_ms}", channel="hermes-bridge")
        brain_client._brain_set("hermes-bridge:active_request", "")
        brain_client._brain_set("hermes-bridge:active_sessions", str(bridge_state._bridge_active_requests), "global")
        brain_client._brain_set("hermes-bridge:last_completion", f"model={body.model} events={event_count} elapsed_ms={elapsed_ms}", "global")
        # Bridge metrics — publish final state via _update_bridge_metrics (called from
        # the worker) plus api_calls for the completed request
        brain_client._brain_set("bridge:metrics", json.dumps({
            "active_requests": bridge_state._bridge_active_requests,
            "error_rate": round(bridge_state._bridge_error_count / max(bridge_state._bridge_total_requests, 1), 4),
            "uptime": round(time.time() - bridge_state._bridge_start_time, 1) if bridge_state._bridge_start_time > 0 else 0.0,
            "start_time": bridge_state._bridge_start_time,
            "total_requests": bridge_state._bridge_total_requests,
            "error_count": bridge_state._bridge_error_count,
            "api_calls": event_count,
            "estimated_cost_usd": round(event_count * 0.001, 4),
        }))
        # Brain MCP: per-request metrics keyed by chunk_id for per-request auditing
        try:
            brain_client._brain_set(f"bridge:metrics:{chunk_id}", json.dumps({
                "tokens": 0,
                "api_calls": event_count,
                "cost": round(event_count * 0.001, 4),
                "elapsed_ms": elapsed_ms,
                "model": body.model,
                "repo_mode": ctx.has_repo_tools,
            }))
        except Exception:
            pass
        for frame in stop_frames(chunk_id, body.model):
            yield frame

        if self.cancel_requested and not agent_task.done():
            # Stopped, and the agent is still unwinding an uninterruptible
            # call: don't hold the response open for it.
            agent_task.add_done_callback(_consume_task_result)
            return
        await agent_task


def _interrupt_agent(agent: Any) -> bool:
    """Set the agent's interrupt flag (hermes ``AIAgent.interrupt`` or the fallback's)."""
    interrupt = getattr(agent, "interrupt", None)
    if not callable(interrupt):
        return False
    try:
        interrupt()
    except Exception:  # noqa: BLE001 - a failed interrupt still leaves the stream-side grace close
        logger.warning("agent interrupt failed", exc_info=True)
        return False
    return True


def _consume_task_result(task: "asyncio.Future") -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.warning("cancelled agent-loop worker ended with an error: %s", exc)
