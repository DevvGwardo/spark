"""The ``ChatTransport`` protocol and the request context every transport gets.

``chat_impl._chat_completions_impl`` does the transport-independent work once
(session tracking, provider routing, request accounting), packs the result into
a ``ChatContext`` and hands it to the transport that ``select_transport``
picks. Each transport owns everything from there to the HTTP response.

Capabilities are declared per transport so later phases (4.3 approvals, 4.4
cancel, 4.5 usage, 4.6 resume, 4.8 UI honesty) have one place to flip a flag
and one method to implement. Today's values are the spec's §2.2 G6 matrix.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    ClassVar,
    Optional,
    Protocol,
    runtime_checkable,
)

from fastapi import Request

import chat_common

if TYPE_CHECKING:  # fastapi is stubbed without Response in the unit tests
    from fastapi.responses import Response


@dataclass(frozen=True)
class TransportCapabilities:
    """What a transport can honor. Mirrors the G6 capability matrix."""

    approvals: bool = False
    cancel: bool = False
    stops_on_client_disconnect: bool = False
    usage_in_stream: bool = False
    session_resume: bool = False


@dataclass
class ChatContext:
    """Everything a transport needs from the routed request.

    Built once by ``chat_impl._chat_completions_impl`` after provider routing.
    ``body`` is the live request model: routing may already have rewritten
    ``body.model`` (MoA preset, credential reroute, custom-endpoint alias).
    """

    request: Request
    body: Any  # chat_common.ChatCompletionRequest
    execution_mode: str
    request_messages: list
    enabled_toolsets: list
    plan_mode: bool
    run_budget_seconds: Optional[int]
    request_profile: str
    repo_owner: str
    repo_name: str
    github_pat: str
    repo_edit_intent: bool
    repo_root_header: str
    use_worktree: bool
    workspace_id: str
    session_id: str
    agent_class: Any
    using_real_agent: bool
    has_repo_tools: bool
    api_key: str
    explicit_provider: str
    resolved_provider: str
    route_source: str
    cli_base_url: str
    cli_is_custom: bool
    agent_base_url: str
    agent_api_key: str
    active_job_meta: Any = None
    extra: dict = field(default_factory=dict)

    def finalize_session(self, success: bool, error_message: Optional[str] = None) -> None:
        chat_common._finalize_tracked_session(
            self.session_id,
            success=success,
            error_message=error_message,
            persist_stub=not self.using_real_agent,
        )


@runtime_checkable
class ChatTransport(Protocol):
    """One way of turning a routed chat request into a response."""

    name: ClassVar[str]
    capabilities: ClassVar[TransportCapabilities]

    async def handle(self) -> Response:
        """Run the turn and return the HTTP response (usually SSE)."""
        ...

    async def cancel(self) -> bool:
        """Stop the in-flight turn. Returns False when unsupported (spec 4.4)."""
        ...


class BaseChatTransport:
    """Shared defaults: no capabilities, cancel unsupported, no usage yet."""

    name: ClassVar[str] = "base"
    capabilities: ClassVar[TransportCapabilities] = TransportCapabilities()

    def __init__(self, ctx: ChatContext, **_: Any):
        self.ctx = ctx

    async def handle(self) -> Response:  # pragma: no cover - abstract
        raise NotImplementedError

    async def cancel(self) -> bool:
        # Spec 4.4 wires real cancellation per transport; today none of the
        # bridge-side transports can stop a turn they started.
        return False

    def resolve_approval(self, approval_id: str, decision: str) -> bool:
        # Spec 4.3: approvals are still resolved through /v1/approvals/{id}.
        return False

    def usage(self) -> Optional[dict]:
        # Spec 4.5: per-turn usage is not collected yet (final chunk reports 0).
        return None


# Type alias for the lazy runs-routing decision passed to select_transport.
RouteViaRuns = Callable[[], bool]
