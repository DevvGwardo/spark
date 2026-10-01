"""Transport parity: cancel everywhere, disconnect semantics, approvals (spec 4.3/4.4).

Every transport registers its turn in ``active_runs.REGISTRY``; Stop
(``POST /v1/chat/cancel``) reaches it whatever the transport, a client that
leaves mid-turn cancels it unless the request asked for ``background: true``,
and agent-loop approval prompts travel the same ``approval_request`` →
``/v1/approvals/{id}`` path ACP uses.

All agents here are fakes; nothing calls a model.
"""

import asyncio
import contextlib
import json
import os
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import test_main  # noqa: E402  (first: installs the fastapi/pydantic stubs)
from test_main import _FakeRequest  # noqa: E402

import active_runs  # noqa: E402
import approval_registry  # noqa: E402

main = test_main.main

_CLI_CFG = {"default": "x", "provider": "openrouter", "base_url": "https://openrouter.ai/api/v1"}

# Spec 4.4 exit criterion: Stop ends generation within 2s on every transport.
STOP_BUDGET_SECONDS = 2.0


def _body(**extra):
    return main.ChatCompletionRequest.model_validate({
        "model": "meta-llama/llama-3-70b-instruct",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": True,
        **extra,
    })


def _deltas(frames):
    out = []
    for frame in frames:
        if frame.startswith("data: ") and not frame.startswith("data: [DONE]"):
            out.append(json.loads(frame[6:])["choices"][0]["delta"])
    return out


class _InterruptibleAdapter:
    """Streams one chunk, then works until interrupted (or 10s)."""

    instances: list = []

    def __init__(self, **kw):
        self.kw = kw
        self.on_thinking = None
        self.on_reasoning = None
        self.interrupted = threading.Event()
        self.finished = threading.Event()
        _InterruptibleAdapter.instances.append(self)

    def interrupt(self):
        self.interrupted.set()
        return True

    def run_conversation(self, user_message, conversation_history):
        self.kw["on_text"]("working")
        self.interrupted.wait(10)
        self.finished.set()


class _StubbornAdapter(_InterruptibleAdapter):
    """Ignores the interrupt for longer than the Stop budget (an uninterruptible call)."""

    def run_conversation(self, user_message, conversation_history):
        self.kw["on_text"]("working")
        time.sleep(4)
        self.finished.set()


@contextlib.contextmanager
def _agent_loop(adapter_cls):
    _InterruptibleAdapter.instances = []
    with patch.dict(sys.modules, {"hermes_adapter": types.SimpleNamespace(HermesAgentAdapter=adapter_cls)}), \
         patch("bridge_providers._load_cli_model_config", return_value=_CLI_CFG), \
         patch("bridge_providers._get_active_provider", return_value=None):
        yield


async def _read_until(stream, needle, seen):
    async for frame in stream:
        seen.append(frame)
        if needle in frame:
            return True
    return False


class _RegistryIsolation(unittest.TestCase):
    def setUp(self):
        active_runs.REGISTRY.clear()

    def tearDown(self):
        active_runs.REGISTRY.clear()


