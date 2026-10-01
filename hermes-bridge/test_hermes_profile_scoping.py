"""Regression tests for Phase 0 items 0.6 and 0.7 (defects B6, B7).

  B6  hermes_ops mutated os.environ["HERMES_HOME"] from worker threads to scope
      a profile. That is process-global, so two profiles served concurrently read
      each other's home.
  B7  unregister_active_run popped by conversation id alone, so a run finishing
      late deleted a newer overlapping run's cancel handle for that conversation.

hermes_ops is imported lazily inside tests, consistent with the other ops tests,
and skipped when hermes-agent is not importable.
"""

import os
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


def _ops_or_skip():
    try:
        import hermes_ops
    except Exception as err:  # pragma: no cover - environment dependent
        raise unittest.SkipTest(f"hermes_ops unavailable: {err}")
    return hermes_ops


def _ensure_hermes_constants():
    """Import hermes_constants, putting the real agent checkout on sys.path.

    The scoped-home tests deliberately use throwaway profile homes that contain
    no hermes-agent checkout, so hermes_ops cannot discover hermes_constants on
    its own. In production the agent code comes from one install while the profile
    home varies per request, so putting the real checkout on sys.path here
    reproduces the real arrangement.

    Returns the module, or None when hermes-agent is not installed. Tests that
    need the override skip on None rather than failing — an unavailable
    hermes-agent is an environment fact, not a regression.
    """
    ops = _ops_or_skip()
    for candidate in (
        ops._hermes_agent_dir(),
        ops._hermes_agent_dir(Path.home() / ".hermes"),
    ):
        try:
            if candidate.is_dir() and str(candidate) not in sys.path:
                sys.path.insert(0, str(candidate))
        except Exception:
            pass
    try:
        import hermes_constants

        return hermes_constants
    except Exception:
        return None


def _require_hermes_constants():
    module = _ensure_hermes_constants()
    if module is None:
        raise unittest.SkipTest("hermes-agent not installed; no context-local home override")
    return module


# ---------------------------------------------------------------------------
# B6 — profile scoping must not be process-global
# ---------------------------------------------------------------------------


