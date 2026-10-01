"""Chat transport tests (spec 4.2).

Covers the single transport-selection function (table test), the shared
``drain_to_sse`` loop, the capability matrix, the SSE event order of the
agent-loop and ACP transports, and the request-time runs-routing reason
(which used to raise NameError).
"""

import asyncio
import json
import os
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import test_main  # noqa: E402  (first: installs the fastapi/pydantic stubs)
from test_main import _FakeRequest, _invoke_chat_and_read_stream  # noqa: E402

main = test_main.main


def _sse_deltas(payload: bytes) -> list:
    deltas = []
    for frame in payload.decode().split("\n\n"):
        if frame.startswith("data: ") and frame != "data: [DONE]":
            deltas.append(json.loads(frame[6:])["choices"][0]["delta"])
    return deltas


class _FakeAdapter:
    def __init__(self, **kwargs):
        self.on_thinking = None
        self.on_reasoning = None

    def run_conversation(self, user_message, conversation_history):
        return None


class RunsFlagNotRoutedReasonTests(unittest.TestCase):
    """HERMES_USE_RUNS on, gateway cannot take the request → agent-loop + reason.

    Regression: the request-time reason used two undefined names
    (``toolsets_overridden``, ``default_toolsets``), so every such request
    raised NameError and came back as a 500 INTERNAL_ERROR instead of
    streaming through the agent loop.
    """

    def _run(self, headers):
        body = main.ChatCompletionRequest.model_validate({
            "model": "meta-llama/llama-3-70b-instruct",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        })
        request = _FakeRequest(dict({"authorization": "Bearer or-key"}, **headers))
        import hermes_runs

        real_parity = hermes_runs.needs_agent_loop_parity
        with patch.dict(sys.modules, {"hermes_adapter": types.SimpleNamespace(HermesAgentAdapter=_FakeAdapter)}), \
             patch("bridge_providers._load_cli_model_config", return_value={
                 "default": "x", "provider": "openrouter", "base_url": "https://openrouter.ai/api/v1",
             }), \
             patch("bridge_providers._get_active_provider", return_value=None), \
             patch("hermes_runs.parse_use_runs_flag", return_value=True), \
             patch("hermes_runs.resolve_gateway_base_url", return_value="http://gw"), \
             patch("hermes_runs.runs_parity_available", return_value=False), \
             patch("hermes_runs.should_route_via_runs", return_value=False), \
             patch("hermes_runs.needs_agent_loop_parity", side_effect=real_parity) as parity:
            response, payload = asyncio.run(_invoke_chat_and_read_stream(request, body))
        return response, payload, parity

    def _transport_status(self, payload):
        statuses = [d["transport_status"] for d in _sse_deltas(payload) if "transport_status" in d]
        self.assertEqual(len(statuses), 1)
        return statuses[0]

    def test_overridden_toolsets_stream_with_a_reason(self):
        response, payload, parity = self._run({"x-hermes-toolsets": "web"})
        self.assertEqual(getattr(response, "status_code", 200), 200)
        self.assertIsNotNone(payload, "expected an SSE stream, not an error response")
        status = self._transport_status(payload)
        self.assertEqual(status["requested"], "runs")
        self.assertEqual(status["actual"], "agent-loop")
        # needs_agent_loop_parity checks the provider before toolsets, and the
        # request-time call always names the resolved provider.
        self.assertEqual(
            status["reason"],
            "Explicit provider=openrouter not supported on /v1/runs (model alias only)",
        )
        kwargs = parity.call_args_list[0].kwargs
        self.assertIs(kwargs["toolsets_overridden"], True)
        self.assertEqual(
            kwargs["default_toolsets"],
            [t.strip() for t in main.DEFAULT_TOOLSETS.split(",") if t.strip()],
        )

    def test_default_toolsets_are_not_reported_as_overridden(self):
        response, payload, parity = self._run({})
        self.assertIsNotNone(payload, "expected an SSE stream, not an error response")
        status = self._transport_status(payload)
        self.assertEqual((status["requested"], status["actual"]), ("runs", "agent-loop"))
        self.assertIs(parity.call_args_list[0].kwargs["toolsets_overridden"], False)


