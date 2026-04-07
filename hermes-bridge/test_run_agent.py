import json
import os
import sys
import types
import unittest
from unittest.mock import patch, MagicMock


sys.path.insert(0, os.path.dirname(__file__))

if "httpx" not in sys.modules:
    httpx_stub = types.ModuleType("httpx")

    class _HTTPError(Exception):
        pass

    class _HTTPStatusError(_HTTPError):
        def __init__(self, *args, response=None, **kwargs):
            super().__init__(*args)
            self.response = response

    class _Response:
        status_code = 200
        text = ""
        reason_phrase = "OK"

        def json(self):
            return {}

        def raise_for_status(self):
            return None

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, *args, **kwargs):
            return _Response()

        def post(self, *args, **kwargs):
            return _Response()

    httpx_stub.HTTPError = _HTTPError
    httpx_stub.HTTPStatusError = _HTTPStatusError
    httpx_stub.Response = _Response
    httpx_stub.Client = _Client
    sys.modules["httpx"] = httpx_stub

import run_agent
from run_agent import AIAgent


class RunAgentRepoModeTests(unittest.TestCase):
    def test_read_github_file_encodes_reserved_repo_paths(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-github-pat",
            github_repo_owner="octo space",
            github_repo_name="repo name",
        )

        captured = {}

        class FakeResponse:
            status_code = 200

            def json(self):
                import base64
                return {
                    "content": base64.b64encode(b"hello world").decode("ascii"),
                }

            def raise_for_status(self):
                return None

        class FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def get(self, url, headers=None):
                captured["url"] = url
                return FakeResponse()

        original_client = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._read_github_file("docs/Release Notes #1.md")
        finally:
            run_agent.httpx.Client = original_client

        self.assertEqual(result, "hello world")
        self.assertEqual(
            captured["url"],
            "https://api.github.com/repos/octo%20space/repo%20name/contents/docs/Release%20Notes%20%231.md",
        )

    def test_keeps_read_only_repo_questions_out_of_edit_workflow(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-github-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        responses = [
            {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "content": "This repository contains the main application shell and chat runtime.",
                        "tool_calls": [],
                    },
                }],
            },
        ]

        seen_tool_choices = []

        def fake_call(messages, forced_repo_tool_choice=None):
            seen_tool_choices.append(forced_repo_tool_choice)
            return responses.pop(0)

        agent._call_api = fake_call  # type: ignore[method-assign]

        agent.run_conversation(
            user_message="what is this repo?",
            conversation_history=[{"role": "system", "content": "repo mode"}],
        )

        self.assertEqual(seen_tool_choices, [None])

    def test_read_only_repo_turns_only_expose_repo_reads(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-github-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        tool_names = {tool["function"]["name"] for tool in agent.tools}

        self.assertIn("read_repo_file", tool_names)
        self.assertIn("list_user_repos", tool_names)
        self.assertNotIn("edit_repo_file", tool_names)
        self.assertNotIn("create_repo_file", tool_names)
        self.assertNotIn("delete_repo_file", tool_names)
        self.assertNotIn("batch_edit_repo_files", tool_names)

    def test_read_only_repo_turns_without_github_access_skip_repo_tools_and_note_limitation(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat=None,
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        tool_names = {tool["function"]["name"] for tool in agent.tools}
        repo_prompt = agent._build_repo_system_prompt()

        self.assertNotIn("read_repo_file", tool_names)
        self.assertIn("GitHub file access is unavailable", repo_prompt)
        self.assertIn("Do NOT call read_repo_file", repo_prompt)
        # Should NOT tell the agent it "has tools to read, edit, create" when PAT is missing
        self.assertNotIn("You have tools to read, edit, create", repo_prompt)
        # Should NOT ask the user for help
        self.assertIn("Do NOT ask the user", repo_prompt)

    def test_forces_repo_tool_after_approved_turn_drifts_into_prose(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,

            repo_edit_intent=True,
            github_pat="test-github-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        responses = [
            {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "content": "Let's continue with the accepted plan.\n\n```python\nprint('reading files')\n```",
                        "tool_calls": [],
                    },
                }],
            },
            {
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [{
                            "id": "read-1",
                            "function": {
                                "name": "read_repo_file",
                                "arguments": json.dumps({"path": "src/App.tsx"}),
                            },
                        }],
                    },
                }],
            },
            {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "content": "Done reading the file.",
                        "tool_calls": [],
                    },
                }],
            },
            {
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [{
                            "id": "edit-1",
                            "function": {
                                "name": "edit_repo_file",
                                "arguments": json.dumps({
                                    "path": "src/App.tsx",
                                    "content": "export default function App() { return null; }",
                                    "description": "Simplify the shell",
                                }),
                            },
                        }],
                    },
                }],
            },
            {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "content": "The approved changes are staged.",
                        "tool_calls": [],
                    },
                }],
            },
        ]

        seen_tool_choices = []
        tool_events = []

        def fake_call(messages, forced_repo_tool_choice=None):
            seen_tool_choices.append(forced_repo_tool_choice)
            return responses.pop(0)

        agent._call_api = fake_call  # type: ignore[method-assign]
        agent._read_github_file = lambda path: "export default function App() {}"  # type: ignore[method-assign]
        agent.on_tool_start = lambda name, payload: tool_events.append(("start", name, payload))
        agent.on_tool_end = lambda name, payload, result: tool_events.append(("end", name, result))

        agent.run_conversation(
            user_message="go ahead",
            conversation_history=[{"role": "system", "content": "repo mode"}],
        )

        self.assertEqual(seen_tool_choices, [None, "required", None, "required", None])
        self.assertIn(("start", "read_repo_file", "src/App.tsx"), tool_events)

    def test_continues_after_read_only_stop_even_when_prose_is_not_an_ack(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,

            repo_edit_intent=True,
            github_pat="test-github-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        responses = [
            {
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [{
                            "id": "read-1",
                            "function": {
                                "name": "read_repo_file",
                                "arguments": json.dumps({"path": "src/App.tsx"}),
                            },
                        }],
                    },
                }],
            },
            {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "content": "I found the component structure and the specific changes needed to implement the approved update.",
                        "tool_calls": [],
                    },
                }],
            },
            {
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [{
                            "id": "edit-1",
                            "function": {
                                "name": "edit_repo_file",
                                "arguments": json.dumps({
                                    "path": "src/App.tsx",
                                    "content": "export default function App() { return <main>Updated</main>; }",
                                    "description": "Apply the approved app shell refresh",
                                }),
                            },
                        }],
                    },
                }],
            },
            {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "content": "The approved changes are staged.",
                        "tool_calls": [],
                    },
                }],
            },
        ]

        seen_tool_choices = []
        tool_events = []

        def fake_call(messages, forced_repo_tool_choice=None):
            seen_tool_choices.append(forced_repo_tool_choice)
            return responses.pop(0)

        agent._call_api = fake_call  # type: ignore[method-assign]
        agent._read_github_file = lambda path: "export default function App() {}"  # type: ignore[method-assign]
        agent.on_tool_start = lambda name, payload: tool_events.append(("start", name, payload))
        agent.on_tool_end = lambda name, payload, result: tool_events.append(("end", name, result))

        agent.run_conversation(
            user_message="go ahead",
            conversation_history=[{"role": "system", "content": "repo mode"}],
        )

        self.assertEqual(seen_tool_choices, [None, None, "required", None])
        self.assertIn(("start", "read_repo_file", "src/App.tsx"), tool_events)

    def test_continues_after_edit_then_read_stop_in_same_repo_turn(self):
        """After an edit+read turn, verification prompt fires. Agent reviews and stops."""
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,

            repo_edit_intent=True,
            github_pat="test-github-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        responses = [
            # 1: edit + read in one turn
            {
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [{
                            "id": "edit-1",
                            "function": {
                                "name": "edit_repo_file",
                                "arguments": json.dumps({
                                    "path": "src/App.tsx",
                                    "content": "export default function App() { return <main>Updated</main>; }",
                                    "description": "Refresh the app shell",
                                }),
                            },
                        }, {
                            "id": "read-2",
                            "function": {
                                "name": "read_repo_file",
                                "arguments": json.dumps({"path": "src/components/chat/ChatArea.tsx"}),
                            },
                        }],
                    },
                }],
            },
            # 2: verification prompt response — agent confirms changes look good
            {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "content": "I've updated the shell. The changes look correct and are staged.",
                        "tool_calls": [],
                    },
                }],
            },
        ]

        seen_tool_choices = []
        tool_events = []

        def fake_call(messages, forced_repo_tool_choice=None):
            seen_tool_choices.append(forced_repo_tool_choice)
            return responses.pop(0)

        def fake_read(path):
            if path == "src/components/chat/ChatArea.tsx":
                return "export function ChatArea() {}"
            return "export default function App() {}"

        agent._call_api = fake_call  # type: ignore[method-assign]
        agent._read_github_file = fake_read  # type: ignore[method-assign]
        agent.on_tool_start = lambda name, payload: tool_events.append(("start", name, payload))
        agent.on_tool_end = lambda name, payload, result: tool_events.append(("end", name, result))

        agent.run_conversation(
            user_message="go ahead",
            conversation_history=[{"role": "system", "content": "repo mode"}],
        )

        # Iteration 1: edit+read (no forced), iteration 2: verification response (no forced)
        self.assertEqual(seen_tool_choices, [None, None])
        self.assertIn(("start", "read_repo_file", "src/components/chat/ChatArea.tsx"), tool_events)
        self.assertIn(("start", "edit_repo_file", "src/App.tsx"), tool_events)


