"""Bridge HTTP tests through the real FastAPI app and middleware (spec 7.1).

Covers routes that had no HTTP-level test: /v1/approvals, /sessions*, the
workspace file PUT (optimistic version), MCP install/uninstall, cron, and the
token guard end to end. Requests go through the real app via TestClient, so
routing, request-body parsing, the token guard, CORS and the exception handlers
all run exactly as they do under uvicorn.

The rest of the suite stubs fastapi, so these tests run inside an isolated
real-FastAPI import of ``main`` (see bridge_http_testkit.py). Each test gets an
empty HERMES_HOME; nothing touches the network or needs hermes-agent.
"""

import hashlib
import json
import os
import sqlite3
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bridge_http_testkit import RealBridgeTestCase  # noqa: E402

TOKEN = "http-test-bridge-token-0123456789abcdef"


def _version(content: str) -> str:
    return hashlib.sha1(content.encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# /v1/approvals
# ---------------------------------------------------------------------------


class _FakeFuture:
    def __init__(self):
        self.result = None

    def done(self):
        return self.result is not None

    def set_result(self, value):
        self.result = value


class ApprovalRouteTests(RealBridgeTestCase):
    def setUp(self):
        super().setUp()
        self.acp = self.kit.mod("acp_transport")
        self.future = _FakeFuture()
        handle = SimpleNamespace(approvals={"ap-1": self.future})
        self.patch_object(self.acp, "_sessions", {"conv-1": handle})

    def test_pending_approval_is_resolved_with_the_option(self):
        r = self.client.post("/v1/approvals/ap-1", json={"option_id": "allow_once"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"ok": True, "approval_id": "ap-1", "option_id": "allow_once"})
        self.assertIsNotNone(self.future.result)
        self.assertIn("option_id", self.future.result)

    def test_already_resolved_approval_is_404(self):
        self.assertEqual(
            self.client.post("/v1/approvals/ap-1", json={"option_id": "deny"}).status_code, 200
        )
        r = self.client.post("/v1/approvals/ap-1", json={"option_id": "deny"})
        self.assertEqual(r.status_code, 404)

    def test_unknown_approval_id_is_404(self):
        r = self.client.post("/v1/approvals/does-not-exist", json={"option_id": "deny"})
        self.assertEqual(r.status_code, 404)
        self.assertIn("does-not-exist", r.json()["error"]["message"])
        self.assertIsNone(self.future.result)

    def test_missing_option_id_is_400_and_resolves_nothing(self):
        for body in ({}, {"option_id": ""}, {"option_id": "   "}):
            r = self.client.post("/v1/approvals/ap-1", json=body)
            self.assertEqual(r.status_code, 400, body)
            self.assertIn("option_id", r.json()["error"]["message"])
        self.assertIsNone(self.future.result)

    def test_transport_failure_is_500_not_a_crash(self):
        self.patch_object(self.acp, "resolve_approval", AsyncMock(side_effect=RuntimeError("boom")))
        r = self.client.post("/v1/approvals/ap-1", json={"option_id": "deny"})
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json()["error"]["message"], "boom")

    def test_there_is_no_approval_list_route(self):
        # Approvals are pushed to the UI over the chat SSE stream; the bridge
        # only exposes the resolve endpoint. Pin that so a list route is a
        # deliberate addition (with its own tests), not an accident.
        r = self.client.get("/v1/approvals")
        self.assertEqual(r.status_code, 404)
        r = self.client.get("/v1/approvals/ap-1")
        self.assertEqual(r.status_code, 405)


# ---------------------------------------------------------------------------
# /sessions
# ---------------------------------------------------------------------------


def _write_state_db(hermes_home: Path, sessions: list[dict], messages: list[tuple] = ()):
    db = sqlite3.connect(str(hermes_home / "state.db"))
    try:
        db.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, "
            "started_at REAL, ended_at REAL, end_reason TEXT, message_count INTEGER, title TEXT)"
        )
        db.execute(
            "CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp REAL)"
        )
        for s in sessions:
            db.execute(
                "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)",
                (
                    s["id"], s.get("source", "cli"), s.get("model", "m"), s["started_at"],
                    s.get("ended_at"), s.get("end_reason"), s.get("message_count", 0),
                    s.get("title", ""),
                ),
            )
        db.executemany("INSERT INTO messages VALUES (?,?,?,?)", list(messages))
        db.commit()
    finally:
        db.close()