# ── selection ────────────────────────────────────────────────────────────


class SelectTransportTableTests(unittest.TestCase):
    """select_transport is the only place a transport is chosen."""

    def test_table(self):
        from chat_transports.acp import AcpTransport
        from chat_transports.agent_loop import AgentLoopTransport
        from chat_transports.passthrough import PassthroughTransport
        from chat_transports.runs import RunsTransport
        from chat_transports.selection import select_transport
        from chat_transports.swarm import SwarmTransport

        # (execution_mode, runs decision, expected transport, runs decision consulted?)
        table = [
            ("agent-loop", False, AgentLoopTransport, True),
            ("agent-loop", True, RunsTransport, True),
            ("swarm", False, SwarmTransport, False),
            ("swarm", True, SwarmTransport, False),
            ("passthrough", False, PassthroughTransport, False),
            ("passthrough", True, PassthroughTransport, False),
            ("acp", False, AcpTransport, False),
            ("acp", True, AcpTransport, False),
            # Unknown modes have always meant the agent loop.
            ("something-else", False, AgentLoopTransport, True),
            ("something-else", True, RunsTransport, True),
            ("", False, AgentLoopTransport, True),
        ]
        for mode, runs, expected, consulted in table:
            with self.subTest(mode=mode, runs=runs):
                calls = []

                def decide(runs=runs):
                    calls.append(1)
                    return runs

                self.assertIs(select_transport(mode, route_via_runs=decide), expected)
                # The runs decision probes the gateway; it must only run for
                # the agent-loop family, and at most once.
                self.assertEqual(len(calls), 1 if consulted else 0)

    def test_chat_impl_dispatches_only_through_select_transport(self):
        """No mode branching left in chat_impl: the transport table is the router."""
        from pathlib import Path

        src = Path(__file__).with_name("chat_impl.py").read_text()
        for needle in ('execution_mode == "swarm"', 'execution_mode == "acp"',
                       'execution_mode == "passthrough"'):
            self.assertNotIn(needle, src)
        self.assertIn("select_transport(execution_mode", src)


class CapabilityMatrixTests(unittest.TestCase):
    """Declared capabilities match the spec §2.2 capability matrix."""

    def test_matrix(self):
        from chat_transports.acp import AcpTransport
        from chat_transports.agent_loop import AgentLoopTransport
        from chat_transports.base import BaseChatTransport, ChatTransport
        from chat_transports.passthrough import PassthroughTransport
        from chat_transports.runs import RunsTransport
        from chat_transports.swarm import SwarmTransport

        expected = {
            AgentLoopTransport: dict(approvals=True, cancel=True, stops_on_client_disconnect=True,
                                     usage_in_stream=True, session_resume=True),
            AcpTransport: dict(approvals=True, cancel=True, stops_on_client_disconnect=True,
                               usage_in_stream=True, session_resume=True),
            RunsTransport: dict(approvals=False, cancel=True, stops_on_client_disconnect=True,
                                usage_in_stream=True, session_resume=False),
            SwarmTransport: dict(approvals=False, cancel=False, stops_on_client_disconnect=False,
                                 usage_in_stream=False, session_resume=False),
            PassthroughTransport: dict(approvals=False, cancel=False, stops_on_client_disconnect=False,
                                       usage_in_stream=False, session_resume=False),
        }
        names = set()
        for cls, caps in expected.items():
            with self.subTest(transport=cls.__name__):
                self.assertTrue(issubclass(cls, BaseChatTransport))
                self.assertTrue(isinstance(cls.__new__(cls), ChatTransport))
                for flag, value in caps.items():
                    self.assertEqual(getattr(cls.capabilities, flag), value, flag)
                self.assertEqual(set(cls.capabilities.as_dict()), set(caps))
                names.add(cls.name)
        self.assertEqual(names, {"agent-loop", "acp", "runs", "swarm", "passthrough"})

    def test_unsupported_cancel_reports_false(self):
        from chat_transports.swarm import SwarmTransport

        transport = SwarmTransport.__new__(SwarmTransport)
        self.assertFalse(asyncio.run(transport.cancel()))


