"""Spec 5.2: chat routing never probes the gateway inline; capabilities refresh in the background."""
import asyncio
import os
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import hermes_ops  # noqa: E402
import hermes_runs  # noqa: E402

BASE = "http://127.0.0.1:8642"


class RoutingCacheTests(unittest.TestCase):
    def setUp(self):
        hermes_ops.clear_gateway_capabilities_cache()
        self.caller = threading.get_ident()
        self.probes = []
        self.probed = threading.Event()

    def tearDown(self):
        hermes_ops.clear_gateway_capabilities_cache()

    def _fake_probe(self, caps, delay=0.0):
        def probe(base_url=BASE, api_key=None, *, force=False):
            self.probes.append(threading.get_ident())
            time.sleep(delay)
            with hermes_ops._gateway_caps_lock:
                hermes_ops._gateway_caps_cache[hermes_ops._gateway_caps_cache_key(base_url, api_key)] = (
                    time.time(), dict(caps)
                )
            self.probed.set()
            return dict(caps)
        return probe

    def _route(self):
        return hermes_runs.should_route_via_runs(
            flag_enabled=True, provider="openrouter", moa_provider_id="moa", base_url=BASE,
        )

    def test_cold_cache_answers_immediately_and_refreshes_in_background(self):
        caps = {"run_submission": True, "features": {"runs_parity": True}}
        with patch.object(hermes_runs, "probe_gateway_capabilities", self._fake_probe(caps, delay=0.5)):
            started = time.monotonic()
            self.assertFalse(self._route())  # nothing known yet -> safe agent-loop
            self.assertFalse(hermes_runs.runs_parity_available(base_url=BASE))
            self.assertLess(time.monotonic() - started, 0.2, "routing waited on the probe")
            self.assertTrue(self.probed.wait(2))
            time.sleep(0.05)
            self.assertTrue(self._route())
            self.assertTrue(hermes_runs.runs_parity_available(base_url=BASE))
        self.assertTrue(self.probes)
        self.assertNotIn(self.caller, self.probes, "probe ran on the request thread")

    def test_refreshes_are_deduplicated(self):
        with patch.object(hermes_runs, "probe_gateway_capabilities", self._fake_probe({}, delay=0.3)):
            for _ in range(10):
                self._route()
            self.assertTrue(self.probed.wait(2))
        self.assertEqual(len(self.probes), 1)

    def test_stale_value_is_served_while_revalidating(self):
        with hermes_ops._gateway_caps_lock:
            hermes_ops._gateway_caps_cache[hermes_ops._gateway_caps_cache_key(BASE, None)] = (
                time.time() - 10_000, {"run_submission": True},
            )
        with patch.object(hermes_runs, "probe_gateway_capabilities", self._fake_probe({"run_submission": False})):
            self.assertTrue(self._route())  # stale-but-known answer, no wait
            self.assertTrue(self.probed.wait(2))
            time.sleep(0.05)
            self.assertFalse(self._route())

    def test_explicit_probe_api_still_blocks(self):
        with patch.object(hermes_runs, "probe_gateway_capabilities", return_value={"run_submission": True}) as p:
            self.assertTrue(hermes_runs.gateway_supports_runs(BASE))
        p.assert_called_once()


class AsyncRunControlTests(unittest.TestCase):
    def tearDown(self):
        hermes_runs._active_runs.clear()

    def test_cancel_and_approve_async_use_async_http(self):
        hermes_runs.register_active_run("conv-x", run_id="run-1", base_url=BASE, api_key="k")
        calls = []

        async def fake_stop(**kwargs):
            calls.append(("stop", kwargs["run_id"]))
            return 200, {}

        async def fake_approve(**kwargs):
            calls.append(("approve", kwargs["run_id"], kwargs["choice"]))
            return 202, {}

        async def run():
            with patch.object(hermes_runs, "stop_run_async", fake_stop), patch.object(
                hermes_runs, "approve_run_async", fake_approve
            ):
                approved = await hermes_runs.approve_active_run_async("conv-x", choice="deny")
                cancelled = await hermes_runs.cancel_active_run_async("conv-x")
                missing = await hermes_runs.cancel_active_run_async("nope")
            return approved, cancelled, missing

        approved, cancelled, missing = asyncio.run(run())
        self.assertEqual(approved, (True, 202))
        self.assertTrue(cancelled)
        self.assertFalse(missing)
        self.assertTrue(hermes_runs.is_run_cancelled("conv-x"))
        self.assertEqual(calls, [("approve", "run-1", "deny"), ("stop", "run-1")])


if __name__ == "__main__":
    unittest.main()
