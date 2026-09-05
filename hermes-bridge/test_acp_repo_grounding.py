"""Regression tests for ACP repo grounding (Sep 2026 read/search outage).

Covers the three fixes for turns where every file read failed and the model
never used search:
1. The ACP repo prefix names the real session tools (`read_file`,
   `search_files`) with exact arg shapes and maps the loop-only
   `read_repo_file` name — previously the prefix named no tool, so models
   emitted empty-path `read` calls that render as `read: ?` and fail.
2. `_resolve_acp_repo_root` falls back to the managed clone
   (~/.cloudchat/repos/<owner>/<name>) when the header is absent — previously
   these turns ran with the bridge process cwd and missed every relative path.
3. `ensure_session` respawns when the conversation moved checkouts instead of
   reusing a live session rooted at the old cwd.
"""

import asyncio
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

import httpx  # noqa: F401,E402  (real, before test_main: test_main stubs
# sys.modules["httpx"] when real httpx is absent, which removes module-level
# httpx.post and breaks test_mcp_tool_loop_check; pre-importing preserves the
# baseline collection order where real httpx wins the race)

import test_main  # noqa: F401,E402  (first: installs fastapi/pydantic stubs)

import acp_transport as at  # noqa: E402  (after test_main: keeps stub-first order)

import main as bridge_main


def _stub_acp_sdk():
    """The `acp` SDK only exists in the bridge runtime venv; stub it so
    ensure_session's import doesn't take down unit tests (spawn paths stay
    mocked — only session-bookkeeping branches are exercised). Scoped per
    test (not module import) so the stub never leaks into other modules."""
    if "acp" not in sys.modules:
        acp_stub = types.ModuleType("acp")
        schema_stub = types.ModuleType("acp.schema")
        schema_stub.ClientCapabilities = object
        schema_stub.Implementation = object
        acp_stub.schema = schema_stub
        sys.modules["acp"] = acp_stub
        sys.modules["acp.schema"] = schema_stub


class _AcpStubMixin:
    def setUp(self):
        _stub_acp_sdk()
        self.addCleanup(sys.modules.pop, "acp.schema", None)
        self.addCleanup(sys.modules.pop, "acp", None)
        super().setUp()


class AcpRepoPrefixTests(unittest.TestCase):
    def test_no_signal_byte_identical_empty(self):
        self.assertEqual(
            bridge_main._build_acp_repo_context_prefix(), ""
        )

    def test_names_real_tools_with_arg_shapes(self):
        prefix = bridge_main._build_acp_repo_context_prefix(
            repo_owner="o",
            repo_name="n",
            repo_root="/tmp/owner/n",
            repo_file_tree=["package.json"],
        )
        self.assertIn("Local checkout at: /tmp/owner/n", prefix)
        self.assertIn("`read_file` {path}", prefix)
        self.assertIn("`search_files` {pattern, path}", prefix)
        self.assertIn("instead of grep", prefix)
        self.assertIn("`read_repo_file`", prefix)
        self.assertIn("never an empty one", prefix)

    def test_empty_tree_still_names_tools_with_arg_shapes(self):
        prefix = bridge_main._build_acp_repo_context_prefix(
            repo_owner="o",
            repo_name="n",
            repo_root="/tmp/owner/n",
            repo_file_tree=[],
        )
        self.assertIn("Local checkout at: /tmp/owner/n", prefix)
        self.assertIn("`read_file` {path}", prefix)
        self.assertIn("`search_files` {pattern, path}", prefix)
        self.assertIn("`read_repo_file`", prefix)
        self.assertIn("never an empty one", prefix)

    def test_owner_name_only_still_no_checkout_line(self):
        prefix = bridge_main._build_acp_repo_context_prefix(
            repo_owner="o", repo_name="n"
        )
        self.assertIn("o/n", prefix)
        self.assertNotIn("Local checkout at:", prefix)

    def test_owner_name_only_still_names_session_tools(self):
        # Wave2 pin (preamble-on-any-signal): owner/name-only turns still map
        # the session tools — otherwise the model emits empty-path `read`
        # calls (`read: ?`) and never discovers search.
        prefix = bridge_main._build_acp_repo_context_prefix(
            repo_owner="o", repo_name="n"
        )
        self.assertIn("`read_file` {path}", prefix)
        self.assertIn("`search_files` {pattern, path}", prefix)

    def test_owner_name_only_with_managed_clone_names_session_tools(self):
        # Composed behavior that holds today: the impl resolves owner/name to
        # the managed clone and builds the prefix from the resolved root, so
        # the preamble names the real session tools.
        with tempfile.TemporaryDirectory() as tmp:
            clone = os.path.join(tmp, "o", "n")
            os.makedirs(clone)
            real_isdir = os.path.isdir
            with mock.patch.object(
                bridge_main, "_MANAGED_REPOS_ROOT", tmp
            ), mock.patch.object(
                os.path,
                "isdir",
                side_effect=lambda p: True if p == clone else real_isdir(p),
            ):
                root = bridge_main._resolve_acp_repo_root("", "o", "n")
                self.assertEqual(root, clone)
                prefix = bridge_main._build_acp_repo_context_prefix(
                    repo_owner="o", repo_name="n", repo_root=root
                )
                self.assertIn("`read_file` {path}", prefix)
                self.assertIn("`search_files` {pattern, path}", prefix)