class ScopedHermesHomeTests(unittest.TestCase):
    """B6: two profiles in parallel threads must each see their own home."""

    def setUp(self):
        self.ops = _ops_or_skip()

    def _resolved_home(self):
        """Resolve the home the way hermes-agent does, inside the scope."""
        return str(_require_hermes_constants().get_hermes_home())

    def test_context_var_override_is_used_when_available(self):
        """Prefer hermes-agent's context-local override over the env var."""
        _require_hermes_constants()
        with TemporaryDirectory() as tmp:
            home = Path(tmp) / "profile-a"
            home.mkdir()
            saved = os.environ.get("HERMES_HOME")
            try:
                os.environ["HERMES_HOME"] = "/nonexistent/should-not-be-used"
                with self.ops._scoped_hermes_home(home):
                    self.assertEqual(self._resolved_home(), str(home))
            finally:
                if saved is None:
                    os.environ.pop("HERMES_HOME", None)
                else:
                    os.environ["HERMES_HOME"] = saved

    def test_two_profiles_in_parallel_threads_do_not_cross_talk(self):
        _require_hermes_constants()
        """The B6 regression: concurrent profiles must not see each other.

        Each thread enters its own scope and resolves the home from inside it.
        Under the old env-var mutation, whichever thread wrote last won and the
        other read the wrong profile.
        """
        with TemporaryDirectory() as tmp:
            homes = []
            for name in ("profile-a", "profile-b", "profile-c", "profile-d"):
                p = Path(tmp) / name
                p.mkdir()
                homes.append(p)

            observed = {}
            errors = []
            barrier = threading.Barrier(len(homes))

            def worker(path):
                try:
                    # Force the threads to actually overlap.
                    barrier.wait(timeout=10)
                    for _ in range(25):
                        with self.ops._scoped_hermes_home(path):
                            got = self._resolved_home()
                            if got != str(path):
                                observed.setdefault("mismatch", []).append(
                                    (str(path), got)
                                )
                            # Yield so the threads interleave inside the scope.
                            threading.Event().wait(0.001)
                except Exception as exc:  # pragma: no cover
                    errors.append(exc)

            threads = [threading.Thread(target=worker, args=(h,)) for h in homes]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)

            self.assertEqual(errors, [], f"worker errors: {errors}")
            self.assertEqual(
                observed.get("mismatch"), None,
                f"profiles observed each other's home: {observed.get('mismatch')}",
            )

    def test_scope_restores_the_previous_home(self):
        """Leaving the scope must not leak the profile's home."""
        get_hermes_home = _require_hermes_constants().get_hermes_home
        with TemporaryDirectory() as tmp:
            home = Path(tmp) / "scoped"
            home.mkdir()
            before = str(get_hermes_home())
            with self.ops._scoped_hermes_home(home):
                self.assertEqual(str(get_hermes_home()), str(home))
            self.assertEqual(str(get_hermes_home()), before)

    def test_nested_scopes_unwind_in_order(self):
        get_hermes_home = _require_hermes_constants().get_hermes_home
        with TemporaryDirectory() as tmp:
            outer = Path(tmp) / "outer"
            inner = Path(tmp) / "inner"
            outer.mkdir()
            inner.mkdir()
            with self.ops._scoped_hermes_home(outer):
                self.assertEqual(str(get_hermes_home()), str(outer))
                with self.ops._scoped_hermes_home(inner):
                    self.assertEqual(str(get_hermes_home()), str(inner))
                self.assertEqual(str(get_hermes_home()), str(outer))

    def test_legacy_fallback_is_used_when_api_is_absent(self):
        """An older hermes-agent without the override must still work."""
        with TemporaryDirectory() as tmp:
            home = Path(tmp) / "legacy"
            home.mkdir()
            saved = os.environ.get("HERMES_HOME")
            try:
                with patch.object(self.ops, "_hermes_home_override_api", return_value=None):
                    with self.ops._scoped_hermes_home(home):
                        self.assertEqual(os.environ.get("HERMES_HOME"), str(home))
                        self.assertEqual(self._resolved_home(), str(home))
                # Restored.
                self.assertEqual(
                    os.environ.get("HERMES_HOME"),
                    saved if saved is not None else os.environ.get("HERMES_HOME"),
                )
            finally:
                if saved is None:
                    os.environ.pop("HERMES_HOME", None)
                else:
                    os.environ["HERMES_HOME"] = saved

    def test_legacy_fallback_restores_a_missing_env_var(self):
        with TemporaryDirectory() as tmp:
            home = Path(tmp) / "legacy2"
            home.mkdir()
            saved = os.environ.pop("HERMES_HOME", None)
            try:
                with patch.object(self.ops, "_hermes_home_override_api", return_value=None):
                    with self.ops._scoped_hermes_home(home):
                        self.assertEqual(os.environ.get("HERMES_HOME"), str(home))
                self.assertNotIn("HERMES_HOME", os.environ)
            finally:
                if saved is not None:
                    os.environ["HERMES_HOME"] = saved

    def test_ops_never_reloads_checkpoint_manager(self):
        """The reload was a process-global race and is no longer needed.

        Upstream resolves the checkpoint root per call, so a reload only risked
        handing back a manager bound to whichever profile reloaded last.

        Checked on the AST so the prose in hermes_ops' own docstrings, which
        names the old call to explain what changed, cannot satisfy or break it.
        """
        import ast

        tree = ast.parse(Path(self.ops.__file__).read_text())
        reload_calls = [
            ast.unparse(node)
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "reload"
        ]
        self.assertEqual(reload_calls, [], f"importlib.reload reintroduced: {reload_calls}")


