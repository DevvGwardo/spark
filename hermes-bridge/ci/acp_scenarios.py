#!/usr/bin/env python3
"""Run one ``acp_transport`` scenario against ``fake_acp_agent.py`` (spec 7.2).

The bridge test suite stubs pydantic process-wide, and the ACP SDK needs the
real one, so the end-to-end ACP tests run each scenario in a fresh interpreter
through this script and assert on the JSON it prints:

    python ci/acp_scenarios.py <scenario> <tmp_dir> [--load-session]

The output is ``{"result": ..., "agent_log": [...]}`` on the last stdout line;
``agent_log`` is every request the fake agent received, across respawns.
"""
from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_DIR = os.path.dirname(HERE)
sys.path.insert(0, BRIDGE_DIR)

FAKE_AGENT = os.path.join(HERE, "fake_acp_agent.py")


def _setup(tmp: str, load_session: bool) -> None:
    wrapper = os.path.join(tmp, "hermes-acp")
    with open(wrapper, "w") as fh:
        fh.write(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_AGENT}" "$@"\n')
    os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IEXEC)
    os.environ.update({
        "HERMES_ACP_CMD": wrapper,
        "HERMES_HOME": tmp,
        "FAKE_ACP_STATE": os.path.join(tmp, "state.json"),
        "FAKE_ACP_LOG": os.path.join(tmp, "agent.log"),
        "FAKE_ACP_LOAD_SESSION": "1" if load_session else "0",
        # Keep the spawn retry fast if a scenario kills the agent.
        "HERMES_ACP_SPAWN_BACKOFF_BASE_MS": "0",
    })


class Harness:
    def __init__(self, tmp: str):
        import acp_transport

        self.at = acp_transport
        self.tmp = tmp
        self.loop = asyncio.get_running_loop()

    async def turn(self, conversation_id, text, history=None, cwd=None, plan_mode=False):
        """One prompt through run_prompt_blocking; returns the emitted events."""
        events: list = []

        def emit(kind, *payload):
            events.append([kind, *[_jsonable(p) for p in payload]])

        error = None
        try:
            await asyncio.to_thread(
                self.at.run_prompt_blocking,
                loop=self.loop,
                conversation_id=conversation_id,
                cwd=cwd or self.tmp,
                user_message=text,
                emit=emit,
                history=history or [],
                plan_mode=plan_mode,
            )
        except Exception as exc:  # noqa: BLE001 - reported to the test as data
            error = f"{type(exc).__name__}: {exc}"
        return {"events": events, "error": error}

    @staticmethod
    def text(turn) -> str:
        return "".join(e[1] for e in turn["events"] if e[0] == "text")

    async def reap_all(self) -> int:
        for handle in list(self.at._sessions.values()):
            handle.last_used = 0
        saved = self.at.IDLE_TIMEOUT_SECONDS
        self.at.IDLE_TIMEOUT_SECONDS = 0.0
        try:
            return await self.at.reap_idle_sessions()
        finally:
            self.at.IDLE_TIMEOUT_SECONDS = saved

    def handle(self, conversation_id):
        return self.at._sessions.get(conversation_id)


def _jsonable(value):
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        if isinstance(value, list):
            return [_jsonable(v) for v in value]
        return {
            k: _jsonable(v) for k, v in vars(value).items()
        } if hasattr(value, "__dict__") else repr(value)


# ── scenarios ────────────────────────────────────────────────────────────────


async def resume(h: Harness) -> dict:
    """Turn, reap mid-conversation, turn again with the request history."""
    first = await h.turn("conv-resume", "my name is Ada")
    first_session = h.handle("conv-resume").session_id
    reaped = await h.reap_all()
    history = [
        {"role": "user", "content": "my name is Ada"},
        {"role": "assistant", "content": h.text(first)},
    ]
    second = await h.turn("conv-resume", "what is my name?", history)
    second_handle = h.handle("conv-resume")
    third = await h.turn("conv-resume", "and again", history)
    return {
        "reaped": reaped,
        "first_session": first_session,
        "second_session": second_handle.session_id,
        "resumed": second_handle.resumed,
        "second_text": h.text(second),
        "third_text": h.text(third),
        "errors": [t["error"] for t in (first, second, third) if t["error"]],
    }


async def first_turn(h: Harness) -> dict:
    turn = await h.turn("conv-new", "hello there")
    return {"text": h.text(turn), "error": turn["error"]}


