"""Unit tests for acp_transport pure logic + session bookkeeping.

Covers the parts of the ACP transport that don't need a live hermes-acp
process: id sanitization, env parsing, idle reaping, approval resolution, and
shutdown. The spawn/connect paths are integration territory and stay untested
here on purpose.
"""

import asyncio
import json
import time
import unittest
from unittest import mock
from types import SimpleNamespace

import acp_transport as at


def _make_handle(cid="c1", busy=False, last_used=None, approvals=None):
    proc = SimpleNamespace(returncode=0, kill=lambda: None, wait=_noop_async)
    conn = SimpleNamespace(close_session=_noop_async_ok)
    handle = at._AcpHandle(
        conversation_id=cid,
        cwd="/tmp",
        proc=proc,
        conn=conn,
        session_id="sess-1",
        client=None,
        loop=None,
        approvals=approvals if approvals is not None else {},
    )
    handle.busy = busy
    if last_used is not None:
        handle.last_used = last_used
    return handle


async def _noop_async(*args, **kwargs):
    return None


async def _noop_async_ok(*args, **kwargs):
    return True


class BuildSessionModelIdTests(unittest.TestCase):
    """custom:<pool> triples must not reach hermes set_session_model.

    parse_model_input only re-joins `custom:<name>:<model>` for config.yaml
    custom providers, so `custom:opencode-go:muse-spark-1.3-contributor`
    resolved to ("custom", "opencode-go:muse-...") and the upstream 400'd
    with "opencode-go:muse-spark-1.3-contributor is not a valid model ID".
    """

    def test_pool_custom_prefix_is_stripped(self):
        self.assertEqual(
            at.build_session_model_id("custom:opencode-go", "muse-spark-1.3-contributor"),
            "opencode-go:muse-spark-1.3-contributor",
        )

    def test_non_pool_custom_prefix_is_kept(self):
        # config.yaml custom providers rely on the triple syntax.
        self.assertEqual(
            at.build_session_model_id("custom:my-endpoint", "some-model"),
            "custom:my-endpoint:some-model",
        )

    def test_native_provider_untouched(self):
        self.assertEqual(
            at.build_session_model_id("opencode-go", "muse-spark-1.3-contributor"),
            "opencode-go:muse-spark-1.3-contributor",
        )
        self.assertEqual(
            at.build_session_model_id("openrouter", "anthropic/claude-3"),
            "openrouter:anthropic/claude-3",
        )

    def test_model_none_returns_provider_only(self):
        self.assertEqual(at.build_session_model_id("custom:opencode-go", None), "opencode-go")
        self.assertEqual(at.build_session_model_id("openrouter", None), "openrouter")


class SafeConversationIdTests(unittest.TestCase):
    def test_strips_path_separators(self):
        self.assertEqual(at._safe_conversation_id("a/b/c"), "a_b_c")

    def test_blocks_traversal_sequences(self):
        result = at._safe_conversation_id("../../etc/passwd")
        self.assertNotIn("..", result)
        self.assertNotIn("/", result)

    def test_all_invalid_becomes_unknown(self):
        self.assertEqual(at._safe_conversation_id("///"), "unknown")
        self.assertEqual(at._safe_conversation_id(""), "unknown")

    def test_capped_at_40_chars(self):
        long_id = "x" * 200
        self.assertEqual(len(at._safe_conversation_id(long_id)), 40)

    def test_safe_ids_pass_through(self):
        self.assertEqual(at._safe_conversation_id("conv_ABC-123"), "conv_ABC-123")


class EnvFloatTests(unittest.TestCase):
    def test_missing_uses_default(self):
        with mock.patch.dict("os.environ", {"X_TEST_FLOAT": ""}):
            self.assertEqual(at._env_float("X_TEST_FLOAT", 5.0), 5.0)

    def test_non_numeric_falls_back(self):
        with mock.patch.dict("os.environ", {"X_TEST_FLOAT": "abc"}):
            self.assertEqual(at._env_float("X_TEST_FLOAT", 5.0), 5.0)

    def test_non_positive_falls_back(self):
        with mock.patch.dict("os.environ", {"X_TEST_FLOAT": "-3"}):
            self.assertEqual(at._env_float("X_TEST_FLOAT", 5.0), 5.0)
        with mock.patch.dict("os.environ", {"X_TEST_FLOAT": "0"}):
            self.assertEqual(at._env_float("X_TEST_FLOAT", 5.0), 5.0)

    def test_valid_value_parsed(self):
        with mock.patch.dict("os.environ", {"X_TEST_FLOAT": "12.5"}):
            self.assertEqual(at._env_float("X_TEST_FLOAT", 5.0), 12.5)