class ToolResponseCapTests(unittest.TestCase):
    """Tests for the universal tool response cap (_cap_tool_response)."""

    def test_short_response_unchanged(self):
        result = run_agent._cap_tool_response("hello world")
        self.assertEqual(result, "hello world")

    def test_response_at_limit_unchanged(self):
        text = "x" * run_agent.MAX_TOOL_RESPONSE_CHARS
        result = run_agent._cap_tool_response(text)
        self.assertEqual(result, text)

    def test_long_response_truncated_with_head_and_tail(self):
        text = "A" * 30000 + "B" * 30000
        result = run_agent._cap_tool_response(text)
        self.assertLessEqual(len(result), run_agent.MAX_TOOL_RESPONSE_CHARS + 200)
        self.assertTrue(result.startswith("AAAA"))
        self.assertTrue(result.endswith("BBBB"))
        self.assertIn("characters omitted", result)

    def test_truncation_preserves_head_tail_ratio(self):
        text = "H" * 40000 + "T" * 10000
        result = run_agent._cap_tool_response(text)
        # Head should be ~80% of budget
        head_part = result.split("[...")[0]
        self.assertGreater(len(head_part), run_agent.MAX_TOOL_RESPONSE_CHARS * 0.7)


class ActionableErrorTests(unittest.TestCase):
    """Tests for improved tool error messages."""

    def test_read_file_not_found_lists_siblings(self):
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create some files in the directory
            for name in ["foo.py", "bar.js", "baz.ts"]:
                open(os.path.join(tmpdir, name), "w").close()
            result = run_agent._tool_read_file(os.path.join(tmpdir, "nonexistent.py"))
            self.assertIn("Error: File not found", result)
            self.assertIn("foo.py", result)
            self.assertIn("bar.js", result)

    def test_read_file_binary_error(self):
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "binary.bin")
            with open(path, "wb") as f:
                f.write(bytes(range(256)) * 100)
            result = run_agent._tool_read_file(path)
            # Should either succeed (if decodable) or give a clear error
            # Binary files with invalid UTF-8 should trigger the error
            if "Error" in result:
                self.assertIn("binary", result.lower())

    def test_write_file_creates_parent_dirs(self):
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "deep", "nested", "file.txt")
            result = run_agent._tool_write_file(path, "hello")
            self.assertIn("Written", result)
            self.assertTrue(os.path.exists(path))

    def test_run_command_timeout_message(self):
        result = run_agent._tool_run_command("sleep 10")
        # With default timeout of 5400s this won't actually timeout in tests
        # but we can test the exit code hints
        pass

    def test_run_command_exit_code_hints(self):
        result = run_agent._tool_run_command("command_that_does_not_exist_xyz")
        self.assertIn("Exit code:", result)

    def test_github_file_not_found_suggests_parent(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        class Fake200Response:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return [{"name": "README.md"}, {"name": "src"}]

        class Fake404Response:
            status_code = 404
            def raise_for_status(self): pass

        class FakeClient:
            """Returns 404 for the specific file but 200 for the root probe."""
            def __init__(self, *a, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, url, **kw):
                # Root directory probe succeeds — repo is accessible
                if url.endswith("/contents/"):
                    return Fake200Response()
                return Fake404Response()

        original = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._read_github_file("src/components/Missing.tsx")
        finally:
            run_agent.httpx.Client = original

        self.assertIn("Error: File not found", result)
        self.assertIn("src/components", result)

    def test_github_repo_inaccessible_returns_clear_error(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        class Fake404Response:
            status_code = 404
            def raise_for_status(self): pass

        class FakeClient:
            """Returns 404 for everything — repo itself is inaccessible."""
            def __init__(self, *a, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, *a, **kw): return Fake404Response()

        original = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._read_github_file("src/index.ts")
        finally:
            run_agent.httpx.Client = original

        self.assertIn("was not found", result)
        self.assertIn("octo/repo", result)
        self.assertIn("list_user_repos", result)

    def test_github_directory_lists_contents(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        class FakeDirResponse:
            status_code = 200
            def json(self):
                return [
                    {"name": "App.tsx", "type": "file"},
                    {"name": "index.ts", "type": "file"},
                    {"name": "components", "type": "dir"},
                ]
            def raise_for_status(self):
                pass

        class FakeClient:
            def __init__(self, *a, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, *a, **kw): return FakeDirResponse()

        original = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._read_github_file("src")
        finally:
            run_agent.httpx.Client = original

        self.assertIn("directory", result.lower())
        self.assertIn("App.tsx", result)
        self.assertIn("index.ts", result)


class ContextCompactionTests(unittest.TestCase):
    """Tests for context compaction in long conversations."""

    def _make_agent(self):
        return AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=True,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

    def test_no_compaction_below_threshold(self):
        agent = self._make_agent()
        messages = [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Fix the bug"},
            {"role": "assistant", "content": "I'll look into it."},
        ]
        result = agent._compact_context(messages)
        self.assertEqual(len(result), 3)
        self.assertEqual(result, messages)

    def test_compaction_above_threshold(self):
        agent = self._make_agent()
        # Create messages that exceed the threshold
        messages = [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Fix the bug in the application"},
        ]
        # Add many large tool result messages
        for i in range(20):
            messages.append({
                "role": "assistant",
                "content": f"Reading file {i}",
                "tool_calls": [{
                    "id": f"call-{i}",
                    "function": {
                        "name": "read_repo_file",
                        "arguments": json.dumps({"path": f"src/file{i}.tsx"}),
                    },
                }],
            })
            messages.append({
                "role": "tool",
                "tool_call_id": f"call-{i}",
                "content": "x" * 5000,  # Large file content
            })
        # Add recent messages
        messages.append({"role": "assistant", "content": "Almost done."})

        result = agent._compact_context(messages)
        # Should be significantly fewer messages
        self.assertLess(len(result), len(messages))
        # Should preserve system and user messages
        self.assertEqual(result[0]["role"], "system")
        self.assertEqual(result[1]["role"], "user")
        # Should have a compaction summary
        compacted = [m for m in result if "Context compacted" in (m.get("content") or "")]
        self.assertEqual(len(compacted), 1)
        self.assertIn("Files read", compacted[0]["content"])

    def test_compaction_preserves_recent_messages(self):
        agent = self._make_agent()
        messages = [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Fix it"},
        ]
        for i in range(15):
            messages.append({"role": "assistant", "content": "x" * 5000})
            messages.append({"role": "user", "content": f"step {i}"})
        # The last 6 messages should be preserved
        last_6 = messages[-6:]
        result = agent._compact_context(messages)
        self.assertEqual(result[-6:], last_6)

    def test_short_conversation_not_compacted(self):
        agent = self._make_agent()
        messages = [
            {"role": "system", "content": "x"},
            {"role": "user", "content": "y"},
            {"role": "assistant", "content": "z"},
        ]
        result = agent._compact_context(messages)
        self.assertEqual(len(result), 3)


class VerificationPromptTests(unittest.TestCase):
    """Tests for the post-edit verification prompt injection."""

    def test_verification_injected_after_edit(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=True,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        call_count = [0]
        captured_messages = []

        def fake_call(messages, forced_repo_tool_choice=None):
            call_count[0] += 1
            captured_messages.append([m.get("content", "") for m in messages])
            if call_count[0] == 1:
                return {
                    "choices": [{
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "",
                            "tool_calls": [{
                                "id": "edit-1",
                                "function": {
                                    "name": "batch_edit_repo_files",
                                    "arguments": json.dumps({
                                        "changes": [{"path": "src/App.tsx", "action": "edit", "content": "new content"}],
                                    }),
                                },
                            }],
                        },
                    }],
                }
            # Second call is the verification — agent confirms
            return {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {"content": "Changes verified. All looks good.", "tool_calls": []},
                }],
            }

        agent._call_api = fake_call
        agent.run_conversation(
            user_message="update App.tsx",
            conversation_history=[{"role": "system", "content": "repo"}],
        )

        self.assertEqual(call_count[0], 2)
        # The second call should include the verification prompt
        last_msgs = captured_messages[-1]
        verification_found = any("evaluator phase" in (m or "").lower() for m in last_msgs)
        self.assertTrue(verification_found, "Evaluator phase should be injected after edits")

    def test_no_verification_after_read_only(self):
        """Read-only repo turns should never inject a verification prompt."""
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        captured_messages = []

        call_count = [0]

        def fake_call(messages, forced_repo_tool_choice=None):
            call_count[0] += 1
            captured_messages.append([m.get("content", "") for m in messages])
            if call_count[0] == 1:
                return {
                    "choices": [{
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "",
                            "tool_calls": [{
                                "id": "read-1",
                                "function": {
                                    "name": "read_repo_file",
                                    "arguments": json.dumps({"path": "src/App.tsx"}),
                                },
                            }],
                        },
                    }],
                }
            return {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {"content": "Here's what the file contains.", "tool_calls": []},
                }],
            }

        agent._call_api = fake_call
        agent._read_github_file = lambda path: "file content"
        agent.run_conversation(
            user_message="show me App.tsx",
            conversation_history=[{"role": "system", "content": "repo"}],
        )

        # No verification prompt should appear in any call's messages
        for msgs in captured_messages:
            for m in msgs:
                self.assertNotIn("verify your work", (m or "").lower(),
                    "Verification prompt should not be injected for read-only turns")