async def usage(h: Harness) -> dict:
    turn = await h.turn("conv-usage", "count me")
    return {
        "usage": [e[1] for e in turn["events"] if e[0] == "usage"],
        "usage_update": [e[1] for e in turn["events"] if e[0] == "usage_update"],
        "error": turn["error"],
    }


async def translation(h: Harness) -> dict:
    """session_update kinds → the bridge's emit kinds."""
    turn = await h.turn("conv-tr", "THINK TOOL PLAN go")
    return {"events": turn["events"], "error": turn["error"]}


async def permission(h: Harness) -> dict:
    """request_permission parks an approval; /v1/approvals resolves it."""
    results = {}
    for decision in ("allow_once", "deny"):
        events: list = []

        def emit(kind, *payload):
            events.append([kind, *[_jsonable(p) for p in payload]])
            if kind == "approval_request":
                approval_id = payload[0]["approval_id"]
                h.loop.call_soon_threadsafe(
                    lambda: asyncio.ensure_future(h.at.resolve_approval(approval_id, decision))
                )

        await asyncio.to_thread(
            h.at.run_prompt_blocking,
            loop=h.loop, conversation_id=f"conv-perm-{decision}", cwd=h.tmp,
            user_message="PERMISSION please", emit=emit,
        )
        results[decision] = {
            "approvals": [e[1] for e in events if e[0] == "approval_request"],
            "text": "".join(e[1] for e in events if e[0] == "text"),
        }
    import approval_registry

    results["pending_after"] = approval_registry.pending_ids()
    return results


async def cancel(h: Harness) -> dict:
    """session/cancel stops a long prompt promptly."""
    task = asyncio.ensure_future(h.turn("conv-cancel", "SLOW work"))
    for _ in range(200):
        handle = h.handle("conv-cancel")
        if handle is not None and handle.busy:
            break
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.2)
    started = time.monotonic()
    cancelled = await h.at.cancel_turn("conv-cancel")
    turn = await task
    return {
        "cancelled": cancelled,
        "elapsed": time.monotonic() - started,
        "text": h.text(turn),
        "error": turn["error"],
        "missing": await h.at.cancel_turn("nobody"),
    }


async def ensure_session(h: Harness) -> dict:
    """Reuse on the same cwd, respawn on a cwd switch, respawn after a crash."""
    a = await h.turn("conv-es", "one")
    s1 = h.handle("conv-es").session_id
    pid1 = h.handle("conv-es").proc.pid
    b = await h.turn("conv-es", "two")
    s2 = h.handle("conv-es").session_id
    other = os.path.join(h.tmp, "other")
    os.makedirs(other, exist_ok=True)
    c = await h.turn("conv-es", "three", cwd=other)
    s3 = h.handle("conv-es").session_id
    pid3 = h.handle("conv-es").proc.pid
    # Crash: kill the agent; the next turn must respawn transparently.
    proc = h.handle("conv-es").proc
    proc.kill()
    await proc.wait()
    d = await h.turn("conv-es", "four", cwd=other)
    s4 = h.handle("conv-es").session_id
    pid4 = h.handle("conv-es").proc.pid
    retries = [e[1]["reason"] for t in (c, d) for e in t["events"] if e[0] == "stream_retry"]
    return {
        "sessions": [s1, s2, s3, s4],
        "pids": [pid1, pid3, pid4],
        "texts": [h.text(t) for t in (a, b, c, d)],
        "retry_reasons": retries,
        "errors": [t["error"] for t in (a, b, c, d) if t["error"]],
    }


SCENARIOS = {
    "resume": resume,
    "first_turn": first_turn,
    "usage": usage,
    "translation": translation,
    "permission": permission,
    "cancel": cancel,
    "ensure_session": ensure_session,
}


async def _main(name: str, tmp: str) -> dict:
    h = Harness(tmp)
    try:
        result = await asyncio.wait_for(SCENARIOS[name](h), timeout=90)
    finally:
        await h.at.shutdown_all()
    log_path = os.environ["FAKE_ACP_LOG"]
    agent_log = []
    if os.path.exists(log_path):
        with open(log_path) as fh:
            agent_log = [json.loads(line) for line in fh if line.strip()]
    return {"result": result, "agent_log": agent_log}


def main() -> None:
    name, tmp = sys.argv[1], sys.argv[2]
    _setup(tmp, load_session="--load-session" in sys.argv[3:])
    out = asyncio.run(_main(name, tmp))
    print(json.dumps(out, default=repr))


if __name__ == "__main__":
    main()
