"""
test_bridge_lifespan.py — regression tests for Phase 0 items 0.1, 0.2 and 0.5.

Covers three defects that all shared one root cause area — the bridge's startup
and brain wiring:

  B1  @app.on_event("startup") handlers never ran, because FastAPI ignores
      on_event entirely when `lifespan=` is supplied. The cron scheduler never
      ticked and MCP telemetry never initialized.

  B2  swarm_pattern.py did `import main`. The bridge runs as `python main.py`,
      so that executed main.py a SECOND time under a separate module object
      whose _brain_proc was always None — every swarm brain RPC returned None,
      silently.

  B5  brain-mcp and node were located by hard-coded absolute paths
      (/Users/devgwardo/brain-mcp, /opt/homebrew/bin/node), so the bridge only
      worked on the original author's machine.

NOTE ON STYLE: this suite deliberately runs with fastapi and pydantic stubbed out
(test_acp_repo_grounding.py imports test_main first, which installs the stubs
before `main` is imported). So `main.app` is a stub with no router and
`TestClient` cannot be used here. The lifespan is therefore driven directly as
the async generator it is, which tests the startup/shutdown contract more
precisely than going through HTTP would.
"""

import ast
import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import brain_client
import main
import swarm_pattern


# ---------------------------------------------------------------------------
# B5 — portable brain-mcp / node discovery
# ---------------------------------------------------------------------------


class BrainDiscoveryTests(unittest.TestCase):
    """B5: brain-mcp and node must be discovered, not hard-coded."""

    def test_resolve_brain_script_none_when_not_installed(self):
        """With an empty HOME and no override, discovery reports 'not installed'."""
        with TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("BRAIN_MCP_PATH", None)
                with patch.dict(os.environ, {"HOME": tmp, "USERPROFILE": tmp}):
                    self.assertIsNone(brain_client.resolve_brain_script())

    def test_resolve_brain_script_honors_env_override(self):
        """BRAIN_MCP_PATH wins, so a checkout can live anywhere on disk."""
        with TemporaryDirectory() as tmp:
            script = Path(tmp) / "custom" / "index.js"
            script.parent.mkdir(parents=True)
            script.write_text("// brain-mcp\n")
            with patch.dict(os.environ, {"BRAIN_MCP_PATH": str(script)}):
                self.assertEqual(brain_client.resolve_brain_script(), str(script))

    def test_resolve_brain_script_env_override_pointing_nowhere_is_none(self):
        """A configured-but-missing BRAIN_MCP_PATH must not silently fall back."""
        with TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "nope" / "index.js")
            with patch.dict(os.environ, {"BRAIN_MCP_PATH": missing}):
                self.assertIsNone(brain_client.resolve_brain_script())

    def test_resolve_node_binary_uses_path_lookup(self):
        """node is found via PATH rather than a hard-coded absolute path."""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BRAIN_NODE_PATH", None)
            with patch("brain_client.shutil.which", return_value="/usr/bin/node"):
                self.assertEqual(brain_client.resolve_node_binary(), "/usr/bin/node")

    def test_resolve_node_binary_none_when_absent_everywhere(self):
        """No node on PATH and none in the standard locations -> report missing."""
        real_exists = os.path.exists
        standard = ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node")

        def fake_exists(path):
            if path in standard:
                return False
            return real_exists(path)

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BRAIN_NODE_PATH", None)
            with patch("brain_client.shutil.which", return_value=None), \
                 patch("brain_client.os.path.exists", side_effect=fake_exists):
                self.assertIsNone(brain_client.resolve_node_binary())

    def test_start_brain_returns_false_when_script_missing(self):
        """Missing brain-mcp is a skip, not a crash, and not a false 'connected'."""
        cfg = brain_client.BrainConfig(port=3002, model="m", toolsets="web", max_iterations=1)
        with TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"BRAIN_MCP_PATH": str(Path(tmp) / "absent.js")}):
                connected = asyncio.run(brain_client.start_brain(cfg))
        self.assertFalse(connected)
        self.assertFalse(brain_client._brain_initialized)

    def test_start_brain_returns_false_when_node_missing(self):
        """A present script but no node interpreter is also a clean skip."""
        cfg = brain_client.BrainConfig(port=3002, model="m", toolsets="web", max_iterations=1)
        with TemporaryDirectory() as tmp:
            script = Path(tmp) / "index.js"
            script.write_text("// brain-mcp\n")
            with patch.dict(os.environ, {"BRAIN_MCP_PATH": str(script), "BRAIN_NODE_PATH": str(script)}), \
                 patch("brain_client.resolve_node_binary", return_value=None):
                connected = asyncio.run(brain_client.start_brain(cfg))
        self.assertFalse(connected)
        self.assertFalse(brain_client._brain_initialized)

    def test_no_hardcoded_machine_paths_in_brain_client(self):
        """Guard against the original B5 defect being reintroduced.

        Checked against the AST rather than raw text, so the prose in this
        module's own docstrings (which names the old paths to explain what
        changed) cannot mask a real hard-coded literal in executable code.
        """
        tree = ast.parse(Path(brain_client.__file__).read_text())

        docstrings = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                doc = ast.get_docstring(node, clean=False)
                if doc:
                    docstrings.add(doc)

        offenders = [
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and node.value not in docstrings
            and "/Users/devgwardo" in node.value
        ]
        self.assertEqual(offenders, [], f"hard-coded machine path in code: {offenders}")

    def test_spawn_passes_the_resolved_node_binary_not_a_literal(self):
        """create_subprocess_exec must receive the resolved interpreter by name.

        AST-level: the first argument has to be a Name, never a string literal.
        This is what pins the original `/opt/homebrew/bin/node` defect shut.
        """
        tree = ast.parse(Path(brain_client.__file__).read_text())
        spawns = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and getattr(node.func, "attr", None) == "create_subprocess_exec"
        ]
        self.assertEqual(len(spawns), 1, "expected exactly one brain subprocess spawn")
        first_arg = spawns[0].args[0]
        self.assertIsInstance(first_arg, ast.Name, "spawn target must be a name, not a literal path")
        self.assertEqual(first_arg.id, "node_bin")

    def test_subprocess_env_does_not_hardcode_path(self):
        """The brain subprocess inherits the bridge env instead of a fixed PATH."""
        src = Path(brain_client.__file__).read_text()
        self.assertIn("dict(os.environ)", src)
        self.assertNotIn(
            '"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"', src
        )


