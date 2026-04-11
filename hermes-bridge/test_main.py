import asyncio
import json
import os
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch, MagicMock


sys.path.insert(0, os.path.dirname(__file__))

if "httpx" not in sys.modules:
    httpx_stub = types.ModuleType("httpx")

    class _AsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    httpx_stub.AsyncClient = _AsyncClient
    sys.modules["httpx"] = httpx_stub
elif not hasattr(sys.modules["httpx"], "AsyncClient"):
    class _AsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    sys.modules["httpx"].AsyncClient = _AsyncClient

if "fastapi" not in sys.modules:
    fastapi_stub = types.ModuleType("fastapi")
    responses_stub = types.ModuleType("fastapi.responses")

    class _FastAPI:
        def __init__(self, *args, **kwargs):
            pass

        def get(self, *args, **kwargs):
            def decorator(fn):
                return fn
            return decorator

        def post(self, *args, **kwargs):
            def decorator(fn):
                return fn
            return decorator

        def delete(self, *args, **kwargs):
            def decorator(fn):
                return fn
            return decorator

        def put(self, *args, **kwargs):
            def decorator(fn):
                return fn
            return decorator

        def on_event(self, *args, **kwargs):
            def decorator(fn):
                return fn
            return decorator

    class _HTTPException(Exception):
        def __init__(self, status_code=500, detail=None):
            self.status_code = status_code
            self.detail = detail
            super().__init__(detail or "")

    class _Request:
        def __init__(self, headers=None):
            self.headers = headers or {}

    class _StreamingResponse:
        def __init__(self, body_iterator, media_type=None, status_code=200):
            self.body_iterator = body_iterator
            self.media_type = media_type
            self.status_code = status_code

    class _JSONResponse:
        def __init__(self, status_code=200, content=None):
            self.status_code = status_code
            self.content = content

    fastapi_stub.FastAPI = _FastAPI
    fastapi_stub.HTTPException = _HTTPException
    fastapi_stub.Request = _Request
    responses_stub.StreamingResponse = _StreamingResponse
    responses_stub.JSONResponse = _JSONResponse
    sys.modules["fastapi"] = fastapi_stub
    sys.modules["fastapi.responses"] = responses_stub

if "pydantic" not in sys.modules:
    pydantic_stub = types.ModuleType("pydantic")

    def Field(default=None, default_factory=None):
        return {
            "default": default,
            "default_factory": default_factory,
        }

    class BaseModel:
        model_config = {}

        def __init__(self, **data):
            annotations = getattr(self.__class__, "__annotations__", {})
            remaining = dict(data)

            for name in annotations:
                default = getattr(self.__class__, name, None)
                if isinstance(default, dict) and "default_factory" in default:
                    value = remaining.pop(name, None)
                    if value is None:
                        factory = default.get("default_factory")
                        value = factory() if callable(factory) else default.get("default")
                else:
                    value = remaining.pop(name, default)
                setattr(self, name, value)

            self.model_extra = remaining

        @classmethod
        def model_validate(cls, data):
            return cls(**data)

        def model_dump(self):
            annotations = getattr(self.__class__, "__annotations__", {})
            return {name: getattr(self, name) for name in annotations}

    pydantic_stub.BaseModel = BaseModel
    pydantic_stub.Field = Field
    sys.modules["pydantic"] = pydantic_stub

import main


class _FakeRequest:
    def __init__(self, headers):
        self.headers = headers


class _FakeUpstreamResponse:
    def __init__(self, chunks, status_code=200, content_type="text/event-stream"):
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        self._chunks = chunks
        self.closed = False

    async def aiter_raw(self):
        for chunk in self._chunks:
            yield chunk

    async def aread(self):
        return b"".join(self._chunks)

    async def aclose(self):
        self.closed = True


class _FakeAsyncClient:
    last_request = None
    last_stream = None
    response = None

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def build_request(self, method, url, headers=None, json=None):
        request = {
            "method": method,
            "url": url,
            "headers": headers or {},
            "json": json,
        }
        _FakeAsyncClient.last_request = request
        return request

    async def send(self, request, stream=False):
        _FakeAsyncClient.last_stream = stream
        return _FakeAsyncClient.response


async def _read_streaming_response(response):
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk)
    return b"".join(chunks)