class ResolveAcpRepoRootTests(unittest.TestCase):
    def test_header_dir_under_managed_root_wins(self):
        # The header is client-controlled: only a checkout under the managed
        # root is honored (Wave2 allowlist). A managed-root header still wins
        # over the owner/name clone lookup.
        header = os.path.join(bridge_main._MANAGED_REPOS_ROOT, "o", "n")
        with mock.patch.object(os.path, "isdir", return_value=True):
            self.assertEqual(
                bridge_main._resolve_acp_repo_root(header, "o", "n"), header
            )

    def test_header_file_falls_through_to_clone(self):
        with mock.patch.object(
            bridge_main, "_MANAGED_REPOS_ROOT", "/managed"
        ), mock.patch.object(
            os.path, "isdir", side_effect=lambda p: p == "/managed/o/n"
        ):
            self.assertEqual(
                bridge_main._resolve_acp_repo_root("/hdr-file", "o", "n"),
                "/managed/o/n",
            )

    def test_missing_header_resolves_managed_clone(self):
        with mock.patch.object(
            bridge_main, "_MANAGED_REPOS_ROOT", "/managed"
        ), mock.patch.object(
            os.path, "isdir", side_effect=lambda p: p == "/managed/o/n"
        ):
            self.assertEqual(
                bridge_main._resolve_acp_repo_root("", "o", "n"),
                "/managed/o/n",
            )

    def test_traversal_segments_rejected(self):
        with mock.patch.object(os.path, "isdir", return_value=True) as m:
            self.assertEqual(
                bridge_main._resolve_acp_repo_root("", "..", "n"), ""
            )
            self.assertEqual(
                bridge_main._resolve_acp_repo_root("", "o", "../x"), ""
            )
            # Only the header check (absent here) may touch the fs.
            m.assert_not_called()

    def test_nothing_resolves_empty(self):
        with mock.patch.object(os.path, "isdir", return_value=False):
            self.assertEqual(bridge_main._resolve_acp_repo_root("", "", ""), "")
            self.assertEqual(
                bridge_main._resolve_acp_repo_root("", "o", "n"), ""
            )

    def test_escape_header_outside_managed_root_rejected(self):
        # Wave2 allowlist pin: a header pointing outside the managed repos
        # root must NOT become the session cwd (stale/foreign absolute paths
        # would run reads/searches against the wrong tree) — it falls through
        # to the owner/name clone lookup.
        with mock.patch.object(os.path, "isdir", return_value=True):
            self.assertNotEqual(
                bridge_main._resolve_acp_repo_root("/etc", "o", "n"), "/etc"
            )

    def test_traversal_owner_never_checks_out(self):
        # "../etc" as a segment must never resolve (nor touch the fs): with a
        # hostile owner there is no checkout, even when headers are present
        # for other fields.
        with mock.patch.object(os.path, "isdir", return_value=True) as m:
            self.assertEqual(
                bridge_main._resolve_acp_repo_root("", "../etc", "n"), ""
            )
            self.assertEqual(
                bridge_main._resolve_acp_repo_root("", "o", "../etc"), ""
            )
            m.assert_not_called()


class SameDirTests(unittest.TestCase):
    def test_equal(self):
        self.assertTrue(at._same_dir("/a/b", "/a/b"))

    def test_trailing_slash_and_symlink(self):
        self.assertTrue(at._same_dir("/tmp/", "/tmp"))
        self.assertTrue(at._same_dir("/tmp", os.path.realpath("/tmp")))

    def test_different(self):
        self.assertFalse(at._same_dir("/a/b", "/a/c"))


def _make_live_handle(cwd):
    proc = mock.Mock()
    proc.returncode = None
    return at._AcpHandle(
        conversation_id="c1",
        cwd=cwd,
        proc=proc,
        conn=mock.Mock(),
        session_id="sess-1",
        client=None,
        loop=None,
        approvals={},
    )


class EnsureSessionCwdTests(_AcpStubMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        at._sessions.clear()
        self.addCleanup(at._sessions.clear)

    def test_same_cwd_reuses_without_spawning(self):
        handle = _make_live_handle("/repo/a")
        at._sessions["c1"] = handle
        emitted = []
        # _acp_command must NOT be reached on the reuse path.
        with mock.patch.object(
            at, "_acp_command", side_effect=AssertionError("spawned!")
        ):
            got = asyncio.run(
                at.ensure_session(
                    loop=asyncio.new_event_loop(),
                    conversation_id="c1",
                    cwd="/repo/a",
                    emit=lambda *a: emitted.append(a),
                )
            )
        self.assertIs(got, handle)
        self.assertEqual(emitted, [])

    def test_changed_cwd_evicts_and_signals_retry(self):
        handle = _make_live_handle("/repo/a")
        at._sessions["c1"] = handle
        emitted = []

        async def _noop_close(h):
            return None

        with mock.patch.object(
            at, "_acp_command", side_effect=RuntimeError("no binary in test")
        ), mock.patch.object(at, "_close_handle_quietly", _noop_close):
            with self.assertRaisesRegex(RuntimeError, "no binary"):
                asyncio.run(
                    at.ensure_session(
                        loop=asyncio.new_event_loop(),
                        conversation_id="c1",
                        cwd="/repo/b",
                        emit=lambda *a: emitted.append(a),
                    )
                )
        self.assertNotIn("c1", at._sessions)
        retries = [p for (name, p) in emitted if name == "stream_retry"]
        self.assertEqual(len(retries), 1)
        self.assertEqual(retries[0]["reason"], "acp-transport-cwd-switch")


if __name__ == "__main__":
    unittest.main()
