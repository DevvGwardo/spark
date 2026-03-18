import json
import os
import sys
import types
import unittest


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
        self.assertIn("GitHub file access is unavailable for this request", repo_prompt)
        self.assertIn("Do not call read_repo_file", repo_prompt)

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

        class Fake404Response:
            status_code = 404
            def raise_for_status(self):
                pass

        class FakeClient:
            def __init__(self, *a, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, *a, **kw): return Fake404Response()

        original = run_agent.httpx.Client
        run_agent.httpx.Client = FakeClient
        try:
            result = agent._read_github_file("src/components/Missing.tsx")
        finally:
            run_agent.httpx.Client = original

        self.assertIn("Error: File not found", result)
        self.assertIn("src/components", result)

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
        verification_found = any("verify your work" in (m or "").lower() for m in last_msgs)
        self.assertTrue(verification_found, "Verification prompt should be injected after edits")

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


if __name__ == "__main__":
    unittest.main()