class ActiveRunRegistryUnitTests(_RegistryIsolation):
    def test_keyed_by_conversation_and_run(self):
        reg = active_runs.ActiveRunRegistry()
        reg.register("c", "r1", transport="agent-loop")
        reg.register("c", "r2", transport="runs")
        self.assertEqual([r.run_id for r in reg.runs_for("c")], ["r1", "r2"])
        self.assertEqual(reg.latest("c").run_id, "r2")
        self.assertEqual(reg.latest("c", transport="agent-loop").run_id, "r1")
        self.assertFalse(reg.unregister("c", "nope"))
        self.assertTrue(reg.unregister("c", "r1"))
        self.assertEqual([r.run_id for r in reg.runs_for("c")], ["r2"])

    def test_cancel_flags_every_run_then_calls_hooks(self):
        reg = active_runs.ActiveRunRegistry()
        calls = []

        async def async_hook():
            # Every sibling is already flagged when the first hook runs.
            calls.append(("async", reg.get("c", "r2").is_cancelled))

        reg.register("c", "r1", transport="acp", cancel=async_hook)
        reg.register("c", "r2", transport="agent-loop", cancel=lambda: calls.append(("sync", True)))
        self.assertTrue(asyncio.run(reg.cancel("c")))
        self.assertEqual(calls, [("async", True), ("sync", True)])
        self.assertTrue(reg.is_cancelled("c"))
        self.assertFalse(asyncio.run(reg.cancel("missing")))

    def test_failing_hook_still_reports_cancelled(self):
        reg = active_runs.ActiveRunRegistry()

        def boom():
            raise RuntimeError("gateway down")

        reg.register("c", "r", transport="runs", cancel=boom)
        with self.assertLogs("active_runs", level="WARNING"):
            self.assertTrue(asyncio.run(reg.cancel("c")))
        self.assertTrue(reg.get("c", "r").is_cancelled)

    def test_cancel_blocking_runs_coroutine_hook_on_its_loop(self):
        reg = active_runs.ActiveRunRegistry()
        hit = []

        async def main_():
            async def hook():
                hit.append(threading.current_thread() is threading.main_thread())

            reg.register("c", "r", transport="acp", cancel=hook)
            return await asyncio.to_thread(reg.cancel_blocking, "c")

        self.assertTrue(asyncio.run(main_()))
        self.assertEqual(hit, [True])


class AgentLoopStopTests(_RegistryIsolation):
    def _stream_then_cancel(self, adapter_cls, conv):
        """Start a turn, wait for its first chunk, cancel via the registry.

        Returns (seconds from Stop to end of stream, frames, adapter).
        """

        async def run():
            response = await main.chat_completions(
                _FakeRequest({"authorization": "Bearer k", "x-hermes-conversation-id": conv}), _body(),
            )
            stream = response.body_iterator
            seen = []
            self.assertTrue(await _read_until(stream, '"working"', seen))
            self.assertEqual([r.transport for r in active_runs.REGISTRY.runs_for(conv)], ["agent-loop"])
            stopped_at = time.monotonic()
            self.assertTrue(await active_runs.REGISTRY.cancel(conv))
            async for frame in stream:
                seen.append(frame)
            elapsed = time.monotonic() - stopped_at
            # Read before asyncio.run joins the worker thread on shutdown.
            self.finished_when_stream_ended = _InterruptibleAdapter.instances[0].finished.is_set()
            return elapsed, seen

        with _agent_loop(adapter_cls):
            elapsed, seen = asyncio.run(run())
        return elapsed, seen, _InterruptibleAdapter.instances[0]

    def test_stop_interrupts_the_agent_within_budget(self):
        elapsed, seen, adapter = self._stream_then_cancel(_InterruptibleAdapter, "conv-stop")
        self.assertTrue(adapter.interrupted.is_set(), "the real agent's interrupt flag was never set")
        self.assertTrue(adapter.finished.wait(2))
        self.assertLess(elapsed, STOP_BUDGET_SECONDS)
        self.assertIn("data: [DONE]\n\n", seen)
        # The worker unregisters itself once it ends.
        for _ in range(100):
            if not active_runs.REGISTRY.runs_for("conv-stop"):
                break
            time.sleep(0.01)
        self.assertEqual(active_runs.REGISTRY.runs_for("conv-stop"), [])

    def test_stop_ends_the_stream_even_if_the_agent_ignores_it(self):
        elapsed, seen, adapter = self._stream_then_cancel(_StubbornAdapter, "conv-stubborn")
        self.assertLess(elapsed, STOP_BUDGET_SECONDS)
        self.assertFalse(self.finished_when_stream_ended, "stream waited for the uninterruptible call")
        self.assertIn("data: [DONE]\n\n", seen)

    def test_cancel_route_reaches_agent_loop(self):
        import routes.ops

        class _JsonRequest:
            def __init__(self, payload):
                self._payload = payload

            async def json(self):
                return self._payload

        async def run():
            response = await main.chat_completions(
                _FakeRequest({"authorization": "Bearer k", "x-hermes-conversation-id": "conv-route"}), _body(),
            )
            stream = response.body_iterator
            seen = []
            await _read_until(stream, '"working"', seen)
            result = await routes.ops.cancel_chat_turn(_JsonRequest({"conversation_id": "conv-route"}))
            async for frame in stream:
                seen.append(frame)
            missing = await routes.ops.cancel_chat_turn(_JsonRequest({"conversation_id": "nobody"}))
            return result, missing

        with _agent_loop(_InterruptibleAdapter):
            result, missing = asyncio.run(run())
        self.assertEqual(result.content, {"cancelled": True})
        self.assertEqual(missing.content, {"cancelled": False})
        self.assertTrue(_InterruptibleAdapter.instances[0].interrupted.is_set())


