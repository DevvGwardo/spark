"""Spec 5.8: MCP reload must not tear down process-wide servers under active runs."""
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))

import bridge_workspace  # noqa: E402
from routes import mcp as mcp_routes  # noqa: E402


def _fake_tools(*, with_reconcile: bool, shutdown_takes_names: bool = True):
    discovery = types.ModuleType("tools.mcp_tool_discovery")
    discovery.discover_mcp_tools = MagicMock(return_value=[])
    if with_reconcile:
        discovery.reconcile_mcp_servers_with_config = MagicMock(
            return_value={"removed": [], "added": ["x"], "pending": []}
        )
    lifecycle = types.ModuleType("tools.mcp_tool_lifecycle")
    calls = []
    if shutdown_takes_names:
        def shutdown_mcp_servers(*, scope=None, names=None, timeout=15.0):
            calls.append({"scope": scope, "names": names})
    else:
        def shutdown_mcp_servers():
            calls.append("wildcard")
    lifecycle.shutdown_mcp_servers = shutdown_mcp_servers
    pkg = types.ModuleType("tools")
    pkg.mcp_tool_discovery = discovery
    pkg.mcp_tool_lifecycle = lifecycle
    modules = {
        "tools": pkg,
        "tools.mcp_tool_discovery": discovery,
        "tools.mcp_tool_lifecycle": lifecycle,
    }
    return modules, discovery, calls


class ReloadAgentMcpTests(unittest.TestCase):
    def test_uses_scoped_reconcile_and_never_wildcard_shutdown(self):
        modules, discovery, calls = _fake_tools(with_reconcile=True)
        with patch.dict(sys.modules, modules):
            self.assertTrue(mcp_routes._reload_agent_mcp(bridge_workspace._HERMES_HOME, removed=("x",)))
        discovery.reconcile_mcp_servers_with_config.assert_called_once_with()
        self.assertEqual(calls, [])

    def test_other_profile_home_does_not_touch_process_servers(self):
        modules, discovery, calls = _fake_tools(with_reconcile=True)
        with patch.dict(sys.modules, modules):
            ok = mcp_routes._reload_agent_mcp(Path("/nonexistent/profiles/other"))
        self.assertFalse(ok)
        discovery.reconcile_mcp_servers_with_config.assert_not_called()
        discovery.discover_mcp_tools.assert_not_called()
        self.assertEqual(calls, [])

    def test_older_agent_shuts_down_only_removed_names(self):
        modules, discovery, calls = _fake_tools(with_reconcile=False)
        with patch.dict(sys.modules, modules):
            self.assertTrue(mcp_routes._reload_agent_mcp(None, removed=("gone",)))
        self.assertEqual(calls, [{"scope": None, "names": {"gone"}}])
        discovery.discover_mcp_tools.assert_called_once()

    def test_install_on_older_agent_is_additive(self):
        modules, discovery, calls = _fake_tools(with_reconcile=False)
        with patch.dict(sys.modules, modules):
            self.assertTrue(mcp_routes._reload_agent_mcp(None))
        self.assertEqual(calls, [])
        discovery.discover_mcp_tools.assert_called_once()

    def test_unscopable_agent_never_falls_back_to_wildcard(self):
        modules, discovery, calls = _fake_tools(with_reconcile=False, shutdown_takes_names=False)
        with patch.dict(sys.modules, modules):
            mcp_routes._reload_agent_mcp(None, removed=("gone",))
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
