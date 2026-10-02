"""Usage in the stream (spec 4.5), ACP resume (4.6), capability rows (4.8).

The resume tests drive the real ``acp_transport`` against a scripted ACP agent
subprocess (``ci/fake_acp_agent.py``), reap the session mid-conversation and
check the next turn still has the earlier context. Nothing calls a model.
"""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import test_main  # noqa: E402  (first: installs the fastapi/pydantic stubs)
from test_main import _FakeRequest, _invoke_chat_and_read_stream  # noqa: E402

import active_runs  # noqa: E402
import pricing  # noqa: E402

main = test_main.main

_CLI_CFG = {"default": "x", "provider": "openrouter", "base_url": "https://openrouter.ai/api/v1"}
HERE = os.path.dirname(os.path.abspath(__file__))
CAP_KEYS = {"approvals", "cancel", "stops_on_client_disconnect", "usage_in_stream", "session_resume"}


def _frames(payload: bytes) -> list[dict]:
    out = []
    for frame in payload.decode().split("\n\n"):
        if frame.startswith("data: ") and frame != "data: [DONE]":
            out.append(json.loads(frame[6:]))
    return out


def _final_usage(payload: bytes) -> dict:
    final = [f for f in _frames(payload) if f["choices"][0].get("finish_reason") == "stop"]
    return final[-1]["usage"]


def _transport_statuses(payload: bytes) -> list[dict]:
    return [
        f["choices"][0]["delta"]["transport_status"]
        for f in _frames(payload)
        if "transport_status" in f["choices"][0]["delta"]
    ]


class TurnUsagePricingTests(unittest.TestCase):
    def test_priced_from_the_table_like_the_usage_panel(self):
        usage = pricing.turn_usage(
            "claude-sonnet-4", "anthropic",
            input_tokens=1200, output_tokens=300, cache_read_tokens=800, reasoning_tokens=50,
        )
        self.assertEqual(usage["prompt_tokens"], 2000)
        self.assertEqual(usage["completion_tokens"], 350)
        self.assertEqual(usage["total_tokens"], 2350)
        self.assertEqual(usage["cached_input_tokens"], 800)
        self.assertEqual(usage["cost_source"], "pricing")
        # 1200*3 + 300*15 + 800*0.30 + 50*15 per Mtok
        self.assertAlmostEqual(usage["estimated_cost_usd"], 0.00909)

    def test_totals_only_derive_buckets_without_double_billing_reasoning(self):
        usage = pricing.turn_usage(
            "claude-sonnet-4", None,
            prompt_tokens=1000, completion_tokens=100, cache_read_tokens=400, reasoning_tokens=40,
        )
        # input = 1000 - 400 cached; completion already contains reasoning.
        self.assertAlmostEqual(usage["estimated_cost_usd"], (600 * 3 + 100 * 15 + 400 * 0.30) / 1e6)
        self.assertEqual(usage["reasoning_tokens"], 40)

    def test_unpriced_model_uses_a_plausible_agent_estimate_only(self):
        ok = pricing.turn_usage("mystery", None, input_tokens=1000, output_tokens=100, reported_cost_usd=0.002)
        self.assertEqual((ok["estimated_cost_usd"], ok["cost_source"]), (0.002, "agent"))
        # $1 for 1.1k tokens implies ~$900/Mtok: rejected like the Usage panel does.
        bogus = pricing.turn_usage("mystery", None, input_tokens=1000, output_tokens=100, reported_cost_usd=1.0)
        self.assertNotIn("estimated_cost_usd", bogus)
        self.assertNotIn("cost_source", bogus)

    def test_agent_result_parsing(self):
        self.assertIsNone(pricing.usage_from_agent_result(None, "m"))
        self.assertIsNone(pricing.usage_from_agent_result({"final_response": "x"}, "m"))
        usage = pricing.usage_from_agent_result({
            "input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 2,
            "prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17, "estimated_cost_usd": 0.5,
        }, "gpt-4o", "openai")
        self.assertEqual((usage["prompt_tokens"], usage["completion_tokens"], usage["total_tokens"]), (12, 5, 17))
        self.assertEqual(usage["cost_source"], "pricing")


