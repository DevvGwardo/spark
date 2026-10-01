"""The ``ChatTransport`` protocol and the request context every transport gets.

``chat_impl._chat_completions_impl`` does the transport-independent work once
(session tracking, provider routing, request accounting), packs the result into
a ``ChatContext`` and hands it to the transport that ``select_transport``
picks. Each transport owns everything from there to the HTTP response.

Capabilities are declared per transport so the UI (4.8) and the tests have
one place to read what a transport can honor. They mirror the spec's §2.2
capability matrix.

Every transport registers its turn in ``active_runs.REGISTRY`` (spec 4.4), so
``POST /v1/chat/cancel`` reaches it whatever the transport, and a client
disconnect cancels it unless the request asked for ``background: true``.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass, field
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
from active_runs import REGISTRY, ActiveRun

logger = logging.getLogger(__name__)

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

    def as_dict(self) -> dict:
        return asdict(self)


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
    # Spec 4.4: keep the turn running when the client stream goes away
    # (persist-on-disconnect). Off by default; the desktop chat sets it.
    background: bool = False
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


# Strong references to disconnect-cancel tasks so they are not collected mid-flight.
_disconnect_tasks: set = set()


class BaseChatTransport:
    """Shared defaults: no capabilities, cancel unsupported, no usage yet."""

    name: ClassVar[str] = "base"
    capabilities: ClassVar[TransportCapabilities] = TransportCapabilities()

    def __init__(self, ctx: ChatContext, **_: Any):
        self.ctx = ctx
        self.active_run: Optional[ActiveRun] = None

    async def handle(self) -> Response:  # pragma: no cover - abstract
        raise NotImplementedError

    async def cancel(self) -> bool:
        """Stop the in-flight turn. False when this transport cannot."""
        return False

    def resolve_approval(self, approval_id: str, decision: str) -> bool:
        # Approvals are resolved through /v1/approvals/{id} (approval_registry).
        return False

    def usage(self) -> Optional[dict]:
        # Spec 4.5: per-turn usage is not collected yet (final chunk reports 0).
        return None

    # ── spec 4.4: one registry, cancel on disconnect ─────────────────────

    def register_run(self, run_id: str) -> Optional[ActiveRun]:
        """Make this turn reachable by Stop and by the disconnect handler."""
        self.active_run = REGISTRY.register(
            self.ctx.workspace_id,
            run_id,
            transport=self.name,
            cancel=self.cancel if self.capabilities.cancel else None,
            background=self.ctx.background,
        )
        return self.active_run

    def unregister_run(self) -> None:
        run = self.active_run
        if run is not None:
            REGISTRY.unregister(run.conversation_id, run.run_id)

    @property
    def cancel_requested(self) -> bool:
        run = self.active_run
        return bool(run and run.is_cancelled)

    def on_stream_closed(self, completed: bool) -> None:
        """Called from the SSE generator's ``finally``.

        A stream that ends before its final chunk means the client went away.
        Unless the request opted into background mode, that cancels the turn
        so the agent stops spending tokens nobody will read. Scheduled rather
        than awaited: the generator may be closing under a CancelledError.
        """
        run = self.active_run
        if completed or run is None or self.ctx.background or run.is_cancelled:
            return
        if not self.capabilities.stops_on_client_disconnect:
            return
        print(
            f"[hermes-bridge] Client disconnected mid-turn — cancelling {self.name} run "
            f"conversation={run.conversation_id} run={run.run_id}",
            flush=True,
        )
        try:
            loop: Optional[asyncio.AbstractEventLoop] = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            task = loop.create_task(REGISTRY.cancel(run.conversation_id, run.run_id))
            _disconnect_tasks.add(task)
            task.add_done_callback(_disconnect_tasks.discard)
        elif run.loop is not None and not run.loop.is_closed():
            asyncio.run_coroutine_threadsafe(REGISTRY.cancel(run.conversation_id, run.run_id), run.loop)
        else:
            run.cancelled.set()


# Type alias for the lazy runs-routing decision passed to select_transport.
RouteViaRuns = Callable[[], bool]