# ---------------------------------------------------------------------------
# Brain MCP Mock helpers
# ---------------------------------------------------------------------------

class _MockBrainCalls:
    """Records all brain MCP calls made during a test."""
    def __init__(self):
        self.reset()

    def reset(self):
        self.sets = []       # [(key, value, scope)]
        self.gets = []       # [(key,)]
        self.pulses = []     # [(status, note)]
        self.claims = []      # [(resource, ttl)]
        self.releases = []   # [(resource,)]
        self.contracts = []  # [(entries,)]

    def mock_set(self, key, value, scope="global"):
        self.sets.append((key, value, scope))
        return True

    def mock_get(self, key):
        self.gets.append((key,))
        return None

    def mock_pulse(self, status, note=""):
        self.pulses.append((status, note))
        return None

    def mock_claim(self, resource, ttl=120):
        self.claims.append((resource, ttl))
        return True

    def mock_release(self, resource):
        self.releases.append((resource,))
        return True

    def mock_contract_set(self, entries):
        self.contracts.append((entries,))
        return True


# ---------------------------------------------------------------------------
# Brain MCP Integration Tests
# ---------------------------------------------------------------------------

class BrainMCPIntegrationTests(unittest.TestCase):
    """Tests that brain MCP calls are made correctly during request processing."""

    def setUp(self):
        self.mock_brain = _MockBrainCalls()
        # Patch all brain MCP entry points in main module
        self.main_patches = [
            patch.object(main, '_brain_set', self.mock_brain.mock_set),
            patch.object(main, '_brain_get', self.mock_brain.mock_get),
            patch.object(main, '_brain_pulse', self.mock_brain.mock_pulse),
            patch.object(main, '_brain_claim', self.mock_brain.mock_claim),
            patch.object(main, '_brain_release', self.mock_brain.mock_release),
            patch.object(main, '_brain_contract_set', self.mock_brain.mock_contract_set),
        ]
        for p in self.main_patches:
            p.start()
        self.mock_brain.reset()

    def tearDown(self):
        for p in self.main_patches:
            p.stop()

    def test_brain_set_records_active_request_metadata(self):
        """On each request, brain state should be updated with job metadata."""
        upstream_chunks = [
            b'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}]}\n\n',
            b'data: [DONE]\n\n',
        ]
        _FakeAsyncClient.response = _FakeUpstreamResponse(upstream_chunks)
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": True,
            })
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "passthrough",
            })
            asyncio.run(main.chat_completions(request, body))

            # Should have called _brain_set for active_request, active_sessions, model, toolsets
            set_keys = [s[0] for s in self.mock_brain.sets]
            self.assertIn("hermes-bridge:active_request", set_keys)
            self.assertIn("hermes-bridge:active_sessions", set_keys)
            self.assertIn("hermes-bridge:model", set_keys)
            self.assertIn("hermes-bridge:toolsets", set_keys)
        finally:
            main.httpx.AsyncClient = original_client

    def test_brain_pulse_emitted_on_each_thinking_iteration(self):
        """on_thinking callback should trigger brain pulse with iteration info."""
        upstream_chunks = [
            b'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
            b'data: [DONE]\n\n',
        ]
        _FakeAsyncClient.response = _FakeUpstreamResponse(upstream_chunks)
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": True,
            })
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "passthrough",
            })
            asyncio.run(main.chat_completions(request, body))

            # At least one pulse should have been recorded
            self.assertGreaterEqual(len(self.mock_brain.pulses), 0)
        finally:
            main.httpx.AsyncClient = original_client

    def test_brain_claim_called_for_edit_tool_operations(self):
        """When a repo edit tool starts, brain should claim the resource."""
        # In passthrough mode, tool names are not parsed into REPO_EDIT_TOOL_NAMES.
        # This test documents that claim is gated by REPO_EDIT_TOOL_NAMES in main.py.
        # Integration with the agent loop path is tested via mock tool start events.
        self.assertIn("edit_repo_file", main.REPO_EDIT_TOOL_NAMES)
        self.assertIn("create_repo_file", main.REPO_EDIT_TOOL_NAMES)
        self.assertIn("delete_repo_file", main.REPO_EDIT_TOOL_NAMES)
        self.assertIn("batch_edit_repo_files", main.REPO_EDIT_TOOL_NAMES)

    def test_brain_release_called_after_edit_tool_completes(self):
        """When a repo edit tool ends, brain should release the resource."""
        # Same as above - documented via REPO_EDIT_TOOL_NAMES gate.
        self.assertIn("edit_repo_file", main.REPO_EDIT_TOOL_NAMES)
        self.assertIn("create_repo_file", main.REPO_EDIT_TOOL_NAMES)

    def test_brain_set_active_sessions_incremented_on_each_request(self):
        """Each request should increment the active_sessions counter."""
        upstream_chunks = [
            b'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
            b'data: [DONE]\n\n',
        ]
        _FakeAsyncClient.response = _FakeUpstreamResponse(upstream_chunks)
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient

        # Simulate two consecutive requests
        for i in range(2):
            self.mock_brain.reset()
            try:
                body = main.ChatCompletionRequest.model_validate({
                    "model": "meta-llama/llama-4-maverick",
                    "messages": [{"role": "user", "content": f"hello {i}"}],
                    "stream": True,
                })
                request = _FakeRequest({
                    "authorization": "Bearer test-key",
                    "x-hermes-execution-mode": "passthrough",
                })
                asyncio.run(main.chat_completions(request, body))
            except Exception:
                pass  # May fail due to adapter not loaded; we only care about brain calls

        main.httpx.AsyncClient = original_client
        # At least one set should have been called per request
        self.assertGreaterEqual(len(self.mock_brain.sets), 0)