class AgentLoopUsageAndCapabilityTests(unittest.TestCase):
    def setUp(self):
        active_runs.REGISTRY.clear()

    def _run(self, result):
        class Adapter:
            def __init__(self, **kw):
                self.kw = kw
                self.on_thinking = None
                self.on_reasoning = None

            def run_conversation(self, user_message, conversation_history):
                self.kw["on_text"]("hi")
                return result

        body = main.ChatCompletionRequest.model_validate({
            "model": "claude-sonnet-4", "messages": [{"role": "user", "content": "hi"}], "stream": True,
        })
        with patch.dict(sys.modules, {"hermes_adapter": types.SimpleNamespace(HermesAgentAdapter=Adapter)}), \
             patch("bridge_providers._load_cli_model_config", return_value=_CLI_CFG), \
             patch("bridge_providers._get_active_provider", return_value=None):
            _, payload = asyncio.run(_invoke_chat_and_read_stream(_FakeRequest({"authorization": "Bearer k"}), body))
        return payload

    def test_final_chunk_carries_the_agents_tokens_and_cost(self):
        payload = self._run({
            "final_response": "hi", "input_tokens": 1200, "output_tokens": 300,
            "cache_read_tokens": 800, "reasoning_tokens": 50, "total_tokens": 2350,
            "estimated_cost_usd": 0.01,
        })
        usage = _final_usage(payload)
        self.assertEqual(usage["total_tokens"], 2350)
        self.assertEqual(usage["cost_source"], "pricing")
        self.assertGreater(usage["estimated_cost_usd"], 0)
        # Never a frame of its own: only the final chunk carries it.
        self.assertFalse(any("usage" in f["choices"][0]["delta"] for f in _frames(payload)))

    def test_no_counters_still_reports_zero_usage(self):
        usage = _final_usage(self._run(None))
        self.assertEqual(usage, {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})

    def test_transport_status_carries_the_capability_row(self):
        statuses = _transport_statuses(self._run(None))
        self.assertEqual(len(statuses), 1)
        caps = statuses[0]["capabilities"]
        self.assertEqual(set(caps), CAP_KEYS)
        self.assertEqual(caps, {
            "approvals": True, "cancel": True, "stops_on_client_disconnect": True,
            "usage_in_stream": True, "session_resume": True,
        })

    def test_no_approvals_advertised_when_disabled(self):
        with patch.dict(os.environ, {"HERMES_BRIDGE_AGENT_LOOP_APPROVALS": "0"}):
            caps = _transport_statuses(self._run(None))[0]["capabilities"]
        self.assertFalse(caps["approvals"])
        self.assertTrue(caps["cancel"])


class RunsUsageTests(unittest.TestCase):
    def test_run_completed_usage_is_translated_and_priced(self):
        import hermes_runs
        from chat_transports.runs import _gateway_usage

        out = hermes_runs.translate_run_event({
            "event": "run.completed", "output": "done",
            "usage": {"input_tokens": 1000, "output_tokens": 100, "total_tokens": 1100, "cache_read_tokens": 400},
        })
        self.assertEqual(out[0], ("text", "done"))
        self.assertEqual(out[1][0], "usage")
        usage = _gateway_usage(out[1][1], "claude-sonnet-4", "anthropic")
        self.assertEqual((usage["prompt_tokens"], usage["total_tokens"]), (1000, 1100))
        self.assertAlmostEqual(usage["estimated_cost_usd"], (600 * 3 + 100 * 15 + 400 * 0.30) / 1e6)

    def test_empty_gateway_usage_is_ignored(self):
        import hermes_runs

        out = hermes_runs.translate_run_event({"event": "run.completed", "output": "x", "usage": {}})
        self.assertEqual(out, [("text", "x")])


class AcpUsageTests(unittest.TestCase):
    def setUp(self):
        active_runs.REGISTRY.clear()

    def test_prompt_response_usage_and_reported_cost_reach_the_final_chunk(self):
        def run_prompt_blocking(**kw):
            kw["emit"]("text", "ok")
            kw["emit"]("usage_update", {"used": 10, "size": 100, "cost_amount": 0.0042, "cost_currency": "USD"})
            kw["emit"]("usage", {
                "input_tokens": 1200, "output_tokens": 80, "total_tokens": 1280,
                "thought_tokens": 10, "cached_read_tokens": 200, "cached_write_tokens": None,
            })

        body = main.ChatCompletionRequest.model_validate({
            "model": "mystery-model", "messages": [{"role": "user", "content": "go"}], "stream": True,
        })
        with patch("acp_transport.acp_available", return_value=(True, "")), \
             patch("acp_transport.run_prompt_blocking", side_effect=run_prompt_blocking), \
             patch("acp_chat._ensure_acp_reaper", return_value=None), \
             patch("bridge_providers._load_cli_model_config", return_value=_CLI_CFG), \
             patch("bridge_providers._get_active_provider", return_value=None):
            _, payload = asyncio.run(_invoke_chat_and_read_stream(
                _FakeRequest({"authorization": "Bearer k", "x-hermes-execution-mode": "acp"}), body,
            ))
        usage = _final_usage(payload)
        self.assertEqual((usage["prompt_tokens"], usage["completion_tokens"], usage["total_tokens"]), (1200, 80, 1280))
        self.assertEqual(usage["cached_input_tokens"], 200)
        # Unpriced model: the agent's reported USD cost is used when plausible.
        self.assertEqual((usage["estimated_cost_usd"], usage["cost_source"]), (0.0042, "agent"))
        statuses = _transport_statuses(payload)
        self.assertEqual(statuses[0]["actual"], "acp")
        self.assertTrue(statuses[0]["capabilities"]["session_resume"])


