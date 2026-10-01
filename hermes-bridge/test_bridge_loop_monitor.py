"""Spec 5.1: no route stalls the event loop, and the debug lag monitor proves it.

The monitor runs on the same loop as the app (httpx ASGITransport, in one
asyncio.run). Every slow dependency below is patched to ``time.sleep(SLOW)``
with SLOW above the 250ms threshold, so a route that still called it on the
loop would register a stall.
"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import httpx  # noqa: E402

import bridge_loop_monitor  # noqa: E402

SLOW = 0.4


def _slow(result):
    def fn(*args, **kwargs):
        time.sleep(SLOW)
        return result
    return fn


def _blocking_coroutine_stall():
    time.sleep(SLOW)


class LoopLagMonitorUnitTests(unittest.TestCase):
    def test_detects_injected_stall_and_names_the_culprit(self):
        async def run():
            monitor = bridge_loop_monitor.LoopLagMonitor(log=False).start()
            await asyncio.sleep(0.1)
            _blocking_coroutine_stall()  # sync sleep on the loop
            await asyncio.sleep(0.1)
            monitor.cancel()
            return monitor

        monitor = asyncio.run(run())
        self.assertEqual(len(monitor.stalls), 1, monitor.stalls)
        self.assertGreaterEqual(monitor.stalls[0].lag_ms, 250)
        self.assertIn("_blocking_coroutine_stall", monitor.stalls[0].stack)

    def test_quiet_when_blocking_work_runs_in_a_thread(self):
        async def run():
            monitor = bridge_loop_monitor.LoopLagMonitor(log=False).start()
            await asyncio.to_thread(time.sleep, SLOW)
            await asyncio.sleep(0.05)
            monitor.cancel()
            return monitor

        self.assertEqual(asyncio.run(run()).stalls, [])

    def test_disabled_without_env_flag(self):
        with patch.dict(os.environ, {bridge_loop_monitor.ENV_FLAG: ""}):
            self.assertIsNone(bridge_loop_monitor.start_if_enabled())


@unittest.skipUnless(hasattr(httpx, "ASGITransport"), "real httpx required")
class RoutesDoNotStallLoopTests(unittest.TestCase):
    """A representative slice of HTTP routes, each with its blocking dependency slowed."""

    def setUp(self):
        import main  # noqa: F401 - builds the app and wires every router
        self.app = sys.modules["main"].app
        self._tmp = tempfile.TemporaryDirectory()
        home = Path(self._tmp.name)
        (home / "config.yaml").write_text("mcp_servers: {}\n")
        self.home = home

    def tearDown(self):
        self._tmp.cleanup()

    def _patches(self):
        import bridge_providers
        import bridge_workspace
        import hermes_ops
        import routes.cron as cron_routes
        import routes.mcp as mcp_routes
        import routes.sessions as session_routes
        import routes.workspace as workspace_routes

        return [
            patch.dict(os.environ, {"HERMES_BRIDGE_TOKEN": ""}),
            patch("bridge_config.HERMES_BRIDGE_TOKEN", ""),
            patch.object(bridge_workspace, "_resolve_hermes_home", lambda *_a, **_k: self.home),
            patch.object(bridge_providers, "_provider_has_credentials", lambda *_a, **_k: False),
            patch.object(bridge_workspace, "_cursor_composer_integration_status", _slow({"enabled": False})),
            patch.object(cron_routes, "_HERMES_CRON_AVAILABLE", True),
            patch.object(cron_routes, "_hermes_list_jobs", _slow([])),
            patch.object(workspace_routes, "_workspace_overview_payload", _slow({"ok": True})),
            patch.object(session_routes, "_load_state_db_sessions", _slow([])),
            patch.object(hermes_ops, "list_auth_pool", _slow({"providers": []})),
            patch.object(mcp_routes, "_reload_agent_mcp", _slow(True)),
        ]

    REQUESTS = [
        ("GET", "/health", None),
        ("GET", "/diag", None),
        ("GET", "/cron", None),
        ("GET", "/workspace/overview", None),
        ("GET", "/sessions", None),
        ("GET", "/auth/pool", None),
        ("POST", "/workspace/mcp-servers/install", {"id": "memory"}),
    ]

    async def _hit_all(self, client):
        statuses = {}
        for method, path, body in self.REQUESTS:
            resp = await client.request(method, path, json=body)
            statuses[path] = resp.status_code
        return statuses

    def test_lag_monitor_stays_quiet_across_routes(self):
        import routes.mcp as mcp_routes

        catalog_id = next(iter(mcp_routes._MCP_CATALOG_BY_ID))
        self.REQUESTS = [r if r[0] != "POST" else (r[0], r[1], {"id": catalog_id}) for r in self.REQUESTS]

        async def run():
            transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 50000))
            async with httpx.AsyncClient(transport=transport, base_url="http://bridge") as client:
                # Warm-up pass: first-call imports are one-off and not what this guards.
                await self._hit_all(client)
                (self.home / "config.yaml").write_text("mcp_servers: {}\n")
                monitor = bridge_loop_monitor.LoopLagMonitor(log=False).start()
                started = time.monotonic()
                statuses = await self._hit_all(client)
                elapsed = time.monotonic() - started
                monitor.cancel()
                return monitor, statuses, elapsed

        ps = self._patches()
        for p in ps:
            p.start()
        try:
            monitor, statuses, elapsed = asyncio.run(run())
        finally:
            for p in reversed(ps):
                p.stop()

        for path, status in statuses.items():
            self.assertLess(status, 500, f"{path} -> {status}")
        # Every slowed dependency actually ran (otherwise "quiet" proves nothing).
        self.assertGreaterEqual(elapsed, SLOW * 5)
        stalls = [(s.lag_ms, s.stack.strip().splitlines()[-3:]) for s in monitor.stalls]
        self.assertEqual(stalls, [], "event loop stalled during route handling")


if __name__ == "__main__":
    unittest.main()