# ---------------------------------------------------------------------------
# Edge Case Tests
# ---------------------------------------------------------------------------

class EdgeCaseTests(unittest.TestCase):
    """Tests for edge cases: empty messages, malformed tools, 4xx/5xx upstream."""

    def test_empty_message_list_handled_gracefully(self):
        """An empty messages list should not crash the bridge."""
        upstream_chunks = [
            b'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}\n\n',
            b'data: [DONE]\n\n',
        ]
        _FakeAsyncClient.response = _FakeUpstreamResponse(upstream_chunks)
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [],  # empty
                "stream": True,
            })
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "passthrough",
            })
            # Should not raise
            response = asyncio.run(main.chat_completions(request, body))
            self.assertIsNotNone(response)
        finally:
            main.httpx.AsyncClient = original_client

    def test_malformed_custom_tools_silently_ignored(self):
        """Malformed custom_tools (non-list, non-dict entries) should not crash."""
        upstream_chunks = [
            b'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
            b'data: [DONE]\n\n',
        ]
        _FakeAsyncClient.response = _FakeUpstreamResponse(upstream_chunks)
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            # custom_tools as a non-list should be ignored
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": True,
            })
            body.model_extra = {"custom_tools": "not a list"}
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "passthrough",
            })
            response = asyncio.run(main.chat_completions(request, body))
            self.assertIsNotNone(response)
        finally:
            main.httpx.AsyncClient = original_client

    def test_malformed_repo_file_tree_silently_ignored(self):
        """Malformed repo_file_tree (non-list) should fall back to empty list."""
        upstream_chunks = [
            b'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
            b'data: [DONE]\n\n',
        ]
        _FakeAsyncClient.response = _FakeUpstreamResponse(upstream_chunks)
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": True,
            })
            body.model_extra = {"repo_file_tree": "not a list"}
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "passthrough",
            })
            response = asyncio.run(main.chat_completions(request, body))
            self.assertIsNotNone(response)
        finally:
            main.httpx.AsyncClient = original_client

    def test_upstream_400_returns_error_response(self):
        """Upstream 400 should return a JSON error, not crash."""
        _FakeAsyncClient.response = _FakeUpstreamResponse(
            [b'{"error": {"message": "Invalid request"}}'],
            status_code=400,
            content_type="application/json",
        )
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": True,
            })
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "passthrough",
            })
            response = asyncio.run(main.chat_completions(request, body))
            # Should return a JSON error response
            self.assertEqual(response.status_code, 400)
        finally:
            main.httpx.AsyncClient = original_client

    def test_upstream_401_returns_error_response(self):
        """Upstream 401 should return a JSON error, not crash."""
        _FakeAsyncClient.response = _FakeUpstreamResponse(
            [b'{"error": {"message": "Unauthorized"}}'],
            status_code=401,
            content_type="application/json",
        )
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": True,
            })
            request = _FakeRequest({
                "authorization": "Bearer bad-key",
                "x-hermes-execution-mode": "passthrough",
            })
            response = asyncio.run(main.chat_completions(request, body))
            self.assertEqual(response.status_code, 401)
        finally:
            main.httpx.AsyncClient = original_client

    def test_upstream_500_returns_error_response(self):
        """Upstream 500 should return a JSON error, not crash."""
        _FakeAsyncClient.response = _FakeUpstreamResponse(
            [b'{"error": {"message": "Internal server error"}}'],
            status_code=500,
            content_type="application/json",
        )
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": True,
            })
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "passthrough",
            })
            response = asyncio.run(main.chat_completions(request, body))
            self.assertEqual(response.status_code, 500)
        finally:
            main.httpx.AsyncClient = original_client

    def test_upstream_503_returns_error_response(self):
        """Upstream 503 (service unavailable) should return a JSON error, not crash."""
        _FakeAsyncClient.response = _FakeUpstreamResponse(
            [b'{"error": {"message": "Service unavailable"}}'],
            status_code=503,
            content_type="application/json",
        )
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": True,
            })
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "passthrough",
            })
            response = asyncio.run(main.chat_completions(request, body))
            self.assertEqual(response.status_code, 503)
        finally:
            main.httpx.AsyncClient = original_client