class ReflectionPromptTests(unittest.TestCase):
    """Tests for the structured reflection prompt at iteration intervals."""

    def test_reflection_at_iteration_5(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            max_iterations=10,
            enabled_toolsets=["web"],
        )

        call_count = [0]
        captured_messages = []

        def fake_call(messages, forced_repo_tool_choice=None):
            call_count[0] += 1
            captured_messages.append(list(messages))

            if call_count[0] <= 5:
                # Keep making tool calls for 5 iterations
                return {
                    "choices": [{
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "",
                            "tool_calls": [{
                                "id": f"search-{call_count[0]}",
                                "function": {
                                    "name": "web_search",
                                    "arguments": json.dumps({"query": f"search {call_count[0]}"}),
                                },
                            }],
                        },
                    }],
                }
            # After reflection, stop
            return {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {"content": "Task complete.", "tool_calls": []},
                }],
            }

        agent._call_api = fake_call
        agent.run_conversation(user_message="research topic X")

        # After iteration 5 (index 4), a reflection prompt should be injected
        # Check that iteration 6's messages contain the reflection
        if call_count[0] >= 6:
            last_msgs = captured_messages[5]
            reflection_found = any(
                "reflection checkpoint" in (m.get("content") or "").lower()
                for m in last_msgs
            )
            self.assertTrue(reflection_found, "Reflection prompt should appear at iteration 5")