class SessionRouteTests(RealBridgeTestCase):
    def setUp(self):
        super().setUp()
        tracker = self.kit.mod("session_tracker")
        # routes/sessions imported the dict by name, so mutate the shared
        # object in place and put it back afterwards.
        self.sessions = tracker._sessions
        saved = dict(self.sessions)
        self.sessions.clear()
        self.addCleanup(lambda: (self.sessions.clear(), self.sessions.update(saved)))

    def _add_memory_session(self, sid, *, created_at, profile="default", status="active",
                            updated_at=None, **extra):
        # The tracker is TTL-bounded on updated_at (spec 5.5), so fixtures are
        # "recently updated" unless a test says otherwise; created_at drives
        # the list ordering.
        if updated_at is None:
            updated_at = datetime.now(timezone.utc).isoformat()
        self.sessions[sid] = {
            "id": sid,
            "created_at": created_at,
            "updated_at": updated_at,
            "messages": 1,
            "model": extra.pop("model", "anthropic/claude"),
            "status": status,
            "toolsets": [],
            "repo": extra.pop("repo", None),
            "firstUserMessage": extra.pop("first", "hello"),
            "chat": [{"role": "user", "content": "hello"}],
            "profile": profile,
            **extra,
        }

    def test_stale_finished_sessions_age_out_of_the_list(self):
        # Phase 5 bound: finished entries expire `ttl` after their last update,
        # pruned on the next insert. The durable copy is state.db.
        stale = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        self._add_memory_session("old", created_at=stale, updated_at=stale, status="completed")
        self._add_memory_session("new", created_at="2026-09-01T00:00:00+00:00")
        ids = [s["id"] for s in self.client.get("/sessions").json()["sessions"]]
        self.assertEqual(ids, ["new"])

    def test_list_is_empty_with_counts_when_there_is_nothing(self):
        r = self.client.get("/sessions")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            r.json(),
            {"sessions": [], "total": 0,
             "counts": {"active": 0, "completed": 0, "error": 0, "total": 0}},
        )

    def test_list_merges_memory_and_state_db_newest_first(self):
        self._add_memory_session("mem-1", created_at="2026-09-03T00:00:00+00:00")
        _write_state_db(self.hermes_home, [
            {"id": "db-old", "started_at": 1_756_684_800, "ended_at": 1_756_684_900,
             "end_reason": "done", "title": "old cli chat"},          # 2025-09-01
            {"id": "db-err", "started_at": 1_788_307_200, "ended_at": 1_788_307_300,
             "end_reason": "provider error", "title": "broken"},       # 2026-09-02
            # Same id as an in-memory session: the in-memory copy wins.
            {"id": "mem-1", "started_at": 1_000, "title": "shadowed"},
        ])
        body = self.client.get("/sessions").json()
        self.assertEqual([s["id"] for s in body["sessions"]], ["mem-1", "db-err", "db-old"])
        self.assertEqual(body["total"], 3)
        self.assertEqual(body["counts"], {"active": 1, "completed": 1, "error": 1, "total": 3})
        mem = body["sessions"][0]
        self.assertNotIn("chat", mem)
        self.assertNotIn("profile", mem)
        self.assertEqual(body["sessions"][1]["status"], "error")
        self.assertEqual(body["sessions"][2]["toolsets"], ["source:cli"])

    def test_search_and_pagination(self):
        for i in range(5):
            self._add_memory_session(
                f"s{i}", created_at=f"2026-09-0{i + 1}T00:00:00+00:00",
                first=("deploy fix" if i % 2 == 0 else "unrelated"),
            )
        body = self.client.get("/sessions", params={"q": "DEPLOY"}).json()
        self.assertEqual([s["id"] for s in body["sessions"]], ["s4", "s2", "s0"])
        self.assertEqual(body["total"], 3)

        page = self.client.get("/sessions", params={"q": "deploy", "limit": 1, "offset": 1}).json()
        self.assertEqual([s["id"] for s in page["sessions"]], ["s2"])
        # total/counts describe the whole filtered set, not the page.
        self.assertEqual(page["total"], 3)
        self.assertEqual(page["counts"]["total"], 3)

        # Search also matches id and model.
        self.assertEqual(
            [s["id"] for s in self.client.get("/sessions", params={"q": "s3"}).json()["sessions"]],
            ["s3"],
        )

    def test_negative_offset_and_limit_are_clamped(self):
        for i in range(3):
            self._add_memory_session(f"s{i}", created_at=f"2026-09-0{i + 1}T00:00:00+00:00")
        body = self.client.get("/sessions", params={"limit": 2, "offset": -5}).json()
        self.assertEqual([s["id"] for s in body["sessions"]], ["s2", "s1"])
        body = self.client.get("/sessions", params={"limit": -1}).json()
        self.assertEqual(body["sessions"], [])
        self.assertEqual(body["total"], 3)

    def test_non_integer_limit_is_rejected(self):
        r = self.client.get("/sessions", params={"limit": "lots"})
        self.assertEqual(r.status_code, 422)

    def test_sessions_are_scoped_to_the_profile_header(self):
        (self.hermes_home / "profiles" / "work").mkdir(parents=True)
        self._add_memory_session("mine", created_at="2026-09-01T00:00:00+00:00")
        self._add_memory_session("theirs", created_at="2026-09-02T00:00:00+00:00", profile="work")

        default_ids = [s["id"] for s in self.client.get("/sessions").json()["sessions"]]
        self.assertEqual(default_ids, ["mine"])
        work = self.client.get("/sessions", headers={"X-Hermes-Profile": "work"}).json()
        self.assertEqual([s["id"] for s in work["sessions"]], ["theirs"])

        # Detail and delete are scoped the same way.
        self.assertEqual(self.client.get("/sessions/theirs").status_code, 404)
        self.assertEqual(self.client.delete("/sessions/theirs").status_code, 200)
        self.assertIn("theirs", self.sessions)

    def test_detail_from_memory_strips_profile_keeps_chat(self):
        self._add_memory_session("mem-1", created_at="2026-09-01T00:00:00+00:00")
        r = self.client.get("/sessions/mem-1")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["id"], "mem-1")
        self.assertNotIn("profile", body)
        self.assertEqual(body["chat"], [{"role": "user", "content": "hello"}])

    def test_detail_from_state_db_includes_ordered_messages(self):
        _write_state_db(
            self.hermes_home,
            [{"id": "cli-1", "started_at": 1_788_220_800, "model": "gpt", "title": "t",
              "message_count": 2}],
            [("cli-1", "assistant", "second", 2.0), ("cli-1", "user", "first", 1.0),
             ("other", "user", "nope", 0.5), ("cli-1", "tool", None, 3.0)],
        )
        r = self.client.get("/sessions/cli-1")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "active")
        self.assertIsNone(body["updated_at"])
        self.assertEqual(body["messages"], 2)
        self.assertEqual(
            body["chat"],
            [{"role": "user", "content": "first"}, {"role": "assistant", "content": "second"},
             {"role": "tool", "content": ""}],
        )

    def test_detail_unknown_is_404(self):
        self.assertEqual(self.client.get("/sessions/nope").status_code, 404)
        _write_state_db(self.hermes_home, [])
        self.assertEqual(self.client.get("/sessions/nope").status_code, 404)

    def test_delete_removes_memory_session_and_is_idempotent(self):
        self._add_memory_session("mem-1", created_at="2026-09-01T00:00:00+00:00")
        r = self.client.delete("/sessions/mem-1")
        self.assertEqual((r.status_code, r.json()), (200, {"ok": True}))
        self.assertNotIn("mem-1", self.sessions)
        self.assertEqual(self.client.delete("/sessions/mem-1").json(), {"ok": True})
        self.assertEqual(self.client.get("/sessions/mem-1").status_code, 404)

    def test_fork_proxies_to_the_gateway_with_title(self):
        ops = self.kit.mod("hermes_ops")
        fork = MagicMock(return_value=(201, {"id": "child", "parent": "abc"}))
        self.patch_object(ops, "fork_gateway_session", fork)
        self.patch_object(self.kit.mod("bridge_providers"), "_get_local_gateway_key", lambda: None)

        r = self.client.post("/sessions/abc/fork", json={"title": "  my fork  "})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json(), {"id": "child", "parent": "abc"})
        args, kwargs = fork.call_args
        self.assertEqual(args, ("abc",))
        self.assertEqual(kwargs["title"], "my fork")
        self.assertEqual(kwargs["base_url"], "http://127.0.0.1:8642")
        self.assertIsNone(kwargs["api_key"])

    def test_fork_tolerates_missing_or_non_object_body(self):
        ops = self.kit.mod("hermes_ops")
        fork = MagicMock(return_value=(200, {"ok": True}))
        self.patch_object(ops, "fork_gateway_session", fork)
        self.patch_object(self.kit.mod("bridge_providers"), "_get_local_gateway_key", lambda: None)
        for kwargs in ({}, {"content": b"not json"}, {"json": ["a", "list"]}, {"json": {"title": "  "}}):
            r = self.client.post("/sessions/abc/fork", **kwargs)
            self.assertEqual(r.status_code, 200, kwargs)
            self.assertIsNone(fork.call_args.kwargs["title"], kwargs)

    def test_fork_rejects_unsafe_gateway_base_without_network(self):
        # Real fork_gateway_session: the SSRF guard raises before any request.
        os.environ["HERMES_API_BASE"] = "file:///etc/passwd"
        self.addCleanup(os.environ.pop, "HERMES_API_BASE", None)
        r = self.client.post("/sessions/abc/fork", json={})
        self.assertEqual(r.status_code, 400)
        self.assertIn("error", r.json())