# ── drain ────────────────────────────────────────────────────────────────


class DrainToSseTests(unittest.TestCase):
    def _collect(self, produce, *, heartbeat_seconds=5.0):
        from chat_transports.drain import DrainStats, EventChannel, drain_to_sse

        def render(event):
            return [f"{event[0]}:{event[1]}"] * (2 if event[0] == "double" else 1)

        async def run():
            channel = EventChannel()
            stats = DrainStats()
            producer = asyncio.ensure_future(asyncio.to_thread(produce, channel))
            frames = [
                frame
                async for frame in drain_to_sse(
                    channel.queue, render, heartbeat_seconds=heartbeat_seconds, stats=stats,
                )
            ]
            await producer
            return frames, stats.events

        return asyncio.run(run())

    def test_forwards_every_event_in_order_then_stops_at_close(self):
        def produce(channel):
            for i in range(200):
                channel.put(("text", i))
            channel.put(("double", "x"))
            channel.close()
            channel.put(("text", "after-close"))  # dropped: the stream already ended

        frames, events = self._collect(produce)
        self.assertEqual(frames, [f"text:{i}" for i in range(200)] + ["double:x", "double:x"])
        self.assertEqual(events, 201)

    def test_heartbeat_on_silence_only(self):
        import time as _time

        def produce(channel):
            channel.put(("text", "a"))
            _time.sleep(0.35)  # silence longer than the heartbeat interval
            channel.put(("text", "b"))
            channel.close()

        frames, _ = self._collect(produce, heartbeat_seconds=0.1)
        self.assertEqual(frames[0], "text:a")
        self.assertEqual(frames[-1], "text:b")
        beats = frames[1:-1]
        self.assertTrue(beats, "expected a keepalive during the silence")
        self.assertTrue(all(f == ": heartbeat\n\n" for f in beats), frames)
        self.assertLessEqual(len(beats), 4, "heartbeats must follow the interval, not spin")

    def test_drain_waits_on_the_queue_not_on_sleep(self):
        """The old loops slept 50ms between polls; the drain never sleeps."""
        import time as _time

        def produce(channel):
            channel.put(("text", "a"))
            _time.sleep(0.05)  # drain is parked on queue.get here
            channel.put(("text", "b"))
            channel.close()

        with patch("asyncio.sleep", side_effect=AssertionError("drain must not sleep-poll")):
            frames, events = self._collect(produce)
        self.assertEqual(frames, ["text:a", "text:b"])
        self.assertEqual(events, 2)

    def test_one_drain_loop_and_no_sleep_polling(self):
        from pathlib import Path

        pkg = Path(__file__).with_name("chat_transports")
        for path in sorted(pkg.glob("*.py")):
            with self.subTest(module=path.name):
                self.assertNotIn("asyncio.sleep", path.read_text())
        for name in ("agent_loop.py", "acp.py"):
            self.assertIn("drain_to_sse(", (pkg / name).read_text())
        for name in ("chat_impl.py", "acp_chat.py"):
            self.assertNotIn("event_queue", Path(__file__).with_name(name).read_text())


# ── SSE order per transport ──────────────────────────────────────────────


def _delta_keys(payload: bytes) -> list:
    keys = []
    for frame in payload.decode().split("\n\n"):
        if frame.startswith("data: ") and frame != "data: [DONE]":
            choice = json.loads(frame[6:])["choices"][0]
            keys.append("+".join(sorted(choice["delta"])) or f"<{choice['finish_reason']}>")
        elif frame:
            keys.append(frame)
    return keys


_CLI_CFG = {"default": "x", "provider": "openrouter", "base_url": "https://openrouter.ai/api/v1"}


