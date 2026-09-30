"""Contract tests for the custom SSE event payloads (spec Phase 1.1).

bridge_events.py is the single source of truth for the custom event contract:
the Pydantic models generate the JSON Schema (Phase 1.2), and the constructors
are what main.py actually emits. These tests pin the wire shape of both, so a
field rename or a dropped key fails here rather than silently in the stream.

Note the suite runs with pydantic stubbed, so these assert constructor output
against literal expected dicts. Model/schema fidelity is checked separately by
`npm run gen:hermes-contract`, which runs outside the stubbed environment.
"""

import ast
import unittest
from pathlib import Path

import bridge_events as be

MAIN = Path(__file__).with_name("main.py")


class ConstructorShapeTests(unittest.TestCase):
    """Pin the exact dict each constructor returns."""

    def test_tool_activity_running(self):
        self.assertEqual(
            be.tool_activity_event("web_search", "running", {"q": "x"}, None),
            {"tool": "web_search", "status": "running", "input": {"q": "x"}, "output": None},
        )

    def test_tool_activity_completed_uses_empty_input_when_omitted(self):
        # The agent-loop path sends "" for input on completion, not None.
        self.assertEqual(
            be.tool_activity_event("web_search", "completed", "", "result"),
            {"tool": "web_search", "status": "completed", "input": "", "output": "result"},
        )

    def test_agent_status_shape(self):
        import time

        event = be.agent_status_event(
            phase="thinking", label="agent-loop", started_at=time.monotonic()
        )
        self.assertEqual(set(event), {"phase", "label", "elapsed_ms", "source"})
        self.assertEqual(event["phase"], "thinking")
        self.assertEqual(event["label"], "agent-loop")
        self.assertEqual(event["source"], "hermes-bridge")
        self.assertGreaterEqual(event["elapsed_ms"], 0)

    def test_agent_status_omits_iteration_when_absent(self):
        import time

        event = be.agent_status_event(
            phase="starting", label="x", started_at=time.monotonic()
        )
        self.assertNotIn("iteration", event)

    def test_agent_status_includes_iteration_when_given(self):
        import time

        event = be.agent_status_event(
            phase="thinking", label="x", started_at=time.monotonic(), iteration=3
        )
        self.assertEqual(event["iteration"], 3)

    def test_agent_status_elapsed_never_negative(self):
        # A start time in the future (clock skew) must not produce a negative age.
        import time

        event = be.agent_status_event(
            phase="x", label="y", started_at=time.monotonic() + 10
        )
        self.assertEqual(event["elapsed_ms"], 0)

    def test_fallback_switch_omits_absent_reason(self):
        self.assertEqual(
            be.fallback_switch_event("openrouter", "gpt-x"),
            {"provider": "openrouter", "model": "gpt-x"},
        )

    def test_fallback_switch_includes_reason_when_given(self):
        self.assertEqual(
            be.fallback_switch_event("openrouter", "gpt-x", "rate limited"),
            {"provider": "openrouter", "model": "gpt-x", "reason": "rate limited"},
        )

    def test_fallback_switch_omits_empty_reason(self):
        # An empty string is not a reason; it must not add a dead key.
        self.assertNotIn("reason", be.fallback_switch_event("p", "m", ""))

    def test_transport_status_shape(self):
        self.assertEqual(
            be.transport_status_event("agent-loop", "acp", "forced by header"),
            {"requested": "agent-loop", "actual": "acp", "reason": "forced by header"},
        )

    def test_transport_status_omits_absent_reason(self):
        self.assertEqual(
            be.transport_status_event("agent-loop", "agent-loop"),
            {"requested": "agent-loop", "actual": "agent-loop"},
        )

    def test_usage_shape_and_zero_defaults(self):
        self.assertEqual(
            be.usage_event(),
            {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        )

    def test_usage_omits_cost_unless_supplied(self):
        self.assertNotIn("estimated_cost_usd", be.usage_event(1, 2, 3))
        self.assertEqual(
            be.usage_event(1, 2, 3, 0.5)["estimated_cost_usd"], 0.5
        )

    def test_usage_coerces_numeric_strings(self):
        # The agent-loop path builds these from CLI output, which is text.
        self.assertEqual(
            be.usage_event("10", "20", "30"),
            {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        )

    def test_agent_notice_clear_shape(self):
        self.assertEqual(be.agent_notice_clear_event("credits"), {"key": "credits"})

    def test_hermes_run_server_tool_event_shape(self):
        self.assertEqual(
            be.hermes_run_server_tool_event("run-1", "conv-1"),
            {"type": "hermes_run", "run_id": "run-1", "conversation_id": "conv-1"},
        )

    def test_swarm_result_server_tool_event_shape(self):
        self.assertEqual(
            be.swarm_result_server_tool_event(
                success=True,
                verdict="approve",
                review_notes="looks good",
                staged_files=["a.py"],
                plan=["step"],
                elapsed_ms=120,
            ),
            {
                "type": "swarm_result",
                "success": True,
                "verdict": "approve",
                "review_notes": "looks good",
                "staged_files": ["a.py"],
                "plan": ["step"],
                "elapsed_ms": 120,
            },
        )

    def test_swarm_result_copies_staged_files(self):
        source = ["a.py"]
        event = be.swarm_result_server_tool_event(
            success=True, verdict="v", review_notes="r",
            staged_files=source, plan=None, elapsed_ms=1,
        )
        event["staged_files"].append("b.py")
        self.assertEqual(source, ["a.py"], "constructor must not alias the caller's list")


class ModelRegistryTests(unittest.TestCase):
    """The model registry drives schema generation, so it must be complete."""

    EXPECTED_KEYS = {
        "tool_activity",
        "agent_status",
        "computer_use_frame",
        "agent_notice",
        "agent_notice_clear",
        "server_tool_event",
        "fallback_switch",
        "transport_status",
        "usage",
    }

    def test_registry_covers_every_custom_event(self):
        self.assertEqual(set(be.CUSTOM_EVENT_MODELS), self.EXPECTED_KEYS)

    def test_every_registered_key_has_a_model(self):
        for key, model in be.CUSTOM_EVENT_MODELS.items():
            self.assertIsNotNone(model, f"{key} has no model")

    def test_agent_owned_payloads_are_open_objects(self):
        """Adapter-owned events must not forbid extra fields.

        hermes-agent adds notice and frame fields without a bridge release, so a
        closed model here would silently drop events the frontend needs.

        Asserted via model_config rather than pydantic internals like
        model_extra, because this suite runs both with real pydantic and with the
        suite-wide stub, and the stub only sets model_extra on instances. An
        hasattr check on the class would then pass or fail depending on which
        environment imported the module first. "We never declare extra='forbid'"
        holds in both.
        """
        for key in ("computer_use_frame", "agent_notice", "server_tool_event"):
            model = be.CUSTOM_EVENT_MODELS[key]
            config = getattr(model, "model_config", None) or {}
            self.assertNotEqual(
                config.get("extra"), "forbid",
                f"{key} must accept extra fields from hermes-agent",
            )

    def test_usage_total_is_not_silently_inferred(self):
        # The bridge reports what upstream reported; it must not invent totals.
        event = be.usage_event(5, 7, 0)
        self.assertEqual(event["total_tokens"], 0)


class MainUsesConstructorsTests(unittest.TestCase):
    """main.py must build custom events through bridge_events, not inline.

    The spec's exit criterion is phrased as a grep for the event key, but the key
    string has to appear at the emission site — it is the SSE field name. What
    actually matters is that no *payload dict literal* is built inline, so that
    is what is asserted here, on the AST.
    """

    EVENT_KEYS = {
        "tool_activity",
        "agent_status",
        "transport_status",
        "fallback_switch",
        "agent_notice",
        "agent_notice_clear",
        "computer_use_frame",
        "server_tool_event",
        "usage",
    }

    def _ast(self):
        return ast.parse(MAIN.read_text())

    def test_no_inline_payload_dicts_for_custom_events(self):
        """A custom event's payload must never be a dict literal.

        The single-key wrapper `{"tool_activity": tool_activity_event(...)}` is
        required — the key is the SSE field name and appears in the delta. What
        must not happen is the payload itself being spelled out inline at the
        call site, which is exactly the drift this contract exists to stop.
        """
        offenders = []
        for node in ast.walk(self._ast()):
            if not isinstance(node, ast.Dict):
                continue
            for key, value in zip(node.keys, node.values):
                if not (
                    isinstance(key, ast.Constant)
                    and isinstance(key.value, str)
                    and key.value in self.EVENT_KEYS
                ):
                    continue
                if isinstance(value, ast.Dict):
                    offenders.append(f"{key.value} at line {value.lineno}")
        self.assertEqual(
            offenders, [],
            f"custom event payloads still built inline in main.py: {offenders}",
        )

    def test_adapter_owned_events_are_forwarded_not_rebuilt(self):
        """computer_use_frame / agent_notice / server_tool_event are passed through.

        Their payloads belong to hermes-agent, so the bridge forwards the object it
        received rather than reconstructing a field list it does not own.
        """
        src = MAIN.read_text()
        for key, var in (
            ("computer_use_frame", "frame"),
            ("agent_notice", "notice"),
            ("agent_notice_clear", "clear"),
        ):
            self.assertRegex(
                src,
                rf'"{key}": {var}\b',
                f"{key} should forward the adapter payload, not rebuild it",
            )

    def test_main_imports_the_constructors_it_uses(self):
        src = MAIN.read_text()
        tree = self._ast()
        used = {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {
                "tool_activity_event",
                "agent_status_event",
                "transport_status_event",
                "fallback_switch_event",
                "agent_notice_clear_event",
                "usage_event",
                "hermes_run_server_tool_event",
                "swarm_result_server_tool_event",
            }
        }
        self.assertTrue(used, "expected main.py to call the new constructors")
        for name in sorted(used):
            self.assertIn(name, src.split("from bridge_events import", 1)[-1].split(")", 1)[0],
                          f"{name} is called but not imported from bridge_events")

    def test_local_agent_status_builder_is_gone(self):
        self.assertNotIn(
            "def _build_agent_status", MAIN.read_text(),
            "the local builder should be replaced by the contract constructor",
        )


if __name__ == "__main__":
    unittest.main()
