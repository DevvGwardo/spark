"""Startup smoke test (spec 7.3): `python main.py` must boot and answer /health.

The in-process suite imports main with fastapi stubbed out and drives the
lifespan by hand, so nothing else exercises the real entry point that
scripts/start-bridge.sh and electron/bridge.ts spawn. This runs it as a
subprocess on a free port with an empty HOME, waits for /health, checks the
lifespan-owned cron scheduler came up, then stops it and requires a clean exit.
"""

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
STARTUP_TIMEOUT_S = 60
SHUTDOWN_TIMEOUT_S = 20

_PROBE = r"""
import importlib, sys
for name in ("fastapi", "uvicorn", "httpx", "pydantic"):
    importlib.import_module(name)
import fastapi
sys.exit(0 if hasattr(fastapi, "APIRouter") else 1)
"""


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get_json(url: str, timeout: float = 2.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


class BridgeStartupSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        probe = subprocess.run(
            [sys.executable, "-c", _PROBE], cwd=str(BRIDGE_DIR),
            capture_output=True, text=True, timeout=60,
        )
        if probe.returncode != 0:
            raise unittest.SkipTest(f"bridge runtime deps not importable: {probe.stderr[-500:]}")

    def test_python_main_py_serves_health_and_shuts_down_cleanly(self):
        port = _free_port()
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ)
            for key in ("HERMES_BRIDGE_TOKEN", "BRAIN_MCP_PATH", "HERMES_BRIDGE_ALLOW_LOOPBACK_NOAUTH"):
                env.pop(key, None)
            env.update({
                "HOME": home,
                "USERPROFILE": home,
                "HERMES_HOME": os.path.join(home, ".hermes"),
                "HERMES_AGENT_DIR": os.path.join(home, ".hermes", "hermes-agent"),
                "HERMES_PORT": str(port),
                "HERMES_BRIDGE_HOST": "127.0.0.1",
                "PYTHONUNBUFFERED": "1",
            })
            log_path = os.path.join(home, "bridge.log")
            with open(log_path, "w") as log:
                proc = subprocess.Popen(
                    [sys.executable, "main.py"],
                    cwd=str(BRIDGE_DIR), env=env,
                    stdout=log, stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            try:
                health = None
                deadline = time.monotonic() + STARTUP_TIMEOUT_S
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        break
                    try:
                        status, body = _get_json(f"http://127.0.0.1:{port}/health")
                        if status == 200:
                            health = body
                            break
                    except (urllib.error.URLError, ConnectionError, OSError, ValueError):
                        pass
                    time.sleep(0.25)

                log_tail = Path(log_path).read_text(errors="replace")[-4000:]
                self.assertIsNone(proc.poll(), f"bridge exited during startup:\n{log_tail}")
                self.assertIsNotNone(health, f"/health never answered 200:\n{log_tail}")
                self.assertIsInstance(health, dict)

                # /diag is the Electron ownership probe; it must answer too.
                status, diag = _get_json(f"http://127.0.0.1:{port}/diag")
                self.assertEqual(status, 200)
                self.assertEqual(diag.get("pid"), proc.pid)

                # The lifespan owns the cron scheduler (B1): its startup line
                # only prints from _start_cron_scheduler.
                log_text = Path(log_path).read_text(errors="replace")
                self.assertIn("[cron]", log_text, f"cron scheduler never started:\n{log_tail}")
            finally:
                if proc.poll() is None:
                    proc.send_signal(signal.SIGINT)
                    try:
                        proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait(timeout=5)
                        self.fail("bridge did not shut down within "
                                  f"{SHUTDOWN_TIMEOUT_S}s of SIGINT")

            # The cron helper probe may log an expected ImportError traceback
            # when hermes-agent is absent, so assert on the shutdown path itself.
            log_text = Path(log_path).read_text(errors="replace")
            self.assertIn("Application shutdown complete", log_text,
                          f"lifespan shutdown did not complete:\n{log_text[-4000:]}")
            self.assertEqual(proc.returncode, 0, f"bridge exit code {proc.returncode}:\n{log_text[-4000:]}")


if __name__ == "__main__":
    unittest.main()
