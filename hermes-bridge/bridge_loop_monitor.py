"""Debug-mode event-loop lag monitor (spec 5.1).

Any sync CLI call, HTTP request or sqlite query made directly inside an
``async def`` route freezes every other request on the bridge until it returns.
This monitor makes those stalls visible: a heartbeat coroutine stamps the time
every ``interval`` seconds, and a watchdog thread notices when the stamp goes
stale for longer than ``threshold_ms``. It then captures the event-loop
thread's stack *while it is still stuck*, so the log names the blocking call
instead of just reporting that something was slow.

Off by default. Enable with ``HERMES_BRIDGE_LOOP_LAG_MONITOR=1`` (threshold
override: ``HERMES_BRIDGE_LOOP_LAG_MS``, default 250).
"""
from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Optional

from bridge_logger import log as _log

ENV_FLAG = "HERMES_BRIDGE_LOOP_LAG_MONITOR"
ENV_THRESHOLD = "HERMES_BRIDGE_LOOP_LAG_MS"
DEFAULT_THRESHOLD_MS = 250.0
_TRUTHY = frozenset({"1", "true", "yes", "on"})


@dataclass
class Stall:
    lag_ms: float
    stack: str


@dataclass
class LoopLagMonitor:
    threshold_ms: float = DEFAULT_THRESHOLD_MS
    interval_s: float = 0.02
    log: bool = True
    stalls: list[Stall] = field(default_factory=list)

    _loop_thread_id: Optional[int] = None
    _last_beat: float = 0.0
    _task: Optional[asyncio.Task] = None
    _watchdog: Optional[threading.Thread] = None
    _stop: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def start(self) -> "LoopLagMonitor":
        """Start on the running loop. Call from inside that loop."""
        self._loop_thread_id = threading.get_ident()
        self._last_beat = time.monotonic()
        self._stop.clear()
        self._task = asyncio.get_running_loop().create_task(self._heartbeat())
        self._watchdog = threading.Thread(target=self._watch, name="loop-lag-watchdog", daemon=True)
        self._watchdog.start()
        return self

    def cancel(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()

    async def _heartbeat(self) -> None:
        while not self._stop.is_set():
            with self._lock:
                self._last_beat = time.monotonic()
            await asyncio.sleep(self.interval_s)

    def _watch(self) -> None:
        reported_beat = None
        poll = max(self.interval_s / 2, 0.005)
        while not self._stop.wait(poll):
            with self._lock:
                beat = self._last_beat
            lag_ms = (time.monotonic() - beat) * 1000 - self.interval_s * 1000
            if lag_ms <= self.threshold_ms or beat == reported_beat:
                continue
            # Still stuck right now: the loop thread's current frame is the culprit.
            frame = sys._current_frames().get(self._loop_thread_id)
            stack = "".join(traceback.format_stack(frame)) if frame is not None else ""
            # Wait for the stall to end so the logged lag is the full duration.
            while not self._stop.is_set():
                with self._lock:
                    if self._last_beat != beat:
                        break
                time.sleep(poll)
            total_ms = (time.monotonic() - beat) * 1000 - self.interval_s * 1000
            reported_beat = beat
            stall = Stall(lag_ms=round(max(total_ms, lag_ms), 1), stack=stack)
            self.stalls.append(stall)
            if self.log:
                _log.warning(
                    "loop-lag",
                    "event loop stalled",
                    lag_ms=stall.lag_ms,
                    threshold_ms=self.threshold_ms,
                    stack=stack[-4000:],
                )


def enabled() -> bool:
    return os.environ.get(ENV_FLAG, "").strip().lower() in _TRUTHY


def start_if_enabled() -> Optional[LoopLagMonitor]:
    """Start a monitor on the running loop when the env flag is set; else None."""
    if not enabled():
        return None
    try:
        threshold = float(os.environ.get(ENV_THRESHOLD, "") or DEFAULT_THRESHOLD_MS)
    except ValueError:
        threshold = DEFAULT_THRESHOLD_MS
    monitor = LoopLagMonitor(threshold_ms=threshold).start()
    _log.info("loop-lag", "event-loop lag monitor enabled", threshold_ms=threshold)
    return monitor
