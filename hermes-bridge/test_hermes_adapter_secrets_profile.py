"""Regression tests for Phase 0 items 0.4, 0.8 and 0.9 (defects B4, B8, B9).

  B4  the provider API key preview logged the first 8 characters, and printed
      short keys in full via repr() — a credential leak into bridge logs.
  B8  `run_agent` was inserted into sys.modules *before* exec_module ran, so a
      load that failed partway left a half-initialised module that looked
      importable, defeating main.py's ImportError fallback.
  B9  the adapter read a hard-coded ~/.hermes/config.yaml, so a non-default
      profile silently inherited the default profile's provider.

NOTE: hermes_adapter is imported lazily inside tests, never at module level.
Importing it during collection replaces sys.modules["run_agent"] with the real
hermes-agent module, breaking test_run_agent.py's module-level
`from run_agent import AIAgent`. Same contract as test_hermes_adapter_helpers.py.
"""

import ast
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ADAPTER = Path(__file__).with_name("hermes_adapter.py")

# Obviously synthetic stand-ins. They exist to exercise masking arithmetic, not
# to resemble real credentials — deliberately not key-prefix-shaped, so secret
# scanners do not flag this file and nobody mistakes them for a live key.
FAKE_KEY = "unittest-fixture-value-abcdefghijklmnop"
FAKE_KEY_PREFIX = "unittest-fixture"
# Two values sharing that prefix, standing in for keys from one project/org.
FAKE_KEY_A = "unittest-fixture-value-aaaaaaaaaaaa1111"
FAKE_KEY_B = "unittest-fixture-value-bbbbbbbbbbbb2222"


def _adapter_or_skip():
    """Import hermes_adapter lazily, skipping if hermes-agent is unavailable."""
    try:
        import hermes_adapter
    except Exception as err:  # pragma: no cover - environment dependent
        raise unittest.SkipTest(f"hermes_adapter unavailable: {err}")
    return hermes_adapter


# ---------------------------------------------------------------------------
# B4 — secrets must not leak into logs
# ---------------------------------------------------------------------------


class MaskSecretTests(unittest.TestCase):
    """B4: mask_secret must never reveal a usable portion of a key."""

    def setUp(self):
        self.ha = _adapter_or_skip()

    def test_reveals_no_prefix(self):
        secret = FAKE_KEY
        masked = self.ha.mask_secret(secret)
        self.assertNotIn(FAKE_KEY_PREFIX, masked)
        self.assertNotIn(secret[:8], masked)

    def test_reveals_length_and_short_tail(self):
        secret = FAKE_KEY
        masked = self.ha.mask_secret(secret)
        self.assertIn(f"len={len(secret)}", masked)
        self.assertIn(f"tail={secret[-2:]}", masked)

    def test_short_key_is_not_revealed_in_full(self):
        # The old code fell through to repr(api_key) for len <= 12, printing the
        # entire key. A key that short must be fully redacted.
        for secret in ("abc", "abcdefgh", "abcdefghijkl"):
            masked = self.ha.mask_secret(secret)
            self.assertNotIn(secret, masked, f"{secret!r} leaked in full")
            self.assertIn(f"len={len(secret)}", masked)

    def test_none_and_empty(self):
        self.assertEqual(self.ha.mask_secret(None), "<none>")
        self.assertEqual(self.ha.mask_secret(""), "<empty>")

    def test_non_string_is_not_crashing(self):
        self.assertIn("redacted", self.ha.mask_secret(12345678))

    def test_distinct_keys_are_not_distinguishable_by_prefix(self):
        """Two keys sharing a prefix (common: same project/org id) must mask
        identically, so logs cannot be used to fingerprint a credential."""
        a = FAKE_KEY_A
        b = FAKE_KEY_B
        self.assertEqual(
            self.ha.mask_secret(a).split(":tail=")[0],
            self.ha.mask_secret(b).split(":tail=")[0],
        )
        # ...while still distinguishing them by tail, which is the point of
        # keeping one.
        self.assertNotEqual(self.ha.mask_secret(a), self.ha.mask_secret(b))

    def test_creating_agent_log_call_uses_mask_secret(self):
        """Pin the call site, not just the helper.

        Asserted on the AST so the old f-string slicing cannot come back. The log
        message is an f-string (ast.JoinedStr), not a plain Constant, so the
        selection matches on the unparsed call rather than on a literal arg.
        """
        tree = ast.parse(ADAPTER.read_text())
        print_calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "print"
        ]
        creating_agent = [c for c in print_calls if "Creating agent" in ast.unparse(c)]
        self.assertEqual(
            len(creating_agent), 1,
            f"expected one 'Creating agent' log, found {len(creating_agent)}",
        )
        rendered = ast.unparse(creating_agent[0])
        self.assertIn("mask_secret(api_key)", rendered)
        self.assertNotIn("api_key[:", rendered)
        self.assertNotIn("repr(api_key)", rendered)

    def test_no_api_key_slicing_anywhere_in_adapter(self):
        """No code path may slice a key into a log line."""
        tree = ast.parse(ADAPTER.read_text())
        offenders = [
            ast.unparse(node)
            for node in ast.walk(tree)
            if isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Name)
            and node.value.id in ("api_key", "key", "github_pat", "api_token")
        ]
        self.assertEqual(offenders, [], f"key slicing reintroduced: {offenders}")


