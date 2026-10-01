"""Spec 5.1: no route stalls the event loop, and the debug lag monitor proves it.

The route check runs the real app in a child interpreter, with the monitor on
the same loop as the app (httpx ASGITransport, in one asyncio.run). Every slow dependency below is patched to ``time.sleep(SLOW)``
with SLOW above the 250ms threshold, so a route that still called it on the
loop would register a stall.
"""
import asyncio
import json
import os
import subprocess
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


REQUESTS = [
    ("GET", "/health", None),
    ("GET", "/diag", None),
    ("GET", "/cron", None),
    ("GET", "/workspace/overview", None),
    ("GET", "/sessions", None),
    ("GET", "/auth/pool", None),
    ("POST", "/workspace/mcp-servers/install", "<catalog-id>"),
]


def _route_run_child() -> dict:
    """Drive the real app in this (clean) interpreter; return what the monitor saw.

    Runs in a subprocess: the pytest process imports test_main's fastapi /
    pydantic stubs at collection, so the in-process ``main.app`` is not a real
    ASGI app there.
    """
    import main
    import bridge_providers
    import bridge_workspace
    import hermes_ops
    import routes.cron as cron_routes
    import routes.mcp as mcp_routes
    import routes.sessions as session_routes
    import routes.workspace as workspace_routes

    tmp = tempfile.TemporaryDirectory()
    home = Path(tmp.name)
    catalog_id = next(iter(mcp_routes._MCP_CATALOG_BY_ID))
    requests = [(m, p, {"id": catalog_id} if b else None) for m, p, b in REQUESTS]

    patches = [
        patch("bridge_config.HERMES_BRIDGE_TOKEN", ""),
        patch.object(bridge_workspace, "_resolve_hermes_home", lambda *_a, **_k: home),
        patch.object(bridge_providers, "_provider_has_credentials", lambda *_a, **_k: False),
        patch.object(bridge_workspace, "_cursor_composer_integration_status", _slow({"enabled": False})),
        patch.object(cron_routes, "_HERMES_CRON_AVAILABLE", True),
        patch.object(cron_routes, "_hermes_list_jobs", _slow([])),
        patch.object(workspace_routes, "_workspace_overview_payload", _slow({"ok": True})),
        patch.object(session_routes, "_load_state_db_sessions", _slow([])),
        patch.object(hermes_ops, "list_auth_pool", _slow({"providers": []})),
        patch.object(mcp_routes, "_reload_agent_mcp", _slow(True)),
    ]

    async def hit_all(client):
        statuses = {}
        for method, path, body in requests:
            (home / "config.yaml").write_text("mcp_servers: {}\n")
            resp = await client.request(method, path, json=body)
            statuses[path] = resp.status_code
        return statuses

    async def run():
        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="http://bridge") as client:
            # Warm-up pass: first-call imports are one-off and not what this guards.
            await hit_all(client)
            monitor = bridge_loop_monitor.LoopLagMonitor(log=False).start()
            started = time.monotonic()
            statuses = await hit_all(client)
            elapsed = time.monotonic() - started
            monitor.cancel()
        return {
            "statuses": statuses,
            "elapsed": elapsed,
            "stalls": [{"lag_ms": s.lag_ms, "stack": s.stack[-1500:]} for s in monitor.stalls],
        }

    for p in patches:
        p.start()
    try:
        return asyncio.run(run())
    finally:
        for p in reversed(patches):
            p.stop()
        tmp.cleanup()


class RoutesDoNotStallLoopTests(unittest.TestCase):
    """A representative slice of HTTP routes, each with its blocking dependency slowed."""

    def test_lag_monitor_stays_quiet_across_routes(self):
        proc = subprocess.run(
            [sys.executable, os.path.abspath(__file__), "--route-run-child"],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            capture_output=True,
            text=True,
            timeout=180,
            env={**os.environ, "HERMES_BRIDGE_TOKEN": "", "PYTHONDONTWRITEBYTECODE": "1"},
        )
        marker = [line for line in proc.stdout.splitlines() if line.startswith(_RESULT_PREFIX)]
        self.assertTrue(marker, f"child produced no result (rc={proc.returncode}):\n{proc.stderr[-3000:]}")
        result = json.loads(marker[-1][len(_RESULT_PREFIX):])

        for path, status in result["statuses"].items():
            self.assertLess(status, 500, f"{path} -> {status}")
        # Every slowed dependency actually ran (otherwise "quiet" proves nothing).
        self.assertGreaterEqual(result["elapsed"], SLOW * 5)
        self.assertEqual(result["stalls"], [], "event loop stalled during route handling")


_RESULT_PREFIX = "__LOOP_MONITOR_RESULT__="


if __name__ == "__main__":
    if "--route-run-child" in sys.argv:
        print(_RESULT_PREFIX + json.dumps(_route_run_child()), flush=True)
    else:
        unittest.main()
