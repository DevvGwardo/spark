#!/usr/bin/env python3
"""A scriptable stand-in for ``hermes-acp`` (spec 7.2).

Speaks real ACP over stdio through the ``agent-client-protocol`` SDK, so the
bridge's ``acp_transport`` is exercised end to end (spawn, initialize,
sessions, notifications, permission requests, cancel) without hermes-agent or
a model. Tests point ``HERMES_ACP_CMD`` at a wrapper that runs this file.

Behaviour is driven by the prompt text:

* default      reply ``echo: <prompt> | history_len=<n>`` where ``n`` is how
               many messages the session already held (so a test can tell a
               restored session from a fresh one)
* ``TOOL``     also emit a tool call (start, progress, completed)
* ``PLAN``     also emit a plan update
* ``THINK``    also emit a thought chunk
* ``PERMISSION`` ask the client for permission and reply with the outcome
* ``SLOW``     wait (up to 10s) until ``session/cancel`` arrives, then end the
               turn with ``stop_reason="cancelled"``

Environment:

* ``FAKE_ACP_STATE``         JSON file holding session transcripts, so they
                             survive the process being reaped or killed (as
                             hermes' state.db does)
* ``FAKE_ACP_LOAD_SESSION``  ``1`` advertises (and implements) load_session
* ``FAKE_ACP_LOG``           append one JSON line per received request, for
                             assertions about what the bridge sent
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from typing import Any

import acp
from acp import schema as s

STATE_PATH = os.environ.get("FAKE_ACP_STATE", "")
LOAD_SESSION = os.environ.get("FAKE_ACP_LOAD_SESSION", "") == "1"
LOG_PATH = os.environ.get("FAKE_ACP_LOG", "")


def _load_state() -> dict:
    if STATE_PATH and os.path.exists(STATE_PATH):
        with open(STATE_PATH) as fh:
            return json.load(fh)
    return {}


def _save_state(state: dict) -> None:
    if STATE_PATH:
        with open(STATE_PATH, "w") as fh:
            json.dump(state, fh)


def _log(kind: str, **fields: Any) -> None:
    if LOG_PATH:
        with open(LOG_PATH, "a") as fh:
            fh.write(json.dumps({"kind": kind, "pid": os.getpid(), **fields}) + "\n")


def _prompt_text(prompt: list) -> str:
    parts = []
    for block in prompt or []:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return "\n".join(parts)


class FakeAgent:
    def __init__(self) -> None:
        self.conn: Any = None
        self.state = _load_state()
        self.cancel_events: dict[str, asyncio.Event] = {}

    def on_connect(self, conn: Any) -> None:
        self.conn = conn

    async def initialize(self, protocol_version: int, client_capabilities: Any = None, client_info: Any = None, **_: Any):
        _log("initialize")
        return s.InitializeResponse(
            protocol_version=protocol_version,
            agent_capabilities=s.AgentCapabilities(load_session=LOAD_SESSION),
        )

    async def new_session(self, cwd: str, **_: Any):
        session_id = f"fake-{uuid.uuid4().hex[:8]}"
        self.state[session_id] = []
        _save_state(self.state)
        _log("new_session", session_id=session_id, cwd=cwd)
        return s.NewSessionResponse(session_id=session_id)

    async def load_session(self, cwd: str, session_id: str, **_: Any):
        _log("load_session", session_id=session_id, cwd=cwd)
        if not LOAD_SESSION:
            raise acp.RequestError.method_not_found("session/load")
        history = self.state.get(session_id)
        if history is None:
            return None
        # Real agents replay the transcript as notifications on load.
        for message in history:
            update = (
                acp.update_user_message_text(message["text"])
                if message["role"] == "user"
                else acp.update_agent_message_text(message["text"])
            )
            await self.conn.session_update(session_id=session_id, update=update)
        return s.LoadSessionResponse()

    async def set_session_model(self, model_id: str, session_id: str, **_: Any):
        _log("set_session_model", model_id=model_id, session_id=session_id)
        return None

    async def close_session(self, session_id: str, **_: Any):
        _log("close_session", session_id=session_id)
        return None

    async def cancel(self, session_id: str, **_: Any) -> None:
        _log("cancel", session_id=session_id)
        event = self.cancel_events.get(session_id)
        if event is not None:
            event.set()

    async def prompt(self, prompt: list, session_id: str, **_: Any):
        text = _prompt_text(prompt)
        history = self.state.setdefault(session_id, [])
        prior = len(history)
        _log("prompt", session_id=session_id, text=text)
        history.append({"role": "user", "text": text})
        conn = self.conn
        stop_reason = "end_turn"
        reply = f"echo: {text} | history_len={prior}"

        if "THINK" in text:
            await conn.session_update(session_id=session_id, update=acp.update_agent_thought_text("thinking hard"))
        if "PLAN" in text:
            await conn.session_update(session_id=session_id, update=acp.update_plan([
                acp.plan_entry("first step", status="completed"),
                acp.plan_entry("second step", status="in_progress"),
            ]))
        if "TOOL" in text:
            await conn.session_update(session_id=session_id, update=acp.start_tool_call(
                "call-1", "read_file", kind="read", status="in_progress", raw_input={"path": "README.md"},
            ))
            await conn.session_update(session_id=session_id, update=acp.update_tool_call(
                "call-1", status="in_progress", content=[acp.tool_content(acp.text_block("partial"))],
            ))
            await conn.session_update(session_id=session_id, update=acp.update_tool_call(
                "call-1", status="completed", content=[acp.tool_content(acp.text_block("file body"))],
            ))
        if "PERMISSION" in text:
            response = await conn.request_permission(
                session_id=session_id,
                tool_call=acp.update_tool_call(
                    "perm-1", title="terminal", kind="execute", status="pending",
                    raw_input={"command": "rm -rf build"},
                ),
                options=[
                    s.PermissionOption(option_id="allow_once", name="Allow once", kind="allow_once"),
                    s.PermissionOption(option_id="deny", name="Deny", kind="reject_once"),
                ],
            )
            outcome = response.outcome
            chosen = getattr(outcome, "option_id", None) or getattr(outcome, "outcome", "?")
            reply = f"permission:{chosen}"
        if "SLOW" in text:
            event = self.cancel_events[session_id] = asyncio.Event()
            try:
                await asyncio.wait_for(event.wait(), timeout=10)
                stop_reason = "cancelled"
                reply = "stopped"
            except asyncio.TimeoutError:
                reply = "slow turn finished without a cancel"
            finally:
                self.cancel_events.pop(session_id, None)

        await conn.session_update(session_id=session_id, update=acp.update_agent_message_text(reply))
        history.append({"role": "assistant", "text": reply})
        _save_state(self.state)
        await conn.session_update(
            session_id=session_id,
            update=s.UsageUpdate(
                session_update="usage_update", used=1000 + prior, size=200000,
                cost=s.Cost(amount=0.0042, currency="USD"),
            ),
        )
        return s.PromptResponse(
            stop_reason=stop_reason,
            usage=s.Usage(
                input_tokens=1200, output_tokens=80, total_tokens=1280,
                cached_read_tokens=200, thought_tokens=10,
            ),
        )


def main() -> None:
    asyncio.run(acp.run_agent(FakeAgent(), use_unstable_protocol=True))


if __name__ == "__main__":
    main()
