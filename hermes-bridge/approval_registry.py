"""Pending tool approvals, shared by every transport (spec 4.3).

A transport that pauses a tool for the user parks an ``asyncio.Future`` here
under an approval id and emits an ``approval_request`` SSE event carrying that
id. ``POST /v1/approvals/{id}`` resolves the future with the user's option.

ACP's ``request_permission`` already worked this way with a per-session dict;
the agent-loop approval callback (which runs on an agent worker thread) now
parks on the same registry through ``wait_blocking``, so one route and one UI
banner serve both transports.

Futures live on the bridge's event loop. ``resolve`` must be called there (the
route is async); ``wait_blocking`` is for worker threads.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass
from typing import Callable, Optional

logger = logging.getLogger(__name__)


@dataclass
class _Pending:
    future: asyncio.Future
    conversation_id: str


_lock = threading.Lock()
_pending: dict[str, _Pending] = {}


def register(approval_id: str, conversation_id: str = "") -> asyncio.Future:
    """Park a future for ``approval_id`` (call on the event loop)."""
    future = asyncio.get_running_loop().create_future()
    with _lock:
        _pending[approval_id] = _Pending(future=future, conversation_id=str(conversation_id or ""))
    return future


def discard(approval_id: str) -> None:
    with _lock:
        _pending.pop(approval_id, None)


def pending_ids(conversation_id: Optional[str] = None) -> list[str]:
    with _lock:
        return [
            aid for aid, p in _pending.items()
            if conversation_id is None or p.conversation_id == conversation_id
        ]


def resolve(approval_id: str, option_id: str) -> bool:
    """Deliver a decision. False when the id is unknown or already answered."""
    with _lock:
        entry = _pending.get(approval_id)
    if entry is None or entry.future.done():
        return False
    entry.future.set_result({"option_id": option_id})
    return True


def deny_all(conversation_id: str) -> int:
    """Answer every pending approval of a conversation with ``deny``.

    Used on cancel: a turn parked on an approval would otherwise sit out the
    full approval timeout before it noticed the Stop.
    """
    with _lock:
        targets = [p for p in _pending.values() if p.conversation_id == conversation_id]
    denied = 0
    for entry in targets:
        if entry.future.done():
            continue
        loop = entry.future.get_loop()
        if loop.is_closed():
            continue
        loop.call_soon_threadsafe(_set_if_pending, entry.future, {"option_id": "deny"})
        denied += 1
    return denied


def _set_if_pending(future: asyncio.Future, value: dict) -> None:
    if not future.done():
        future.set_result(value)


async def wait(
    approval_id: str,
    conversation_id: str,
    timeout: float,
    announce: Optional[Callable[[], None]] = None,
) -> Optional[dict]:
    """Park and await a decision; None on timeout. Always unregisters.

    ``announce`` (emit the approval_request event) runs only once the future
    is parked, so a client that answers instantly cannot race the parking.
    """
    future = register(approval_id, conversation_id)
    try:
        if announce is not None:
            announce()
        return await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        return None
    finally:
        discard(approval_id)


def wait_blocking(
    loop: asyncio.AbstractEventLoop,
    approval_id: str,
    conversation_id: str,
    timeout: float,
    announce: Optional[Callable[[], None]] = None,
) -> Optional[dict]:
    """``wait`` from a worker thread: parks on ``loop`` and blocks for the answer."""
    future = asyncio.run_coroutine_threadsafe(wait(approval_id, conversation_id, timeout, announce), loop)
    try:
        # wait() owns the timeout; the margin only covers scheduling latency.
        return future.result(timeout + 5)
    except Exception:  # noqa: BLE001 - any failure to get an answer is treated as "no decision" (fails closed)
        logger.warning("approval %s: no decision delivered", approval_id, exc_info=True)
        future.cancel()
        return None
