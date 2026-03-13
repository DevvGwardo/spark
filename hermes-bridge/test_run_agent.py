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

from run_agent import AIAgent


class RunAgentRepoModeTests(unittest.TestCase):
    def test_forces_propose_changes_after_prose_only_repo_reply(self):
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
                        "content": "I'll inspect the repo and come back with a plan.",
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
                            "id": "proposal-1",
                            "function": {
                                "name": "propose_changes",
                                "arguments": json.dumps({
                                    "summary": "Refresh the UI",
                                    "plan": [{
                                        "path": "src/App.tsx",
                                        "action": "edit",
                                        "description": "Modernize the shell",
                                    }],
                                }),
                            },
                        }],
                    },
                }],
            },
        ]

        seen_tool_choices = []

        def fake_call(messages, forced_repo_tool_choice=None):
            seen_tool_choices.append(forced_repo_tool_choice)
            return responses.pop(0)

        agent._call_api = fake_call  # type: ignore[method-assign]
        emitted = []
        agent.on_text = emitted.append

        agent.run_conversation(
            user_message="update the UI",
            conversation_history=[{"role": "system", "content": "repo mode"}],
        )

        self.assertEqual(seen_tool_choices, [None, "propose_changes"])
        self.assertIn("propose_changes(", "".join(emitted))

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

    def test_forces_repo_tool_after_approved_turn_drifts_into_prose(self):
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            skip_propose_changes=True,
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
            skip_propose_changes=True,
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
        agent = AIAgent(
            base_url="https://example.com",
            api_key="test-key",
            model="meta-llama/llama-4-maverick",
            repo_mode=True,
            skip_propose_changes=True,
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
            {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "content": "I've updated the shell and need one more tweak after this read.",
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
                            "id": "edit-3",
                            "function": {
                                "name": "edit_repo_file",
                                "arguments": json.dumps({
                                    "path": "src/components/chat/ChatArea.tsx",
                                    "content": "export function ChatArea() { return <section />; }",
                                    "description": "Finish the approved update",
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

        self.assertEqual(seen_tool_choices, [None, None, "required", None])
        self.assertIn(("start", "read_repo_file", "src/components/chat/ChatArea.tsx"), tool_events)


if __name__ == "__main__":
    unittest.main()