class DisconnectTests(_RegistryIsolation):
    def _disconnect(self, conv, then_cancel=False, **body_extra):
        async def run():
            response = await main.chat_completions(
                _FakeRequest({"authorization": "Bearer k", "x-hermes-conversation-id": conv}), _body(**body_extra),
            )
            stream = response.body_iterator
            seen = []
            await _read_until(stream, '"working"', seen)
            await stream.aclose()  # the client went away
            adapter = _InterruptibleAdapter.instances[0]
            for _ in range(100):
                if adapter.interrupted.is_set():
                    break
                await asyncio.sleep(0.01)
            self.interrupted_after_disconnect = adapter.interrupted.is_set()
            self.cancelled_after_disconnect = active_runs.REGISTRY.is_cancelled(conv)
            if then_cancel:
                # Stop still reaches a background turn explicitly.
                await active_runs.REGISTRY.cancel(conv)
            else:
                adapter.interrupt()  # let the worker finish
            return adapter

        with _agent_loop(_InterruptibleAdapter):
            adapter = asyncio.run(run())
        return adapter

    def test_disconnect_cancels_a_foreground_turn(self):
        self._disconnect("conv-fg")
        self.assertTrue(self.interrupted_after_disconnect, "a foreground turn must stop when its client leaves")

    def test_disconnect_leaves_a_background_turn_running(self):
        adapter = self._disconnect("conv-bg", then_cancel=True, background=True)
        self.assertFalse(self.interrupted_after_disconnect, "background: true must survive a disconnect")
        self.assertFalse(self.cancelled_after_disconnect)
        self.assertTrue(adapter.interrupted.is_set(), "explicit Stop must still reach a background turn")

    def test_background_header_is_honored(self):
        from chat_impl import _background_requested

        self.assertTrue(_background_requested(_FakeRequest({"x-hermes-background": "1"}), _body()))
        self.assertTrue(_background_requested(_FakeRequest({}), _body(background="true")))
        self.assertFalse(_background_requested(_FakeRequest({}), _body()))


