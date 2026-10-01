"""acp_transport against a fake ACP agent subprocess (hardening spec 7.2).

Each scenario in ``ci/acp_scenarios.py`` drives the real ``acp_transport``
(spawn, initialize, sessions, the stdio JSON-RPC connection) against
``ci/fake_acp_agent.py`` in a fresh interpreter, and these tests assert on what
the bridge emitted and what the agent received. Resume is covered in
test_transport_usage_resume.py.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from test_transport_usage_resume import run_acp_scenario  # noqa: E402


_TRANSLATION: dict = {}


class SessionUpdateTranslationTests(unittest.TestCase):
    def setUp(self):
        # One agent run serves every assertion here (results are plain data).
        if not _TRANSLATION:
            _TRANSLATION.update(run_acp_scenario(self, "translation"))
        self.out = _TRANSLATION
        self.events = _TRANSLATION["result"]["events"]

    def kinds(self):
        return [e[0] for e in self.events]

    def test_no_error(self):
        self.assertIsNone(self.out["result"]["error"])

    def test_thought_chunk_becomes_reasoning(self):
        self.assertIn(["reasoning", "thinking hard"], self.events)

    def test_tool_call_lifecycle(self):
        begin = next(e[1] for e in self.events if e[0] == "tool_call_begin")
        self.assertEqual((begin["call_id"], begin["name"]), ("call-1", "read_file"))
        start = next(e for e in self.events if e[0] == "tool_start")
        # raw_input is rendered as the tool input.
        self.assertEqual(start[1:], ["read_file", '{"path": "README.md"}'])
        delta = next(e[1] for e in self.events if e[0] == "tool_call_delta")
        self.assertEqual(delta["output"], "partial")
        end = next(e[1] for e in self.events if e[0] == "tool_call_end")
        self.assertTrue(end["success"])
        tool_end = next(e for e in self.events if e[0] == "tool_end")
        self.assertEqual(tool_end[3], "file body")
        order = self.kinds()
        self.assertLess(order.index("tool_call_begin"), order.index("tool_call_delta"))
        self.assertLess(order.index("tool_call_delta"), order.index("tool_call_end"))

    def test_plan_update_reaches_the_stream(self):
        """Regression: the SDK's discriminator is "plan", which used to be dropped."""
        plans = [e[1] for e in self.events if e[0] == "plan"]
        self.assertEqual(len(plans), 1)
        self.assertEqual([p["content"] for p in plans[0]], ["first step", "second step"])

    def test_agent_message_text_and_usage(self):
        self.assertIn(["text", "echo: THINK TOOL PLAN go | history_len=0"], self.events)
        self.assertIn("usage_update", self.kinds())
        self.assertEqual(self.kinds()[-1], "usage")


class RequestPermissionTests(unittest.TestCase):
    def test_approval_round_trip_both_ways(self):
        result = run_acp_scenario(self, "permission")["result"]
        approved, denied = result["allow_once"], result["deny"]
        for outcome in (approved, denied):
            self.assertEqual(len(outcome["approvals"]), 1)
            event = outcome["approvals"][0]
            self.assertTrue(event["approval_id"].startswith("acp-"))
            self.assertEqual(event["command"], "rm -rf build")
            self.assertEqual([o["option_id"] for o in event["options"]], ["allow_once", "deny"])
            self.assertEqual(event["available_decisions"], ["approved", "denied"])
        self.assertEqual(approved["text"], "permission:allow_once")
        # A deny goes back to the agent as a cancelled outcome.
        self.assertEqual(denied["text"], "permission:cancelled")
        # Nothing left parked in the shared approval registry.
        self.assertEqual(result["pending_after"], [])


class CancelTests(unittest.TestCase):
    def test_session_cancel_stops_a_long_prompt(self):
        out = run_acp_scenario(self, "cancel")
        result = out["result"]
        self.assertTrue(result["cancelled"])
        self.assertIsNone(result["error"])
        self.assertEqual(result["text"], "stopped")
        self.assertLess(result["elapsed"], 2.0)
        self.assertFalse(result["missing"], "cancelling an unknown conversation reports False")
        self.assertIn("cancel", [e["kind"] for e in out["agent_log"]])


class EnsureSessionTests(unittest.TestCase):
    def test_reuse_cwd_switch_and_crash_respawn(self):
        out = run_acp_scenario(self, "ensure_session")
        result, log = out["result"], out["agent_log"]
        self.assertEqual(result["errors"], [])
        s1, s2, s3, s4 = result["sessions"]
        # Same cwd: the live session (and process) is reused.
        self.assertEqual(s1, s2)
        self.assertIn("history_len=2", result["texts"][1])
        # A cwd switch tears the session down and starts one in the new checkout.
        self.assertNotEqual(s2, s3)
        # A crashed agent is respawned on the next turn.
        self.assertNotEqual(s3, s4)
        self.assertEqual(len(set(result["pids"])), 3)
        self.assertEqual(result["retry_reasons"], ["acp-transport-cwd-switch", "acp-transport-reconnect"])
        new_sessions = [e["cwd"] for e in log if e["kind"] == "new_session"]
        self.assertTrue(new_sessions[1].endswith("/other"))
        self.assertEqual(result["texts"][3], "echo: four | history_len=0")


if __name__ == "__main__":
    unittest.main()