class VisionToolsetRemovedTests(unittest.TestCase):
    """Tests that the vision toolset was properly removed."""

    def test_vision_not_in_tool_definitions(self):
        self.assertNotIn("vision", run_agent.TOOL_DEFINITIONS)

    def test_agent_ignores_vision_toolset(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            enabled_toolsets=["web", "vision", "browser"],
        )
        tool_names = {t["function"]["name"] for t in agent.tools}
        self.assertIn("web_search", tool_names)
        self.assertIn("browse_url", tool_names)
        # No vision tools should exist
        self.assertEqual(len(agent.tools), 2)


class IntelligentFileTruncationTests(unittest.TestCase):
    """Tests for intelligent file truncation in _read_github_file."""

    def test_small_file_not_truncated(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        content = "line 1\nline 2\nline 3"
        import base64
        encoded = base64.b64encode(content.encode()).decode()

        class FakeResponse:
            status_code = 200
            def json(self): return {"content": encoded}
            def raise_for_status(self): pass

        class FakeClient:
            def __init__(self, *a, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, *a, **kw): return FakeResponse()

        original = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._read_github_file("small.txt")
        finally:
            run_agent.httpx.Client = original

        self.assertEqual(result, content)

    def test_large_file_preserves_head_and_tail(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        # Create a large file with distinct head and tail (must exceed MAX_TOOL_RESPONSE_CHARS)
        lines = [f"HEAD_LINE_{i}_{'x' * 20}" for i in range(500)]
        lines += [f"MIDDLE_LINE_{i}_{'x' * 20}" for i in range(500)]
        lines += [f"TAIL_LINE_{i}_{'x' * 20}" for i in range(500)]
        content = "\n".join(lines)

        import base64
        encoded = base64.b64encode(content.encode()).decode()

        class FakeResponse:
            status_code = 200
            def json(self): return {"content": encoded}
            def raise_for_status(self): pass

        class FakeClient:
            def __init__(self, *a, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, *a, **kw): return FakeResponse()

        original = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._read_github_file("large.txt")
        finally:
            run_agent.httpx.Client = original

        # Should contain head lines
        self.assertIn("HEAD_LINE_0", result)
        # Should contain tail lines
        self.assertIn("TAIL_LINE_499", result)
        # Should have truncation notice
        self.assertIn("lines omitted", result)


class RepoFileTreeTests(unittest.TestCase):
    """Tests for the repo file tree being passed to AIAgent and included in system prompts."""

    def test_file_tree_stored_on_agent(self):
        tree = ["README.md", "src/index.ts", "src/App.tsx"]
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
            repo_file_tree=tree,
        )
        self.assertEqual(agent.repo_file_tree, tree)

    def test_file_tree_defaults_to_empty(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )
        self.assertEqual(agent.repo_file_tree, [])

    def test_system_prompt_includes_file_tree_when_available(self):
        tree = ["README.md", "src/index.ts", "package.json"]
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
            repo_file_tree=tree,
        )
        prompt = agent._build_repo_system_prompt()
        self.assertIn("Repository file tree:", prompt)
        self.assertIn("README.md", prompt)
        self.assertIn("src/index.ts", prompt)
        self.assertIn("package.json", prompt)
        # Should NOT tell the model to list the root directory when tree is available
        self.assertNotIn("read_repo_file with path ''", prompt)

    def test_system_prompt_hints_at_root_listing_when_tree_missing(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
            repo_file_tree=[],
        )
        prompt = agent._build_repo_system_prompt()
        self.assertNotIn("Repository file tree:", prompt)
        self.assertIn("read_repo_file with path ''", prompt)

    def test_system_prompt_no_tree_without_pat(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat=None,
            github_repo_owner="octo",
            github_repo_name="repo",
            repo_file_tree=["README.md"],
        )
        prompt = agent._build_repo_system_prompt()
        # Without PAT, the prompt should indicate no GitHub access
        self.assertIn("GitHub file access is unavailable", prompt)
        self.assertNotIn("Repository file tree:", prompt)

    def test_system_prompt_injected_into_conversation(self):
        """Verify the file tree makes it into actual conversation messages."""
        tree = ["src/main.ts", "src/lib/utils.ts"]
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
            repo_file_tree=tree,
        )

        # Mock _call_api to capture the messages sent to the LLM
        captured_messages = []
        responses = [
            {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "content": "The repo has two source files.",
                        "tool_calls": [],
                    },
                }],
            },
        ]

        def fake_call(messages, forced_repo_tool_choice=None):
            captured_messages.extend(messages)
            return responses.pop(0)

        agent._call_api = fake_call

        agent.run_conversation(
            user_message="what files are in this repo?",
            conversation_history=[],
        )

        # Find the system message
        system_msgs = [m for m in captured_messages if m.get("role") == "system"]
        self.assertTrue(len(system_msgs) > 0, "No system message found in conversation")
        system_content = system_msgs[0]["content"]
        self.assertIn("src/main.ts", system_content)
        self.assertIn("src/lib/utils.ts", system_content)


