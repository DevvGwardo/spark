"""One registry of in-flight chat turns for every transport (spec 4.4).

Before this, only gateway ``/v1/runs`` turns were cancellable, through a
``hermes_runs._active_runs`` dict keyed by conversation id alone. That key is
what made B7 possible: a late-finishing run could pop the handle of a newer
overlapping run on the same conversation.

Entries here are keyed by ``(conversation_id, run_id)``, so removal is
compare-and-delete by construction: a run can only ever unregister itself.
A conversation can briefly hold several entries (a gateway run plus the
request-level entry of the transport that submitted it, or an old run still
draining while a new one starts); cancelling the conversation cancels all of
them, which is what the Stop button means.

Each entry carries an optional ``cancel`` hook supplied by its transport:

* agent-loop  - sets the real agent's interrupt flag
* ACP         - ``conn.cancel(session_id)`` on the hermes-acp connection
* runs        - ``POST /v1/runs/{id}/stop`` on the gateway

The hook may be a plain function or a coroutine function. ``cancel`` awaits it
on the event loop; ``cancel_blocking`` is for worker threads and runs a
coroutine hook on the loop it was registered from.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Union

logger = logging.getLogger(__name__)

CancelHook = Callable[[], Union[None, bool, Awaitable[Any]]]


@dataclass
class ActiveRun:
    conversation_id: str
    run_id: str
    transport: str
    cancel_hook: Optional[CancelHook] = None
    # True when the client asked for the turn to outlive its HTTP stream.
    background: bool = False
    # Transport-specific details (the runs transport keeps base_url/api_key).
    meta: dict = field(default_factory=dict)
    cancelled: threading.Event = field(default_factory=threading.Event)
    started_at: float = field(default_factory=time.monotonic)
    # Loop the entry was registered from; coroutine hooks run there.
    loop: Optional[asyncio.AbstractEventLoop] = None
    seq: int = 0

    @property
    def is_cancelled(self) -> bool:
        return self.cancelled.is_set()


def _key(value: Any) -> str:
    return str(value or "").strip()


class ActiveRunRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._runs: dict[tuple[str, str], ActiveRun] = {}
        self._seq = 0

    # ── registration ─────────────────────────────────────────────────────

    def register(
        self,
        conversation_id: str,
        run_id: str,
        *,
        transport: str,
        cancel: Optional[CancelHook] = None,
        background: bool = False,
        **meta: Any,
    ) -> Optional[ActiveRun]:
        cid, rid = _key(conversation_id), _key(run_id)
        if not cid or not rid:
            return None
        try:
            loop: Optional[asyncio.AbstractEventLoop] = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        with self._lock:
            self._seq += 1
            run = ActiveRun(
                conversation_id=cid,
                run_id=rid,
                transport=transport,
                cancel_hook=cancel,
                background=bool(background),
                meta=dict(meta),
                loop=loop,
                seq=self._seq,
            )
            self._runs[(cid, rid)] = run
        return run

    def unregister(self, conversation_id: str, run_id: Optional[str] = None) -> bool:
        """Remove one run (compare-and-delete), or every run of the conversation.

        ``run_id=None`` is the explicit "clear whatever is there" reset; every
        completion path passes its own run_id, so it can never remove a newer
        run's entry.
        """
        cid = _key(conversation_id)
        if not cid:
            return False
        with self._lock:
            if run_id is not None:
                return self._runs.pop((cid, _key(run_id)), None) is not None
            keys = [k for k in self._runs if k[0] == cid]
            for k in keys:
                del self._runs[k]
            return bool(keys)

    def clear(self) -> None:
        with self._lock:
            self._runs.clear()

    # ── lookup ───────────────────────────────────────────────────────────

    def get(self, conversation_id: str, run_id: str) -> Optional[ActiveRun]:
        with self._lock:
            return self._runs.get((_key(conversation_id), _key(run_id)))

    def runs_for(self, conversation_id: str, *, transport: Optional[str] = None) -> list[ActiveRun]:
        """Runs of one conversation, oldest first."""
        cid = _key(conversation_id)
        with self._lock:
            runs = [r for (c, _), r in self._runs.items() if c == cid]
        if transport is not None:
            runs = [r for r in runs if r.transport == transport]
        return sorted(runs, key=lambda r: r.seq)

    def latest(self, conversation_id: str, *, transport: Optional[str] = None) -> Optional[ActiveRun]:
        runs = self.runs_for(conversation_id, transport=transport)
        return runs[-1] if runs else None

    def all(self) -> list[ActiveRun]:
        with self._lock:
            return sorted(self._runs.values(), key=lambda r: r.seq)

    def is_cancelled(self, conversation_id: str, run_id: Optional[str] = None) -> bool:
        if run_id is not None:
            run = self.get(conversation_id, run_id)
            return bool(run and run.is_cancelled)
        return any(r.is_cancelled for r in self.runs_for(conversation_id))

    # ── cancellation ─────────────────────────────────────────────────────

    def _targets(self, conversation_id: str, run_id: Optional[str]) -> list[ActiveRun]:
        if run_id is not None:
            run = self.get(conversation_id, run_id)
            return [run] if run else []
        return self.runs_for(conversation_id)

    async def cancel(self, conversation_id: str, run_id: Optional[str] = None) -> bool:
        """Flag and stop the conversation's runs. True when anything was active."""
        targets = self._targets(conversation_id, run_id)
        # Flag everything first, so a hook that stops a sibling run (the runs
        # transport stops its own gateway run) can see it is already handled.
        for run in targets:
            run.cancelled.set()
        for run in targets:
            await _invoke_hook_async(run)
        return bool(targets)

    def cancel_blocking(self, conversation_id: str, run_id: Optional[str] = None, *, timeout: float = 15.0) -> bool:
        """``cancel`` for worker threads (never call it on the event loop thread)."""
        targets = self._targets(conversation_id, run_id)
        for run in targets:
            run.cancelled.set()
        for run in targets:
            _invoke_hook_blocking(run, timeout)
        return bool(targets)


async def _invoke_hook_async(run: ActiveRun) -> None:
    hook = run.cancel_hook
    if hook is None:
        return
    try:
        result = hook()
        if inspect.isawaitable(result):
            await result
    except Exception:  # noqa: BLE001 - the cancelled flag is already set; the worker stops on its next check
        logger.warning("cancel hook failed for %s/%s (%s)", run.conversation_id, run.run_id, run.transport, exc_info=True)


def _invoke_hook_blocking(run: ActiveRun, timeout: float) -> None:
    hook = run.cancel_hook
    if hook is None:
        return
    try:
        result = hook()
        if inspect.isawaitable(result):
            if run.loop is None or run.loop.is_closed():
                # No loop to run it on: drop it (the flag is set) and close the
                # coroutine so it does not warn as never-awaited.
                getattr(result, "close", lambda: None)()
                return
            asyncio.run_coroutine_threadsafe(_await(result), run.loop).result(timeout)
    except Exception:  # noqa: BLE001 - the cancelled flag is already set; the worker stops on its next check
        logger.warning("cancel hook failed for %s/%s (%s)", run.conversation_id, run.run_id, run.transport, exc_info=True)


async def _await(awaitable: Awaitable[Any]) -> Any:
    return await awaitable


REGISTRY = ActiveRunRegistry()
