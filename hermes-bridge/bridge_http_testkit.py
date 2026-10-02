"""Test-only helper: the real bridge app, importable inside the stubbed suite.

The in-process suite runs with fastapi/pydantic (and sometimes httpx) replaced
by stubs: test_main.py installs them at import time, and unittest/pytest import
every test module before running any test, so by the time an HTTP test runs
``sys.modules["fastapi"]`` is a stub and ``main.app`` has no routes. That is why
the route-table and startup-smoke tests shell out to a fresh interpreter.

For HTTP tests a subprocess per test is too slow and too opaque, so this module
builds a second, *isolated* import world instead: it temporarily removes every
"contested" module (bridge-local modules, the fastapi/starlette/pydantic/httpx
families, and any spec-less stub module) from ``sys.modules``, imports ``main``
for real under a throwaway HOME / HERMES_HOME, and records the result. Tests
swap that world in for their duration and swap the suite's original modules back
afterwards, so neither world leaks into the other.

Names are patched on the module that owns them, reached through
``RealBridge.mod("<name>")`` (for example ``kit.mod("routes.cron")``), exactly as
the rest of the suite patches owning modules rather than ``main``.
"""

from __future__ import annotations

import importlib
import os
import shutil
import sys
import tempfile
import warnings
from pathlib import Path
from typing import Optional

BRIDGE_DIR = Path(__file__).resolve().parent

# Third-party families the suite stubs (or whose real copies must not leak into
# the stubbed world). Anything under these top-level names is swapped as a unit.
_FAMILIES = frozenset({
    "fastapi",
    "starlette",
    "pydantic",
    "pydantic_core",
    "pydantic_settings",
    "httpx",
    "httpcore",
    "uvicorn",
})

# Env the bridge reads at import time. Cleared so a developer's real token or
# hermes-agent checkout never reaches the app under test.
_CLEARED_ENV = (
    "HERMES_BRIDGE_TOKEN",
    "HERMES_BRIDGE_ALLOW_LOOPBACK_NOAUTH",
    "BRAIN_MCP_PATH",
    "HERMES_API_BASE",
    "HERMES_API_KEY",
    "API_SERVER_KEY",
    "HERMES_CRON_PYTHON",
)


def _is_local(mod) -> bool:
    """True for modules that live in hermes-bridge/ itself (not its .venv)."""
    path = getattr(mod, "__file__", None)
    if not path:
        return False
    try:
        resolved = Path(path).resolve()
    except OSError:
        return False
    if "site-packages" in resolved.parts:
        return False
    try:
        resolved.relative_to(BRIDGE_DIR)
    except ValueError:
        return False
    return True


def _is_contested(name: str, mod) -> bool:
    if name == "__main__" or name in sys.builtin_module_names:
        return False
    if name.split(".", 1)[0] in _FAMILIES:
        return True
    if mod is None:
        return False
    # types.ModuleType(...) stubs have no import spec; real modules always do.
    if getattr(mod, "__spec__", None) is None:
        return True
    return _is_local(mod)


def _contested_snapshot() -> dict:
    return {n: m for n, m in list(sys.modules.items()) if _is_contested(n, m)}


def real_fastapi_available() -> Optional[str]:
    """None when the real bridge runtime deps exist on disk, else a skip reason."""
    import importlib.util

    for name in ("fastapi", "starlette", "pydantic", "httpx"):
        # find_spec on a stubbed module raises (no __spec__); look on disk instead.
        saved = sys.modules.pop(name, None)
        try:
            spec = importlib.util.find_spec(name)
        except (ImportError, ValueError):
            spec = None
        finally:
            if saved is not None:
                sys.modules[name] = saved
        if spec is None:
            return f"{name} is not installed"
    return None


