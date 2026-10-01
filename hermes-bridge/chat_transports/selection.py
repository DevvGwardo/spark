"""The one place a chat request's transport is chosen (spec 4.2).

``x-hermes-execution-mode`` picks swarm, passthrough or ACP outright. Every
other value (including the default ``agent-loop`` and unknown modes) is the
agent-loop family, where the runs decision decides between ``RunsTransport``
and ``AgentLoopTransport``. That decision probes the gateway, so it is passed
in lazily and only evaluated for the agent-loop family.
"""
from __future__ import annotations

from chat_transports.acp import AcpTransport
from chat_transports.agent_loop import AgentLoopTransport
from chat_transports.base import BaseChatTransport, RouteViaRuns
from chat_transports.passthrough import PassthroughTransport
from chat_transports.runs import RunsTransport
from chat_transports.swarm import SwarmTransport

# Execution modes that name a transport directly.
_MODE_TRANSPORTS: dict[str, type[BaseChatTransport]] = {
    "swarm": SwarmTransport,
    "passthrough": PassthroughTransport,
    "acp": AcpTransport,
}


def select_transport(execution_mode: str, *, route_via_runs: RouteViaRuns) -> type[BaseChatTransport]:
    """Return the transport class for a request.

    ``execution_mode`` is the normalized ``x-hermes-execution-mode`` header.
    ``route_via_runs`` is called at most once, and only for the agent-loop
    family.
    """
    direct = _MODE_TRANSPORTS.get(execution_mode)
    if direct is not None:
        return direct
    return RunsTransport if route_via_runs() else AgentLoopTransport
