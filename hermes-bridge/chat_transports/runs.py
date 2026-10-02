"""RunsTransport: run the turn on the Hermes gateway via ``/v1/runs``.

Selected when ``plan_runs_route`` says the gateway can take the request
(``HERMES_USE_RUNS`` / header / body flag plus a reachable gateway). The worker
re-checks parity once the worktree state is known and falls back to the agent
loop — on the same SSE stream — when the gateway cannot honor the request or
rejects a MoA run.
"""
from __future__ import annotations

import json

import brain_client
from bridge_events import hermes_run_server_tool_event
from bridge_state import _mark_request_finished, _update_bridge_metrics
from active_runs import REGISTRY
from chat_transports.agent_loop import AgentLoopTransport, AgentTurn
from chat_transports.base import TransportCapabilities
from chat_transports.runs_plan import default_toolset_list, toolsets_overridden
from moa_config import MOA_PROVIDER_ID


class RunsTransport(AgentLoopTransport):
    name = "runs"
    # Cancel: the gateway run is stopped (POST /v1/runs/{id}/stop) and an
    # agent-loop fallback is interrupted. Usage comes from run.completed.
    # Approvals are gateway-dependent (approval.* events arrive as
    # server_tool_event), so not advertised.
    capabilities = TransportCapabilities(
        cancel=True,
        stops_on_client_disconnect=True,
        usage_in_stream=True,
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._gateway_run_id: str | None = None

    async def cancel(self) -> bool:
        """Stop this request's gateway run and/or its agent-loop fallback.

        The gateway run has its own registry entry; when the registry cancels
        the whole conversation it has already been flagged (and stops through
        its own hook), so it is only stopped here when this is a direct call.
        """
        run_id = self._gateway_run_id
        if run_id:
            entry = REGISTRY.get(self.ctx.workspace_id, run_id)
            if entry is not None and not entry.is_cancelled:
                await REGISTRY.cancel(self.ctx.workspace_id, run_id)
        # Interrupts an agent-loop fallback, and ends the stream promptly.
        return await super().cancel()

    def _run_turn(self, turn: AgentTurn) -> None:
        import hermes_runs as _hermes_runs

        ctx = self.ctx
        body = ctx.body
        plan = self.runs_plan
        resolved_provider = ctx.resolved_provider
        explicit_provider = ctx.explicit_provider
        workspace_id = ctx.workspace_id
        github_pat = ctx.github_pat
        worktree_active = turn.worktree_active
        wt_info = turn.wt_info
        _gateway_base = plan.gateway_base
        _gateway_key = plan.gateway_key
        _runs_parity = plan.runs_parity

        route_runs = True
        moa_runs_allowed = (
            resolved_provider == MOA_PROVIDER_ID and plan.route_via_runs
        )
        needs_loop, parity_reason = _hermes_runs.needs_agent_loop_parity(
            runs_parity_available=_runs_parity,
            worktree_active=worktree_active,
            # Use resolved_provider so demoted openrouter → custom still
            # forces agent-loop; header-only would miss that path.
            explicit_provider=(explicit_provider or resolved_provider or None),
            moa_provider_id=MOA_PROVIDER_ID,
            moa_runs_allowed=moa_runs_allowed,
            enabled_toolsets=turn.agent_toolsets,
            toolsets_overridden=toolsets_overridden(ctx.request),
            default_toolsets=default_toolset_list(),
            repo_mode=turn.agent_repo_mode,
            github_pat=github_pat if github_pat else None,
            custom_tools=turn.custom_tools or None,
            reasoning_effort=turn.reasoning_effort,
            custom_cli_base_url=(
                ctx.cli_base_url
                if ctx.cli_is_custom and (
                    resolved_provider == "custom"
                    or str(resolved_provider or "").startswith("custom:")
                    or (ctx.agent_base_url and ctx.agent_base_url == ctx.cli_base_url)
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
            # The earlier transport_status said "runs"; correct it (and the
            # capability row the UI keys its affordances on).
            self.on_transport_status("runs", "agent-loop", parity_reason)

        if route_runs:
            user_message = turn.user_message
            history = turn.history
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
                session_key=ctx.request.headers.get("x-hermes-session-key"),
                cwd=worktree_cwd,
                enabled_toolsets=turn.agent_toolsets if _runs_parity else None,
                provider=run_provider,
                reasoning_effort=turn.reasoning_effort,
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

        if not route_runs:
            super()._run_turn(turn)
            return

        run_id = str(run_payload.get("run_id") or "").strip()
        if not run_id:
            raise RuntimeError("Gateway /v1/runs returned no run_id")

        _hermes_runs.register_active_run(
            workspace_id,
            run_id=run_id,
            base_url=_gateway_base,
            api_key=_gateway_key or None,
            background=ctx.background,
        )
        self._gateway_run_id = run_id
        self._qput((
            "server_tool_event",
            hermes_run_server_tool_event(run_id, workspace_id),
        ))

        def _emit_run_event(*args):
            if args and args[0] == "usage":
                self.on_usage(_gateway_usage(args[1], body.model, resolved_provider))
                return
            self._qput(args)

        try:
            _hermes_runs.pump_run_events(
                base_url=_gateway_base,
                api_key=_gateway_key or None,
                run_id=run_id,
                emit=_emit_run_event,
                should_stop=lambda: _hermes_runs.is_run_cancelled(workspace_id, run_id),
            )
        finally:
            # Pass run_id so a late-finishing run cannot delete a newer
            # overlapping run's cancel handle for the same conversation.
            _hermes_runs.unregister_active_run(workspace_id, run_id)
        print(f"[hermes-bridge] Gateway run completed. run_id={run_id}", flush=True)
        brain_client._brain_pulse("working", "completed")
        _update_bridge_metrics(success=True, decrement_active=True)
        ctx.finalize_session(True)
        _mark_request_finished(
            model=body.model,
            success=True,
            summary=f"model={body.model} mode=runs run_id={run_id}",
        )


def _gateway_usage(raw: dict, model: str, provider: str) -> dict:
    """Price the gateway's run.completed usage (input/output are OpenAI-style totals)."""
    import pricing

    return pricing.turn_usage(
        model,
        provider,
        prompt_tokens=raw.get("input_tokens") or raw.get("prompt_tokens") or 0,
        completion_tokens=raw.get("output_tokens") or raw.get("completion_tokens") or 0,
        total_tokens=raw.get("total_tokens"),
        cache_read_tokens=raw.get("cache_read_tokens") or 0,
        cache_write_tokens=raw.get("cache_write_tokens") or 0,
    )
