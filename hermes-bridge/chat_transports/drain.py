"""One shared SSE drain loop for every queue-backed chat transport (spec 4.2).

Producers are worker threads (the agent loop, the gateway run pump, the ACP
prompt). They publish through an ``EventChannel``, which hops onto the event
loop with ``call_soon_threadsafe``. ``drain_to_sse`` then awaits the queue
with a timeout instead of sleep-polling it: an event is forwarded as soon as it
lands, and the timeout is what produces the keepalive comment.

Ordering guarantee: ``call_soon_threadsafe`` callbacks run FIFO, so the
``close()`` sentinel always lands after every event the producer queued before
calling it. The drain therefore forwards everything and then stops, which is
what the old ``while not done or not queue.empty()`` loops did.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Iterable, Optional

from chat_common import make_delta_chunk, sse_chunk

# SSE comment frame. Proxies count it as activity; clients ignore it.
HEARTBEAT_FRAME = ": heartbeat\n\n"

# Agent-loop keepalive cadence. The old loop sent a heartbeat every 60 idle
# polls of 50ms, i.e. after 3s without an event.
AGENT_LOOP_HEARTBEAT_SECONDS = 3.0


class _Done:
    """End-of-stream sentinel (a class so it reprs clearly in debugging)."""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<drain DONE>"


DONE = _Done()


class EventChannel:
    """Thread-safe producer side of an ``asyncio.Queue``.

    Must be created on the event loop thread (it captures the running loop).
    ``put`` and ``close`` may then be called from any thread.
    """

    def __init__(self, loop: Optional[asyncio.AbstractEventLoop] = None):
        self.loop = loop or asyncio.get_running_loop()
        self.queue: asyncio.Queue = asyncio.Queue()

    def put(self, item) -> None:
        self.loop.call_soon_threadsafe(self.queue.put_nowait, item)

    def close(self) -> None:
        """Mark the end of the stream; events put after this are dropped."""
        self.loop.call_soon_threadsafe(self.queue.put_nowait, DONE)


@dataclass
class DrainStats:
    """Counters the transports read back after the drain finishes."""

    events: int = 0


async def drain_to_sse(
    queue: asyncio.Queue,
    render: Callable[[tuple], Iterable[str]],
    *,
    heartbeat_seconds: float,
    stats: Optional[DrainStats] = None,
) -> AsyncIterator[str]:
    """Yield SSE frames for each queued event until the ``DONE`` sentinel.

    ``render`` turns one queued event tuple into zero or more SSE frames.
    After ``heartbeat_seconds`` with no event and no heartbeat, a
    ``: heartbeat`` comment is yielded so idle streams stay open through the
    Express proxy's activity timeout.
    """
    last_activity = time.monotonic()
    while True:
        remaining = heartbeat_seconds - (time.monotonic() - last_activity)
        try:
            event = await asyncio.wait_for(queue.get(), timeout=max(remaining, 0.0))
        except asyncio.TimeoutError:
            last_activity = time.monotonic()
            yield HEARTBEAT_FRAME
            continue
        if event is DONE:
            return
        last_activity = time.monotonic()
        if stats is not None:
            stats.events += 1
        for frame in render(event):
            yield frame


def delta_frame(chunk_id: str, model: str, delta: dict) -> str:
    return sse_chunk(make_delta_chunk(chunk_id, model, delta))


def stop_frames(chunk_id: str, model: str) -> list[str]:
    """The final ``finish_reason=stop`` chunk and the ``[DONE]`` marker."""
    return [
        sse_chunk(make_delta_chunk(chunk_id, model, {}, finish_reason="stop")),
        "data: [DONE]\n\n",
    ]