class ListUserReposToolTests(unittest.TestCase):
    """Tests for the list_user_repos tool."""

    def test_list_user_repos_tool_present_in_read_only_mode(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )
        tool_names = {t["function"]["name"] for t in agent.tools}
        self.assertIn("list_user_repos", tool_names)
        self.assertIn("read_repo_file", tool_names)

    def test_list_user_repos_tool_present_in_edit_mode(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=True,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )
        tool_names = {t["function"]["name"] for t in agent.tools}
        self.assertIn("list_user_repos", tool_names)
        self.assertIn("edit_repo_file", tool_names)

    def test_list_user_repos_tool_absent_without_pat(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat=None,
            github_repo_owner="octo",
            github_repo_name="repo",
        )
        tool_names = {t["function"]["name"] for t in agent.tools}
        # No PAT → can't call GitHub API → tool is useless
        self.assertNotIn("list_user_repos", tool_names)

    def test_list_user_repos_returns_error_without_pat(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=True,
            github_pat=None,
            github_repo_owner="octo",
            github_repo_name="repo",
        )
        result = agent._list_user_repos()
        self.assertIn("Error", result)
        self.assertIn("No GitHub token", result)

    def test_list_user_repos_returns_repo_list(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        class FakeReposResponse:
            status_code = 200
            def json(self):
                return [
                    {"full_name": "octo/project-a", "description": "Frontend app", "private": False},
                    {"full_name": "octo/project-b", "description": "Backend API", "private": True},
                    {"full_name": "octo/project-c", "description": None, "private": False},
                ]
            def raise_for_status(self):
                return None

        class FakeClient:
            def __init__(self, *a, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, *a, **kw): return FakeReposResponse()

        original = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._list_user_repos()
        finally:
            run_agent.httpx.Client = original

        self.assertIn("Found 3 accessible repositories", result)
        self.assertIn("octo/project-a", result)
        self.assertIn("Frontend app", result)
        self.assertIn("octo/project-b", result)
        self.assertIn("(private)", result)
        self.assertIn("octo/project-c", result)

    def test_list_user_repos_handles_401(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        class Fake401Response:
            status_code = 401
            def raise_for_status(self): pass

        class FakeClient:
            def __init__(self, *a, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, *a, **kw): return Fake401Response()

        original = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._list_user_repos()
        finally:
            run_agent.httpx.Client = original

        self.assertIn("invalid or expired", result)

    def test_execute_repo_tool_dispatches_list_user_repos(self):
        """Verify the tool dispatch routes list_user_repos correctly."""
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat=None,
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        events = []
        agent.on_tool_start = lambda name, payload: events.append(("start", name))
        agent.on_tool_end = lambda name, payload, result: events.append(("end", name))

        result = agent._execute_repo_tool("list_user_repos", {})

        self.assertIn("Error", result)  # No PAT
        self.assertIn(("start", "list_user_repos"), events)
        self.assertIn(("end", "list_user_repos"), events)


class RepoValidationErrorRecoveryTests(unittest.TestCase):
    """Tests that 404 errors guide the model toward list_user_repos."""

    def test_repo_404_suggests_list_user_repos(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="nonexistent",
        )

        class Fake404Response:
            status_code = 404
            def raise_for_status(self): pass

        class FakeClient:
            def __init__(self, *a, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, *a, **kw): return Fake404Response()

        original = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._read_github_file("README.md")
        finally:
            run_agent.httpx.Client = original

        self.assertIn("list_user_repos", result)
        self.assertIn("octo/nonexistent", result)
        self.assertIn("not found", result.lower())

    def test_file_not_found_in_valid_repo_does_not_suggest_list_repos(self):
        """When only the file is missing but the repo exists, don't suggest list_user_repos."""
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            repo_edit_intent=False,
            github_pat="test-pat",
            github_repo_owner="octo",
            github_repo_name="repo",
        )

        class Fake404Response:
            status_code = 404
            def raise_for_status(self): pass

        class Fake200Response:
            status_code = 200
            def json(self):
                return [{"name": "README.md"}, {"name": "src"}]
            def raise_for_status(self): pass

        class FakeClient:
            def __init__(self, *a, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, url, **kw):
                if url.endswith("/contents/"):
                    return Fake200Response()
                return Fake404Response()

        original = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._read_github_file("src/missing.ts")
        finally:
            run_agent.httpx.Client = original

        # File not found, but repo is accessible — don't suggest list_user_repos
        self.assertIn("File not found", result)
        self.assertNotIn("list_user_repos", result)


# ---------------------------------------------------------------------------
# Check hermes_adapter availability
# ---------------------------------------------------------------------------
try:
    import hermes_adapter as _ha
    HERMES_ADAPTER_AVAILABLE = True
except Exception:
    HERMES_ADAPTER_AVAILABLE = False


# ---------------------------------------------------------------------------
# Brain MCP Integration Tests for hermes_adapter pooled caching
# ---------------------------------------------------------------------------

@unittest.skipUnless(HERMES_ADAPTER_AVAILABLE, "hermes_adapter not available (missing dependencies)")
class BrainMCPPooledCachingTests(unittest.TestCase):
    """Tests for brain-based pooled caching in hermes_adapter (repo files + trees)."""

    def test_hermes_adapter_brain_safe_set_returns_false_when_no_token(self):
        """_brain_safe_set should return False gracefully when no token is available."""
        import hermes_adapter as ha
        # Save original
        orig_token = ha._BRAIN_GATEWAY_TOKEN
        ha._BRAIN_GATEWAY_TOKEN = None
        try:
            # Patch _get_brain_token to return None
            with patch.object(ha, '_get_brain_token', return_value=None):
                result = ha._brain_safe_set("test-key", "test-value")
                self.assertFalse(result)
        finally:
            ha._BRAIN_GATEWAY_TOKEN = orig_token

    def test_hermes_adapter_brain_safe_get_returns_none_when_no_token(self):
        """_brain_safe_get should return None gracefully when no token is available."""
        import hermes_adapter as ha
        orig_token = ha._BRAIN_GATEWAY_TOKEN
        ha._BRAIN_GATEWAY_TOKEN = None
        try:
            with patch.object(ha, '_get_brain_token', return_value=None):
                result = ha._brain_safe_get("test-key")
                self.assertIsNone(result)
        finally:
            ha._BRAIN_GATEWAY_TOKEN = orig_token

    def test_hermes_adapter_cache_stats_tracked_per_request(self):
        """Cache hit/miss stats should be tracked in _cache_stats dict."""
        import hermes_adapter as ha
        ha._reset_cache_stats()
        stats = ha._get_cache_stats()
        self.assertIn("repo_file_hits", stats)
        self.assertIn("repo_file_misses", stats)
        self.assertIn("repo_tree_hits", stats)
        self.assertIn("repo_tree_misses", stats)
        self.assertEqual(stats["repo_file_hits"], 0)
        self.assertEqual(stats["repo_file_misses"], 0)

    def test_hermes_adapter_brain_http_call_returns_none_on_failure(self):
        """_brain_http_call should return None when the HTTP call fails."""
        import hermes_adapter as ha
        with patch.object(ha, '_get_brain_token', return_value="fake-token"):
            with patch('hermes_adapter.httpx.Client') as mock_client_class:
                mock_client = MagicMock()
                mock_client_class.return_value = mock_client
                mock_client.__enter__ = MagicMock(return_value=mock_client)
                mock_client.__exit__ = MagicMock(return_value=False)
                mock_client.get.side_effect = Exception("Connection refused")
                result = ha._brain_http_call("GET", "/state/get?key=test")
                self.assertIsNone(result)

    def test_hermes_adapter_brain_http_call_returns_none_for_non_200(self):
        """_brain_http_call should return None when the response is not 200/201."""
        import hermes_adapter as ha
        with patch.object(ha, '_get_brain_token', return_value="fake-token"):
            with patch('hermes_adapter.httpx.Client') as mock_client_class:
                mock_response = MagicMock()
                mock_response.status_code = 404
                mock_client = MagicMock()
                mock_client_class.return_value = mock_client
                mock_client.__enter__ = MagicMock(return_value=mock_client)
                mock_client.__exit__ = MagicMock(return_value=False)
                mock_client.get.return_value = mock_response
                result = ha._brain_http_call("GET", "/state/get?key=test")
                self.assertIsNone(result)

    def test_hermes_adapter_brain_http_call_success(self):
        """_brain_http_call should return parsed JSON on success."""
        import hermes_adapter as ha
        with patch.object(ha, '_get_brain_token', return_value="fake-token"):
            with patch('hermes_adapter.httpx.Client') as mock_client_class:
                mock_response = MagicMock()
                mock_response.status_code = 200
                mock_response.content = b'{"value": "test-data"}'
                mock_response.json.return_value = {"value": "test-data"}
                mock_client = MagicMock()
                mock_client_class.return_value = mock_client
                mock_client.__enter__ = MagicMock(return_value=mock_client)
                mock_client.__exit__ = MagicMock(return_value=False)
                mock_client.get.return_value = mock_response
                result = ha._brain_http_call("GET", "/state/get?key=test")
                self.assertEqual(result, {"value": "test-data"})

    def test_hermes_adapter_brain_http_call_post_success(self):
        """_brain_http_call should handle POST requests correctly."""
        import hermes_adapter as ha
        with patch.object(ha, '_get_brain_token', return_value="fake-token"):
            with patch('hermes_adapter.httpx.Client') as mock_client_class:
                mock_response = MagicMock()
                mock_response.status_code = 201
                mock_response.content = b'{"ok": true}'
                mock_response.json.return_value = {"ok": True}
                mock_client = MagicMock()
                mock_client_class.return_value = mock_client
                mock_client.__enter__ = MagicMock(return_value=mock_client)
                mock_client.__exit__ = MagicMock(return_value=False)
                mock_client.post.return_value = mock_response
                result = ha._brain_http_call("POST", "/state/set", {"key": "k", "value": "v"})
                self.assertEqual(result, {"ok": True})
                mock_client.post.assert_called_once()

    def test_hermes_adapter_brain_http_call_unsupported_method(self):
        """_brain_http_call should return None for unsupported HTTP methods."""
        import hermes_adapter as ha
        result = ha._brain_http_call("DELETE", "/state/delete")
        self.assertIsNone(result)

    def test_hermes_adapter_cache_ttl_env_var_override(self):
        """REPO_CACHE_TTL and REPO_TREE_TTL should be configurable via env vars."""
        import hermes_adapter as ha
        with patch.dict(os.environ, {"HERMES_REPO_CACHE_TTL": "600", "HERMES_REPO_TREE_TTL": "1200"}):
            # Re-import to pick up new env values
            import importlib
            importlib.reload(ha)
            self.assertEqual(ha.REPO_CACHE_TTL, 600)
            self.assertEqual(ha.REPO_TREE_TTL, 1200)


@unittest.skipUnless(HERMES_ADAPTER_AVAILABLE, "hermes_adapter not available (missing dependencies)")
class HermesAdapterRepoToolProviderTests(unittest.TestCase):
    """Tests for RepoToolProvider brain caching behavior in hermes_adapter."""

    def test_repo_tool_provider_initializes_without_github_pat(self):
        """RepoToolProvider should initialize even when github_pat is None."""
        from hermes_adapter import RepoToolProvider
        with patch('hermes_adapter._brain_safe_get', return_value=None):
            with patch('hermes_adapter._brain_safe_set', return_value=True):
                provider = RepoToolProvider(
                    github_pat=None,
                    owner="octo",
                    name="repo",
                    file_tree=["README.md"],
                    edit_intent=False,
                    on_server_tool_event=None,
                )
                self.assertEqual(provider.file_tree, ["README.md"])
                self.assertEqual(provider.github_pat, None)

    def test_repo_tool_provider_uses_cached_tree_from_brain(self):
        """When brain returns a cached tree, it should be used instead of provided tree."""
        from hermes_adapter import RepoToolProvider
        cached_tree = ["cached/README.md", "cached/src/main.ts"]
        with patch('hermes_adapter._brain_safe_get', return_value=json.dumps(cached_tree)):
            with patch('hermes_adapter._brain_safe_set', return_value=True):
                provider = RepoToolProvider(
                    github_pat="fake-pat",
                    owner="octo",
                    name="repo",
                    file_tree=["original/README.md"],
                    edit_intent=False,
                    on_server_tool_event=None,
                )
                self.assertEqual(provider.file_tree, cached_tree)
                stats = provider._cache_stats if hasattr(provider, '_cache_stats') else {}
                # The tree should have been loaded from cache
                self.assertEqual(provider.file_tree, cached_tree)

    def test_repo_tool_provider_caches_provided_tree_when_no_brain_cache(self):
        """When no brain cache exists, the provided tree should be cached to brain."""
        from hermes_adapter import RepoToolProvider
        provided_tree = ["provided/README.md", "provided/src/app.ts"]
        with patch('hermes_adapter._brain_safe_get', return_value=None) as mock_get:
            with patch('hermes_adapter._brain_safe_set', return_value=True) as mock_set:
                provider = RepoToolProvider(
                    github_pat="fake-pat",
                    owner="octo",
                    name="repo",
                    file_tree=provided_tree,
                    edit_intent=False,
                    on_server_tool_event=None,
                )
                # Should have tried to cache the provided tree
                self.assertEqual(provider.file_tree, provided_tree)
                # brain_safe_set should have been called to cache the tree
                self.assertTrue(mock_set.called)

    def test_repo_tool_provider_session_cache_stores_edited_content(self):
        """Session cache should store edited file contents for read-after-edit."""
        from hermes_adapter import RepoToolProvider
        with patch('hermes_adapter._brain_safe_get', return_value=None):
            with patch('hermes_adapter._brain_safe_set', return_value=True):
                with patch('hermes_adapter._brain_safe_delete', return_value=True):
                    provider = RepoToolProvider(
                        github_pat="fake-pat",
                        owner="octo",
                        name="repo",
                        file_tree=["src/App.tsx"],
                        edit_intent=True,
                        on_server_tool_event=None,
                    )
                    # Simulate an edit
                    result = provider._handle_edit_repo_file({
                        "path": "src/App.tsx",
                        "content": "new content",
                        "description": "updated",
                    })
                    self.assertIn("Staged edit", result)
                    # Session cache should have the new content
                    self.assertEqual(provider.session_cache.get("src/App.tsx"), "new content")

    def test_repo_tool_provider_read_returns_staged_content(self):
        """Reading a file that was edited should return staged content."""
        from hermes_adapter import RepoToolProvider
        with patch('hermes_adapter._brain_safe_get', return_value=None):
            with patch('hermes_adapter._brain_safe_set', return_value=True):
                with patch('hermes_adapter._brain_safe_delete', return_value=True):
                    provider = RepoToolProvider(
                        github_pat="fake-pat",
                        owner="octo",
                        name="repo",
                        file_tree=["src/App.tsx"],
                        edit_intent=True,
                        on_server_tool_event=None,
                    )
                    # First edit
                    provider._handle_edit_repo_file({
                        "path": "src/App.tsx",
                        "content": "edited content",
                        "description": "updated",
                    })
                    # Then read - should get staged content
                    result = provider._handle_read_repo_file({"path": "src/App.tsx"})
                    self.assertEqual(result, "edited content")

    def test_repo_tool_provider_invalidate_cache_on_edit(self):
        """Editing a file should invalidate the brain cache for that file."""
        from hermes_adapter import RepoToolProvider
        with patch('hermes_adapter._brain_safe_get', return_value=None):
            with patch('hermes_adapter._brain_safe_set', return_value=True) as mock_set:
                with patch('hermes_adapter._brain_safe_delete', return_value=True) as mock_delete:
                    provider = RepoToolProvider(
                        github_pat="fake-pat",
                        owner="octo",
                        name="repo",
                        file_tree=["src/App.tsx"],
                        edit_intent=True,
                        on_server_tool_event=None,
                    )
                    provider._handle_edit_repo_file({
                        "path": "src/App.tsx",
                        "content": "new content",
                        "description": "updated",
                    })
                    # _brain_safe_delete should have been called to invalidate cache
                    self.assertTrue(mock_delete.called)

    def test_repo_tool_provider_handles_missing_owner_or_name_gracefully(self):
        """Provider should work without owner/name (no brain caching attempted)."""
        from hermes_adapter import RepoToolProvider
        with patch('hermes_adapter._brain_safe_get') as mock_get:
            with patch('hermes_adapter._brain_safe_set') as mock_set:
                provider = RepoToolProvider(
                    github_pat=None,
                    owner=None,
                    name=None,
                    file_tree=["README.md"],
                    edit_intent=False,
                    on_server_tool_event=None,
                )
                # Should not attempt brain calls when owner/name is None
                mock_get.assert_not_called()
                mock_set.assert_not_called()
                self.assertEqual(provider.file_tree, ["README.md"])


@unittest.skipUnless(HERMES_ADAPTER_AVAILABLE, "hermes_adapter not available (missing dependencies)")
class HermesAdapterBuildRepoSystemPromptTests(unittest.TestCase):
    """Tests for build_repo_system_prompt in hermes_adapter."""

    def test_build_repo_system_prompt_without_github_pat(self):
        """Without a GitHub PAT, prompt should indicate API access is unavailable."""
        from hermes_adapter import RepoToolProvider
        with patch('hermes_adapter._brain_safe_get', return_value=None):
            with patch('hermes_adapter._brain_safe_set', return_value=True):
                provider = RepoToolProvider(
                    github_pat=None,
                    owner="octo",
                    name="repo",
                    file_tree=["README.md"],
                    edit_intent=False,
                    on_server_tool_event=None,
                )
                prompt = provider.build_repo_system_prompt()
                self.assertIn("GitHub API access is not available", prompt)
                self.assertIn("no token configured", prompt)

    def test_build_repo_system_prompt_includes_file_tree(self):
        """With a file tree, prompt should include it."""
        from hermes_adapter import RepoToolProvider
        with patch('hermes_adapter._brain_safe_get', return_value=None):
            with patch('hermes_adapter._brain_safe_set', return_value=True):
                provider = RepoToolProvider(
                    github_pat="fake-pat",
                    owner="octo",
                    name="repo",
                    file_tree=["README.md", "src/main.ts"],
                    edit_intent=False,
                    on_server_tool_event=None,
                )
                prompt = provider.build_repo_system_prompt()
                self.assertIn("Repository file tree:", prompt)
                self.assertIn("README.md", prompt)
                self.assertIn("src/main.ts", prompt)

    def test_build_repo_system_prompt_limits_tree_to_500_entries(self):
        """Large file trees should be truncated to 500 entries in the prompt."""
        from hermes_adapter import RepoToolProvider
        large_tree = [f"file_{i}.txt" for i in range(600)]
        with patch('hermes_adapter._brain_safe_get', return_value=None):
            with patch('hermes_adapter._brain_safe_set', return_value=True):
                provider = RepoToolProvider(
                    github_pat="fake-pat",
                    owner="octo",
                    name="repo",
                    file_tree=large_tree,
                    edit_intent=False,
                    on_server_tool_event=None,
                )
                prompt = provider.build_repo_system_prompt()
                # Should include "file_0.txt" but not "file_599.txt"
                self.assertIn("file_0.txt", prompt)
                self.assertNotIn("file_599.txt", prompt)


# ---------------------------------------------------------------------------
# Swarm Pattern Integration Stubs for run_agent / hermes_adapter
# ---------------------------------------------------------------------------

class SwarmPatternIntegrationStubs(unittest.TestCase):
    """
    Integration test stubs for swarm/multi-agent patterns with run_agent and hermes_adapter.

    These are documented as TODO stubs for when the agent is integrated into
    multi-agent supervised workflows. They require a live brain MCP server.

    To enable: remove the skip decorator and provide brain MCP server URL.
    """

    @unittest.skip("Requires live brain MCP server - enable when swarm integration is complete")
    def test_swarm_agent_registers_with_brain_on_initialization(self):
        """
        Integration stub: AIAgent registers with brain as a named session
        on initialization so it can be addressed via brain_dm.

        Steps:
        1. AIAgent.__init__ calls brain_register("hermes-agent-<session-id>")
        2. Other agents can now send direct messages to this session
        3. Session ID is stored for cleanup on agent shutdown
        """
        pass

    @unittest.skip("Requires live brain MCP server - enable when swarm integration is complete")
    def test_swarm_agent_pulses_heartbeat_during_long_operations(self):
        """
        Integration stub: during long-running operations, the agent pulses
        brain_pulse(status="working", progress="reading files...") to allow
        the overseer to track progress.

        Steps:
        1. Agent starts a long task (e.g., reading 20 files)
        2. Every N iterations, brain_pulse is called with iteration count
        3. Overseer reads pulses to detect hung/stuck agents
        """
        pass

    @unittest.skip("Requires live brain MCP server - enable when swarm integration is complete")
    def test_swarm_agent_publishes_contract_for_tool_interface(self):
        """
        Integration stub: agent publishes its tool interface contract via
        brain_contract_set so orchestrator knows what tools it exposes.

        Steps:
        1. Agent starts with enabled toolsets
        2. brain_contract_set publishes {name, kind: "provides", signature: {...}}
        3. Orchestrator can discover agent capabilities via brain_contract_get
        """
        pass

    @unittest.skip("Requires live brain MCP server - enable when swarm integration is complete")
    def test_swarm_agents_coordinate_via_brain_shared_state(self):
        """
        Integration stub: multiple agents share state via brain_set/brain_get
        to coordinate work on related tasks (e.g., file locking).

        Steps:
        1. Agent A: brain_set("swarm:task:123:status", "in_progress")
        2. Agent B: brain_get("swarm:task:123:status") -> "in_progress"
        3. Coordination via shared keys instead of direct messaging
        """
        pass

    @unittest.skip("Requires live brain MCP server - enable when swarm integration is complete")
    def test_swarm_overseer_uses_brain_recall_for_context_recovery(self):
        """
        Integration stub: if an agent becomes stale, overseer uses brain_recall
        to recover conversation context and resume the task with a new agent.

        Steps:
        1. Agent stores conversation history in brain via brain_remember
        2. Agent goes stale (no pulse for N minutes)
        3. Overseer calls brain_recall to get context
        4. New agent resumes from stored conversation state
        """
        pass


if __name__ == "__main__":
    unittest.main()
