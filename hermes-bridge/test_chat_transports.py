"""Chat transport tests (spec 4.2).

Covers the request-time runs-routing reason (which used to raise NameError),
and — once the transports split lands — the single selection function and the
shared SSE drain.
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


if __name__ == "__main__":
    unittest.main()
