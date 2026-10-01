"""Decide whether an agent-loop-mode request goes through gateway ``/v1/runs``.

``plan_runs_route`` is the request-time half of the runs decision (flag,
gateway probe, parity). ``select_transport`` calls it only for agent-loop
mode, and ``RunsTransport`` re-checks parity on the worker once the worktree
state is known.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

import bridge_providers
from bridge_config import DEFAULT_TOOLSETS
from moa_config import MOA_PROVIDER_ID


@dataclass(frozen=True)
class RunsPlan:
    use_runs_flag: bool
    gateway_base: str
    gateway_key: str
    runs_parity: bool
    route_via_runs: bool
    transport_label: str
    transport_reason: Optional[str]


def default_toolset_list() -> list[str]:
    """``DEFAULT_TOOLSETS`` as a list (the toolsets the UI sends by default)."""
    return [t.strip() for t in DEFAULT_TOOLSETS.split(",") if t.strip()]


def toolsets_overridden(request) -> bool:
    """True when the caller chose toolsets explicitly (``x-hermes-toolsets``)."""
    return request.headers.get("x-hermes-toolsets") is not None


def plan_runs_route(ctx) -> RunsPlan:
    """Compute the runs flag, gateway target and routing decision for ``ctx``."""
    import hermes_runs as _hermes_runs

    request = ctx.request
    body = ctx.body
    resolved_provider = ctx.resolved_provider
    enabled_toolsets = ctx.enabled_toolsets
    workspace_id = ctx.workspace_id

    _use_runs_flag = _hermes_runs.parse_use_runs_flag(
        env_value=os.environ.get("HERMES_USE_RUNS"),
        header_value=request.headers.get("x-hermes-use-runs"),
        body_value=(body.model_extra or {}).get("hermes_use_runs"),
    )
    _gateway_base = _hermes_runs.resolve_gateway_base_url()
    _gateway_key = (
        ctx.api_key
        or os.environ.get("HERMES_API_KEY", "").strip()
        or os.environ.get("API_SERVER_KEY", "").strip()
        or (bridge_providers._get_local_gateway_key() or "")
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
                worktree_active=ctx.use_worktree,
                explicit_provider=resolved_provider,
                moa_provider_id=MOA_PROVIDER_ID,
                moa_runs_allowed=_hermes_runs.parse_runs_moa_flag(),
                enabled_toolsets=enabled_toolsets,
                # These two were undefined names here (NameError → 500 for any
                # HERMES_USE_RUNS request the gateway could not take). Same
                # semantics as the worker-side parity check in RunsTransport.
                toolsets_overridden=toolsets_overridden(request),
                default_toolsets=default_toolset_list(),
                repo_mode=ctx.has_repo_tools,
                github_pat=ctx.github_pat or None,
                custom_tools=_requested_custom_tools if isinstance(_requested_custom_tools, list) else None,
                reasoning_effort=(body.model_extra or {}).get("reasoning_effort"),
                custom_cli_base_url=(
                    ctx.cli_base_url
                    if ctx.cli_is_custom and (
                        resolved_provider == "custom"
                        or (resolved_provider or "").startswith("custom:")
                        or ctx.route_source.startswith("config.yaml-custom")
                        or ctx.route_source == "explicit-custom"
                    )
                    else None
                ),
            )
            if _needs_loop and _needs_loop_reason:
                _transport_reason = _needs_loop_reason[:1].upper() + _needs_loop_reason[1:]

    return RunsPlan(
        use_runs_flag=_use_runs_flag,
        gateway_base=_gateway_base,
        gateway_key=_gateway_key,
        runs_parity=_runs_parity,
        route_via_runs=_route_via_runs,
        transport_label=_transport_label,
        transport_reason=_transport_reason,
    )