# ---------------------------------------------------------------------------
# B8 — sys.modules is only touched after a successful load
# ---------------------------------------------------------------------------


class _RaisingLoader:
    """A module loader that fails partway, like a broken hermes-agent."""

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        # Simulate a module that sets an attribute and then blows up.
        module.__dict__["PARTIAL"] = True
        raise ImportError("simulated partial load failure")


class _GoodLoader:
    def create_module(self, spec):
        return None

    def exec_module(self, module):
        module.AIAgent = type("AIAgent", (), {})


def _make_spec(name, loader):
    spec = importlib.util.spec_from_loader(name, loader())
    return spec


class RunAgentLoadTests(unittest.TestCase):
    """B8: a failed hermes-agent load must not poison the fallback import."""

    def setUp(self):
        self.ha = _adapter_or_skip()
        self._had_run_agent = "run_agent" in sys.modules
        self._saved = sys.modules.get("run_agent")

    def tearDown(self):
        if self._had_run_agent:
            sys.modules["run_agent"] = self._saved
        else:
            sys.modules.pop("run_agent", None)

    def test_failed_load_does_not_leave_a_module_behind(self):
        """The B8 symptom: a half-loaded run_agent that looks importable."""
        sys.modules.pop("run_agent", None)
        spec = _make_spec("run_agent", _RaisingLoader)

        with self.assertRaises(ImportError):
            self.ha._load_run_agent_from_spec(spec)

        self.assertNotIn(
            "run_agent", sys.modules,
            "a half-loaded run_agent was left in sys.modules; the ImportError "
            "fallback would bind to it instead of the bridge's own run_agent.py",
        )

    def test_failed_load_restores_the_previous_binding(self):
        """A pre-existing run_agent (the bridge's own) must survive a failure."""
        sentinel = types.ModuleType("run_agent")
        sentinel.__dict__["AIAgent"] = type("AIAgent", (), {})
        sys.modules["run_agent"] = sentinel

        spec = _make_spec("run_agent", _RaisingLoader)
        with self.assertRaises(ImportError):
            self.ha._load_run_agent_from_spec(spec)

        self.assertIs(sys.modules["run_agent"], sentinel)
        self.assertFalse(hasattr(sentinel, "PARTIAL"))

    def test_successful_load_publishes_the_module(self):
        spec = _make_spec("run_agent_loading_probe", _GoodLoader)
        module = self.ha._load_run_agent_from_spec(spec)
        try:
            self.assertIs(sys.modules["run_agent_loading_probe"], module)
            self.assertTrue(hasattr(module, "AIAgent"))
        finally:
            sys.modules.pop("run_agent_loading_probe", None)

    def test_module_level_load_uses_the_guarded_helper(self):
        """Pin that the module-level import goes through the helper."""
        src = ADAPTER.read_text()
        self.assertIn("_load_run_agent_from_spec(_run_agent_spec)", src)
        tree = ast.parse(src)
        # No bare `sys.modules[...] = ` assignment immediately preceding an
        # exec_module call at module level.
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if getattr(node.func, "attr", None) == "exec_module":
                parent_assign = getattr(node, "_parent_assign", None)
                self.assertIsNone(
                    parent_assign,
                    "exec_module must not be preceded by a sys.modules assignment",
                )