# ---------------------------------------------------------------------------
# B2 — one brain module, one subprocess handle
# ---------------------------------------------------------------------------


class _FakeStdin:
    def __init__(self):
        self.written = b""

    def write(self, data: bytes) -> None:
        self.written += data

    async def drain(self) -> None:
        return None


class _FakeStdout:
    """Pipe stand-in that polls, so a reply queued after the reader started
    waiting is still delivered — the way a real pipe behaves."""

    def __init__(self, proc: "_FakeProc"):
        self._proc = proc

    async def readline(self) -> bytes:
        for _ in range(3000):          # ~15s ceiling, then report EOF
            if self._proc._responses:
                return self._proc._responses.pop(0)
            await asyncio.sleep(0.005)
        return b""


class _FakeProc:
    """Minimal stand-in for asyncio.subprocess.Process."""

    def __init__(self):
        self.stdin = _FakeStdin()
        self.stderr = None
        self.returncode = None
        self.pid = 4242
        self._responses: list[bytes] = []
        self._stdout = _FakeStdout(self)

    @property
    def stdout(self):
        return self._stdout

    def queue(self, line: bytes) -> None:
        self._responses.append(line)


class BrainModuleIdentityTests(unittest.TestCase):
    """B2: main and swarm_pattern must share one brain_client instance."""

    def test_main_and_swarm_pattern_share_one_brain_client(self):
        self.assertIs(main.brain_client, swarm_pattern.brain_client)
        self.assertIs(main.brain_client, sys.modules["brain_client"])

    def test_swarm_pattern_does_not_import_main(self):
        """The cycle that caused the bug must not come back.

        Asserted on source because the failure mode is a *second* module object,
        which is invisible to a plain import in the test process.
        """
        src = Path(swarm_pattern.__file__).read_text()
        imports = [
            ln.strip() for ln in src.splitlines()
            if ln.strip().startswith(("import ", "from "))
        ]
        offenders = [
            ln for ln in imports
            if ln == "import main" or ln.startswith("from main ") or ln.startswith("from main.")
        ]
        self.assertEqual(offenders, [], f"swarm_pattern must not import main: {offenders}")

    def test_brain_client_does_not_import_main(self):
        """brain_client must stay dependency-free, or the cycle just moves."""
        src = Path(brain_client.__file__).read_text()
        imports = [
            ln.strip() for ln in src.splitlines()
            if ln.strip().startswith(("import ", "from "))
        ]
        offenders = [
            ln for ln in imports
            if ln == "import main" or ln.startswith("from main ") or ln.startswith("from main.")
        ]
        self.assertEqual(offenders, [], f"brain_client must not import main: {offenders}")

    def test_main_registers_itself_under_its_dotted_name(self):
        """The `python main.py` __main__ guard is present.

        Source-level assertion: the guard only executes under `__main__`, so it
        cannot be observed by importing main in-process.
        """
        src = Path(main.__file__).read_text()
        self.assertIn('sys.modules.setdefault("main", sys.modules["__main__"])', src)

    def test_brain_rpc_returns_result_when_process_is_alive(self):
        """The exact B2 symptom: RPC must not return None on a live process.

        Before the fix, swarm_pattern reached a *second* main module whose
        _brain_proc was None, so this returned None with no error anywhere. Now
        the shared handle means a live process yields a real result.
        """
        async def scenario():
            proc = _FakeProc()
            with patch.object(brain_client, "_brain_proc", proc):
                reader = asyncio.create_task(brain_client._brain_reader())
                rpc = asyncio.create_task(
                    brain_client._brain_rpc("tools/call", {"name": "brain_get", "arguments": {}})
                )
                try:
                    for _ in range(3000):
                        await asyncio.sleep(0.005)
                        if proc.stdin.written:
                            break
                    self.assertTrue(proc.stdin.written, "request was never written to stdin")
                    request = json.loads(proc.stdin.written.decode())
                    proc.queue(json.dumps({
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": {"content": [{"type": "text", "text": "ok"}]},
                    }).encode() + b"\n")
                    return await rpc
                finally:
                    for task in (rpc, reader):
                        task.cancel()
                        try:
                            await task
                        except (asyncio.CancelledError, Exception):
                            pass

        result = asyncio.run(scenario())
        self.assertIsNotNone(result, "brain RPC returned None against a live process")
        self.assertEqual(result["content"][0]["text"], "ok")

    def test_brain_rpc_returns_none_when_process_is_gone(self):
        """The other half: a dead process must return None, not raise."""
        async def scenario():
            proc = _FakeProc()
            proc.returncode = 1
            with patch.object(brain_client, "_brain_proc", proc):
                return await brain_client._brain_rpc("tools/call", {})

        self.assertIsNone(asyncio.run(scenario()))