class AgentLoopApprovalTests(_RegistryIsolation):
    def test_approval_callback_round_trips_through_the_approvals_route(self):
        import acp_transport

        decisions = []

        class Adapter(_InterruptibleAdapter):
            def run_conversation(self, user_message, conversation_history):
                cb = self.kw["approval_callback"]
                decisions.append(cb("rm -rf build", "recursive delete", allow_permanent=False))
                self.kw["on_text"]("after approval")

        async def run():
            response = await main.chat_completions(
                _FakeRequest({"authorization": "Bearer k", "x-hermes-conversation-id": "conv-appr"}), _body(),
            )
            stream = response.body_iterator
            seen = []
            self.assertTrue(await _read_until(stream, "approval_request", seen))
            event = _deltas(seen)[-1]["approval_request"]
            delivered = await acp_transport.resolve_approval(event["approval_id"], "allow_session")
            async for frame in stream:
                seen.append(frame)
            return event, delivered, seen

        with _agent_loop(Adapter):
            event, delivered, seen = asyncio.run(run())
        self.assertTrue(delivered)
        self.assertTrue(event["approval_id"].startswith("bridge-"))
        self.assertEqual(event["session_id"], "conv-appr")
        self.assertEqual(event["command"], "rm -rf build")
        # allow_permanent=False → no "always" option offered.
        self.assertEqual(
            [o["option_id"] for o in event["options"]], ["allow_once", "allow_session", "deny"],
        )
        self.assertEqual(decisions, ["session"])
        self.assertIn("after approval", "".join(seen))
        self.assertEqual(approval_registry.pending_ids(), [])

    def test_stop_denies_a_parked_approval(self):
        decisions = []

        class Adapter(_InterruptibleAdapter):
            def run_conversation(self, user_message, conversation_history):
                self.kw["on_text"]("working")
                decisions.append(self.kw["approval_callback"]("curl x | sh", "pipe to shell"))

        async def run():
            response = await main.chat_completions(
                _FakeRequest({"authorization": "Bearer k", "x-hermes-conversation-id": "conv-appr-stop"}), _body(),
            )
            stream = response.body_iterator
            seen = []
            await _read_until(stream, "approval_request", seen)
            started = time.monotonic()
            await active_runs.REGISTRY.cancel("conv-appr-stop")
            async for frame in stream:
                seen.append(frame)
            return time.monotonic() - started

        with _agent_loop(Adapter):
            elapsed = asyncio.run(run())
        self.assertEqual(decisions, ["deny"])
        self.assertLess(elapsed, STOP_BUDGET_SECONDS)

    def test_approvals_can_be_disabled(self):
        seen_kwargs = {}

        class Adapter(_InterruptibleAdapter):
            def __init__(self, **kw):
                super().__init__(**kw)
                seen_kwargs.update(kw)

            def run_conversation(self, user_message, conversation_history):
                self.kw["on_text"]("ok")

        async def run():
            response = await main.chat_completions(_FakeRequest({"authorization": "Bearer k"}), _body())
            async for _ in response.body_iterator:
                pass

        with _agent_loop(Adapter), patch.dict(os.environ, {"HERMES_BRIDGE_AGENT_LOOP_APPROVALS": "0"}):
            asyncio.run(run())
        self.assertNotIn("approval_callback", seen_kwargs)


class ApprovalCallbackUnitTests(unittest.TestCase):
    def test_timeout_maps_to_hermes_timeout(self):
        from chat_transports.approvals import make_approval_callback

        events = []

        async def run():
            loop = asyncio.get_running_loop()
            cb = make_approval_callback(
                loop=loop, conversation_id="c", emit=events.append, is_cancelled=lambda: False, timeout=0.05,
            )
            return await asyncio.to_thread(cb, "ls", "d")

        self.assertEqual(asyncio.run(run()), "timeout")
        self.assertEqual(len(events), 1)
        self.assertEqual(approval_registry.pending_ids(), [])

    def test_cancelled_turn_denies_without_prompting(self):
        from chat_transports.approvals import make_approval_callback

        events = []

        async def run():
            cb = make_approval_callback(
                loop=asyncio.get_running_loop(), conversation_id="c", emit=events.append, is_cancelled=lambda: True,
            )
            return await asyncio.to_thread(cb, "ls", "d")

        self.assertEqual(asyncio.run(run()), "deny")
        self.assertEqual(events, [])

    def test_broader_grant_clamps_to_what_was_offered(self):
        from chat_transports.approvals import make_approval_callback

        events = []

        async def run():
            loop = asyncio.get_running_loop()
            cb = make_approval_callback(
                loop=loop, conversation_id="c", emit=events.append, is_cancelled=lambda: False, timeout=5,
            )
            task = asyncio.ensure_future(asyncio.to_thread(cb, "ls", "d", smart_denied=True))
            while not events:
                await asyncio.sleep(0.01)
            approval_registry.resolve(events[0]["approval_id"], "allow_always")
            return await task

        # smart_denied offers only once/deny, so "always" collapses to "once".
        self.assertEqual(asyncio.run(run()), "once")