class AgentLoopSseOrderTests(unittest.TestCase):
    def test_event_order(self):
        class Adapter:
            def __init__(self, **kw):
                self.kw = kw
                self.on_thinking = None
                self.on_reasoning = None

            def run_conversation(self, user_message, conversation_history):
                kw = self.kw
                self.on_thinking(1)
                self.on_reasoning("why")
                kw["on_text"]("hello")
                kw["on_tool_start"]("terminal", '{"command":"ls"}')
                kw["on_tool_end"]("terminal", '{"command":"ls"}', "ok")
                kw["on_stream_retry"](1, 3, "timeout", 500)
                kw["on_computer_use_frame"]({"image": "abc"})
                kw["on_notice"]({"key": "k", "level": "warn", "message": "m"})
                kw["on_notice_clear"]("k")
                kw["on_fallback_switch"]("openrouter", "m2")
                kw["on_server_tool_event"]({"type": "swarm_result", "success": True})
                self.on_thinking(2)

        body = main.ChatCompletionRequest.model_validate({
            "model": "meta-llama/llama-3-70b-instruct",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        })
        with patch.dict(sys.modules, {"hermes_adapter": types.SimpleNamespace(HermesAgentAdapter=Adapter)}), \
             patch("bridge_providers._load_cli_model_config", return_value=_CLI_CFG), \
             patch("bridge_providers._get_active_provider", return_value=None):
            response, payload = asyncio.run(_invoke_chat_and_read_stream(
                _FakeRequest({"authorization": "Bearer k"}), body,
            ))
        self.assertEqual(response.media_type, "text/event-stream")
        self.assertEqual(_delta_keys(payload), [
            "role", "agent_status", "transport_status", "agent_status", "reasoning",
            "content", "tool_call_begin", "content", "tool_activity",
            "tool_call_end", "content", "tool_activity", "stream_retry",
            "computer_use_frame", "agent_notice", "agent_notice_clear",
            "fallback_switch", "server_tool_event",
            "agent_status", "content", "<stop>", "data: [DONE]",
        ])
        deltas = _sse_deltas(payload)
        switch = next(d["fallback_switch"] for d in deltas if "fallback_switch" in d)
        self.assertEqual((switch["provider"], switch["model"]), ("openrouter", "m2"))
        server = next(d["server_tool_event"] for d in deltas if "server_tool_event" in d)
        self.assertEqual(server["type"], "swarm_result")


class RunsSseTests(unittest.TestCase):
    """Gateway runs announce the run on server_tool_event (fixtures/sse/runs.jsonl)."""

    def test_hermes_run_and_approval_go_out_as_server_tool_event(self):
        import hermes_runs

        def pump(**kw):
            kw["emit"]("text", "gateway says hi")
            kw["emit"]("server_tool_event", {"type": "approval", "tool": "t", "preview": "p", "run_id": "run-1"})

        body = main.ChatCompletionRequest.model_validate({
            "model": "meta-llama/llama-3-70b-instruct",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        })
        request = _FakeRequest({"authorization": "Bearer k", "x-hermes-conversation-id": "conv-runs"})
        with patch.dict(sys.modules, {"hermes_adapter": types.SimpleNamespace(HermesAgentAdapter=_FakeAdapter)}), \
             patch("bridge_providers._load_cli_model_config", return_value=_CLI_CFG), \
             patch("bridge_providers._get_active_provider", return_value=None), \
             patch.object(hermes_runs, "parse_use_runs_flag", return_value=True), \
             patch.object(hermes_runs, "resolve_gateway_base_url", return_value="http://gw"), \
             patch.object(hermes_runs, "runs_parity_available", return_value=True), \
             patch.object(hermes_runs, "should_route_via_runs", return_value=True), \
             patch.object(hermes_runs, "needs_agent_loop_parity", return_value=(False, None)), \
             patch.object(hermes_runs, "submit_run", return_value=(202, {"run_id": "run-1"})), \
             patch.object(hermes_runs, "pump_run_events", side_effect=pump), \
             patch.object(hermes_runs, "register_active_run"), \
             patch.object(hermes_runs, "unregister_active_run") as unregister:
            _, payload = asyncio.run(_invoke_chat_and_read_stream(request, body))
        self.assertEqual(_delta_keys(payload), [
            "role", "agent_status", "transport_status", "server_tool_event",
            "content", "server_tool_event", "<stop>", "data: [DONE]",
        ])
        events = [d["server_tool_event"] for d in _sse_deltas(payload) if "server_tool_event" in d]
        self.assertEqual(events[0], {"type": "hermes_run", "run_id": "run-1", "conversation_id": "conv-runs"})
        self.assertEqual(events[1]["type"], "approval")
        unregister.assert_called_once_with("conv-runs", "run-1")


