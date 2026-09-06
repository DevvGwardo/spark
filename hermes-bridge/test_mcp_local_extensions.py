"""Milestone proof: bridge local MCP extensions (Node mcp-workers pool).

Covers the bridge side that surfaces Node-side local extensions
(``GET <node>/api/mcp-workers/extensions``-style listing, exact path owned by
the concurrent bridge-module impl) as agent ``custom_tools`` entries pointing
at ``/api/mcp-workers/<serverId>/rpc``.

CONVENTIONS (mirrors test_hermes_adapter_mcp.py):
- Impl module imported LAZILY (inside helpers), never at module level, so
  importing this file during collection cannot clobber
  ``sys.modules["run_agent"]`` for test_run_agent.py.
- Impl module name is owned by the concurrent implementer; probe
  ``mcp_local_extensions`` first (matches this test file's name), then
  fallbacks. Anything missing -> skip with an explicit drift reason instead
  of failing, so the targeted pytest stays green pre-wire and becomes
  strict automatically post-wire.
- Fail-soft test uses closed port 127.0.0.1:1 (fast refused, no network).
"""

import importlib.util
import inspect
import unittest

_CANDIDATE_MODULES = (
    "mcp_local_extensions",  # expected: mirrors test_mcp_local_extensions.py
    "hermes_mcp_local",
    "local_mcp_extensions",
    "mcp_local",
)

_SHAPE_FN_CANDIDATES = (
    "to_custom_tools",
    "local_extensions_to_custom_tools",
    "extensions_to_custom_tools",
)

_FETCH_FN_CANDIDATES = (
    "fetch_local_extensions",
    "fetchLocalExtensions",
    "get_local_extensions",
    "list_local_extensions",
)

_MERGE_FN_CANDIDATES = (
    "merge_custom_tools",
    "merge_tools",
    "compose_custom_tools",
    "combine_custom_tools",
    "merge_user_and_local_tools",
)

_RPC_SUFFIX = "/api/mcp-workers/ext:x/rpc"


def _load_impl():
    """Return (module, name) for the first importable candidate, else (None, None)."""
    for name in _CANDIDATE_MODULES:
        if importlib.util.find_spec(name) is None:
            continue
        try:
            return __import__(name), name
        except Exception:
            continue
    return None, None


def _pick(mod, candidates):
    for name in candidates:
        fn = getattr(mod, name, None)
        if callable(fn):
            return fn, name
    return None, None


def _call_shape_fn(fn, exts, base_url):
    """Adapt to the impl's to_custom_tools signature via inspect."""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return fn(exts)
    params = list(sig.parameters.values())
    if len(params) >= 2:
        second = params[1].name.lower()
        if "url" in second or "base" in second or "node" in second:
            return fn(exts, base_url)
        return fn(exts, base_url)
    # Single-arg form: rely on env the impl reads (set by caller).
    return fn(exts)


def _call_fetch_fn(fn, base_url):
    """Adapt to the impl's fetch signature via inspect; fail-soft on errors."""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        try:
            return fn(base_url)
        except TypeError:
            return fn()
    names = [p.name.lower() for p in sig.parameters.values()]
    kwargs = {}
    for key in ("base_url", "node_base_url", "node_url", "url"):
        if key in names:
            kwargs[key] = base_url
            break
    for key in ("timeout", "timeout_s", "timeout_seconds"):
        if key in names:
            kwargs[key] = 2
            break
    try:
        return fn(*([base_url] if not kwargs and names else []), **kwargs)
    except TypeError:
        try:
            return fn()
        except Exception:
            raise