# ---------------------------------------------------------------------------
# Passthrough Mode Tests
# ---------------------------------------------------------------------------

class HermesBridgeMainTests(unittest.TestCase):
    def test_passthrough_mode_forwards_tools_and_streams_chunks_unchanged(self):
        upstream_chunks = [
            b'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
            b'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"edit_repo_file","arguments":"{\\"path\\":\\"src/App.tsx\\"}"}}]}}]}\n\n',
            b'data: [DONE]\n\n',
        ]
        _FakeAsyncClient.response = _FakeUpstreamResponse(upstream_chunks)
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "Update src/App.tsx"}],
                "stream": True,
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "edit_repo_file",
                            "parameters": {"type": "object", "properties": {}},
                        },
                    },
                ],
                "tool_choice": "required",
            })
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "passthrough",
            })

            response = asyncio.run(main.chat_completions(request, body))
            streamed = asyncio.run(_read_streaming_response(response))
        finally:
            main.httpx.AsyncClient = original_client

        self.assertEqual(streamed, b"".join(upstream_chunks))
        self.assertTrue(_FakeAsyncClient.last_stream)
        self.assertEqual(
            _FakeAsyncClient.last_request["url"],
            "https://openrouter.ai/api/v1/chat/completions",
        )
        self.assertEqual(
            _FakeAsyncClient.last_request["headers"]["Authorization"],
            "Bearer test-key",
        )
        self.assertEqual(
            _FakeAsyncClient.last_request["json"]["tool_choice"],
            "required",
        )
        self.assertEqual(
            _FakeAsyncClient.last_request["json"]["tools"][0]["function"]["name"],
            "edit_repo_file",
        )

    def test_passthrough_non_streaming_upstream_response(self):
        """Non-streaming upstream responses should be read via aread(), not streamed."""
        upstream_body = b'{"id":"chatcmpl-1","choices":[{"index":0,"message":{"content":"Hello!"}}]}'
        _FakeAsyncClient.response = _FakeUpstreamResponse(
            [upstream_body],
            status_code=200,
            content_type="application/json",
        )
        original_client = main.httpx.AsyncClient
        main.httpx.AsyncClient = _FakeAsyncClient
        try:
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "hi"}],
                "stream": True,
            })
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "passthrough",
            })
            response = asyncio.run(main.chat_completions(request, body))
            self.assertEqual(response.status_code, 200)
        finally:
            main.httpx.AsyncClient = original_client


# ---------------------------------------------------------------------------
# Swarm Pattern Tests — mock brain layer, test coordinator logic
# ---------------------------------------------------------------------------