# ---------------------------------------------------------------------------
# PUT /workspace/files/{key} (optimistic concurrency)
# ---------------------------------------------------------------------------


class WorkspaceFileTests(RealBridgeTestCase):
    def test_get_and_put_unknown_key_is_404(self):
        self.assertEqual(self.client.get("/workspace/files/passwd").status_code, 404)
        r = self.client.put("/workspace/files/passwd", json={"content": "x"})
        self.assertEqual(r.status_code, 404)
        self.assertFalse((self.hermes_home / "passwd").exists())

    def test_put_creates_the_file_and_returns_its_version(self):
        r = self.client.put("/workspace/files/user", json={"content": "# me\n"})
        self.assertEqual(r.status_code, 200)
        entry = r.json()["file"]
        path = self.hermes_home / "memories" / "USER.md"
        self.assertEqual(path.read_text(), "# me\n")
        self.assertEqual(entry["content"], "# me\n")
        self.assertEqual(entry["version"], _version("# me\n"))
        self.assertTrue(entry["exists"])

    def test_put_with_matching_version_writes(self):
        (self.hermes_home / "SOUL.md").write_text("v1")
        current = self.client.get("/workspace/files/soul").json()["file"]["version"]
        self.assertEqual(current, _version("v1"))
        r = self.client.put("/workspace/files/soul", json={"content": "v2", "expected_version": current})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["file"]["version"], _version("v2"))
        self.assertEqual((self.hermes_home / "SOUL.md").read_text(), "v2")

    def test_put_with_stale_version_is_409_and_does_not_write(self):
        soul = self.hermes_home / "SOUL.md"
        soul.write_text("v1")
        stale = self.client.get("/workspace/files/soul").json()["file"]["version"]
        soul.write_text("changed on disk")  # another writer got there first

        r = self.client.put("/workspace/files/soul", json={"content": "mine", "expected_version": stale})
        self.assertEqual(r.status_code, 409)
        body = r.json()
        self.assertIn("changed on disk", body["error"])
        # The conflict response carries the current file so the UI can rebase.
        self.assertEqual(body["file"]["content"], "changed on disk")
        self.assertEqual(body["file"]["version"], _version("changed on disk"))
        self.assertEqual(soul.read_text(), "changed on disk")

    def test_expected_version_of_a_missing_file_guards_creation(self):
        missing = self.client.get("/workspace/files/memory").json()["file"]
        self.assertFalse(missing["exists"])
        # Someone else creates it after we loaded the empty editor.
        path = self.hermes_home / "memories" / "MEMORY.md"
        path.parent.mkdir(parents=True)
        path.write_text("theirs")
        r = self.client.put(
            "/workspace/files/memory", json={"content": "mine", "expected_version": missing["version"]}
        )
        self.assertEqual(r.status_code, 409)
        self.assertEqual(path.read_text(), "theirs")

    def test_put_without_expected_version_is_last_write_wins(self):
        (self.hermes_home / "SOUL.md").write_text("old")
        r = self.client.put("/workspace/files/soul", json={"content": "new"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((self.hermes_home / "SOUL.md").read_text(), "new")

    def test_file_key_is_case_insensitive(self):
        r = self.client.put("/workspace/files/SOUL", json={"content": "x"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((self.hermes_home / "SOUL.md").read_text(), "x")

    def test_invalid_body_is_422_and_does_not_write(self):
        r = self.client.put("/workspace/files/soul", json={"content": 123})
        self.assertEqual(r.status_code, 422)
        self.assertFalse((self.hermes_home / "SOUL.md").exists())

    def test_validation_errors_use_the_bridge_error_envelope(self):
        # main.py promises every error leaves the bridge as
        # {"error": {code, message, retryable}} and never as a bare {"detail"}
        # (spec 1.4), and its HTTPException handler comment says it covers
        # "validation failures". It does not: request-body/query validation
        # raises RequestValidationError, which is not an HTTPException, so
        # FastAPI's default handler answers {"detail": [...]}.
        r = self.client.put("/workspace/files/soul", json={"content": 123})
        self.assertEqual(r.status_code, 422)
        body = r.json()
        self.assertNotIn("detail", body)
        self.assertEqual(body["error"]["code"], "VALIDATION")

    def test_profile_header_writes_into_that_profile(self):
        work = self.hermes_home / "profiles" / "work"
        work.mkdir(parents=True)
        r = self.client.put(
            "/workspace/files/soul", json={"content": "work soul"}, headers={"X-Hermes-Profile": "work"}
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual((work / "SOUL.md").read_text(), "work soul")
        self.assertFalse((self.hermes_home / "SOUL.md").exists())


# ---------------------------------------------------------------------------
# MCP install / uninstall
# ---------------------------------------------------------------------------


class McpInstallTests(RealBridgeTestCase):
    def setUp(self):
        super().setUp()
        self.mcp = self.kit.mod("routes.mcp")
        # The "installer" is the in-process agent reload; never touch the agent.
        self.reload = MagicMock(return_value=True)
        self.patch_object(self.mcp, "_reload_agent_mcp", self.reload)
        self.config = self.hermes_home / "config.yaml"

    def _config(self) -> dict:
        import yaml

        return yaml.safe_load(self.config.read_text()) or {}

    def test_catalog_and_empty_server_list(self):
        catalog = self.client.get("/workspace/mcp-catalog").json()["catalog"]
        ids = {e["id"] for e in catalog}
        self.assertIn("filesystem", ids)
        # Display view never exposes the command template.
        self.assertTrue(all("command" not in e and "args" not in e for e in catalog))
        self.assertEqual(self.client.get("/workspace/mcp-servers").json(), {"servers": []})

    def test_install_writes_config_and_reloads(self):
        r = self.client.post(
            "/workspace/mcp-servers/install", json={"id": "filesystem", "param": "/tmp/project"}
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"ok": True, "installed": "filesystem", "reloaded": True})
        self.reload.assert_called_once()
        entry = self._config()["mcp_servers"]["filesystem"]
        self.assertEqual(entry["command"], "npx")
        self.assertEqual(entry["args"][-1], "/tmp/project")
        self.assertTrue(entry["enabled"])

        servers = self.client.get("/workspace/mcp-servers").json()["servers"]
        self.assertEqual([s["name"] for s in servers], ["filesystem"])
        self.assertEqual(servers[0]["catalog_id"], "filesystem")

    def test_install_preserves_existing_config_and_backs_it_up(self):
        self.config.write_text("# keep me\nmodel:\n  default: some/model\n")
        r = self.client.post("/workspace/mcp-servers/install", json={"id": "fetch"})
        self.assertEqual(r.status_code, 200)
        cfg = self._config()
        self.assertEqual(cfg["model"], {"default": "some/model"})
        self.assertIn("fetch", cfg["mcp_servers"])
        backups = list(self.hermes_home.glob("config.yaml.bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertIn("# keep me", backups[0].read_text())

    def test_reinstall_is_409_and_does_not_reload(self):
        self.client.post("/workspace/mcp-servers/install", json={"id": "fetch"})
        self.reload.reset_mock()
        before = self.config.read_text()
        r = self.client.post("/workspace/mcp-servers/install", json={"id": "fetch"})
        self.assertEqual(r.status_code, 409)
        self.reload.assert_not_called()
        self.assertEqual(self.config.read_text(), before)

    def test_install_unknown_id_is_400_and_writes_nothing(self):
        r = self.client.post("/workspace/mcp-servers/install", json={"id": "rm-rf"})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(self.config.exists())
        self.reload.assert_not_called()

    def test_install_without_id_is_422(self):
        r = self.client.post("/workspace/mcp-servers/install", json={"param": "x"})
        self.assertEqual(r.status_code, 422)
        self.assertFalse(self.config.exists())

    def test_uninstall_removes_the_server(self):
        self.client.post("/workspace/mcp-servers/install", json={"id": "fetch"})
        self.reload.reset_mock()
        r = self.client.delete("/workspace/mcp-servers/fetch")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"ok": True, "removed": "fetch", "reloaded": True})
        self.reload.assert_called_once()
        self.assertNotIn("fetch", self._config().get("mcp_servers") or {})

    def test_uninstall_not_installed_is_404(self):
        self.assertEqual(self.client.delete("/workspace/mcp-servers/fetch").status_code, 404)
        self.reload.assert_not_called()

    def test_uninstall_agent_managed_server_is_403_and_untouched(self):
        self.config.write_text(
            "mcp_servers:\n  my-own:\n    command: node\n    env:\n      SECRET_KEY: s3cr3t\n"
            "  remote:\n    url: https://example.invalid/mcp\n    headers:\n      Authorization: Bearer s3cr3t\n"
        )
        r = self.client.delete("/workspace/mcp-servers/my-own")
        self.assertEqual(r.status_code, 403)
        self.assertIn("my-own", self._config()["mcp_servers"])
        # And the listing redacts secrets: env names only, no headers at all.
        listing = self.client.get("/workspace/mcp-servers")
        self.assertNotIn("s3cr3t", listing.text)
        servers = {s["name"]: s for s in listing.json()["servers"]}
        self.assertEqual(servers["my-own"]["env_keys"], ["SECRET_KEY"])
        self.assertEqual(servers["remote"]["transport"], "http")


# ---------------------------------------------------------------------------
# /cron
# ---------------------------------------------------------------------------


class _FakeHermesCron:
    """In-memory stand-in for hermes-agent's cron.jobs API (the only backend)."""

    def __init__(self):
        self.jobs: dict[str, dict] = {}
        self.created = []
        self._n = 0

    def create_job(self, *, prompt, schedule, name, deliver, origin):
        self._n += 1
        job_id = f"job{self._n}"
        job = {"id": job_id, "prompt": prompt, "schedule": schedule, "name": name or job_id,
               "deliver": deliver, "origin": origin, "enabled": True,
               "created_at": f"2026-09-{self._n:02d}T00:00:00+00:00",
               "conversation_id": (origin or {}).get("conversation_id") if isinstance(origin, dict) else None}
        self.jobs[job_id] = job
        self.created.append(job)
        return dict(job)

    def list_jobs(self, include_disabled=False):
        return [dict(j) for j in self.jobs.values() if include_disabled or j["enabled"]]

    def get_job(self, job_id):
        job = self.jobs.get(job_id)
        return dict(job) if job else None

    def remove_job(self, job_id):
        return self.jobs.pop(job_id, None) is not None

    def _set_enabled(self, job_id, enabled):
        job = self.jobs.get(job_id)
        if not job:
            return None
        job["enabled"] = enabled
        return dict(job)

    def pause_job(self, job_id):
        return self._set_enabled(job_id, False)

    def resume_job(self, job_id):
        return self._set_enabled(job_id, True)

    def trigger_job(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return None
        job["triggered"] = True
        return dict(job)


class CronRouteTests(RealBridgeTestCase):
    """/cron delegates to hermes-agent's cron (spec 5.6: the only implementation)."""

    def setUp(self):
        super().setUp()
        self.cron = self.kit.mod("routes.cron")
        self.fake = _FakeHermesCron()
        self.patch_object(self.cron, "_HERMES_CRON_AVAILABLE", True)
        self.patch_object(
            self.cron, "_map_hermes_job",
            lambda job: {"mapped": True, "status": "active" if job.get("enabled") else "paused", **job},
        )
        for route_name, fake_name in (
            ("_hermes_create_job", "create_job"),
            ("_hermes_list_jobs", "list_jobs"),
            ("_hermes_get_job", "get_job"),
            ("_hermes_remove_job", "remove_job"),
            ("_hermes_pause_job", "pause_job"),
            ("_hermes_resume_job", "resume_job"),
            ("_hermes_trigger_job", "trigger_job"),
        ):
            self.patch_object(self.cron, route_name, getattr(self.fake, fake_name))
        self.tick = MagicMock()
        self.patch_object(self.cron, "_run_hermes_tick_now", self.tick)
        self.history = MagicMock(return_value=[{"run_id": "r1", "status": "completed"}])
        self.patch_object(self.cron, "_build_hermes_run_history", self.history)

    def _create(self, **body):
        body = {"schedule": "every 1h", "prompt": "check CI", **body}
        r = self.client.post("/cron", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["job"]

    def test_crud_round_trip(self):
        self.assertEqual(self.client.get("/cron").json(), {"jobs": []})
        job = self._create(name="nightly")
        self.assertTrue(job["mapped"])
        self.assertEqual(job["name"], "nightly")
        self.assertEqual([j["id"] for j in self.client.get("/cron").json()["jobs"]], [job["id"]])

        r = self.client.post(f"/cron/{job['id']}/pause")
        self.assertEqual((r.status_code, r.json()["job"]["status"]), (200, "paused"))
        # Paused jobs are still listed (include_disabled=True).
        self.assertEqual(len(self.client.get("/cron").json()["jobs"]), 1)
        r = self.client.post(f"/cron/{job['id']}/resume")
        self.assertEqual((r.status_code, r.json()["job"]["status"]), (200, "active"))

        self.assertEqual(self.client.delete(f"/cron/{job['id']}").json(), {"ok": True})
        self.assertEqual(self.fake.jobs, {})
        self.assertEqual(self.client.get("/cron").json(), {"jobs": []})

    def test_create_delegates_with_local_delivery_and_trimmed_name(self):
        self._create(name="   ")
        created = self.fake.created[-1]
        self.assertEqual(created["deliver"], "local")
        self.assertEqual((created["prompt"], created["schedule"]), ("check CI", "every 1h"))
        self.assertEqual(created["name"], created["id"])  # blank name -> None -> backend default

    def test_create_validation(self):
        self.assertEqual(self.client.post("/cron", json={"prompt": "x"}).status_code, 400)
        self.assertEqual(self.client.post("/cron", json={"schedule": "* * * * *"}).status_code, 400)
        r = self.client.post("/cron", content=b"{not json", headers={"content-type": "application/json"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.fake.created, [])

    def test_list_is_newest_first_and_filters_by_conversation(self):
        self.fake.jobs = {
            "a1": {"id": "a1", "conversation_id": "c1", "created_at": "2026-09-01", "enabled": True},
            "b2": {"id": "b2", "conversation_id": "c2", "created_at": "2026-09-02", "enabled": False},
        }
        body = self.client.get("/cron").json()
        self.assertEqual([j["id"] for j in body["jobs"]], ["b2", "a1"])
        body = self.client.get("/cron", params={"conversation_id": "c1"}).json()
        self.assertEqual([j["id"] for j in body["jobs"]], ["a1"])

    def test_unknown_job_is_404_everywhere(self):
        for method, path in (
            ("delete", "/cron/nope"),
            ("post", "/cron/nope/pause"),
            ("post", "/cron/nope/resume"),
            ("post", "/cron/nope/run"),
            ("get", "/cron/nope/history"),
        ):
            r = getattr(self.client, method)(path)
            self.assertEqual(r.status_code, 404, path)
        self.tick.assert_not_called()
        self.history.assert_not_called()

    def test_history_rejects_an_invalid_job_id(self):
        r = self.client.get("/cron/bad%20id/history")
        self.assertEqual(r.status_code, 422)
        self.history.assert_not_called()

    def test_run_queues_the_job_and_kicks_a_tick(self):
        job = self._create()
        r = self.client.post(f"/cron/{job['id']}/run")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body["ok"], body["status"]), (True, "queued"))
        self.assertTrue(body["job"]["triggered"])
        # The tick runs on a daemon thread; give it a moment.
        deadline = time.monotonic() + 5
        while not self.tick.called and time.monotonic() < deadline:
            time.sleep(0.01)
        self.tick.assert_called_once()

    def test_history_comes_from_the_hermes_run_records(self):
        job = self._create()
        r = self.client.get(f"/cron/{job['id']}/history")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"job_id": job["id"], "runs": [{"run_id": "r1", "status": "completed"}]})
        self.history.assert_called_once_with(job["id"])


class CronUnavailableTests(RealBridgeTestCase):
    """Without hermes-agent cron every /cron route is a retryable 503 envelope."""

    def setUp(self):
        super().setUp()
        self.cron = self.kit.mod("routes.cron")
        self.patch_object(self.cron, "_HERMES_CRON_AVAILABLE", False)
        self.patch_object(self.cron, "_HERMES_CRON_IMPORT_ERROR", "No module named 'cron'")
        self.backend = MagicMock(side_effect=AssertionError("backend must not be called"))
        for name in ("_hermes_create_job", "_hermes_list_jobs", "_hermes_get_job",
                     "_hermes_remove_job", "_hermes_pause_job", "_hermes_resume_job",
                     "_hermes_trigger_job", "_run_hermes_tick_now"):
            self.patch_object(self.cron, name, self.backend)

    def test_every_route_is_503_with_the_import_error(self):
        for method, path, kwargs in (
            ("get", "/cron", {}),
            ("post", "/cron", {"json": {"schedule": "every 1h", "prompt": "p"}}),
            ("delete", "/cron/job1", {}),
            ("post", "/cron/job1/pause", {}),
            ("post", "/cron/job1/resume", {}),
            ("post", "/cron/job1/run", {}),
            ("get", "/cron/job1/history", {}),
        ):
            r = getattr(self.client, method)(path, **kwargs)
            self.assertEqual(r.status_code, 503, path)
            error = r.json()["error"]
            self.assertEqual(error["code"], "BRIDGE_STARTING", path)
            self.assertTrue(error["retryable"], path)
            self.assertIn("No module named 'cron'", error["message"], path)
        self.backend.assert_not_called()

    def test_request_validation_still_wins_over_503(self):
        # Bad input is the caller's bug whether or not cron is up.
        self.assertEqual(self.client.post("/cron", json={"prompt": "x"}).status_code, 400)
        self.assertEqual(self.client.get("/cron/bad%20id/history").status_code, 422)

    def test_message_has_a_default_when_no_import_error_was_recorded(self):
        self.patch_object(self.cron, "_HERMES_CRON_IMPORT_ERROR", None)
        r = self.client.get("/cron")
        self.assertEqual(r.status_code, 503)
        self.assertIn("not importable", r.json()["error"]["message"])


# ---------------------------------------------------------------------------
# Token guard through the real middleware stack
# ---------------------------------------------------------------------------


class TokenGuardHttpTests(RealBridgeTestCase):
    """The guard as a client sees it: real app, real middleware, real routing."""

    def setUp(self):
        super().setUp()
        cfg = self.kit.mod("bridge_config")
        self.patch_object(cfg, "HERMES_BRIDGE_TOKEN", TOKEN)
        self.patch_object(cfg, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False)

    def _client(self, host="127.0.0.1"):
        client = self.kit.client(host=host)
        self.addCleanup(client.close)
        return client

    def test_loopback_without_token_is_rejected_on_every_privileged_route(self):
        for method, path, kwargs in (
            ("get", "/sessions", {}),
            ("post", "/v1/approvals/x", {"json": {"option_id": "deny"}}),
            ("put", "/workspace/files/soul", {"json": {"content": "pwned"}}),
            ("post", "/workspace/mcp-servers/install", {"json": {"id": "fetch"}}),
            ("post", "/cron", {"json": {"schedule": "* * * * *", "prompt": "x"}}),
        ):
            r = getattr(self.client, method)(path, **kwargs)
            self.assertEqual(r.status_code, 401, path)
            self.assertEqual(
                r.json(),
                {"error": {"code": "BRIDGE_AUTH", "message": "Missing or invalid Hermes bridge token.",
                           "retryable": False}},
                path,
            )
        # Nothing behind the guard ran.
        self.assertFalse((self.hermes_home / "SOUL.md").exists())
        self.assertFalse((self.hermes_home / "config.yaml").exists())

    def test_wrong_token_is_rejected(self):
        for headers in ({"X-Hermes-Bridge-Token": "nope"}, {"Authorization": "Bearer nope"},
                        {"X-Hermes-Bridge-Token": TOKEN[:-1]}):
            self.assertEqual(self.client.get("/sessions", headers=headers).status_code, 401, headers)

    def test_correct_token_is_accepted_in_either_header(self):
        for headers in ({"X-Hermes-Bridge-Token": TOKEN}, {"Authorization": f"Bearer {TOKEN}"}):
            r = self.client.get("/sessions", headers=headers)
            self.assertEqual(r.status_code, 200, headers)
            self.assertIn("sessions", r.json())

    def test_probes_stay_open_without_a_token(self):
        for path in ("/health", "/diag"):
            self.assertEqual(self.client.get(path).status_code, 200, path)
            self.assertEqual(self._client("10.1.2.3").get(path).status_code, 200, path)

    def test_exemption_is_exact_path_only(self):
        for path in ("/health/", "/diag/x", "/healthz", "/v1/models"):
            self.assertEqual(self.client.get(path).status_code, 401, path)

    def test_diag_never_returns_the_token(self):
        for headers, matches in (
            ({}, False),
            ({"X-Hermes-Bridge-Token": "wrong"}, False),
            ({"X-Hermes-Bridge-Token": TOKEN}, True),
        ):
            r = self.client.get("/diag", headers=headers)
            self.assertEqual(r.status_code, 200)
            self.assertNotIn(TOKEN, r.text)
            self.assertNotIn(TOKEN[:16], r.text)
            body = r.json()
            self.assertTrue(body["launch_token_present"])
            self.assertIs(body["token_matches"], matches, headers)
            self.assertEqual(body["pid"], os.getpid())

    def test_health_does_not_leak_the_token_either(self):
        r = self.client.get("/health")
        self.assertNotIn(TOKEN, r.text)
        self.assertTrue(r.json()["launch_token_present"])

    def test_non_loopback_needs_the_token_too(self):
        remote = self._client("192.168.1.20")
        self.assertEqual(remote.get("/sessions").status_code, 401)
        self.assertEqual(remote.get("/sessions", headers={"X-Hermes-Bridge-Token": TOKEN}).status_code, 200)

    def test_foreign_origin_is_403_even_with_the_token(self):
        r = self.client.get(
            "/sessions", headers={"Origin": "https://evil.example", "X-Hermes-Bridge-Token": TOKEN}
        )
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"]["code"], "BRIDGE_AUTH")
        # Also on the otherwise-exempt probes.
        self.assertEqual(self.client.get("/diag", headers={"Origin": "https://evil.example"}).status_code, 403)

    def test_app_origin_with_token_is_allowed_and_gets_cors_headers(self):
        r = self.client.get(
            "/sessions", headers={"Origin": "http://localhost:8080", "X-Hermes-Bridge-Token": TOKEN}
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("access-control-allow-origin"), "http://localhost:8080")

    def test_escape_hatch_reopens_loopback_only(self):
        self.patch_object(self.kit.mod("bridge_config"), "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", True)
        self.assertEqual(self.client.get("/sessions").status_code, 200)
        self.assertEqual(self._client("10.0.0.5").get("/sessions").status_code, 401)

    def test_no_token_configured_means_open_bridge(self):
        self.patch_object(self.kit.mod("bridge_config"), "HERMES_BRIDGE_TOKEN", "")
        self.assertEqual(self.client.get("/sessions").status_code, 200)
        self.assertEqual(self._client("10.0.0.5").get("/sessions").status_code, 200)
        body = self.client.get("/diag").json()
        self.assertFalse(body["launch_token_present"])
        self.assertFalse(body["token_matches"])

    def test_unknown_route_behind_the_guard_is_401_not_404(self):
        # The guard runs before routing, so unauthenticated callers cannot
        # probe which routes exist.
        self.assertEqual(self.client.get("/definitely/not/a/route").status_code, 401)
        r = self.client.get("/definitely/not/a/route", headers={"X-Hermes-Bridge-Token": TOKEN})
        self.assertEqual(r.status_code, 404)

    def test_unknown_route_404_uses_the_bridge_error_envelope(self):
        # main._handle_http_exception says "FastAPI raises this for 404s", but
        # it is registered for fastapi.HTTPException, and an unmatched route
        # raises starlette.exceptions.HTTPException (the base class), which the
        # handler does not catch. Unknown routes therefore answer the legacy
        # {"detail": "Not Found"} shape instead of the spec 1.4 envelope.
        r = self.client.get("/definitely/not/a/route", headers={"X-Hermes-Bridge-Token": TOKEN})
        self.assertEqual(r.status_code, 404)
        body = r.json()
        self.assertNotIn("detail", body)
        self.assertEqual(body["error"]["code"], "VALIDATION")


if __name__ == "__main__":
    unittest.main()