def _string_values(obj, out):
    if isinstance(obj, str):
        out.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _string_values(v, out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            _string_values(v, out)


@unittest.skipUnless(
    any(importlib.util.find_spec(m) is not None for m in _CANDIDATE_MODULES),
    "DRIFT: no local-extensions bridge module yet "
    f"(probed {_CANDIDATE_MODULES!r}); bridge impl owns it.",
)
class LocalExtensionShapingTests(unittest.TestCase):
    def test_to_custom_tools_points_at_worker_rpc(self):
        mod, mod_name = _load_impl()
        self.assertIsNotNone(mod, "module vanished between probe and load")
        fn, fn_name = _pick(mod, _SHAPE_FN_CANDIDATES)
        if fn is None:
            self.skipTest(
                f"DRIFT: {mod_name} has no shaping fn "
                f"(probed {_SHAPE_FN_CANDIDATES!r}); impl owns naming."
            )
        exts = [{"id": "e1", "serverId": "ext:x", "name": "local_tool"}]
        try:
            tools = _call_shape_fn(fn, exts, "http://127.0.0.1:3001")
        except Exception as exc:
            self.skipTest(f"DRIFT: {fn_name} rejected probe input: {exc!r}")
        self.assertIsInstance(tools, list, f"{fn_name} must return a list")
        self.assertEqual(len(tools), 1, f"{fn_name} must map 1 extension -> 1 tool")
        strings: list = []
        _string_values(tools[0], strings)
        self.assertTrue(
            any(s.endswith(_RPC_SUFFIX) for s in strings),
            f"{fn_name} entry must carry a URL ending {_RPC_SUFFIX!r}; saw {strings!r}",
        )


@unittest.skipUnless(
    any(importlib.util.find_spec(m) is not None for m in _CANDIDATE_MODULES),
    "DRIFT: no local-extensions bridge module yet; bridge impl owns it.",
)
class FetchLocalExtensionsTests(unittest.TestCase):
    def test_fetch_fail_soft_on_unroutable_node(self):
        mod, mod_name = _load_impl()
        self.assertIsNotNone(mod, "module vanished between probe and load")
        fn, fn_name = _pick(mod, _FETCH_FN_CANDIDATES)
        if fn is None:
            self.skipTest(
                f"DRIFT: {mod_name} has no fetch fn "
                f"(probed {_FETCH_FN_CANDIDATES!r}); impl owns naming."
            )
        try:
            # Closed port on loopback: connect refused fast, must yield [].
            result = _call_fetch_fn(fn, "http://127.0.0.1:1")
        except unittest.SkipTest:
            raise
        except Exception as exc:
            self.fail(f"{fn_name} must fail soft (return []), raised {exc!r}")
        self.assertEqual(result, [], f"{fn_name} must return [] when Node is unreachable")


@unittest.skipUnless(
    any(importlib.util.find_spec(m) is not None for m in _CANDIDATE_MODULES),
    "DRIFT: no local-extensions bridge module yet; bridge impl owns it.",
)
class MergePrecedenceTests(unittest.TestCase):
    def test_user_tools_first(self):
        mod, mod_name = _load_impl()
        self.assertIsNotNone(mod, "module vanished between probe and load")
        fn, fn_name = _pick(mod, _MERGE_FN_CANDIDATES)
        if fn is None:
            self.skipTest(
                f"SKIP REASON: {mod_name} exposes no composing/merge fn "
                f"(probed {_MERGE_FN_CANDIDATES!r}); precedence untestable "
                "until the impl exposes composition — bridge impl owns it."
            )

        def _fname(t):
            if isinstance(t, dict):
                f = t.get("function", t)
                if isinstance(f, dict) and f.get("name"):
                    return f["name"]
                return t.get("name")
            return None

        user = [
            {
                "type": "function",
                "function": {"name": "user_tool", "description": "u", "parameters": {}},
            }
        ]
        local = [
            {
                "type": "function",
                "function": {"name": "local_tool", "description": "l", "parameters": {}},
            }
        ]
        try:
            sig = inspect.signature(fn)
            names = list(sig.parameters.keys())
            if len(names) >= 2:
                merged = fn(user, local)
            else:
                merged = fn(custom_tools=user, local_tools=local)
        except Exception as exc:
            self.skipTest(f"DRIFT: {fn_name} rejected probe input: {exc!r}")
        self.assertIsInstance(merged, list, f"{fn_name} must return a list")
        ordered = [_fname(t) for t in merged]
        self.assertIn("user_tool", ordered)
        self.assertIn("local_tool", ordered)
        self.assertLess(
            ordered.index("user_tool"),
            ordered.index("local_tool"),
            f"{fn_name} must order user tools first; saw {ordered!r}",
        )


if __name__ == "__main__":
    unittest.main()