class AdapterApprovalHookTests(unittest.TestCase):
    """HermesAgentAdapter installs hermes' per-thread approval callback around a turn."""

    def _fake_hermes_tools(self):
        state = {"callback": None, "interactive": None}
        terminal_tool = types.SimpleNamespace(
            _get_approval_callback=lambda: state["callback"],
            set_approval_callback=lambda cb: state.__setitem__("callback", cb),
        )

        def set_ctx(value):
            previous = state["interactive"]
            state["interactive"] = value
            return previous

        approval_context = types.SimpleNamespace(
            set_hermes_interactive_context=set_ctx,
            reset_hermes_interactive_context=lambda token: state.__setitem__("interactive", token),
        )
        tools_pkg = types.SimpleNamespace(terminal_tool=terminal_tool, approval_context=approval_context)
        modules = {"tools": tools_pkg, "tools.terminal_tool": terminal_tool, "tools.approval_context": approval_context}
        return state, modules

    def test_callback_installed_only_for_the_turn(self):
        import hermes_adapter

        state, modules = self._fake_hermes_tools()
        seen = {}

        def cb(*a, **k):
            return "once"

        adapter = hermes_adapter.HermesAgentAdapter.__new__(hermes_adapter.HermesAgentAdapter)
        adapter.approval_callback = cb
        with patch.dict(sys.modules, modules):
            with adapter._approval_context():
                seen["callback"] = state["callback"]
                seen["interactive"] = state["interactive"]
        self.assertIs(seen["callback"], cb)
        self.assertTrue(seen["interactive"])
        self.assertIsNone(state["callback"])
        self.assertIsNone(state["interactive"])

    def test_interrupt_requests_a_hard_cancel(self):
        import hermes_adapter

        calls = []
        adapter = hermes_adapter.HermesAgentAdapter.__new__(hermes_adapter.HermesAgentAdapter)
        adapter._agent = types.SimpleNamespace(interrupt=lambda **kw: calls.append(kw))
        self.assertTrue(adapter.interrupt())
        self.assertEqual(calls, [{"hard_cancel": True}])

    def test_interrupt_without_agent_is_a_noop(self):
        import hermes_adapter

        adapter = hermes_adapter.HermesAgentAdapter.__new__(hermes_adapter.HermesAgentAdapter)
        self.assertFalse(adapter.interrupt())


class LegacyAgentInterruptTests(unittest.TestCase):
    def test_interrupt_stops_before_the_next_model_call(self):
        import importlib.util

        # Load the bridge's own run_agent.py: hermes_adapter may have bound
        # the name "run_agent" to hermes-agent's module.
        spec = importlib.util.spec_from_file_location(
            "bridge_run_agent_under_test", os.path.join(os.path.dirname(__file__), "run_agent.py"),
        )
        run_agent = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(run_agent)

        agent = run_agent.AIAgent.__new__(run_agent.AIAgent)
        agent.max_iterations = 3
        agent.on_thinking = None
        agent._build_repo_system_prompt = lambda: ""
        calls = []
        agent._call_api = lambda *a, **k: calls.append(1)
        agent.interrupt()
        self.assertIsNone(agent.run_conversation("hi"))
        self.assertEqual(calls, [])