class PersistOnDisconnectTests(unittest.TestCase):
    """A ``background: true`` turn survives its client going away mid-stream
    (spec 4.4 keeps today's persist-on-disconnect as an explicit choice); the
    worker still finalizes. Without the flag a disconnect cancels the turn —
    see test_transport_parity.py."""

    def test_agent_loop_finishes_and_finalizes_after_disconnect(self):
        import threading

        import session_tracker

        release = threading.Event()
        finished = threading.Event()

        class Adapter:
            def __init__(self, **kw):
                self.kw = kw
                self.on_thinking = None
                self.on_reasoning = None

            def run_conversation(self, user_message, conversation_history):
                self.kw["on_text"]("before")
                release.wait(5)
                self.kw["on_text"]("after")
                finished.set()

        body = main.ChatCompletionRequest.model_validate({
            "model": "meta-llama/llama-3-70b-instruct",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
            "background": True,
        })
        request = _FakeRequest({"authorization": "Bearer k", "x-hermes-conversation-id": "conv-disconnect"})

        async def run():
            response = await main.chat_completions(request, body)
            stream = response.body_iterator
            seen = []
            async for frame in stream:
                seen.append(frame)
                if '"before"' in frame:
                    break
            await stream.aclose()  # client disconnect
            release.set()
            for _ in range(200):
                if finished.is_set() and session_tracker._sessions["conv-disconnect"]["status"] != "active":
                    break
                await asyncio.sleep(0.01)
            return seen

        with patch.dict(sys.modules, {"hermes_adapter": types.SimpleNamespace(HermesAgentAdapter=Adapter)}), \
             patch("bridge_providers._load_cli_model_config", return_value=_CLI_CFG), \
             patch("bridge_providers._get_active_provider", return_value=None):
            seen = asyncio.run(run())
        self.assertTrue(any('"before"' in f for f in seen))
        self.assertTrue(finished.is_set(), "the turn must keep running after the client leaves")
        session = session_tracker._sessions["conv-disconnect"]
        self.assertEqual(session["status"], "completed")
        self.assertIn("after", session["chat"][-1]["content"])


class AcpSseOrderTests(unittest.TestCase):
    def test_event_order_and_error_text(self):
        def run_prompt_blocking(**kw):
            emit = kw["emit"]
            emit("text", "hi")
            emit("tool_start", "read_file", "{}")
            emit("tool_end", "read_file", "{}", "out")
            emit("approval_request", {"id": "acp-1"})
            emit("plan", [types.SimpleNamespace(content="step", status="pending")])
            raise RuntimeError("acp died")

        body = main.ChatCompletionRequest.model_validate({
            "model": "m", "messages": [{"role": "user", "content": "go"}], "stream": True,
        })
        with patch("acp_transport.acp_available", return_value=(True, "")), \
             patch("acp_transport.run_prompt_blocking", side_effect=run_prompt_blocking), \
             patch("acp_chat._ensure_acp_reaper", return_value=None), \
             patch("bridge_providers._load_cli_model_config", return_value=_CLI_CFG), \
             patch("bridge_providers._get_active_provider", return_value=None):
            response, payload = asyncio.run(_invoke_chat_and_read_stream(
                _FakeRequest({"authorization": "Bearer k", "x-hermes-execution-mode": "acp"}), body,
            ))
        self.assertEqual(_delta_keys(payload), [
            "role", "transport_status", "agent_status", "content", "content", "tool_activity",
            "content", "tool_activity", "approval_request", "content",
            "plan_update", "content", "<stop>", "data: [DONE]",
        ])
        self.assertIn("[Error: acp died]", payload.decode())


if __name__ == "__main__":
    unittest.main()
