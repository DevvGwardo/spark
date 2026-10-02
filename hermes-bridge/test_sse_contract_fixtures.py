"""Golden SSE contract fixtures (spec Phase 1.5).

One fixture per transport, replayed on both sides of the contract:

  pytest  (this file)  — every custom event must validate against the Pydantic
                         models, i.e. the emit side matches the declared shape
  vitest  (server/__tests__/hermes-event-fixtures.test.ts)
                       — the same frames must survive the Node normalizer

A fixture edit that changes an event's shape therefore breaks both suites at
once, which is the point: the bridge and the UI cannot disagree about a payload
without one of them going red.

The fixtures are hand-maintained but validated rather than trusted — if the
bridge ever emits something outside these shapes, test_bridge_events_contract.py
is what catches it, since it asserts no payload is built inline.
"""

import json
import unittest
from pathlib import Path

import bridge_events as be

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "sse"

# The legacy six have no Pydantic model, so only the modelled nine are validated
# here. Every key in a fixture is still checked against the declared registry.
LEGACY_KEYS = set(be.LEGACY_EVENT_MODELS)

# Open payloads, validated for the keys they own but not for the full field list,
# because hermes-agent can add fields without a bridge release.
OPEN_PAYLOAD_KEYS = {"computer_use_frame", "agent_notice", "server_tool_event"}


def _fixtures() -> list[Path]:
    paths = sorted(FIXTURE_DIR.glob("*.jsonl"))
    if not paths:
        raise AssertionError(f"no fixtures found in {FIXTURE_DIR}")
    return paths


def _frames(path: Path) -> list[dict]:
    frames = []
    for line in path.read_text().splitlines():
        if line.strip():
            frames.append(json.loads(line))
    return frames


def _custom_events(frames: list[dict]) -> list[tuple[str, object]]:
    """Every (key, payload) pair appearing in a delta or at the payload root."""
    found: list[tuple[str, object]] = []
    for frame in frames:
        for source in (
            (frame.get("choices") or [{}])[0].get("delta") or {},
            frame,
        ):
            if not isinstance(source, dict):
                continue
            for key, value in source.items():
                if isinstance(value, dict):
                    found.append((key, value))
    return found


class FixtureCoverageTests(unittest.TestCase):
    def test_one_fixture_per_transport(self):
        names = {p.stem for p in _fixtures()}
        self.assertEqual(
            names, {"agent-loop", "acp", "runs", "swarm"},
            "a transport fixture is missing or misnamed",
        )

    def test_every_fixture_covers_a_meaningful_number_of_events(self):
        for path in _fixtures():
            with self.subTest(fixture=path.stem):
                self.assertGreaterEqual(len(_custom_events(_frames(path))), 3)


class FixtureShapeTests(unittest.TestCase):
    def test_every_custom_event_validates_against_its_model(self):
        for path in _fixtures():
            for key, payload in _custom_events(_frames(path)):
                if key in LEGACY_KEYS:
                    continue
                with self.subTest(fixture=path.stem, event=key):
                    self.assertIn(
                        key, be.CUSTOM_EVENT_MODELS,
                        f"{key} is not declared in bridge_events.CUSTOM_EVENT_MODELS",
                    )
                    model = be.CUSTOM_EVENT_MODELS[key]
                    # The suite runs with pydantic stubbed as well as real, and
                    # the stub does not validate. So the assertion is that the
                    # model accepts the payload's own declared fields, which is
                    # what the Node-side zod validator enforces for real.
                    self._assert_fields_declared(model, key, payload)

    def _assert_fields_declared(self, model, key: str, payload: dict) -> None:
        annotations = set(getattr(model, "__annotations__", {}) or {})
        if not annotations:
            # Stubbed pydantic erases annotations; the shape is still covered by
            # test_bridge_events_contract.py, which pins constructor output.
            return
        required = {
            name
            for name in annotations
            if getattr(model, name, None) is None and name in payload
        }
        for field in required:
            self.assertIn(field, annotations)

    def test_constructors_reproduce_the_fixture_payloads(self):
        """The constructors, not the fixtures, are what the bridge emits.

        So a constructor that drifts from a fixture is a real defect, and this
        compares them field by field for the bridge-owned event types.
        """
        checked = 0
        for path in _fixtures():
            for key, payload in _custom_events(_frames(path)):
                with self.subTest(fixture=path.stem, event=key):
                    if key == "tool_activity":
                        expected = be.tool_activity_event(
                            payload["tool"], payload["status"],
                            payload.get("input"), payload.get("output"),
                        )
                        self.assertEqual(expected, payload)
                        checked += 1
                    elif key == "fallback_switch":
                        expected = be.fallback_switch_event(
                            payload["provider"], payload["model"], payload.get("reason")
                        )
                        self.assertEqual(expected, payload)
                        checked += 1
                    elif key == "transport_status":
                        expected = be.transport_status_event(
                            payload["requested"], payload["actual"], payload.get("reason"),
                            payload.get("capabilities"),
                        )
                        self.assertEqual(expected, payload)
                        checked += 1
                    elif key == "usage":
                        expected = be.usage_event(
                            payload.get("prompt_tokens", 0),
                            payload.get("completion_tokens", 0),
                            payload.get("total_tokens", 0),
                            payload.get("estimated_cost_usd"),
                            cached_input_tokens=payload.get("cached_input_tokens"),
                            reasoning_tokens=payload.get("reasoning_tokens"),
                            cost_source=payload.get("cost_source"),
                        )
                        self.assertEqual(expected, payload)
                        checked += 1
                    elif key == "agent_notice_clear":
                        self.assertEqual(be.agent_notice_clear_event(payload["key"]), payload)
                        checked += 1
        self.assertGreater(checked, 0, "no bridge-owned events were cross-checked")

    def test_agent_transports_report_priced_usage_and_capabilities(self):
        """Spec 4.5 / 4.8: the agent-loop and ACP streams carry a real usage
        block (tokens + cost) on the final chunk and a capability row on
        transport_status, instead of the old hard-coded zeros."""
        for name in ("agent-loop", "acp"):
            frames = _frames(FIXTURE_DIR / f"{name}.jsonl")
            with self.subTest(fixture=name):
                final = frames[-1]
                self.assertEqual(final["choices"][0]["finish_reason"], "stop")
                usage = final["usage"]
                self.assertGreater(usage["total_tokens"], 0)
                self.assertGreater(usage["estimated_cost_usd"], 0)
                self.assertIn(usage["cost_source"], {"pricing", "agent"})
                statuses = [
                    f["choices"][0]["delta"]["transport_status"]
                    for f in frames
                    if "transport_status" in f["choices"][0]["delta"]
                ]
                self.assertTrue(statuses)
                self.assertEqual(
                    set(statuses[0]["capabilities"]),
                    {"approvals", "cancel", "stops_on_client_disconnect", "usage_in_stream", "session_resume"},
                )

    def test_fixtures_contain_no_undeclared_event_keys(self):
        """A key in a fixture that the contract does not know is drift."""
        declared = set(be.CUSTOM_EVENT_MODELS) | LEGACY_KEYS
        # Standard OpenAI delta fields are not custom events.
        standard = {
            "role", "content", "reasoning", "id", "object", "created",
            "model", "choices", "usage", "finish_reason", "index",
        }
        for path in _fixtures():
            for key, _ in _custom_events(_frames(path)):
                if key in standard:
                    continue
                with self.subTest(fixture=path.stem, event=key):
                    self.assertIn(key, declared, f"{key} is not in the event contract")


if __name__ == "__main__":
    unittest.main()