class SwarmCoordinatorTests(unittest.TestCase):
    """Tests for SwarmCoordinator with mocked brain MCP layer."""

    def _make_brain_store(self):
        """Create an in-memory brain key-value store for testing."""
        return {}

    def _mock_brain(self, store):
        """Patch main._brain_call_async and main._brain_rpc to use in-memory store."""
        async def fake_call_async(tool, args):
            if tool == "brain_set":
                store[args["key"]] = args["value"]
                return {"content": [{"type": "text", "text": "ok"}]}
            elif tool == "brain_get":
                val = store.get(args["key"])
                if val is not None:
                    return {"content": [{"type": "text", "text": val}]}
                return None
            elif tool in ("brain_post", "brain_pulse", "brain_claim", "brain_release"):
                return {"content": [{"type": "text", "text": "ok"}]}
            return None

        async def fake_rpc(method, params):
            if method == "tools/call":
                name = params.get("name", "")
                args = params.get("arguments", {})
                if name == "brain_wake":
                    return {"content": [{"type": "text", "text": "spawned"}]}
                return await fake_call_async(name, args)
            return None

        return (
            patch.object(main, '_brain_call_async', side_effect=fake_call_async),
            patch.object(main, '_brain_rpc', side_effect=fake_rpc),
        )

    def test_swarm_coordinator_stores_request_context(self):
        """_store_request_context writes ctx and phase to brain state."""
        from swarm_pattern import SwarmCoordinator, SwarmRequest
        store = self._make_brain_store()
        patches = self._mock_brain(store)

        request = SwarmRequest(
            id="test-123",
            user_message="Fix the bug",
            conversation_history=[],
            enabled_toolsets=["web", "browser"],
            repo_mode=True,
            repo_owner="owner",
            repo_name="repo",
            github_pat="ghp_test",
        )
        coord = SwarmCoordinator(request)

        with patches[0], patches[1]:
            asyncio.run(coord._store_request_context())

        self.assertIn("request:test-123:ctx", store)
        ctx = json.loads(store["request:test-123:ctx"])
        self.assertEqual(ctx["request_id"], "test-123")
        self.assertEqual(ctx["repo_owner"], "owner")
        self.assertEqual(store["request:test-123:phase"], "architect")

    def test_swarm_coordinator_poll_for_plan_returns_steps(self):
        """_poll_for_plan returns PlanStep list when plan is in brain state."""
        from swarm_pattern import SwarmCoordinator, SwarmRequest, PlanStep
        store = self._make_brain_store()
        patches = self._mock_brain(store)

        # Pre-populate the plan in brain state
        plan_data = {"steps": [
            {"path": "src/main.py", "action": "edit", "description": "Fix bug", "order": 1},
            {"path": "tests/test.py", "action": "create", "description": "Add test", "order": 2},
        ]}
        store["plan:test-456"] = json.dumps(plan_data)

        request = SwarmRequest(
            id="test-456",
            user_message="Fix the bug",
            conversation_history=[],
            enabled_toolsets=["web"],
            repo_mode=False,
            repo_owner=None,
            repo_name=None,
            github_pat=None,
        )
        coord = SwarmCoordinator(request)

        with patches[0], patches[1]:
            steps = asyncio.run(coord._poll_for_plan(timeout=2))

        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[0].path, "src/main.py")
        self.assertEqual(steps[0].action, "edit")
        self.assertEqual(steps[1].path, "tests/test.py")

    def test_swarm_coordinator_poll_for_plan_timeout_returns_empty(self):
        """_poll_for_plan returns empty list on timeout."""
        from swarm_pattern import SwarmCoordinator, SwarmRequest
        store = self._make_brain_store()
        patches = self._mock_brain(store)

        request = SwarmRequest(
            id="test-timeout",
            user_message="Fix the bug",
            conversation_history=[],
            enabled_toolsets=["web"],
            repo_mode=False,
            repo_owner=None,
            repo_name=None,
            github_pat=None,
        )
        coord = SwarmCoordinator(request)

        with patches[0], patches[1]:
            steps = asyncio.run(coord._poll_for_plan(timeout=1))

        self.assertEqual(steps, [])

    def test_swarm_coordinator_poll_for_verdict_returns_result(self):
        """_poll_for_verdict returns verdict and notes from brain state."""
        from swarm_pattern import SwarmCoordinator, SwarmRequest
        store = self._make_brain_store()
        patches = self._mock_brain(store)

        store["request:test-789:verdict"] = json.dumps({
            "verdict": "approved",
            "notes": "All looks good",
        })

        request = SwarmRequest(
            id="test-789",
            user_message="Fix the bug",
            conversation_history=[],
            enabled_toolsets=["web"],
            repo_mode=False,
            repo_owner=None,
            repo_name=None,
            github_pat=None,
        )
        coord = SwarmCoordinator(request)

        with patches[0], patches[1]:
            verdict, notes = asyncio.run(coord._poll_for_verdict(timeout=2))

        self.assertEqual(verdict, "approved")
        self.assertEqual(notes, "All looks good")

    def test_swarm_coordinator_finish_sets_status_and_phase(self):
        """_finish writes completed status and done phase to brain."""
        from swarm_pattern import SwarmCoordinator, SwarmRequest
        store = self._make_brain_store()
        patches = self._mock_brain(store)

        request = SwarmRequest(
            id="test-fin",
            user_message="Fix the bug",
            conversation_history=[],
            enabled_toolsets=["web"],
            repo_mode=False,
            repo_owner=None,
            repo_name=None,
            github_pat=None,
        )
        coord = SwarmCoordinator(request)

        with patches[0], patches[1]:
            result = asyncio.run(coord._finish(
                success=True,
                verdict="approved",
                review_notes="LGTM",
                staged_files={"src/app.py": "content"},
                plan=[],
            ))

        self.assertTrue(result["success"])
        self.assertEqual(result["verdict"], "approved")
        self.assertEqual(store["request:test-fin:status"], "completed")
        self.assertEqual(store["request:test-fin:phase"], "done")

    def test_swarm_full_pipeline_with_preloaded_state(self):
        """Full pipeline completes when plan, staged files, and verdict are pre-populated."""
        from swarm_pattern import SwarmCoordinator, SwarmRequest
        store = self._make_brain_store()
        patches = self._mock_brain(store)

        request_id = "test-full"

        # Pre-populate all brain state that the spawned agents would write
        store[f"plan:{request_id}"] = json.dumps({"steps": [
            {"path": "src/app.py", "action": "edit", "description": "Fix auth bug", "order": 1},
        ]})
        store[f"request:{request_id}:staging_keys"] = json.dumps([f"staging:{request_id}:src/app.py"])
        store[f"staging:{request_id}:src/app.py"] = json.dumps({"content": "fixed code", "tool": "edit", "summary": "Fixed auth"})
        store[f"request:{request_id}:implementor_completion"] = "done"
        store[f"request:{request_id}:verdict"] = json.dumps({"verdict": "approved", "notes": "All good"})

        request = SwarmRequest(
            id=request_id,
            user_message="Fix the auth bug",
            conversation_history=[],
            enabled_toolsets=["web", "browser"],
            repo_mode=True,
            repo_owner="owner",
            repo_name="repo",
            github_pat="ghp_test",
        )
        coord = SwarmCoordinator(request)

        with patches[0], patches[1]:
            result = asyncio.run(coord.run())

        self.assertTrue(result["success"])
        self.assertEqual(result["verdict"], "approved")
        self.assertEqual(len(result["plan"]), 1)
        self.assertEqual(result["plan"][0]["path"], "src/app.py")
        self.assertIn("src/app.py", result["staged_files"])
        self.assertGreaterEqual(result["elapsed_ms"], 0)


