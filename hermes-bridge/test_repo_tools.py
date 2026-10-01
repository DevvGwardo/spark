"""Focused tests for repo_tools.py (shared GitHub repo tools). No network:
httpx.Client is replaced with an in-memory fake and the brain cache with a dict."""

import base64
import unittest
from typing import Optional
from unittest.mock import patch

import repo_tools as rt


class FakeResponse:
    def __init__(self, status_code=200, payload=None, headers=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeClient:
    """Serves queued responses per URL prefix and records every request."""

    routes: list = []
    calls: list = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get(self, url, headers=None, params=None):
        FakeClient.calls.append({"url": url, "headers": headers, "params": params})
        for i, (match, response) in enumerate(FakeClient.routes):
            if match(url):
                if isinstance(response, list):
                    return response.pop(0)
                return response
        raise AssertionError(f"unexpected GET {url}")


def serve(*routes):
    """Patch httpx.Client to serve ``(predicate, response_or_list)`` routes."""
    FakeClient.routes = list(routes)
    FakeClient.calls = []
    return patch.object(rt.httpx, "Client", FakeClient)


class Host(rt.RepoToolsMixin):
    def __init__(self, pat: Optional[str] = "pat", owner: Optional[str] = "octo", name: Optional[str] = "repo"):
        self.github_pat = pat
        self._owner = owner
        self._name = name
        self.workspace_id = "ws1"
        self.session_cache: dict[str, str] = {}
        self.brain: dict[str, str] = {}
        self.sets: list = []
        self.deletes: list = []
        self.events: list = []
        self.markers: list = []

    @property
    def repo_owner(self):
        return self._owner

    @property
    def repo_name(self):
        return self._name

    def _emit_repo_event(self, event):
        self.events.append(event)

    def _emit_tool_marker(self, tool_name, detail=""):
        self.markers.append((tool_name, detail))

    def _cache_get(self, key):
        return self.brain.get(key)

    def _cache_set(self, key, value, ttl):
        self.sets.append((key, value, ttl))
        self.brain[key] = value
        return True

    def _cache_delete(self, key):
        self.deletes.append(key)
        self.brain.pop(key, None)
        return True


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


class SchemaTests(unittest.TestCase):
    def test_openai_definitions_follow_catalog_order(self):
        defs = rt.openai_tool_definitions()
        self.assertEqual([d["function"]["name"] for d in defs], list(rt.REPO_TOOL_ORDER))
        self.assertTrue(all(d["type"] == "function" for d in defs))
        self.assertEqual(rt.REPO_TOOL_NAMES, set(rt.REPO_TOOL_SCHEMAS))
        self.assertEqual(rt.REPO_READONLY_TOOL_NAMES | rt.REPO_EDIT_TOOL_NAMES, rt.REPO_TOOL_NAMES)

    def test_both_hosts_share_one_schema_source(self):
        import run_agent
        self.assertEqual(run_agent.REPO_TOOL_DEFINITIONS, rt.openai_tool_definitions())
        self.assertIs(run_agent.REPO_EDIT_TOOL_NAMES, rt.REPO_EDIT_TOOL_NAMES)
        self.assertTrue(issubclass(run_agent.AIAgent, rt.RepoToolsMixin))

    def test_every_tool_has_a_handler(self):
        self.assertEqual(set(Host().repo_tool_handlers()), rt.REPO_TOOL_NAMES)


class HelperTests(unittest.TestCase):
    def test_cache_keys(self):
        self.assertEqual(rt.shared_repo_file_key("o", "r", "a/b.py"), "repo-file:o/r:a/b.py")
        self.assertEqual(rt.shared_repo_tree_key("o", "r"), "repo-tree:o/r")
        self.assertEqual(rt.workspace_staged_key("w", "o", "r", "a.py"), "repo-staged:w:o/r:a.py")

    def test_cap_keeps_head_and_tail(self):
        self.assertEqual(rt.cap("short"), "short")
        text = "A" * rt.MAX_TOOL_RESPONSE + "B" * 10
        capped = rt.cap(text)
        self.assertTrue(capped.startswith("A" * 100))
        self.assertTrue(capped.endswith("B" * 10))
        self.assertIn("(10 chars truncated)", capped)

    def test_parse_next_link(self):
        header = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'
        self.assertEqual(rt.parse_next_link(header), "https://api.github.com/x?page=2")
        self.assertIsNone(rt.parse_next_link('<u>; rel="last"'))
        self.assertIsNone(rt.parse_next_link(""))

    def test_format_commit_patch(self):
        out = rt.format_commit_patch([
            {"filename": "a.py", "status": "modified", "additions": 1, "deletions": 2, "patch": "x" * 10},
            {"filename": "img.png", "status": "added"},
            "junk",
        ], per_file_cap=4)
        self.assertIn("diff --- a.py (modified, +1 -2)\nxxxx\n[... patch truncated, 6 more chars ...]", out)
        self.assertIn("(no textual diff available — binary or too large)", out)
        self.assertEqual(rt.format_commit_patch([]), "(no file changes)")

    def test_dispatch_unknown_tool(self):
        self.assertEqual(Host().dispatch_repo_tool("nope", {}), "Unknown repo tool: nope")


class ReadRepoFileTests(unittest.TestCase):
    def test_session_cache_wins(self):
        host = Host()
        host.session_cache["a.py"] = "local"
        self.assertEqual(host.dispatch_repo_tool("read_repo_file", {"path": "a.py"}), "local")
        self.assertEqual(host.events, [{"type": "repo_file_read", "path": "a.py", "content": "local"}])
        self.assertEqual(host.markers, [("read_repo_file", "a.py")])

    def test_staged_buffer_before_pool(self):
        host = Host()
        host.brain["repo-staged:ws1:octo/repo:a.py"] = "staged"
        host.brain["repo-file:octo/repo:a.py"] = "pooled"
        self.assertEqual(host._handle_read_repo_file({"path": "a.py"}), "staged")
        self.assertTrue(host.events[0]["staged"])
        self.assertEqual(host.session_cache["a.py"], "staged")

    def test_pool_hit_counts_stats(self):
        host = Host()
        host.brain["repo-file:octo/repo:a.py"] = "pooled"
        before = dict(rt.CACHE_STATS)
        self.assertEqual(host._handle_read_repo_file({"path": "a.py"}), "pooled")
        self.assertEqual(rt.CACHE_STATS["repo_file_hits"], before["repo_file_hits"] + 1)
        self.assertTrue(host.events[0]["cached"])

    def test_miss_fetches_and_pools_with_ttl(self):
        host = Host()
        with serve((lambda u: True, FakeResponse(200, {"content": b64("hi"), "encoding": "base64"}))):
            self.assertEqual(host._handle_read_repo_file({"path": "a.py"}), "hi")
        self.assertEqual(host.sets, [("repo-file:octo/repo:a.py", "hi", rt.REPO_CACHE_TTL)])
        self.assertEqual(host.session_cache["a.py"], "hi")

    def test_errors_are_not_cached(self):
        host = Host()
        with serve((lambda u: True, FakeResponse(403))):
            result = host._handle_read_repo_file({"path": "a.py"})
        self.assertEqual(result, "Error: Access denied (403) for 'a.py'.")
        self.assertEqual(host.sets, [])
        self.assertNotIn("a.py", host.session_cache)
        self.assertEqual(host.events, [])

    def test_empty_file(self):
        host = Host()
        with serve((lambda u: True, FakeResponse(200, {"content": "", "encoding": "base64"}))):
            self.assertEqual(host._handle_read_repo_file({"path": "e.txt"}), "(empty file)")

    def test_pool_opt_out(self):
        class NoPool(Host):
            def _should_pool_file(self, content):
                return False

        host = NoPool()
        with serve((lambda u: True, FakeResponse(200, {"content": b64("hi")}))):
            host._handle_read_repo_file({"path": "a.py"})
        self.assertEqual(host.sets, [])
        self.assertEqual(host.session_cache["a.py"], "hi")


class ReadGithubFileTests(unittest.TestCase):
    def test_encodes_owner_repo_and_path(self):
        host = Host(owner="octo space", name="repo name")
        with serve((lambda u: True, FakeResponse(200, {"content": b64("x")}))):
            host._read_github_file("docs/Release Notes #1.md")
        self.assertEqual(
            FakeClient.calls[0]["url"],
            "https://api.github.com/repos/octo%20space/repo%20name/contents/docs/Release%20Notes%20%231.md",
        )
        self.assertNotIn("X-GitHub-Api-Version", FakeClient.calls[0]["headers"])

    def test_directory_listing_sorted(self):
        host = Host()
        payload = [{"name": "z.py", "type": "file"}, {"name": "lib", "type": "dir"}]
        with serve((lambda u: True, FakeResponse(200, payload))):
            out = host._read_github_file("src")
        self.assertEqual(out, "Directory listing for 'src':\n[dir] lib\nz.py")

    def test_missing_file_in_reachable_repo(self):
        host = Host()
        with serve(
            (lambda u: u.endswith("/contents/"), FakeResponse(200, [])),
            (lambda u: True, FakeResponse(404)),
        ):
            out = host._read_github_file("src/a/b.ts")
        self.assertEqual(out, "Error: File not found at 'src/a/b.ts'. Try read_repo_file on 'src/a'.")

    def test_missing_top_level_file_hint(self):
        host = Host()
        with serve(
            (lambda u: u.endswith("/contents/"), FakeResponse(200, [])),
            (lambda u: True, FakeResponse(404)),
        ):
            out = host._read_github_file("README.md")
        self.assertIn("Try read_repo_file with path '' to list root.", out)

    def test_unreachable_repo_points_at_list_user_repos(self):
        host = Host()
        with serve((lambda u: True, FakeResponse(404))):
            out = host._read_github_file("a.py")
        self.assertEqual(
            out,
            "Error: Repository octo/repo was not found (404). Call list_user_repos to see accessible repositories.",
        )

    def test_not_configured(self):
        self.assertEqual(Host(pat=None)._read_github_file("a"), "Error: GitHub access not configured.")

    def test_transport_error(self):
        host = Host()
        with serve((lambda u: True, FakeResponse(500))):
            self.assertEqual(host._read_github_file("a"), "Error reading 'a': HTTP 500")


class StagedEditTests(unittest.TestCase):
    def test_edit_stages_and_invalidates_pool(self):
        host = Host()
        host.session_cache["a.py"] = "old"
        out = host.dispatch_repo_tool("edit_repo_file", {"path": "a.py", "content": "new", "description": "fix"})
        self.assertEqual(out, "Staged edit for a.py: fix")
        self.assertEqual(host.deletes, ["repo-file:octo/repo:a.py"])
        self.assertEqual(host.sets, [("repo-staged:ws1:octo/repo:a.py", "new", rt.REPO_CACHE_TTL)])
        self.assertEqual(host.events, [{
            "type": "repo_file_edit", "path": "a.py", "content": "new",
            "originalContent": "old", "description": "fix",
        }])
        # A later read in the same session sees the staged content.
        self.assertEqual(host.dispatch_repo_tool("read_repo_file", {"path": "a.py"}), "new")

    def test_create_default_description(self):
        host = Host()
        self.assertEqual(
            host.dispatch_repo_tool("create_repo_file", {"path": "n.py", "content": "c"}),
            "Staged new file n.py: created",
        )
        self.assertEqual(host.events[0]["type"], "repo_file_create")

    def test_delete_clears_pool_and_staged(self):
        host = Host()
        host.session_cache["a.py"] = "x"
        self.assertEqual(host.dispatch_repo_tool("delete_repo_file", {"path": "a.py"}), "Staged deletion of a.py")
        self.assertEqual(host.deletes, ["repo-file:octo/repo:a.py", "repo-staged:ws1:octo/repo:a.py"])
        self.assertNotIn("a.py", host.session_cache)
        self.assertEqual(host.events, [{"type": "repo_file_delete", "path": "a.py"}])

    def test_no_brain_writes_without_repo(self):
        host = Host(owner=None, name=None)
        host.dispatch_repo_tool("edit_repo_file", {"path": "a.py", "content": "x"})
        self.assertEqual((host.sets, host.deletes), ([], []))

    def test_batch_dispatches_each_action(self):
        host = Host()
        out = host.dispatch_repo_tool("batch_edit_repo_files", {"changes": [
            {"path": "a.py", "action": "edit", "content": "1"},
            {"path": "b.py", "action": "create", "content": "2", "description": "new"},
            {"path": "c.py", "action": "delete"},
            "not-a-dict",
        ]})
        self.assertEqual(out, "Staged edit for a.py: updated\nStaged new file b.py: new\nStaged deletion of c.py")
        self.assertEqual([e["type"] for e in host.events], ["repo_file_edit", "repo_file_create", "repo_file_delete"])
        self.assertEqual(host.markers[0], ("batch_edit_repo_files", "a.py, b.py, c.py"))

    def test_batch_rejects_non_list(self):
        self.assertEqual(
            Host().dispatch_repo_tool("batch_edit_repo_files", {"changes": "x"}),
            "Error: 'changes' must be an array.",
        )

    def test_batch_marker_summarises_long_batches(self):
        host = Host()
        host._handle_batch_edit({"changes": [{"path": f"f{i}", "action": "edit"} for i in range(7)]})
        self.assertEqual(host.markers[0], ("batch_edit_repo_files", "f0, f1, f2, f3, f4 +2 more"))


class ListUserReposTests(unittest.TestCase):
    def test_no_token(self):
        self.assertEqual(Host(pat=None)._list_user_repos(), "Error: No GitHub token configured.")

    def test_paginates_and_formats(self):
        page1 = FakeResponse(200, [{"full_name": "o/a", "description": "Alpha", "private": True}],
                             headers={"Link": '<https://api.github.com/user/repos?page=2>; rel="next"'})
        page2 = FakeResponse(200, [{"full_name": "o/b"}])
        with serve((lambda u: True, [page1, page2])):
            out = Host().dispatch_repo_tool("list_user_repos", {})
        self.assertEqual(out, "Found 2 accessible repositories:\n- o/a (private): Alpha\n- o/b")
        self.assertEqual(FakeClient.calls[1]["url"], "https://api.github.com/user/repos?page=2")

    def test_retries_429_then_succeeds(self):
        responses = [FakeResponse(429, headers={"Retry-After": "99"}), FakeResponse(200, [])]
        with serve((lambda u: True, responses)), patch.object(rt.time, "sleep") as sleep:
            out = Host()._list_user_repos()
        sleep.assert_called_once_with(30)
        self.assertEqual(out, "No repositories found.")

    def test_gives_up_after_three_429s(self):
        responses = [FakeResponse(429) for _ in range(4)]
        with serve((lambda u: True, responses)), patch.object(rt.time, "sleep"):
            out = Host()._list_user_repos()
        self.assertIn("Error listing repositories: GitHub API rate limited (429) after 3 retries", out)

    def test_401(self):
        with serve((lambda u: True, FakeResponse(401))):
            self.assertEqual(Host()._list_user_repos(), "Error: GitHub token is invalid or expired.")


class GitHistoryTests(unittest.TestCase):
    def test_creds_missing(self):
        out = Host(pat=None, name=None)._handle_git_log({})
        self.assertEqual(
            out,
            "Error: Cannot access git history — missing GitHub credentials (GitHub PAT, repo name). "
            "The user needs to configure a GitHub Personal Access Token in Settings.",
        )

    def test_git_log_params_and_format(self):
        commits = [{"sha": "abcdef1234", "commit": {"message": "feat: x\n\nbody",
                                                     "author": {"name": "Ada", "date": "2026-06-01T00:00:00Z"}}}]
        host = Host()
        with serve((lambda u: True, FakeResponse(200, commits))):
            out = host._handle_git_log({"path": "src", "ref": "dev", "max_count": 500})
        self.assertEqual(out, "Last 1 commit(s) touching 'src' from 'dev':\nabcdef12  2026-06-01  Ada: feat: x")
        call = FakeClient.calls[0]
        self.assertEqual(call["url"], "https://api.github.com/repos/octo/repo/commits")
        self.assertEqual(call["params"], {"per_page": 50, "path": "src", "sha": "dev"})
        self.assertEqual(call["headers"]["X-GitHub-Api-Version"], "2022-11-28")
        self.assertEqual(host.markers, [("git_log", "src")])

    def test_git_log_empty_and_bad_count(self):
        with serve((lambda u: True, FakeResponse(200, []))):
            self.assertEqual(Host()._handle_git_log({"max_count": "lots"}), "No commits found.")
        self.assertEqual(FakeClient.calls[0]["params"], {"per_page": 15})

    def test_git_show(self):
        data = {"sha": "full", "commit": {"message": "msg", "author": {"name": "A", "email": "a@x", "date": "d"}},
                "stats": {"additions": 3, "deletions": 1},
                "files": [{"filename": "f", "status": "modified", "additions": 3, "deletions": 1, "patch": "@@"}]}
        with serve((lambda u: True, FakeResponse(200, data))):
            out = Host()._handle_git_show({"sha": "a/b"})
        self.assertTrue(out.startswith("commit full\nAuthor: A <a@x>\nDate:   d\nFiles:  1 changed, +3 -1\n\nmsg\n"))
        self.assertIn("diff --- f (modified, +3 -1)\n@@", out)
        self.assertTrue(FakeClient.calls[0]["url"].endswith("/commits/a%2Fb"))

    def test_git_show_requires_sha(self):
        self.assertEqual(Host()._handle_git_show({}), "Error: 'sha' is required. Use a SHA from git_log.")

    def test_git_diff(self):
        data = {"status": "ahead", "ahead_by": 2, "behind_by": 0, "total_commits": 2, "files": []}
        with serve((lambda u: True, FakeResponse(200, data))):
            out = Host()._handle_git_diff({"base": "main", "head": "feat/x"})
        self.assertEqual(
            out,
            "Comparing main...feat/x\nStatus: ahead (ahead 2, behind 0), 2 commit(s), 0 file(s) changed\n\n(no file changes)",
        )
        self.assertTrue(FakeClient.calls[0]["url"].endswith("/compare/main...feat%2Fx"))

    def test_git_diff_requires_both_refs(self):
        self.assertEqual(Host()._handle_git_diff({"base": "main"}), "Error: both 'base' and 'head' refs are required.")

    def test_github_get_error_mapping(self):
        host = Host()
        for status, needle in ((401, "invalid or expired"), (403, "Access denied (HTTP 403) for octo/repo"),
                               (404, "Not found (HTTP 404) for octo/repo")):
            with serve((lambda u: True, FakeResponse(status))):
                data, err = host._github_get("commits")
            self.assertIsNone(data)
            self.assertIn(needle, err)
        with serve((lambda u: True, FakeResponse(500))):
            self.assertEqual(host._github_get("commits"), (None, "Error reaching the GitHub API: HTTP 500"))


class LegacyAgentHostTests(unittest.TestCase):
    """run_agent.AIAgent hosts the same handlers behind tool_start/tool_end."""

    def _agent(self, **kw):
        import run_agent
        agent = run_agent.AIAgent(
            base_url="https://example.com", api_key="k", model="m", repo_mode=True,
            github_pat="pat", github_repo_owner="octo", github_repo_name="repo",
            workspace_id="conv-1", **kw,
        )
        return agent

    def test_execute_repo_tool_brackets_with_start_and_end(self):
        agent = self._agent()
        seen, events = [], []
        agent.on_tool_start = lambda name, payload: seen.append(("start", name, payload))
        agent.on_tool_end = lambda name, payload, result: seen.append(("end", name, result))
        agent.on_server_tool_event = events.append
        with patch.object(rt, "brain_safe_set", return_value=True) as bset, \
                patch.object(rt, "brain_safe_delete", return_value=True):
            out = agent._execute_repo_tool("edit_repo_file", {"path": "a.py", "content": "x"})
        self.assertEqual(out, "Staged edit for a.py: updated")
        self.assertEqual(seen, [("start", "edit_repo_file", "a.py"), ("end", "edit_repo_file", out)])
        self.assertEqual(events[0]["type"], "repo_file_edit")
        bset.assert_called_once_with("repo-staged:conv-1:octo/repo:a.py", "x", ttl=rt.REPO_CACHE_TTL)

    def test_unknown_tool_emits_nothing(self):
        agent = self._agent()
        seen = []
        agent.on_tool_start = lambda *a: seen.append(a)
        self.assertEqual(agent._execute_repo_tool("nope", {}), "Unknown repo tool: nope")
        self.assertEqual(seen, [])

    def test_truncated_reads_are_not_pooled(self):
        import run_agent
        agent = self._agent()
        big = "\n".join(f"line {i} " + "x" * 40 for i in range(2000))
        with serve((lambda u: True, FakeResponse(200, {"content": b64(big)}))), \
                patch.object(rt, "brain_safe_get", return_value=None), \
                patch.object(rt, "brain_safe_set", return_value=True) as bset:
            out = agent._execute_repo_tool("read_repo_file", {"path": "big.txt"})
        self.assertIn(run_agent._FILE_TRUNCATION_MARKER, out)
        bset.assert_not_called()


if __name__ == "__main__":
    unittest.main()
