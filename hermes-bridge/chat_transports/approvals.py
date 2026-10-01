"""Agent-loop tool approvals (spec 4.3).

hermes-agent asks for approval of a dangerous command through a per-thread
callback (``tools.terminal_tool.set_approval_callback``), consulted only in an
interactive context. Its signature, as hermes' own ACP adapter implements it::

    callback(command, description, *, allow_permanent=True,
             allow_session=True, smart_denied=False, **_) -> str

returning ``"once" | "session" | "always" | "deny" | "timeout"``.

The callback built here emits the same ``approval_request`` SSE event the ACP
transport emits (so the existing approval banner renders it), parks on the
shared ``approval_registry`` and blocks the agent's worker thread until
``POST /v1/approvals/{id}`` answers it, the turn is cancelled, or it times out.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from typing import Any, Callable, Optional

import approval_registry
from bridge_events import build_approval_request_event, clamp_acp_option_id

logger = logging.getLogger(__name__)

# Bridge-issued approval ids. Node forwards ids with this prefix (and ACP's
# ``acp-``) to the bridge; anything else is its own approval engine's.
APPROVAL_ID_PREFIX = "bridge-"

_OPTION_TO_HERMES = {
    "allow_once": "once",
    "allow_session": "session",
    "allow_always": "always",
    "deny": "deny",
    "deny_always": "deny",
}

_DEFAULT_TIMEOUT_SECONDS = 300.0


def agent_loop_approvals_enabled() -> bool:
    """Escape hatch: HERMES_BRIDGE_AGENT_LOOP_APPROVALS=0 restores auto-approval."""
    return os.environ.get("HERMES_BRIDGE_AGENT_LOOP_APPROVALS", "1").strip().lower() not in {"0", "false", "no", "off"}


def approval_timeout_seconds() -> float:
    """hermes' own ``approvals.timeout`` (default 300s), so both prompts agree."""
    try:
        from tools.approval_context import _get_approval_timeout

        return float(_get_approval_timeout())
    except Exception:  # noqa: BLE001 - older/absent hermes-agent: use hermes' documented default
        logger.debug("approvals.timeout unavailable; using %ss", _DEFAULT_TIMEOUT_SECONDS, exc_info=True)
        return _DEFAULT_TIMEOUT_SECONDS


def _options(*, allow_permanent: bool, allow_session: bool, smart_denied: bool) -> list[dict]:
    options = [{"option_id": "allow_once", "name": "Allow once"}]
    if allow_session and not smart_denied:
        options.append({"option_id": "allow_session", "name": "Allow for session"})
    if allow_permanent and not smart_denied:
        options.append({"option_id": "allow_always", "name": "Always allow"})
    options.append({"option_id": "deny", "name": "Deny"})
    return options


def make_approval_callback(
    *,
    loop: asyncio.AbstractEventLoop,
    conversation_id: str,
    emit: Callable[[dict], None],
    is_cancelled: Callable[[], bool],
    cwd: Optional[str] = None,
    timeout: Optional[float] = None,
) -> Callable[..., str]:
    """Build the hermes approval callback for one agent-loop turn."""

    def _callback(
        command: str,
        description: str = "",
        *,
        allow_permanent: bool = True,
        allow_session: bool = True,
        smart_denied: bool = False,
        **_: Any,
    ) -> str:
        if is_cancelled():
            return "deny"
        approval_id = f"{APPROVAL_ID_PREFIX}{uuid.uuid4().hex[:16]}"
        options = _options(
            allow_permanent=allow_permanent,
            allow_session=allow_session,
            smart_denied=smart_denied,
        )
        command_text = str(command or "")
        summary = str(description or "").strip() or "Run command"
        event = build_approval_request_event(
            approval_id=approval_id,
            session_id=conversation_id,
            tool="terminal",
            kind="execute",
            summary=summary,
            excerpt=command_text[:2000],
            options=options,
            command=command_text[:2000] or None,
            cwd=cwd,
            reason=str(description or "") or None,
        )
        decision = approval_registry.wait_blocking(
            loop,
            approval_id,
            conversation_id,
            timeout if timeout is not None else approval_timeout_seconds(),
            announce=lambda: emit(event),
        )
        if decision is None:
            return "timeout"
        offered = {o["option_id"] for o in options}
        option_id = clamp_acp_option_id(decision.get("option_id"), offered)
        return _OPTION_TO_HERMES.get(option_id, "deny")

    return _callback