class ReapIdleSessionsTests(unittest.TestCase):
    def setUp(self):
        at._sessions.clear()

    def tearDown(self):
        at._sessions.clear()

    def test_reaps_idle_not_busy(self):
        handle = _make_handle(last_used=time.time() - at.IDLE_TIMEOUT_SECONDS - 1)
        at._sessions["c1"] = handle

        closed = asyncio.run(at.reap_idle_sessions())
        self.assertEqual(closed, 1)
        self.assertNotIn("c1", at._sessions)

    def test_never_reaps_busy_handles(self):
        handle = _make_handle(busy=True, last_used=time.time() - at.IDLE_TIMEOUT_SECONDS - 1)
        at._sessions["c1"] = handle

        closed = asyncio.run(at.reap_idle_sessions())
        self.assertEqual(closed, 0)
        self.assertIn("c1", at._sessions)

    def test_young_sessions_survive(self):
        handle = _make_handle(last_used=time.time())  # just touched
        at._sessions["c1"] = handle

        closed = asyncio.run(at.reap_idle_sessions())
        self.assertEqual(closed, 0)
        self.assertIn("c1", at._sessions)

    def test_close_failure_does_not_raise_and_session_is_popped(self):
        async def _boom():
            raise RuntimeError("unresponsive agent")

        handle = _make_handle(last_used=time.time() - at.IDLE_TIMEOUT_SECONDS - 1)
        # handle.close() itself swallows inner close_session failures (bounded
        # wait_for + except) and still hard-kills the process — so the reaper
        # counts it as closed.
        handle.conn = SimpleNamespace(close_session=_boom)
        at._sessions["c1"] = handle

        closed = asyncio.run(at.reap_idle_sessions())
        self.assertEqual(closed, 1)
        self.assertNotIn("c1", at._sessions)

    def test_handle_close_raising_is_swallowed_by_reaper(self):
        async def _raise(*args, **kwargs):
            raise RuntimeError("close exploded")

        handle = _make_handle(last_used=time.time() - at.IDLE_TIMEOUT_SECONDS - 1)
        handle.close = _raise
        at._sessions["c1"] = handle

        closed = asyncio.run(at.reap_idle_sessions())
        self.assertEqual(closed, 0)
        self.assertNotIn("c1", at._sessions)


class ResolveApprovalTests(unittest.TestCase):
    def setUp(self):
        at._sessions.clear()

    def tearDown(self):
        at._sessions.clear()

    def test_resolves_pending_future(self):
        future = asyncio.get_event_loop().new_future() if False else None
        loop = asyncio.new_event_loop()
        try:
            future = loop.create_future()
            handle = _make_handle(approvals={"appr-1": future})
            at._sessions["c1"] = handle

            delivered = asyncio.run(at.resolve_approval("appr-1", "approved"))
            self.assertTrue(delivered)
            self.assertEqual(future.result(), {"option_id": "allow_once"})
        finally:
            loop.close()

    def test_unknown_approval_returns_false(self):
        at._sessions.clear()
        self.assertFalse(asyncio.run(at.resolve_approval("missing", "denied")))

    def test_already_done_future_is_skipped(self):
        loop = asyncio.new_event_loop()
        try:
            done = loop.create_future()
            done.set_result({"option_id": "first"})
            pending = loop.create_future()
            handle = _make_handle(approvals={"appr-done": done, "appr-pending": pending})
            at._sessions["c1"] = handle

            delivered = asyncio.run(at.resolve_approval("appr-done", "second"))
            # First (done) future is skipped; no crash — but nothing matched it,
            # so resolve returns False for that id.
            self.assertFalse(delivered)
        finally:
            loop.close()


class ShutdownAllTests(unittest.TestCase):
    def test_clears_registry_and_closes_handles(self):
        closed_flags = []

        async def _track_close(inner_self):
            closed_flags.append(inner_self.conversation_id)

        h1 = _make_handle(cid="a")
        h2 = _make_handle(cid="b")
        h1.close = _track_close.__get__(h1)
        h2.close = _track_close.__get__(h2)
        at._sessions["a"] = h1
        at._sessions["b"] = h2

        asyncio.run(at.shutdown_all())

        self.assertEqual(at._sessions, {})
        self.assertEqual(sorted(closed_flags), ["a", "b"])

    def test_close_failure_during_shutdown_is_swallowed(self):
        async def _boom():
            raise RuntimeError("dead process")

        h = _make_handle(cid="a")
        h.close = _boom
        at._sessions["a"] = h

        asyncio.run(at.shutdown_all())
        self.assertEqual(at._sessions, {})