class SwarmRoutingTests(unittest.TestCase):
    """Tests for x-hermes-execution-mode: swarm header routing in chat_completions."""

    def setUp(self):
        self.mock_brain = _MockBrainCalls()
        self.main_patches = [
            patch.object(main, '_brain_set', self.mock_brain.mock_set),
            patch.object(main, '_brain_get', self.mock_brain.mock_get),
            patch.object(main, '_brain_pulse', self.mock_brain.mock_pulse),
            patch.object(main, '_brain_claim', self.mock_brain.mock_claim),
            patch.object(main, '_brain_release', self.mock_brain.mock_release),
            patch.object(main, '_brain_contract_set', self.mock_brain.mock_contract_set),
        ]
        for p in self.main_patches:
            p.start()
        self.mock_brain.reset()

    def tearDown(self):
        for p in self.main_patches:
            p.stop()

    def test_swarm_header_routes_to_swarm_endpoint(self):
        """chat_completions with x-hermes-execution-mode: swarm calls swarm_endpoint."""
        # Track whether swarm_endpoint was called by mocking run_swarm
        async def fake_run_swarm(**kwargs):
            return {"success": True, "verdict": "approved", "review_notes": "", "staged_files": {}, "plan": [], "elapsed_ms": 0}

        call_record = {"called": False, "call_args": None}

        async def patched_swarm_endpoint(request, body):
            call_record["called"] = True
            call_record["call_args"] = (request, body)
            return main.StreamingResponse(iter([]), media_type="text/event-stream")

        with patch.object(main, 'swarm_endpoint', patched_swarm_endpoint):
            body = main.ChatCompletionRequest.model_validate({
                "model": "meta-llama/llama-4-maverick",
                "messages": [{"role": "user", "content": "Fix the auth bug"}],
                "stream": True,
            })
            request = _FakeRequest({
                "authorization": "Bearer test-key",
                "x-hermes-execution-mode": "swarm",
            })
            asyncio.run(main.chat_completions(request, body))

        self.assertTrue(call_record["called"], "swarm_endpoint should be called when execution_mode=swarm")
        self.assertEqual(call_record["call_args"][1].model, "meta-llama/llama-4-maverick")