class CheckpointManagerScopeTests(unittest.TestCase):
    """The manager must resolve the right home while it is being *used*."""

    def setUp(self):
        self.ops = _ops_or_skip()

    def test_checkpoint_manager_is_a_context_manager(self):
        """Callers must hold the scope across usage, not just construction."""
        with TemporaryDirectory() as tmp:
            home = Path(tmp) / "cm-home"
            (home / "hermes-agent").mkdir(parents=True)
            with self.ops._checkpoint_manager(home) as mgr:
                # mgr is None when hermes-agent is absent; either way entering
                # the scope must not raise.
                self.assertTrue(mgr is None or hasattr(mgr, "list_checkpoints"))

    def test_yields_none_when_agent_dir_absent(self):
        with TemporaryDirectory() as tmp:
            home = Path(tmp) / "no-agent"
            home.mkdir()
            with self.ops._checkpoint_manager(home) as mgr:
                self.assertIsNone(mgr)


# ---------------------------------------------------------------------------
# B7 — unregister must not delete a newer run's handle
# ---------------------------------------------------------------------------


class ActiveRunRegistryTests(unittest.TestCase):
    """B7: a late-finishing run must not cancel a newer run's handle."""

    def setUp(self):
        import hermes_runs

        self.runs = hermes_runs
        with self.runs._active_runs_lock:
            self.runs._active_runs.clear()

    def tearDown(self):
        with self.runs._active_runs_lock:
            self.runs._active_runs.clear()

    def _register(self, conv, run_id):
        self.runs.register_active_run(
            conv, run_id=run_id, base_url="http://gateway", api_key=None
        )

    def test_unregister_with_matching_run_id_removes(self):
        self._register("conv-1", "run-1")
        self.runs.unregister_active_run("conv-1", "run-1")
        with self.runs._active_runs_lock:
            self.assertNotIn("conv-1", self.runs._active_runs)

    def test_unregister_with_stale_run_id_preserves_newer_run(self):
        """The B7 regression: the old run must not delete the new run's handle."""
        self._register("conv-1", "run-old")
        # A newer run takes over the same conversation.
        self._register("conv-1", "run-new")

        # The old run finishes late and tries to clean up.
        self.runs.unregister_active_run("conv-1", "run-old")

        with self.runs._active_runs_lock:
            self.assertIn(
                "conv-1", self.runs._active_runs,
                "the newer run's cancel handle was deleted by the older run",
            )
            self.assertEqual(self.runs._active_runs["conv-1"].run_id, "run-new")

    def test_newer_run_remains_cancellable(self):
        """The practical consequence: Stop must still reach the live run."""
        self._register("conv-1", "run-old")
        self._register("conv-1", "run-new")
        self.runs.unregister_active_run("conv-1", "run-old")
        self.assertFalse(self.runs.is_run_cancelled("conv-1"))
        with self.runs._active_runs_lock:
            active = self.runs._active_runs["conv-1"]
            active.cancelled.set()
        self.assertTrue(
            self.runs.is_run_cancelled("conv-1"),
            "the surviving run lost its cancel handle",
        )

    def test_unregister_without_run_id_still_clears(self):
        """Explicit reset semantics are preserved for callers that need them."""
        self._register("conv-1", "run-1")
        self.runs.unregister_active_run("conv-1")
        with self.runs._active_runs_lock:
            self.assertNotIn("conv-1", self.runs._active_runs)

    def test_unregister_unknown_conversation_is_a_noop(self):
        self.runs.unregister_active_run("nope", "run-x")

    def test_main_passes_run_id_on_the_completion_path(self):
        """Pin the call site, or the fix is inert."""
        main_src = Path(__file__).with_name("chat_impl.py").read_text()  # moved from main.py (spec 4.1)
        self.assertIn("unregister_active_run(workspace_id, run_id)", main_src)


if __name__ == "__main__":
    unittest.main()