class ToolInputFromLocationsTests(unittest.TestCase):
    """Regression tests for the Sep 2026 "read: ?" transcript.

    hermes sends read_file start updates with ``content=None`` by design, so
    ``_tool_input_for_display`` used to yield "" and the UI could never
    attribute a running read to its file. The path lives in ``locations`` —
    surface it as ``{"path": ...}`` JSON (the shape UI label parsing and
    start-text summaries expect via ``args.path``).
    """

    def test_locations_path_becomes_json_input(self):
        update = SimpleNamespace(
            raw_input=None,
            content=None,
            locations=[SimpleNamespace(path="/repo/package.json", line=None)],
        )
        parsed = json.loads(at._tool_input_for_display(update))
        self.assertEqual(parsed["path"], "/repo/package.json")

    def test_locations_line_preserved_when_positive(self):
        update = SimpleNamespace(
            raw_input=None,
            content=None,
            locations=[SimpleNamespace(path="/repo/a.ts", line=12)],
        )
        parsed = json.loads(at._tool_input_for_display(update))
        self.assertEqual(parsed, {"path": "/repo/a.ts", "line": 12})

    def test_empty_locations_stays_empty(self):
        update = SimpleNamespace(raw_input=None, content=None, locations=[])
        self.assertEqual(at._tool_input_for_display(update), "")

    def test_raw_input_still_wins(self):
        update = SimpleNamespace(
            raw_input={"command": "ls"},
            content=None,
            locations=[SimpleNamespace(path="/repo/a.ts", line=None)],
        )
        self.assertEqual(
            json.loads(at._tool_input_for_display(update)), {"command": "ls"}
        )


if __name__ == "__main__":
    unittest.main()


class EnsureSessionLockingTests(unittest.TestCase):
    """G11 / spec 5.3: the global lock must not be held across a spawn."""

    SPAWN_SECONDS = 0.4

    def setUp(self):
        at._sessions.clear()
        at._conversation_locks.clear()
        self.spawned: list[str] = []

    def tearDown(self):
        at._sessions.clear()
        at._conversation_locks.clear()

    async def _fake_spawn(self, *, conversation_id, cwd, plan_mode, **kwargs):
        self.spawned.append(conversation_id)
        await asyncio.sleep(self.SPAWN_SECONDS)
        handle = _make_handle(cid=conversation_id)
        handle.proc.returncode = None  # alive
        handle.cwd = cwd
        handle.plan_mode = plan_mode
        return handle

    def _ensure(self, loop, cid):
        return at.ensure_session(loop=loop, conversation_id=cid, cwd="/tmp", emit=lambda *a: None)

    def _run(self, *cids):
        async def main():
            loop = asyncio.get_running_loop()
            started = time.monotonic()
            handles = await asyncio.gather(*(self._ensure(loop, cid) for cid in cids))
            return handles, time.monotonic() - started

        with mock.patch.object(at, "_spawn_session", self._fake_spawn), mock.patch.object(
            at, "_acp_command", return_value=["hermes-acp"]
        ):
            return asyncio.run(main())

    def test_two_first_turns_do_not_serialize(self):
        handles, elapsed = self._run("conv-a", "conv-b")
        self.assertEqual(sorted(self.spawned), ["conv-a", "conv-b"])
        self.assertEqual({h.conversation_id for h in handles}, {"conv-a", "conv-b"})
        # Serialized would be >= 2 * SPAWN_SECONDS; concurrent is ~1x.
        self.assertLess(elapsed, self.SPAWN_SECONDS * 1.75)

    def test_same_conversation_spawns_once(self):
        handles, _ = self._run("conv-a", "conv-a")
        self.assertEqual(self.spawned, ["conv-a"])
        self.assertIs(handles[0], handles[1])

    def test_conversation_locks_pruned_after_shutdown(self):
        self._run("conv-a")
        self.assertIn("conv-a", at._conversation_locks)
        asyncio.run(at.shutdown_all())
        self.assertEqual(at._conversation_locks, {})