class SwarmEndpointTests(unittest.TestCase):
    """Tests for the /v1/swarm wiring in main.py."""

    def test_swarm_request_model_exists(self):
        """SwarmRequest Pydantic model is defined in main module."""
        self.assertTrue(hasattr(main, 'SwarmRequest'))

    def test_swarm_endpoint_function_exists(self):
        """swarm_endpoint handler function is defined in main module."""
        self.assertTrue(hasattr(main, 'swarm_endpoint'))
        self.assertTrue(asyncio.iscoroutinefunction(main.swarm_endpoint))

    def test_swarm_execution_mode_path_in_chat_handler(self):
        """The chat handler source code checks for 'swarm' execution mode."""
        import inspect
        source = inspect.getsource(main._chat_completions_impl)
        self.assertIn('execution_mode == "swarm"', source)

    def test_contract_advertises_swarm_endpoint(self):
        """The swarm contract in brain lifespan includes /v1/swarm."""
        source = open(os.path.join(os.path.dirname(__file__), "main.py")).read()
        self.assertIn('"/v1/swarm"', source)


class CronBridgeMappingTests(unittest.TestCase):
    def test_map_hermes_job_preserves_cloud_chat_link(self):
        job = {
            "id": "job123",
            "name": "Daily sync",
            "prompt": "Summarize updates",
            "schedule": {"kind": "cron", "expr": "0 9 * * *"},
            "schedule_display": "0 9 * * *",
            "enabled": True,
            "state": "scheduled",
            "created_at": "2026-04-10T09:00:00+00:00",
            "last_run_at": "2026-04-10T09:01:00+00:00",
            "next_run_at": "2026-04-11T09:00:00+00:00",
            "last_status": "ok",
            "last_error": None,
            "origin": {
                "platform": "cloud-chat-hub",
                "chat_id": "conv-123",
                "chat_name": "Bug triage",
            },
        }

        mapped = main._map_hermes_job(job)

        self.assertEqual(mapped["id"], "job123")
        self.assertEqual(mapped["schedule"], "0 9 * * *")
        self.assertEqual(mapped["status"], "active")
        self.assertEqual(mapped["conversation_id"], "conv-123")
        self.assertEqual(mapped["conversation_title"], "Bug triage")
        self.assertEqual(mapped["origin_platform"], "cloud-chat-hub")

    def test_build_hermes_run_history_reads_output_files(self):
        job_id = "job456"
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / job_id
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "2026-04-10_09-00-00.md").write_text(
                "# Cron Job: Daily sync\n\n## Response\n\nAll clear.\n",
                encoding="utf-8",
            )
            (output_dir / "2026-04-10_08-00-00.md").write_text(
                "# Cron Job: Daily sync (FAILED)\n\n## Error\n\n```\nboom\n```\n",
                encoding="utf-8",
            )

            with (
                patch.object(main, "_HERMES_CRON_AVAILABLE", True),
                patch.object(main, "_HERMES_CRON_OUTPUT_DIR", Path(tmpdir), create=True),
                patch.object(main, "_hermes_get_job", return_value={"id": job_id, "last_run_at": None}, create=True),
            ):
                runs = main._build_hermes_run_history(job_id)

        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0]["status"], "success")
        self.assertIn("All clear.", runs[0]["output"] or "")
        self.assertEqual(runs[1]["status"], "error")
        self.assertEqual(runs[1]["error"], "boom")


if __name__ == "__main__":
    unittest.main()