# ---------------------------------------------------------------------------
# B1 — the lifespan owns startup and shutdown
# ---------------------------------------------------------------------------


def _idle_forever():
    async def _loop():
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            raise
    return _loop


class _NoBrainStartup:
    """Stand-in for brain_client.start_brain reporting 'not connected'.

    Used where the test is about lifespan wiring, not about spawning a process.
    """

    async def __call__(self, cfg):
        return False


class LifespanOwnsStartupTests(unittest.TestCase):
    """B1: startup work must live in the lifespan, not in on_event handlers.

    The lifespan is driven directly as an async generator — startup is the code
    before the first yield, shutdown is the code after it. See the module
    docstring for why TestClient is not usable in this suite.
    """

    def _drive_lifespan(self, during=None):
        """Run the lifespan through startup, `during`, then shutdown."""
        async def run():
            gen = main._bridge_lifespan(object())
            await gen.__anext__()          # startup
            outcome = None
            try:
                if during is not None:
                    outcome = await during()
            finally:
                with self.assertRaises(StopAsyncIteration):
                    await gen.__anext__()  # shutdown -> generator exhausts
            return outcome
        return asyncio.run(run())

    def _lifespan_patches(self, tmp, start_brain=None):
        """Patch away every side effect the lifespan would otherwise cause."""
        import mcp_telemetry

        return [
            patch.object(main, "_HERMES_HOME", Path(tmp)),
            patch.object(main, "_HERMES_CRON_AVAILABLE", False),
            patch.object(main, "_cron_jobs", {}),
            patch.object(main, "_load_cron_data", lambda: None),
            patch.object(main, "_save_cron_jobs", lambda: None),
            patch.object(main, "_cron_scheduler_loop", _idle_forever()),
            patch.object(mcp_telemetry, "init_persistence", lambda p: True),
            patch.object(
                brain_client, "start_brain",
                start_brain if start_brain is not None else _NoBrainStartup(),
            ),
        ]

    def test_no_on_event_startup_handlers_remain(self):
        """FastAPI ignores on_event when lifespan= is set, so any handler is dead
        code. This pins that the handlers are gone, which is what makes the
        lifespan the single owner of startup."""
        src = Path(main.__file__).read_text()
        tree = ast.parse(src)
        decorators = [
            ast.unparse(dec)
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            for dec in node.decorator_list
        ]
        on_event = [d for d in decorators if "on_event" in d]
        self.assertEqual(on_event, [], f"dead on_event handlers still registered: {on_event}")

    def test_lifespan_starts_cron_scheduler_and_telemetry(self):
        """The regression test for B1: both start, and the task is alive."""
        telemetry_calls = []

        async def during():
            # Snapshot liveness *during* the lifespan — by the time this result
            # is inspected the task has been cancelled and is legitimately done.
            task = main._cron_scheduler_task
            return {
                "task": task,
                "alive": task is not None and not task.done(),
                "telemetry": list(telemetry_calls),
            }

        with TemporaryDirectory() as tmp:
            patches = self._lifespan_patches(tmp)
            for p in patches:
                p.start()
            try:
                # Re-patch telemetry so we can observe the call.
                import mcp_telemetry
                with patch.object(mcp_telemetry, "init_persistence",
                                  lambda p: telemetry_calls.append(p) or True):
                    observed = self._drive_lifespan(during)
            finally:
                for p in reversed(patches):
                    p.stop()

        task = observed["task"]
        self.assertIsNotNone(task, "cron scheduler task was never created (B1)")
        self.assertTrue(observed["alive"], "cron scheduler task is not running (B1)")
        self.assertEqual(len(observed["telemetry"]), 1, "MCP telemetry never initialized (B1)")
        self.assertIsNone(main._cron_scheduler_task, "scheduler handle not cleared on shutdown")
        self.assertTrue(task.cancelled() or task.done(), "scheduler task outlived the lifespan")

    def test_cron_starts_even_when_brain_startup_raises(self):
        """A brain failure must not take cron or telemetry down with it.

        This coupling is what made B1 worse: brain startup and cron startup used
        to share one try block, so a missing brain-mcp silently disabled the
        scheduler as well.
        """
        async def exploding_start_brain(cfg):
            raise RuntimeError("brain is on fire")

        async def during():
            task = main._cron_scheduler_task
            return task is not None and not task.done()

        with TemporaryDirectory() as tmp:
            patches = self._lifespan_patches(tmp, start_brain=exploding_start_brain)
            for p in patches:
                p.start()
            try:
                alive = self._drive_lifespan(during)
            finally:
                for p in reversed(patches):
                    p.stop()

        self.assertTrue(alive, "cron scheduler died with brain startup (B1)")

    def test_bridge_boots_with_an_empty_home(self):
        """B5's exit criterion: the bridge must come up with no brain-mcp anywhere.

        Runs the real start_brain (not a stub) against an empty HOME, so this
        exercises the real discovery path and asserts brain is genuinely absent
        rather than silently 'connected'.
        """
        async def during():
            return {
                "initialized": brain_client._brain_initialized,
                "proc": brain_client._brain_proc,
                "task": main._cron_scheduler_task,
            }

        with TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"HOME": tmp, "USERPROFILE": tmp}):
                os.environ.pop("BRAIN_MCP_PATH", None)
                # Real start_brain; only cron/telemetry are stubbed out.
                patches = [
                    patch.object(main, "_HERMES_HOME", Path(tmp)),
                    patch.object(main, "_HERMES_CRON_AVAILABLE", False),
                    patch.object(main, "_cron_jobs", {}),
                    patch.object(main, "_load_cron_data", lambda: None),
                    patch.object(main, "_save_cron_jobs", lambda: None),
                    patch.object(main, "_cron_scheduler_loop", _idle_forever()),
                ]
                for p in patches:
                    p.start()
                try:
                    observed = self._drive_lifespan(during)
                finally:
                    for p in reversed(patches):
                        p.stop()

        self.assertIsNotNone(observed["task"], "bridge did not come up without brain-mcp")
        self.assertFalse(observed["initialized"], "brain reported initialized with an empty HOME")
        self.assertIsNone(observed["proc"], "a brain subprocess handle was created with an empty HOME")

    def test_bridge_metrics_start_time_is_initialized_without_brain(self):
        """Bridge counters are not brain state.

        They used to be initialized only inside the brain startup block, so with
        no brain the published start_time stayed 0.0.
        """
        async def during():
            return {
                "start_time": main._bridge_start_time,
                "metrics": main._bridge_metrics_snapshot(),
            }

        with TemporaryDirectory() as tmp:
            patches = self._lifespan_patches(tmp)
            for p in patches:
                p.start()
            try:
                observed = self._drive_lifespan(during)
            finally:
                for p in reversed(patches):
                    p.stop()

        self.assertGreater(observed["start_time"], 0, "start_time was never initialized")
        self.assertGreater(observed["metrics"]["start_time"], 0)
        self.assertIn("active_requests", observed["metrics"])


if __name__ == "__main__":
    unittest.main()