class RealBridge:
    """An isolated, real-FastAPI import of ``main`` under a temporary home."""

    def __init__(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="bridge-http-"))
        self.home = self.tmp / "home"
        self.hermes_home = self.home / ".hermes"
        self.hermes_home.mkdir(parents=True)
        self._outer: dict = {}
        self._world: dict = {}
        self._saved_env: dict = {}
        self._saved_path: list = []
        self._active = False
        self.main = None

    # -- env ---------------------------------------------------------------
    def _apply_env(self) -> None:
        overrides = {
            "HOME": str(self.home),
            "USERPROFILE": str(self.home),
            "HERMES_HOME": str(self.hermes_home),
            "HERMES_AGENT_DIR": str(self.hermes_home / "hermes-agent"),
        }
        for key in list(overrides) + list(_CLEARED_ENV):
            self._saved_env[key] = os.environ.get(key)
        for key in _CLEARED_ENV:
            os.environ.pop(key, None)
        os.environ.update(overrides)

    def _restore_env(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._saved_env.clear()

    # -- module worlds -------------------------------------------------------
    def _swap(self, target: dict) -> dict:
        """Replace every contested module with ``target``; return what was there."""
        current = _contested_snapshot()
        for name in current:
            sys.modules.pop(name, None)
        sys.modules.update(target)
        return current

    def start(self) -> "RealBridge":
        self._outer = {}
        self._world = {}
        self.activate()
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                self.main = importlib.import_module("main")
                import fastapi  # noqa: F401  (must be the real one now)

                if getattr(fastapi, "__spec__", None) is None:
                    raise RuntimeError("fresh import still resolved a fastapi stub")
        except BaseException:
            self.stop()
            raise
        return self

    def activate(self) -> None:
        """Swap the real world in (per test): modules, env and sys.path."""
        if self._active:
            return
        self._apply_env()
        self._saved_path = list(sys.path)
        if str(BRIDGE_DIR) not in sys.path:
            sys.path.insert(0, str(BRIDGE_DIR))
        self._outer = self._swap(self._world)
        self._active = True

    def deactivate(self) -> None:
        """Swap the suite's original modules, env and sys.path back (per test).

        Bridge modules insert the (temporary) hermes-agent dir into sys.path at
        import time; restoring sys.path keeps that from steering later imports
        in the stubbed world.
        """
        if not self._active:
            return
        # Capture anything imported lazily during the test (e.g. a route's
        # function-level `import hermes_ops`) so it stays in this world.
        self._world = self._swap(self._outer)
        sys.path[:] = self._saved_path
        self._restore_env()
        self._active = False

    def stop(self) -> None:
        self.deactivate()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers -------------------------------------------------------------
    def mod(self, name: str):
        """The real-world copy of a module (import it on demand)."""
        if not self._active:
            raise RuntimeError("RealBridge.mod() called while the world is inactive")
        return importlib.import_module(name)

    def client(self, *, host: str = "127.0.0.1", headers: Optional[dict] = None):
        """A TestClient against the real middleware stack, lifespan NOT started.

        The lifespan would start brain, the cron scheduler and MCP telemetry;
        none of that is under test here and the startup smoke test covers it.
        """
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from fastapi.testclient import TestClient

            return TestClient(
                self.main.app,
                client=(host, 50000),
                headers=headers or {},
                raise_server_exceptions=False,
            )


# -- unittest glue -------------------------------------------------------------
import unittest  # noqa: E402
from unittest.mock import patch  # noqa: E402

_SHARED: Optional[RealBridge] = None


def shared_bridge() -> RealBridge:
    """One isolated import per process; importing main is the slow part."""
    global _SHARED
    if _SHARED is None:
        reason = real_fastapi_available()
        if reason:
            raise unittest.SkipTest(f"real bridge runtime deps unavailable: {reason}")
        _SHARED = RealBridge().start()
        _SHARED.deactivate()
        import atexit

        atexit.register(_SHARED.stop)
    return _SHARED


class RealBridgeTestCase(unittest.TestCase):
    """Base class: each test runs with the real-FastAPI world swapped in.

    Every test gets its own empty HERMES_HOME (``self.hermes_home``) and a
    TestClient whose peer address is loopback (``self.client``).
    """

    kit: RealBridge

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kit = shared_bridge()

    def setUp(self):
        super().setUp()
        self.kit.activate()
        self.addCleanup(self.kit.deactivate)
        self.hermes_home = Path(tempfile.mkdtemp(prefix="hh-", dir=self.kit.tmp))
        ws = self.kit.mod("bridge_workspace")
        for name, value in (
            ("_HERMES_HOME", self.hermes_home),
            ("_PROFILE_MANAGER_HOME", self.hermes_home),
            ("_PROFILES_ROOT", self.hermes_home / "profiles"),
            ("_ACTIVE_PROFILE_PATH", self.hermes_home / "active_profile"),
        ):
            self.patch_object(ws, name, value)
        self.client = self.kit.client()
        self.addCleanup(self.client.close)

    def patch_object(self, target, attribute: str, new):
        """patch.object for the length of this test."""
        patcher = patch.object(target, attribute, new)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value
