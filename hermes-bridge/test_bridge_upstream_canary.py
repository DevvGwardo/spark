"""Upstream-compat canary checks against a real hermes-agent checkout (spec 7.5).

Skipped unless HERMES_CANARY_AGENT_DIR points at a hermes-agent checkout. The
nightly .github/workflows/hermes-canary.yml sets it after cloning hermes-agent
``main``; locally you can point it at ``~/.hermes/hermes-agent``:

    HERMES_CANARY_AGENT_DIR=~/.hermes/hermes-agent python -m pytest test_bridge_upstream_canary.py

The rest of the suite runs against a fake agent tree (ci/fixture_agent.py), so
nothing else notices when upstream moves a module the bridge reaches into. Each
check below is one of those reach-ins, run in a fresh interpreter so a failure
names the exact shim that broke.
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
AGENT_DIR = os.path.expanduser(os.environ.get("HERMES_CANARY_AGENT_DIR", "").strip())
STARTUP_TIMEOUT_S = 90
SHUTDOWN_TIMEOUT_S = 20

# name -> python source run with the agent dir first on sys.path. Each must
# exit 0; anything printed is surfaced in the failure message.
_SURFACE_CHECKS = {
    # bridge_workspace._load_hermes_agent_commands (/workspace/commands)
    "hermes_cli.commands.COMMAND_REGISTRY": (
        "from hermes_cli import commands as c\n"
        "reg = list(c.COMMAND_REGISTRY)\n"
        "assert reg, 'COMMAND_REGISTRY is empty'\n"
        "for e in reg:\n"
        "    assert getattr(e, 'name', None) and hasattr(e, 'description'), repr(e)\n"
    ),
    "hermes_cli.commands._iter_plugin_command_entries": (
        "from hermes_cli.commands import _iter_plugin_command_entries as f\n"
        "list(f())\n"
    ),
    # routes/mcp._build_mcp_tool_index, hermes_adapter plugin toolsets
    "tools.registry.registry": (
        "from tools.registry import registry\n"
        "assert callable(getattr(registry, 'get_schema', None)), 'registry.get_schema missing'\n"
    ),
    "tools.mcp_tool (index + reload)": (
        "from tools.mcp_tool import _mcp_tool_server_names, _lock\n"
        "from tools.mcp_tool_discovery import discover_mcp_tools\n"
        "from tools.mcp_tool_lifecycle import shutdown_mcp_servers\n"
    ),
    # hermes_adapter / run_agent legacy loop
    "run_agent.AIAgent": (
        "import run_agent\n"
        "assert hasattr(run_agent, 'AIAgent'), 'run_agent.AIAgent missing'\n"
    ),
    # /skill expansion in chat
    "agent.skill_commands.get_skill_commands": (
        "from agent.skill_commands import get_skill_commands\n"
        "assert callable(get_skill_commands)\n"
    ),
    # patches/hermes-api-server-runs-parity.patch target
    "gateway.platforms.api_server": (
        "import importlib.util\n"
        "assert importlib.util.find_spec('gateway.platforms.api_server'), 'api_server moved'\n"
    ),
}


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get_json(url: str, timeout: float = 5.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def _agent_env(home: str) -> dict:
    env = dict(os.environ)
    for key in ("HERMES_BRIDGE_TOKEN", "BRAIN_MCP_PATH", "HERMES_BRIDGE_ALLOW_LOOPBACK_NOAUTH"):
        env.pop(key, None)
    env.update({
        "HOME": home,
        "USERPROFILE": home,
        "HERMES_HOME": os.path.join(home, ".hermes"),
        "HERMES_AGENT_DIR": AGENT_DIR,
        # main.py sets this before importing anything from the agent; the
        # surface checks must import under the same conditions.
        "HERMES_DISABLE_LAZY_INSTALLS": "1",
        "PYTHONUNBUFFERED": "1",
    })
    return env


@unittest.skipUnless(AGENT_DIR, "HERMES_CANARY_AGENT_DIR not set (canary-only checks)")
class UpstreamImportSurfaceTests(unittest.TestCase):
    """Every hermes-agent module/attribute the bridge reaches into still exists."""

    def test_agent_dir_is_a_checkout(self):
        self.assertTrue(
            os.path.isfile(os.path.join(AGENT_DIR, "run_agent.py")),
            f"{AGENT_DIR} has no run_agent.py",
        )

    def test_import_surface(self):
        with tempfile.TemporaryDirectory() as home:
            env = _agent_env(home)
            for name, body in _SURFACE_CHECKS.items():
                with self.subTest(shim=name):
                    src = f"import sys\nsys.path.insert(0, {AGENT_DIR!r})\n" + body
                    proc = subprocess.run(
                        [sys.executable, "-c", src], cwd=AGENT_DIR, env=env,
                        capture_output=True, text=True, timeout=120,
                    )
                    self.assertEqual(
                        proc.returncode, 0,
                        f"{name} broke against hermes-agent:\n{(proc.stdout + proc.stderr)[-3000:]}",
                    )


@unittest.skipUnless(AGENT_DIR, "HERMES_CANARY_AGENT_DIR not set (canary-only checks)")
class UpstreamBridgeBootTests(unittest.TestCase):
    """`python main.py` with the real agent on its path boots and serves."""

    def test_bridge_boots_against_the_real_agent(self):
        port = _free_port()
        with tempfile.TemporaryDirectory() as home:
            env = _agent_env(home)
            env.update({"HERMES_PORT": str(port), "HERMES_BRIDGE_HOST": "127.0.0.1"})
            log_path = os.path.join(home, "bridge.log")
            with open(log_path, "w") as log:
                proc = subprocess.Popen(
                    [sys.executable, "main.py"], cwd=str(BRIDGE_DIR), env=env,
                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                )
            base = f"http://127.0.0.1:{port}"
            try:
                deadline = time.monotonic() + STARTUP_TIMEOUT_S
                health = None
                while time.monotonic() < deadline and proc.poll() is None:
                    try:
                        status, body = _get_json(f"{base}/health")
                        if status == 200:
                            health = body
                            break
                    except (urllib.error.URLError, ConnectionError, OSError, ValueError):
                        pass
                    time.sleep(0.25)
                tail = Path(log_path).read_text(errors="replace")[-4000:]
                self.assertIsNone(proc.poll(), f"bridge exited during startup:\n{tail}")
                self.assertIsNotNone(health, f"/health never answered 200:\n{tail}")

                # /workspace/commands reads hermes_cli.commands in-process; with
                # the real agent on the path it must list agent built-ins.
                status, body = _get_json(f"{base}/workspace/commands")
                self.assertEqual(status, 200)
                kinds = {c.get("kind") for c in body.get("commands", [])}
                log_text = Path(log_path).read_text(errors="replace")
                self.assertIn("agent", kinds, f"no agent commands surfaced:\n{log_text[-4000:]}")
                self.assertNotIn("command registry unavailable", log_text)

                status, _ = _get_json(f"{base}/v1/models")
                self.assertEqual(status, 200)
            finally:
                if proc.poll() is None:
                    proc.send_signal(signal.SIGINT)
                    try:
                        proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait(timeout=5)
                        self.fail(f"bridge did not stop within {SHUTDOWN_TIMEOUT_S}s of SIGINT")
            log_text = Path(log_path).read_text(errors="replace")
            self.assertIn("Application shutdown complete", log_text, log_text[-4000:])
            self.assertEqual(proc.returncode, 0, log_text[-4000:])


if __name__ == "__main__":
    unittest.main()