class AcpStopTests(_RegistryIsolation):
    def test_stop_sends_session_cancel_and_ends_the_stream(self):
        cancel_seen = threading.Event()
        released = threading.Event()

        def run_prompt_blocking(**kw):
            kw["emit"]("text", "working")
            released.wait(10)

        async def fake_cancel_turn(conversation_id):
            cancel_seen.set()
            released.set()
            return True

        async def run():
            response = await main.chat_completions(
                _FakeRequest({
                    "authorization": "Bearer k",
                    "x-hermes-execution-mode": "acp",
                    "x-hermes-conversation-id": "conv-acp-stop",
                }),
                main.ChatCompletionRequest.model_validate({
                    "model": "m", "messages": [{"role": "user", "content": "go"}], "stream": True,
                }),
            )
            stream = response.body_iterator
            seen = []
            await _read_until(stream, '"working"', seen)
            self.assertEqual([r.transport for r in active_runs.REGISTRY.runs_for("conv-acp-stop")], ["acp"])
            started = time.monotonic()
            await active_runs.REGISTRY.cancel("conv-acp-stop")
            async for frame in stream:
                seen.append(frame)
            return time.monotonic() - started

        with patch("acp_transport.acp_available", return_value=(True, "")), \
             patch("acp_transport.run_prompt_blocking", side_effect=run_prompt_blocking), \
             patch("acp_transport.cancel_turn", side_effect=fake_cancel_turn), \
             patch("acp_chat._ensure_acp_reaper", return_value=None), \
             patch("bridge_providers._load_cli_model_config", return_value=_CLI_CFG), \
             patch("bridge_providers._get_active_provider", return_value=None):
            elapsed = asyncio.run(run())
        self.assertTrue(cancel_seen.is_set())
        self.assertLess(elapsed, STOP_BUDGET_SECONDS)

    def test_cancel_turn_sends_session_cancel_and_denies_parked_approvals(self):
        import acp_transport as at

        calls = []

        async def cancel(session_id):
            calls.append(session_id)

        async def run():
            loop = asyncio.get_running_loop()
            pending = approval_registry.register("acp-x", "conv-c")
            handle = at._AcpHandle(
                conversation_id="conv-c", cwd="/tmp",
                proc=types.SimpleNamespace(returncode=None),
                conn=types.SimpleNamespace(cancel=cancel),
                session_id="sess-9", client=None, loop=loop,
                approvals={"acp-x": pending},
            )
            handle.busy = True
            at._sessions["conv-c"] = handle
            try:
                ok = await at.cancel_turn("conv-c")
                await asyncio.sleep(0)
                return ok, pending.result(), await at.cancel_turn("nobody")
            finally:
                at._sessions.pop("conv-c", None)
                approval_registry.discard("acp-x")

        ok, decision, missing = asyncio.run(run())
        self.assertTrue(ok)
        self.assertEqual(calls, ["sess-9"])
        self.assertEqual(decision, {"option_id": "deny"})
        self.assertFalse(missing)


class RunsStopTests(_RegistryIsolation):
    def test_request_cancel_stops_the_gateway_run_once(self):
        import hermes_runs
        from chat_transports.runs import RunsTransport

        stops = []

        async def fake_stop(**kw):
            stops.append(kw["run_id"])
            return 200, {}

        transport = RunsTransport.__new__(RunsTransport)
        transport.ctx = types.SimpleNamespace(workspace_id="conv-r", background=False)
        transport._gateway_run_id = "run-9"
        transport._agent = None
        transport._agent_lock = threading.Lock()
        transport.channel = None
        transport.active_run = None

        async def run():
            transport.register_run("req-1")
            hermes_runs.register_active_run("conv-r", run_id="run-9", base_url="http://127.0.0.1:8642", api_key=None)
            with patch.object(hermes_runs, "stop_run_async", fake_stop):
                # Stop on the conversation: both entries flagged, gateway stopped once.
                await active_runs.REGISTRY.cancel("conv-r")
                return list(stops)

        self.assertEqual(asyncio.run(run()), ["run-9"])
        self.assertTrue(hermes_runs.is_run_cancelled("conv-r", "run-9"))

    def test_disconnect_cancel_of_the_request_reaches_the_gateway(self):
        import hermes_runs
        from chat_transports.runs import RunsTransport

        stops = []

        async def fake_stop(**kw):
            stops.append(kw["run_id"])
            return 200, {}

        transport = RunsTransport.__new__(RunsTransport)
        transport.ctx = types.SimpleNamespace(workspace_id="conv-r2", background=False)
        transport._gateway_run_id = "run-7"
        transport._agent = None
        transport._agent_lock = threading.Lock()
        transport.channel = None
        transport.active_run = None

        async def run():
            transport.register_run("req-2")
            hermes_runs.register_active_run("conv-r2", run_id="run-7", base_url="http://127.0.0.1:8642", api_key=None)
            with patch.object(hermes_runs, "stop_run_async", fake_stop):
                # What on_stream_closed does: cancel only the request's own entry.
                await active_runs.REGISTRY.cancel("conv-r2", "req-2")
                return list(stops)

        self.assertEqual(asyncio.run(run()), ["run-7"])


if __name__ == "__main__":
    unittest.main()