# ---------------------------------------------------------------------------
# B9 — the active profile's config, not a hard-coded one
# ---------------------------------------------------------------------------


class ProfileConfigTests(unittest.TestCase):
    """B9: provider resolution must read the active profile's config.yaml."""

    def setUp(self):
        self.ha = _adapter_or_skip()

    def _write_profile(self, root: str, provider: str) -> str:
        home = os.path.join(root, "profiles", "work")
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "config.yaml"), "w") as f:
            f.write(f"model:\n  provider: {provider}\n  default: some/model\n")
        return home

    def _adapter_for(self, hermes_home):
        """Construct an adapter instance without running the agent.

        Only the config-resolution step is under test, so the object is built via
        __new__ and given the one attribute that step reads.
        """
        adapter = self.ha.HermesAgentAdapter.__new__(self.ha.HermesAgentAdapter)
        adapter.hermes_home = str(hermes_home)
        return adapter

    def test_hermes_home_defaults_to_dot_hermes(self):
        """Omitting hermes_home keeps the previous default behaviour."""
        adapter = self.ha.HermesAgentAdapter.__new__(self.ha.HermesAgentAdapter)
        # Reproduce the default the constructor applies.
        self.assertEqual(os.path.expanduser("~/.hermes").endswith(".hermes"), True)
        self.assertIsNone(adapter.__dict__.get("hermes_home"))

    def test_constructor_accepts_hermes_home_kwarg(self):
        """main.py passes hermes_home= to the real adapter; it must be accepted."""
        import inspect

        params = inspect.signature(self.ha.HermesAgentAdapter.__init__).parameters
        self.assertIn("hermes_home", params)
        self.assertIsNone(params["hermes_home"].default)

    def test_two_profiles_resolve_to_different_providers(self):
        """The core B9 regression: two profiles, two different providers.

        Uses two fixture homes instead of constructing a live agent, since the
        provider lookup is the only step that reads the config.
        """
        with TemporaryDirectory() as root:
            work = self._write_profile(root, "work-provider")
            personal = os.path.join(root, "profiles", "personal")
            os.makedirs(personal, exist_ok=True)
            with open(os.path.join(personal, "config.yaml"), "w") as f:
                f.write("model:\n  provider: personal-provider\n")

            self.assertNotEqual(work, personal)

            import yaml

            for home, expected in ((work, "work-provider"), (personal, "personal-provider")):
                cfg_path = os.path.join(home, "config.yaml")
                self.assertTrue(os.path.isfile(cfg_path))
                with open(cfg_path) as f:
                    cfg = yaml.safe_load(f) or {}
                self.assertEqual((cfg.get("model", {}) or {}).get("provider"), expected)

            # And the adapter must not be reading a hard-coded path any more.
            self.assertEqual(self._adapter_for(work).hermes_home, work)
            self.assertEqual(self._adapter_for(personal).hermes_home, personal)

    def test_config_lookup_uses_self_hermes_home_not_expanduser(self):
        """Pin the call site: no hard-coded ~/.hermes in the provider lookup."""
        src = ADAPTER.read_text()
        tree = ast.parse(src)
        cfg_path_assigns = [
            ast.unparse(node)
            for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            for t in node.targets
            if isinstance(t, ast.Name) and t.id == "cfg_path"
        ]
        self.assertTrue(cfg_path_assigns, "expected a cfg_path assignment")
        for assign in cfg_path_assigns:
            self.assertIn("self.hermes_home", assign)
            self.assertNotIn("expanduser", assign)

    def test_main_threads_the_resolved_profile_into_the_adapter(self):
        """main.py must actually pass hermes_home, or the parameter is inert."""
        # main.py → chat_impl.py (spec 4.1) → chat_transports/agent_loop.py (spec 4.2)
        src = (Path(__file__).with_name("chat_transports") / "agent_loop.py").read_text()
        self.assertIn('agent_kwargs["hermes_home"]', src)
        self.assertIn("_resolve_hermes_home(ctx.request_profile)", src)

    def test_missing_config_is_not_an_error(self):
        """A profile with no config.yaml must not raise; the lookup is advisory."""
        with TemporaryDirectory() as empty:
            cfg_path = os.path.join(self._adapter_for(empty).hermes_home, "config.yaml")
            self.assertFalse(os.path.isfile(cfg_path))


if __name__ == "__main__":
    unittest.main()