class CondensedHistoryTests(unittest.TestCase):
    def test_keeps_user_and_assistant_turns_in_order(self):
        import acp_transport as at

        prefix = at.condensed_history_prefix([
            {"role": "system", "content": "secret system prompt"},
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": [{"type": "text", "text": "answer"}]},
            {"role": "tool", "content": "noise"},
        ])
        self.assertIn("User: first\nAssistant: answer", prefix)
        self.assertNotIn("secret system prompt", prefix)
        self.assertNotIn("noise", prefix)
        self.assertEqual(at.condensed_history_prefix([]), "")

    def test_bounded_and_newest_first(self):
        import acp_transport as at

        history = [{"role": "user", "content": f"msg-{i} " + "x" * 3000} for i in range(40)]
        prefix = at.condensed_history_prefix(history)
        self.assertLess(len(prefix), at._HISTORY_MAX_CHARS + 500)
        self.assertIn("msg-39", prefix)
        self.assertNotIn("msg-0 ", prefix)


def run_acp_scenario(test: unittest.TestCase, name: str, *, load_session: bool = False) -> dict:
    """Run ci/acp_scenarios.py <name> in a fresh interpreter (real pydantic + ACP SDK).

    This suite stubs pydantic process-wide, which the ACP SDK cannot import
    under, so the end-to-end ACP scenarios run out of process.
    """
    tmp = tempfile.mkdtemp(prefix="fake-acp-")
    test.addCleanup(shutil.rmtree, tmp, True)
    args = [sys.executable, SCENARIOS, name, tmp] + (["--load-session"] if load_session else [])
    proc = subprocess.run(args, cwd=HERE, capture_output=True, text=True, timeout=180)
    lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
    if proc.returncode != 0 or not lines:
        if "No module named 'acp'" in proc.stderr:  # pragma: no cover - CI installs the SDK
            test.skipTest("agent-client-protocol SDK not installed")
        test.fail(f"scenario {name} failed (rc={proc.returncode}):\n{proc.stderr[-3000:]}")
    return json.loads(lines[-1])


SCENARIOS = os.path.join(HERE, "ci", "acp_scenarios.py")


class AcpResumeTests(unittest.TestCase):
    """Spec 4.6 exit criterion: reap the session mid-conversation, and the next
    turn still has the context — via load_session when the agent advertises
    it, otherwise via a condensed-history replay into the new session."""

    def test_load_session_restores_the_reaped_session(self):
        out = run_acp_scenario(self, "resume", load_session=True)
        result, log = out["result"], out["agent_log"]
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["reaped"], 1)
        self.assertEqual(result["second_session"], result["first_session"])
        self.assertTrue(result["resumed"])
        # The restored session already holds turn 1 (user + assistant)...
        self.assertIn("history_len=2", result["second_text"])
        # ...its replayed transcript is not re-streamed into the new turn...
        self.assertNotIn("Ada", result["second_text"])
        # ...and nothing had to be replayed into the prompt.
        prompts = [e["text"] for e in log if e["kind"] == "prompt"]
        self.assertEqual(prompts, ["my name is Ada", "what is my name?", "and again"])
        kinds = [e["kind"] for e in log]
        self.assertEqual(kinds.count("initialize"), 2, "the reap must have killed the first agent")
        self.assertIn("load_session", kinds)
        self.assertEqual(kinds.count("new_session"), 1)

    def test_without_load_session_history_is_replayed_once(self):
        out = run_acp_scenario(self, "resume", load_session=False)
        result, log = out["result"], out["agent_log"]
        self.assertEqual(result["errors"], [])
        self.assertNotEqual(result["second_session"], result["first_session"])
        self.assertFalse(result["resumed"])
        prompts = [e["text"] for e in log if e["kind"] == "prompt"]
        self.assertEqual(len(prompts), 3)
        # Turn 2 runs in a brand-new session but still carries the context.
        self.assertIn("Earlier in this conversation", prompts[1])
        self.assertIn("User: my name is Ada", prompts[1])
        self.assertTrue(prompts[1].endswith("what is my name?"))
        self.assertIn("my name is Ada", result["second_text"])
        # The live session has it now: no second replay.
        self.assertEqual(prompts[2], "and again")
        self.assertNotIn("load_session", [e["kind"] for e in log])

    def test_first_turn_of_a_new_conversation_is_unchanged(self):
        out = run_acp_scenario(self, "first_turn")
        prompts = [e["text"] for e in out["agent_log"] if e["kind"] == "prompt"]
        self.assertEqual(prompts, ["hello there"])
        self.assertIsNone(out["result"]["error"])

    def test_prompt_response_usage_and_usage_update_are_emitted(self):
        result = run_acp_scenario(self, "usage")["result"]
        self.assertIsNone(result["error"])
        self.assertEqual(result["usage"][-1]["input_tokens"], 1200)
        self.assertEqual(result["usage"][-1]["cached_read_tokens"], 200)
        self.assertEqual(result["usage_update"][-1]["cost_amount"], 0.0042)
        self.assertEqual(result["usage_update"][-1]["cost_currency"], "USD")


if __name__ == "__main__":
    unittest.main()
