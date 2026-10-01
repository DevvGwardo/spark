"""Regression tests for routes/swarm.py.

swarm_endpoint used to call ``_finalize_session`` — a closure that only exists
inside chat_impl's handler — so every swarm turn raised NameError inside the
SSE stream after the pipeline had already finished (ruff F821).
"""
import asyncio
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import routes.swarm as swarm_routes  # noqa: E402
from session_tracker import _sessions, _sessions_lock  # noqa: E402


class _FakeRequest:
    def __init__(self, headers):
        self.headers = headers


async def _drain(response) -> str:
    parts = []
    async for chunk in response.body_iterator:
        parts.append(chunk if isinstance(chunk, str) else chunk.decode())
    return "".join(parts)


class SwarmFinalizeTests(unittest.TestCase):
    def _run(self, fake_run_swarm, conversation_id="swarm-conv-1"):
        body = swarm_routes.SwarmRequest.model_validate({
            "model": "test/model",
            "messages": [{"role": "user", "content": "do it"}],
            "conversation_id": conversation_id,
        })
        request = _FakeRequest({})
        with patch("swarm_pattern.run_swarm", fake_run_swarm), patch(
            "bridge_providers._resolve_chat_agent_class", return_value=(object, True)
        ), patch.object(swarm_routes, "_mark_request_finished"):
            response = asyncio.run(swarm_routes.swarm_endpoint(request, body))
            return asyncio.run(_drain(response))

    def setUp(self):
        with _sessions_lock:
            _sessions["swarm-conv-1"] = {"id": "swarm-conv-1", "status": "active", "chat": []}

    def tearDown(self):
        with _sessions_lock:
            _sessions.pop("swarm-conv-1", None)

    def test_success_finalizes_tracked_session_without_name_error(self):
        async def fake_run_swarm(**kwargs):
            return {"success": True, "verdict": "approved", "review_notes": "",
                    "staged_files": {}, "plan": [], "elapsed_ms": 1}

        text = self._run(fake_run_swarm)
        self.assertNotIn("NameError", text)
        self.assertNotIn("Swarm Pipeline Error", text)
        self.assertIn("[DONE]", text)
        self.assertEqual(_sessions["swarm-conv-1"]["status"], "completed")

    def test_failure_finalizes_tracked_session_as_error(self):
        async def fake_run_swarm(**kwargs):
            raise RuntimeError("boom")

        text = self._run(fake_run_swarm)
        self.assertIn("Swarm Pipeline Error:** boom", text)
        self.assertIn("[DONE]", text)
        self.assertEqual(_sessions["swarm-conv-1"]["status"], "error")
        self.assertEqual(_sessions["swarm-conv-1"]["error"], "boom")

    def test_direct_call_without_tracked_session_is_noop(self):
        async def fake_run_swarm(**kwargs):
            return {"success": True, "verdict": "approved", "staged_files": {}, "plan": []}

        text = self._run(fake_run_swarm, conversation_id="untracked-conv")
        self.assertNotIn("Swarm Pipeline Error", text)
        self.assertNotIn("untracked-conv", _sessions)


if __name__ == "__main__":
    unittest.main()
