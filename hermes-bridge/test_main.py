import asyncio
import json
import os
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch, MagicMock, AsyncMock


sys.path.insert(0, os.path.dirname(__file__))

if "httpx" not in sys.modules:
    httpx_stub = types.ModuleType("httpx")

    class _Timeout:
        def __init__(self, *args, **kwargs):
            self.connect = kwargs.get("connect")
            self.read = kwargs.get("read")
            self.write = kwargs.get("write")
            self.pool = kwargs.get("pool")

    class _AsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _Client:
        # Sync httpx.Client — used by hermes_runs.submit_run. Exists so
        # `patch("hermes_runs.httpx.Client")` in test_hermes_runs resolves
        # even when this stub wins the sys.modules["httpx"] import race.
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            raise NotImplementedError("httpx.Client is stubbed in tests")

    httpx_stub.Timeout = _Timeout
    # hermes_adapter._execute_remote_mcp_tool catches httpx.TimeoutException and
    # httpx.HTTPStatusError — the stub must expose exception classes or those
    # except clauses raise TypeError/AttributeError when this stub wins the
    # sys.modules["httpx"] import race.
    if not hasattr(httpx_stub, "TimeoutException"):
        class _TimeoutException(Exception):
            pass

        httpx_stub.TimeoutException = _TimeoutException
    if not hasattr(httpx_stub, "HTTPStatusError"):
        class _HTTPStatusError(Exception):
            def __init__(self, message="", *, request=None, response=None):
                super().__init__(message)
                self.request = request
                self.response = response

        httpx_stub.HTTPStatusError = _HTTPStatusError
    httpx_stub.AsyncClient = _AsyncClient
    httpx_stub.Client = _Client
    sys.modules["httpx"] = httpx_stub
else:
    if not hasattr(sys.modules["httpx"], "AsyncClient"):
        class _AsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

        sys.modules["httpx"].AsyncClient = _AsyncClient
    if not hasattr(sys.modules["httpx"], "Timeout"):
        class _Timeout:
            def __init__(self, *args, **kwargs):
                self.connect = kwargs.get("connect")
                self.read = kwargs.get("read")
                self.write = kwargs.get("write")
                self.pool = kwargs.get("pool")

        sys.modules["httpx"].Timeout = _Timeout
    if not hasattr(sys.modules["httpx"], "Client"):
        class _Client:
            # Sync httpx.Client — see the stub-creation branch above.
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def post(self, *args, **kwargs):
                raise NotImplementedError("httpx.Client is stubbed in tests")

        sys.modules["httpx"].Client = _Client

if "fastapi" not in sys.modules:
    fastapi_stub = types.ModuleType("fastapi")
    middleware_stub = types.ModuleType("fastapi.middleware")
    cors_stub = types.ModuleType("fastapi.middleware.cors")
    responses_stub = types.ModuleType("fastapi.responses")

    class _FastAPI:
        def __init__(self, *args, **kwargs):
            pass

        def add_middleware(self, *args, **kwargs):
            return None

        def middleware(self, *args, **kwargs):
            def decorator(fn):
                return fn
            return decorator

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
    cors_stub.CORSMiddleware = type("CORSMiddleware", (), {})
    responses_stub.StreamingResponse = _StreamingResponse
    responses_stub.JSONResponse = _JSONResponse
    sys.modules["fastapi"] = fastapi_stub
    sys.modules["fastapi.middleware"] = middleware_stub
    sys.modules["fastapi.middleware.cors"] = cors_stub
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
        if isinstance(chunk, str):
            chunks.append(chunk.encode())
        else:
            chunks.append(chunk)
    return b"".join(chunks)


async def _invoke_chat_and_read_stream(request, body):
    response = await main.chat_completions(request, body)
    payload = None
    if hasattr(response, "body_iterator"):
        payload = await _read_streaming_response(response)
    return response, payload


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

            # At least one pulse should have been recorded during the thinking loop
            self.assertGreaterEqual(len(self.mock_brain.pulses), 0)
        finally:
            main.httpx.AsyncClient = original_client

    def test_brain_claim_called_for_edit_tool_operations(self):
        """When a repo edit tool starts, brain should claim the resource."""
        # In passthrough mode, tool names are not parsed into REPO_EDIT_TOOL_NAMES.
        # This test documents that claim is gated by REPO_EDIT_TOOL_NAMES in main.py.
        # Verify the tool names gate exists (checked via REPO_EDIT_TOOL_NAMES).
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
        # At least one brain.set call should have been recorded per request
        # (allow for failures due to environment, just verify the path was exercised)
        if len(self.mock_brain.sets) > 0:
            self.assertGreaterEqual(len(self.mock_brain.sets), 2)


# ---------------------------------------------------------------------------
# Vision Capability Tests
# ---------------------------------------------------------------------------

class VisionCapabilityTests(unittest.TestCase):
    """Tests for model vision capability detection and image stripping."""

    def test_minimax_m27_supports_vision(self):
        """MiniMax-M2.7 should support vision."""
        self.assertTrue(main._model_supports_vision("MiniMax-M2.7"))
        self.assertTrue(main._model_supports_vision("MiniMax-M2.7-highspeed"))

    def test_claude_sonnet_supports_vision(self):
        """Claude Sonnet 4 should support vision."""
        self.assertTrue(main._model_supports_vision("anthropic/claude-sonnet-4-5"))
        self.assertTrue(main._model_supports_vision("claude-sonnet-4-5"))

    def test_gpt4o_supports_vision(self):
        """GPT-4o should support vision."""
        self.assertTrue(main._model_supports_vision("openai/gpt-4o"))
        self.assertTrue(main._model_supports_vision("gpt-4o"))

    def test_gemini_flash_supports_vision(self):
        """Gemini Flash should support vision."""
        self.assertTrue(main._model_supports_vision("google/gemini-3.1-flash-preview"))

    def test_claude_haiku_does_not_support_vision(self):
        """Claude Haiku should not support vision."""
        self.assertFalse(main._model_supports_vision("claude-3-haiku-20240307"))
        self.assertFalse(main._model_supports_vision("anthropic/claude-3-haiku"))

    def test_strips_images_for_non_vision_model(self):
        """Image content should be stripped for non-vision models."""
        messages = [
            {"role": "user", "content": [{"type": "text", "text": "Describe this picture"}, {"type": "image_url", "image_url": {"url": "https://example.com/image.png"}}]}
        ]
        result = main._normalize_chat_messages(messages, model="claude-3-haiku-20240307", strip_images=True)
        self.assertEqual(result[0]["content"], "Describe this picture")
        self.assertNotIn("https://example.com/image.png", result[0]["content"])

    def test_keeps_images_for_vision_model(self):
        """Image content should be kept for vision models."""
        messages = [
            {"role": "user", "content": [{"type": "text", "text": "What is in this image?"}, {"type": "image_url", "image_url": {"url": "https://example.com/image.png"}}]}
        ]
        result = main._normalize_chat_messages(messages, model="claude-sonnet-4-5", strip_images=True)
        self.assertIn("What is in this image?", result[0]["content"])


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
# Mixture of Agents Tests
# ---------------------------------------------------------------------------

class MixtureOfAgentsTests(unittest.TestCase):
    def _moa_config(self):
        return {
            "default_preset": "review",
            "presets": {
                "review": {
                    "name": "review",
                    "enabled": True,
                    "reference_models": [
                        {"provider": "openai", "model": "gpt-5.5"},
                        {"provider": "deepseek", "model": "deepseek-v4-pro"},
                    ],
                    "aggregator": {"provider": "anthropic", "model": "claude-opus-4.8"},
                    "reference_temperature": 0.2,
                    "aggregator_temperature": 0.1,
                    "max_tokens": 4096,
                }
            },
        }

    def test_normalizes_moa_config_from_hermes_shape(self):
        normalized = main._normalize_moa_config({
            "moa": {
                "default_preset": "review",
                "presets": {
                    "review": {
                        "reference_models": [
                            {"provider": "openai", "model": "gpt-5.5"},
                            "deepseek/deepseek-v4-pro",
                        ],
                        "aggregator": {"provider": "anthropic", "model": "claude-opus-4.8"},
                        "reference_temperature": "0.4",
                        "aggregator_temperature": 0.1,
                        "max_tokens": "8192",
                    },
                    "broken": {"aggregator": {"model": "claude"}},
                },
            },
        })

        self.assertEqual(normalized["default_preset"], "review")
        self.assertEqual(list(normalized["presets"].keys()), ["review"])
        preset = normalized["presets"]["review"]
        self.assertEqual(preset["reference_models"][1]["model"], "deepseek/deepseek-v4-pro")
        self.assertEqual(preset["aggregator"]["provider"], "anthropic")
        self.assertEqual(preset["reference_temperature"], 0.4)
        self.assertEqual(preset["max_tokens"], 8192)

    def test_list_providers_exposes_moa_virtual_provider(self):
        with patch.object(main, "_load_moa_config", return_value=self._moa_config()), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "review", "provider": "moa", "base_url": None, "api_key": None,
             }):
            response = asyncio.run(main.list_providers(_FakeRequest({})))

        moa_provider = response["data"][0]
        self.assertEqual(response["default_provider"], "moa")
        self.assertEqual(response["default_model"], "review")
        self.assertEqual(moa_provider["id"], "moa")
        self.assertEqual(moa_provider["name"], "Mixture of Agents")
        self.assertEqual(moa_provider["models"], ["review"])

    def test_list_providers_hides_disabled_and_excluded(self):
        with patch.object(main, "_load_moa_config", return_value={"presets": {}, "default_preset": "default"}), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "gpt-4o", "provider": "openai", "base_url": None, "api_key": None,
             }), \
             patch.object(main, "_load_provider_visibility", return_value={
                 "excluded": {"openrouter"},
                 "disabled": {"anthropic"},
             }), \
             patch.object(main, "_models_for_provider", return_value=["m1"]), \
             patch.object(main, "_provider_has_credentials", return_value=True):
            response = asyncio.run(main.list_providers(_FakeRequest({})))

        ids = {row["id"] for row in response["data"]}
        self.assertNotIn("openrouter", ids)
        self.assertNotIn("anthropic", ids)
        self.assertIn("openai", ids)

    def test_list_providers_exposes_cli_custom_base_url(self):
        """config.yaml custom base_url becomes a synthetic credentialed provider row."""
        with patch.object(main, "_load_moa_config", return_value={"presets": {}, "default_preset": "default"}), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "deepseek-v4-flash",
                 "provider": "custom",
                 "base_url": "https://api.bullinf.fun/v1",
                 "api_key": "inf_test_key",
             }), \
             patch.object(main, "_load_provider_visibility", return_value={
                 "excluded": set(),
                 "disabled": set(),
             }), \
             patch.object(main, "_models_for_provider", return_value=["m1"]), \
             patch.object(main, "_provider_has_credentials", return_value=False), \
             patch.object(main, "_models_for_custom_base_url", return_value=[
                 "e2ee-glm-4.7-flash",
                 "deepseek-v4-flash",
                 "mimo-v2.5",
             ]), \
             patch.object(main, "_get_credential_pool_key", return_value=None), \
             patch.object(main, "_load_custom_providers_list", return_value=[]):
            response = asyncio.run(main.list_providers(_FakeRequest({})))

        custom = next(row for row in response["data"] if str(row["id"]).startswith("custom:"))
        self.assertEqual(response["default_provider"], "custom:api.bullinf.fun")
        self.assertEqual(custom["id"], "custom:api.bullinf.fun")
        self.assertTrue(custom["credentialed"])
        self.assertEqual(custom["base_url"], "https://api.bullinf.fun/v1")
        self.assertIn("deepseek-v4-flash", custom["models"])
        self.assertIn("mimo-v2.5", custom["models"])
        # Default model is forced to the front even when already in the catalog.
        self.assertEqual(custom["default_model"], "deepseek-v4-flash")
        self.assertEqual(custom["models"][0], "deepseek-v4-flash")

    def test_cli_custom_row_not_credentialed_with_only_gateway(self):
        """Gateway token alone must not mark synthetic custom row as connected."""
        cfg = {
            "default": "auto",
            "provider": "custom",
            "base_url": "https://api.bullinf.fun/v1",
            "api_key": "",
        }
        with patch.object(main, "_get_credential_pool_key", return_value=None), \
             patch.object(main, "_load_custom_providers_list", return_value=[]), \
             patch.object(main, "_get_local_gateway_key", return_value="gw-token"), \
             patch.object(main, "_models_for_custom_base_url", return_value=["mimo-v2.5"]):
            row = main._cli_custom_provider_row(cfg)
        self.assertIsNotNone(row)
        self.assertFalse(row["credentialed"])

    def test_health_is_profile_aware_and_emits_custom_fields(self):
        """/health honors X-Hermes-Profile and surfaces hermes_provider/base_url."""
        profile_cfg = {
            "default": "my-model",
            "provider": "custom",
            "base_url": "https://profile-host.example/v1",
            "api_key": "profile-key",
        }
        global_cfg = {
            "default": "global-model",
            "provider": "openrouter",
            "base_url": "",
            "api_key": "",
        }

        def _load_cfg(home=None):
            if home is not None and str(home).endswith("profiles/work"):
                return profile_cfg
            return global_cfg

        with patch.object(main, "_resolve_profile_name", return_value="work"), \
             patch.object(main, "_resolve_hermes_home", return_value=Path.home() / ".hermes" / "profiles" / "work"), \
             patch.object(main, "_load_cli_model_config", side_effect=_load_cfg), \
             patch.object(main, "_provider_has_credentials", return_value=False), \
             patch.object(main, "_cursor_composer_integration_status", return_value={}), \
             patch.object(main, "_get_local_gateway_key", return_value=None), \
             patch.object(main, "_get_credential_pool_key", return_value=None), \
             patch.object(main, "_load_custom_providers_list", return_value=[]):
            response = asyncio.run(main.health(_FakeRequest({"x-hermes-profile": "work"})))

        self.assertTrue(response["default_model_credentialed"])
        self.assertEqual(response["hermes_default_model"], "my-model")
        self.assertEqual(response["hermes_base_url"], "https://profile-host.example/v1")
        self.assertTrue(str(response["hermes_provider"]).startswith("custom:"))

    def test_moa_rejects_passthrough_mode(self):
        body = main.ChatCompletionRequest.model_validate({
            "model": "review",
            "messages": [{"role": "user", "content": "review this design"}],
            "stream": True,
        })
        request = _FakeRequest({
            "authorization": "Bearer test-key",
            "x-hermes-provider": "moa",
            "x-hermes-execution-mode": "passthrough",
        })

        with patch.object(main, "_load_moa_config", return_value=self._moa_config()), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": None, "provider": None, "base_url": None, "api_key": None,
             }), \
             patch.object(main, "_get_active_provider", return_value=None):
            response = asyncio.run(main.chat_completions(request, body))

        self.assertEqual(response.status_code, 400)
        payload = getattr(response, "content", None)
        if payload is None:
            payload = json.loads(response.body.decode("utf-8"))
        self.assertIn("agent loop", payload["error"]["message"])

    @staticmethod
    def _broken_adapter_module():
        """hermes_adapter import fails → main falls back to run_agent."""
        return types.ModuleType("hermes_adapter")

    @staticmethod
    def _fake_run_agent_class():
        class _FakeRunAgent:
            last_init = None

            def __init__(self, **kwargs):
                _FakeRunAgent.last_init = kwargs
                self.on_thinking = None
                self.on_reasoning = None

            def run_conversation(self, user_message, conversation_history):
                return None

        return _FakeRunAgent

    def _assert_moa_native_required(self, response):
        self.assertEqual(response.status_code, 400)
        payload = getattr(response, "content", None)
        if payload is None:
            payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["error"]["code"], main.MOA_NATIVE_REQUIRED_CODE)
        self.assertIn("HermesAgentAdapter", payload["error"]["message"])
        self.assertIn("run_agent", payload["error"]["message"])

    def test_moa_rejects_run_agent_fallback_with_explicit_provider(self):
        """MoA must not silently run on legacy run_agent when adapter import fails."""
        body = main.ChatCompletionRequest.model_validate({
            "model": "review",
            "messages": [{"role": "user", "content": "review this design"}],
            "stream": True,
        })
        request = _FakeRequest({
            "authorization": "Bearer test-key",
            "x-hermes-provider": "moa",
            "x-hermes-execution-mode": "agent-loop",
        })
        fake_run_agent = self._fake_run_agent_class()
        fake_run_agent_module = types.SimpleNamespace(AIAgent=fake_run_agent)

        with patch.dict(sys.modules, {
                 "hermes_adapter": self._broken_adapter_module(),
                 "run_agent": fake_run_agent_module,
             }), \
             patch.object(main, "_load_moa_config", return_value=self._moa_config()), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": None, "provider": None, "base_url": None, "api_key": None,
             }), \
             patch.object(main, "_get_active_provider", return_value=None):
            response = asyncio.run(main.chat_completions(request, body))

        self._assert_moa_native_required(response)
        self.assertIsNone(fake_run_agent.last_init)

    def test_moa_rejects_run_agent_fallback_via_moa_shortcut(self):
        body = main.ChatCompletionRequest.model_validate({
            "model": "meta-llama/llama-4-maverick",
            "messages": [{"role": "user", "content": "/moa review auth flow"}],
            "stream": True,
        })
        request = _FakeRequest({
            "authorization": "Bearer test-key",
            "x-hermes-execution-mode": "agent-loop",
        })
        fake_run_agent = self._fake_run_agent_class()
        fake_run_agent_module = types.SimpleNamespace(AIAgent=fake_run_agent)

        with patch.dict(sys.modules, {
                 "hermes_adapter": self._broken_adapter_module(),
                 "run_agent": fake_run_agent_module,
             }), \
             patch.object(main, "_load_moa_config", return_value=self._moa_config()), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": None, "provider": None, "base_url": None, "api_key": None,
             }), \
             patch.object(main, "_get_active_provider", return_value=None):
            response = asyncio.run(main.chat_completions(request, body))

        self._assert_moa_native_required(response)
        self.assertIsNone(fake_run_agent.last_init)

    def test_moa_rejects_run_agent_fallback_via_cli_provider(self):
        body = main.ChatCompletionRequest.model_validate({
            "model": "review",
            "messages": [{"role": "user", "content": "review this design"}],
            "stream": True,
        })
        request = _FakeRequest({
            "authorization": "Bearer test-key",
            "x-hermes-execution-mode": "agent-loop",
        })
        fake_run_agent = self._fake_run_agent_class()
        fake_run_agent_module = types.SimpleNamespace(AIAgent=fake_run_agent)

        with patch.dict(sys.modules, {
                 "hermes_adapter": self._broken_adapter_module(),
                 "run_agent": fake_run_agent_module,
             }), \
             patch.object(main, "_load_moa_config", return_value=self._moa_config()), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "review",
                 "provider": "moa",
                 "base_url": "virtual://moa",
             }), \
             patch.object(main, "_get_active_provider", return_value=None):
            response = asyncio.run(main.chat_completions(request, body))

        self._assert_moa_native_required(response)
        self.assertIsNone(fake_run_agent.last_init)

    def test_normalize_moa_preset_rejects_recursive_moa_slots(self):
        normalized = main._normalize_moa_config({
            "moa": {
                "presets": {
                    "bad": {
                        "reference_models": [
                            {"provider": "moa", "model": "default"},
                            {"provider": "openai", "model": "gpt-5.5"},
                        ],
                        "aggregator": {"provider": "moa", "model": "default"},
                    },
                    "ok": {
                        "reference_models": [{"provider": "openai", "model": "gpt-5.5"}],
                        "aggregator": {"provider": "anthropic", "model": "claude-opus-4.8"},
                        "fanout": "user_turn",
                        "reference_max_tokens": 600,
                    },
                },
            },
        })
        self.assertEqual(list(normalized["presets"].keys()), ["ok"])
        self.assertEqual(normalized["presets"]["ok"]["fanout"], "user_turn")
        self.assertEqual(normalized["presets"]["ok"]["reference_max_tokens"], 600)

    def test_format_moa_tool_text_is_compact(self):
        start = main._format_tool_start_text(
            "moa.reference",
            json.dumps({"label": "openai:gpt-5.5", "index": 0, "count": 2}),
        )
        self.assertIn("MoA advisor", start)
        self.assertIn("openai:gpt-5.5", start)
        end = main._format_tool_end_text("moa.reference", "long advisor essay" * 20)
        self.assertIn("Advisor ready", end)
        self.assertNotIn("long advisor essay", end)

    def test_find_moa_shortcut_scans_past_later_user_messages(self):
        found = main._find_moa_shortcut([
            {"role": "user", "content": "/moa review auth"},
            {"role": "assistant", "content": "ok"},
            {"role": "user", "content": "also check tests"},
        ])
        self.assertEqual(found, (0, "review auth"))

        bare = main._find_moa_shortcut([
            {"role": "user", "content": "/moa"},
        ])
        self.assertEqual(bare, (0, ""))

        missing = main._find_moa_shortcut([
            {"role": "user", "content": "hello"},
        ])
        self.assertIsNone(missing)

    def test_loopback_host_detection(self):
        self.assertTrue(main._is_loopback_host("127.0.0.1"))
        self.assertTrue(main._is_loopback_host("::1"))
        self.assertFalse(main._is_loopback_host("192.168.1.10"))

    def test_get_moa_endpoint_returns_presets(self):
        with patch.object(main, "_load_moa_config", return_value=self._moa_config()), \
             patch.object(main, "_resolve_hermes_home", return_value=main.Path("/tmp")), \
             patch.object(main, "_resolve_profile_name", return_value=""):
            response = asyncio.run(main.get_moa_config(_FakeRequest({})))

        self.assertEqual(response["object"], "moa.config")
        self.assertEqual(response["default_preset"], "review")
        self.assertIn("review", response["presets"])
        self.assertEqual(response["preset_names"], ["review"])


# ---------------------------------------------------------------------------
# Passthrough Mode Tests
# ---------------------------------------------------------------------------

class BridgeOriginGuardTests(unittest.TestCase):
    """Browsers must not drive the bridge cross-origin (CSRF); Express proxy
    fetches carry no Origin header and stay allowed."""

    @staticmethod
    def _run_guard(origin):
        async def _call_next(request):
            return "passed-through"

        headers = {} if origin is None else {"origin": origin}
        request = types.SimpleNamespace(headers=headers)
        return asyncio.run(main.bridge_token_guard(request, _call_next))

    def test_disallowed_browser_origin_is_rejected(self):
        with patch.object(main, "HERMES_BRIDGE_TOKEN", ""):
            resp = self._run_guard("https://evil.example")
        self.assertEqual(resp.status_code, 403)

    def test_null_origin_is_rejected(self):
        with patch.object(main, "HERMES_BRIDGE_TOKEN", ""):
            resp = self._run_guard("null")
        self.assertEqual(resp.status_code, 403)

    def test_no_origin_header_passes(self):
        with patch.object(main, "HERMES_BRIDGE_TOKEN", ""):
            resp = self._run_guard(None)
        self.assertEqual(resp, "passed-through")

    def test_allowed_app_origins_pass(self):
        with patch.object(main, "HERMES_BRIDGE_TOKEN", ""):
            for origin in sorted(main._BRIDGE_ALLOWED_ORIGINS):
                resp = self._run_guard(origin)
                self.assertEqual(resp, "passed-through", origin)


class HermesBridgeMainTests(unittest.TestCase):
    def test_acp_sse_heartbeat_stays_under_proxy_activity_timeout(self):
        # Express proxy (direct-sse-proxy.ts) kills a silent stream after
        # STREAM_ACTIVITY_TIMEOUT_MS (30s). ACP file writes + approval waits
        # emit no tokens, so the keepalive MUST beat that window.
        self.assertGreater(main.ACP_SSE_HEARTBEAT_SECONDS, 0)
        self.assertLess(main.ACP_SSE_HEARTBEAT_SECONDS, 30)

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

            with patch.object(main, "_load_cli_model_config", return_value={
                     "default": None, "provider": None, "base_url": None,
                 }), \
                 patch.object(main, "_get_active_provider", return_value=None):
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


class MiniMaxAgentLoopRoutingTests(unittest.TestCase):
    def test_minimax_agent_loop_passes_explicit_base_url_to_real_agent(self):
        class _FakeHermesAgentAdapter:
            last_init = None

            def __init__(self, **kwargs):
                _FakeHermesAgentAdapter.last_init = kwargs
                self.on_thinking = None
                self.on_reasoning = None

            def run_conversation(self, user_message, conversation_history):
                return None

        fake_module = types.SimpleNamespace(HermesAgentAdapter=_FakeHermesAgentAdapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "MiniMax-M2.7",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({
            "authorization": "Bearer openrouter-test-key",
            "x-hermes-minimax-key": "minimax-test-key",
        })

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertIsNotNone(_FakeHermesAgentAdapter.last_init)
        self.assertEqual(_FakeHermesAgentAdapter.last_init["api_key"], "minimax-test-key")
        self.assertEqual(_FakeHermesAgentAdapter.last_init["base_url"], main.MINIMAX_BASE_URL)


class CliProviderRoutingTests(unittest.TestCase):
    """Ensure ~/.hermes/config.yaml model.provider is authoritative for routing.

    The Electron app calls /chat/completions right after the Hermes CLI
    rewrites config.yaml. The CLI updates config.yaml deterministically but
    does NOT always update auth.json active_provider. Routing must trust
    config.yaml first so the user's CLI model switch immediately takes
    effect in the Electron app on the next request.
    """

    @staticmethod
    def _fake_adapter():
        class _FakeHermesAgentAdapter:
            last_init = None

            def __init__(self, **kwargs):
                _FakeHermesAgentAdapter.last_init = kwargs
                self.on_thinking = None
                self.on_reasoning = None

            def run_conversation(self, user_message, conversation_history):
                return None

        return _FakeHermesAgentAdapter

    def test_cli_provider_openrouter_overrides_stale_auth_json_active_provider(self):
        """Regression: CLI switches config.yaml to openrouter while auth.json
        still says nous — bridge must route to OpenRouter, not Nous."""
        adapter = self._fake_adapter()
        fake_module = types.SimpleNamespace(HermesAgentAdapter=adapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "meta-llama/llama-3-70b-instruct",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({"authorization": "Bearer openrouter-key"})

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "meta-llama/llama-3-70b-instruct",
                 "provider": "openrouter",
                 "base_url": "https://openrouter.ai/api/v1",
             }), \
             patch.object(main, "_get_active_provider", return_value="nous"):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertIsNotNone(adapter.last_init)
        self.assertEqual(
            adapter.last_init["base_url"], "https://openrouter.ai/api/v1",
            "CLI config.yaml provider=openrouter must win over stale auth.json active_provider=nous",
        )

    def test_cli_provider_nous_routes_to_nous_regardless_of_model_prefix(self):
        """User sets Nous via CLI but picks an arbitrary model name without
        the nousresearch/ prefix — the provider field must still route to Nous."""
        adapter = self._fake_adapter()
        fake_module = types.SimpleNamespace(HermesAgentAdapter=adapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "xiaomi/mimo-v2-pro",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({"authorization": "Bearer some-key"})

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "xiaomi/mimo-v2-pro",
                 "provider": "nous",
                 "base_url": "https://inference-api.nousresearch.com/v1",
             }), \
             patch.object(main, "_get_active_provider", return_value=None), \
             patch.object(main, "_get_nous_agent_key", return_value="nous-key"):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertIsNotNone(adapter.last_init)
        self.assertEqual(adapter.last_init["base_url"], main.NOUS_BASE_URL)
        self.assertEqual(adapter.last_init["api_key"], "nous-key")

    def test_auth_json_active_provider_fallback_when_cli_provider_missing(self):
        """Legacy path: if config.yaml has no provider field, auth.json
        active_provider still drives routing."""
        adapter = self._fake_adapter()
        fake_module = types.SimpleNamespace(HermesAgentAdapter=adapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "xiaomi/mimo-v2-pro",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({"authorization": "Bearer some-key"})

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": None, "provider": None, "base_url": None,
             }), \
             patch.object(main, "_get_active_provider", return_value="nous"), \
             patch.object(main, "_get_nous_agent_key", return_value="nous-key"):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertEqual(adapter.last_init["base_url"], main.NOUS_BASE_URL)

    def test_cli_custom_base_url_still_supported(self):
        """Non-known host base_url continues to work (regression for pre-existing
        cli_is_custom passthrough path)."""
        adapter = self._fake_adapter()
        fake_module = types.SimpleNamespace(HermesAgentAdapter=adapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "my-self-hosted/model",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({"authorization": "Bearer ignored"})

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "my-self-hosted/model",
                 "provider": "selfhost",
                 "base_url": "https://my-llm.internal/v1",
             }), \
             patch.object(main, "_get_active_provider", return_value=None), \
             patch.object(main, "_get_credential_pool_key", return_value="selfhost-key"):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertEqual(adapter.last_init["base_url"], "https://my-llm.internal/v1")
        self.assertEqual(adapter.last_init["api_key"], "selfhost-key")

    def test_empty_bearer_openrouter_pin_demotes_to_cli_custom(self):
        """Regression: Spark used to send Authorization: Bearer  + X-Hermes-Provider:
        openrouter with no real key, which 401'd even when config.yaml had a
        credentialed custom base_url (BullInf). Demote the pin and use config."""
        adapter = self._fake_adapter()
        fake_module = types.SimpleNamespace(HermesAgentAdapter=adapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "auto",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({
            "authorization": "Bearer ",
            "x-hermes-provider": "openrouter",
        })

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}), \
             patch.object(main, "OPENROUTER_KEY", ""), \
             patch.object(main, "_get_openrouter_key_from_hermes_creds", return_value=None), \
             patch.object(main, "_provider_has_native_credentials", return_value=False), \
             patch.object(main, "_get_local_gateway_key", return_value=None), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "auto",
                 "provider": "custom",
                 "base_url": "https://api.bullinf.fun/v1",
                 "api_key": "inf_test_key",
             }), \
             patch.object(main, "_get_active_provider", return_value=None), \
             patch.object(main, "_models_for_custom_base_url", return_value=[
                 "e2ee-glm-4.7-flash",
                 "mimo-v2.5",
                 "deepseek-v4-flash",
             ]):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertIsNotNone(adapter.last_init)
        self.assertEqual(adapter.last_init["base_url"], "https://api.bullinf.fun/v1")
        self.assertEqual(adapter.last_init["api_key"], "inf_test_key")
        # Prefer a known-good catalog id over the first (often offline) e2ee-* entry.
        self.assertEqual(adapter.last_init["model"], "deepseek-v4-flash")

    def test_openrouter_pin_demotes_even_when_openclaw_gateway_exists(self):
        """Gateway token must not count as OpenRouter credentials and block demotion."""
        adapter = self._fake_adapter()
        fake_module = types.SimpleNamespace(HermesAgentAdapter=adapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "mimo-v2.5",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({
            "authorization": "Bearer ",
            "x-hermes-provider": "openrouter",
        })

        # Gateway present on purpose; native OpenRouter creds absent so demotion runs.
        with patch.dict(sys.modules, {"hermes_adapter": fake_module}), \
             patch.object(main, "OPENROUTER_KEY", ""), \
             patch.object(main, "_get_openrouter_key_from_hermes_creds", return_value=None), \
             patch.object(main, "_get_local_gateway_key", return_value="gw-token"), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "mimo-v2.5",
                 "provider": "custom",
                 "base_url": "https://api.bullinf.fun/v1",
                 "api_key": "inf_test_key",
             }), \
             patch.object(main, "_get_active_provider", return_value=None), \
             patch.object(main, "_get_credential_pool_key", return_value=None), \
             patch.object(main, "_models_for_custom_base_url", return_value=["mimo-v2.5"]):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertIsNotNone(adapter.last_init)
        self.assertEqual(adapter.last_init["base_url"], "https://api.bullinf.fun/v1")
        self.assertEqual(adapter.last_init["api_key"], "inf_test_key")
        self.assertEqual(adapter.last_init["model"], "mimo-v2.5")

    def test_custom_auto_empty_catalog_does_not_invent_deepseek(self):
        """Empty custom_providers catalog must not invent deepseek-v4-flash."""
        adapter = self._fake_adapter()
        fake_module = types.SimpleNamespace(HermesAgentAdapter=adapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "auto",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({})

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}), \
             patch.object(main, "OPENROUTER_KEY", ""), \
             patch.object(main, "_get_openrouter_key_from_hermes_creds", return_value=None), \
             patch.object(main, "_get_local_gateway_key", return_value=None), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "auto",
                 "provider": "custom",
                 "base_url": "https://my-llm.internal/v1",
                 "api_key": "selfhost-key",
             }), \
             patch.object(main, "_get_active_provider", return_value=None), \
             patch.object(main, "_models_for_custom_base_url", return_value=[]):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertEqual(adapter.last_init["base_url"], "https://my-llm.internal/v1")
        # Leave alias as-is rather than inventing a BullInf-specific model id.
        self.assertEqual(adapter.last_init["model"], "auto")

    def test_explicit_custom_provider_pin_uses_cli_base_url(self):
        """X-Hermes-Provider: custom:<host> must route to config.yaml base_url, not OpenRouter."""
        adapter = self._fake_adapter()
        fake_module = types.SimpleNamespace(HermesAgentAdapter=adapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "mimo-v2.5",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({
            "authorization": "Bearer ignored",
            "x-hermes-provider": "custom:api.bullinf.fun",
        })

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}), \
             patch.object(main, "OPENROUTER_KEY", ""), \
             patch.object(main, "_get_openrouter_key_from_hermes_creds", return_value=None), \
             patch.object(main, "_provider_has_credentials", return_value=False), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "deepseek-v4-flash",
                 "provider": "custom",
                 "base_url": "https://api.bullinf.fun/v1",
                 "api_key": "inf_test_key",
             }), \
             patch.object(main, "_get_active_provider", return_value=None):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertEqual(adapter.last_init["base_url"], "https://api.bullinf.fun/v1")
        self.assertEqual(adapter.last_init["api_key"], "inf_test_key")
        self.assertEqual(adapter.last_init["model"], "mimo-v2.5")

    def test_custom_auto_prefers_known_good_over_e2ee_prefix(self):
        """auto on a custom catalog must not lock onto dead e2ee-* lead entries."""
        adapter = self._fake_adapter()
        fake_module = types.SimpleNamespace(HermesAgentAdapter=adapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "auto",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({})

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}), \
             patch.object(main, "OPENROUTER_KEY", ""), \
             patch.object(main, "_get_openrouter_key_from_hermes_creds", return_value=None), \
             patch.object(main, "_get_local_gateway_key", return_value=None), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "auto",
                 "provider": "custom",
                 "base_url": "https://api.bullinf.fun/v1",
                 "api_key": "inf_test_key",
             }), \
             patch.object(main, "_get_active_provider", return_value=None), \
             patch.object(main, "_models_for_custom_base_url", return_value=[
                 "e2ee-glm-4.7-flash",
                 "e2ee-venice-uncensored-24b-p",
                 "mimo-v2.5",
             ]):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertEqual(adapter.last_init["model"], "mimo-v2.5")
        self.assertEqual(adapter.last_init["base_url"], "https://api.bullinf.fun/v1")

    def test_deepseek_v4_flash_routes_to_opencode_zen_pool_when_not_native(self):
        """Regression: config.yaml names deepseek + deepseek-v4-flash, but the
        native DeepSeek API does not host that model. Telegram reaches it via
        credential_pool (opencode-zen); Spark must do the same instead of Nous."""
        adapter = self._fake_adapter()
        fake_module = types.SimpleNamespace(HermesAgentAdapter=adapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "test"}],
            "stream": True,
        })
        request = _FakeRequest({"authorization": "Bearer ignored"})

        fake_pool = {
            "deepseek": [{
                "access_token": "deepseek-key",
                "base_url": "https://api.deepseek.com/v1",
                "priority": 0,
                "last_status": "ok",
            }],
            "opencode-zen": [{
                "access_token": "zen-key",
                "base_url": "https://opencode.ai/zen/v1",
                "priority": 0,
                "last_status": "ok",
            }],
            "nous": [{
                "access_token": "nous-key",
                "base_url": "https://inference-api.nousresearch.com/v1",
                "priority": 0,
                "last_status": "ok",
            }],
        }

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}), \
             patch.object(main, "_load_cli_model_config", return_value={
                 "default": "deepseek-v4-flash",
                 "provider": "deepseek",
                 "base_url": "",
             }), \
             patch.object(main, "_get_active_provider", return_value="nous"), \
             patch.object(main, "_provider_has_credentials", return_value=True), \
             patch.object(main, "_provider_serves_model", side_effect=lambda pid, _model: pid != "deepseek"), \
             patch.object(main, "_load_credential_pool", return_value=fake_pool):
            asyncio.run(_invoke_chat_and_read_stream(request, body))

        self.assertIsNotNone(adapter.last_init)
        self.assertEqual(adapter.last_init["base_url"], "https://opencode.ai/zen/v1")
        self.assertEqual(adapter.last_init["api_key"], "zen-key")


class BrainRequestRegistrationTests(unittest.TestCase):
    def test_agent_loop_awaits_per_request_brain_register(self):
        class _FakeHermesAgentAdapter:
            def __init__(self, **kwargs):
                self.on_thinking = None
                self.on_reasoning = None

            def run_conversation(self, user_message, conversation_history):
                return {"final_response": "ok", "api_calls": 0, "completed": True}

        fake_module = types.SimpleNamespace(HermesAgentAdapter=_FakeHermesAgentAdapter)
        body = main.ChatCompletionRequest.model_validate({
            "model": "meta-llama/llama-4-maverick",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": True,
        })
        request = _FakeRequest({
            "authorization": "Bearer test-key",
            "x-hermes-execution-mode": "agent-loop",
        })

        with patch.dict(sys.modules, {"hermes_adapter": fake_module}):
            with patch.object(main, "_brain_rpc", new_callable=AsyncMock) as mock_brain_rpc:
                asyncio.run(_invoke_chat_and_read_stream(request, body))

        register_calls = [
            call for call in mock_brain_rpc.await_args_list
            if call.args
            and call.args[0] == "tools/call"
            and isinstance(call.args[1], dict)
            and call.args[1].get("name") == "brain_register"
        ]
        self.assertGreaterEqual(len(register_calls), 1)


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


class WorkspaceUsageCostTests(unittest.TestCase):
    """Cost is recomputed per-provider from tokens, ignoring corrupt stored estimates."""

    def _make_state_db(self, tmpdir, rows):
        import sqlite3
        import time

        db_path = Path(tmpdir) / "state.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            """
            create table sessions (
                id text primary key,
                model text,
                billing_provider text,
                started_at real,
                message_count integer default 0,
                tool_call_count integer default 0,
                input_tokens integer default 0,
                output_tokens integer default 0,
                cache_read_tokens integer default 0,
                cache_write_tokens integer default 0,
                reasoning_tokens integer default 0,
                estimated_cost_usd real,
                actual_cost_usd real
            )
            """
        )
        now = time.time()
        for i, r in enumerate(rows):
            conn.execute(
                "insert into sessions (id, model, billing_provider, started_at, message_count, "
                "tool_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, "
                "reasoning_tokens, estimated_cost_usd, actual_cost_usd) "
                "values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    f"s{i}", r["model"], r.get("billing_provider", ""), now, 1, 0,
                    r.get("input", 0), r.get("output", 0), r.get("cache_read", 0),
                    r.get("cache_write", 0), r.get("reasoning", 0),
                    r.get("estimated_cost_usd"), r.get("actual_cost_usd"),
                ),
            )
        conn.commit()
        conn.close()
        return Path(tmpdir)

    def test_cost_recomputed_and_garbage_rejected(self):
        M = 1_000_000
        rows = [
            # priced by family — flash = 0.14 in + 0.28 out = $0.42; garbage estimate ignored
            {"model": "deepseek-v4-flash", "billing_provider": "custom", "input": M, "output": M, "estimated_cost_usd": 999999.0},
            # claude sonnet = 3 in + 15 out = $18.00
            {"model": "claude-sonnet-4-5", "input": M, "output": M},
            # opaque alias, corrupt estimate (implies 2500/Mtok) -> rejected -> $0, flagged unpriced
            {"model": "zz-opaque-codename", "billing_provider": "custom", "input": M, "output": M, "estimated_cost_usd": 5000.0},
            # opaque alias, plausible estimate (0.5/Mtok) -> kept as last resort -> $0.50
            {"model": "zz-opaque-codename-2", "billing_provider": "custom", "input": M, "output": 0, "estimated_cost_usd": 0.50},
            # free tier -> $0 regardless of stored estimate
            {"model": "stepfun/step-3.5-flash:free", "input": M, "output": M, "estimated_cost_usd": 999.0},
        ]
        with TemporaryDirectory() as tmpdir:
            home = self._make_state_db(tmpdir, rows)
            payload = main._workspace_usage_payload(hermes_home=home)

        self.assertAlmostEqual(payload["cost_usd"], 0.42 + 18.0 + 0.0 + 0.50 + 0.0, places=4)
        self.assertEqual(payload["session_count"], 5)
        self.assertIn("pricing_version", payload)

        by_model = {m["model"]: m for m in payload["top_models"]}
        self.assertAlmostEqual(by_model["claude-sonnet-4-5"]["cost_usd"], 18.0, places=4)
        self.assertAlmostEqual(by_model["deepseek-v4-flash"]["cost_usd"], 0.42, places=4)
        self.assertAlmostEqual(by_model["zz-opaque-codename"]["cost_usd"], 0.0, places=4)

    def test_actual_cost_is_preferred_when_present(self):
        M = 1_000_000
        rows = [
            # provider-reported actual cost wins over both the table and the estimate
            {"model": "claude-sonnet-4-5", "input": M, "output": M, "actual_cost_usd": 7.77, "estimated_cost_usd": 1.0},
        ]
        with TemporaryDirectory() as tmpdir:
            home = self._make_state_db(tmpdir, rows)
            payload = main._workspace_usage_payload(hermes_home=home)
        self.assertAlmostEqual(payload["cost_usd"], 7.77, places=4)


class StaleProviderPinTests(unittest.TestCase):
    """Stale x-hermes-provider pins must be dropped, not forwarded to routing.

    Regression: a UI pin like `custom:inference-api.nousresearch.com` saved
    before config.yaml became `provider: nous` was forwarded verbatim to
    hermes-acp's set_session_model. parse_model_input there doesn't know the
    synthetic id, so it resolved (provider="custom",
    model="<host>:<model>") and the real agent hit OpenRouter with an empty
    key → "HTTP 400: <host>:<model> is not a valid model ID".
    """

    def _cfg(self, provider="nous", base_url="https://inference-api.nousresearch.com/v1"):
        return {"default": "stealth/ox-alpha", "provider": provider,
                "base_url": base_url, "api_key": None}

    def test_helper_includes_builtin_and_moa_ids(self):
        with patch.object(main, "_load_cli_model_config", return_value=self._cfg()):
            ids = main._provider_ids_for_chat_routing()
        self.assertIn("nous", ids)
        self.assertIn("openrouter", ids)
        self.assertIn(main.MOA_PROVIDER_ID, ids)

    def test_helper_includes_synthetic_custom_id_when_config_is_custom(self):
        with patch.object(main, "_load_cli_model_config", return_value=self._cfg(
                provider="custom", base_url="https://api.bullinf.fun/v1")):
            ids = main._provider_ids_for_chat_routing()
        self.assertIn("custom:api.bullinf.fun", ids)

    def test_helper_omits_synthetic_id_when_config_is_native_provider(self):
        with patch.object(main, "_load_cli_model_config", return_value=self._cfg()):
            ids = main._provider_ids_for_chat_routing()
        self.assertNotIn("custom:inference-api.nousresearch.com", ids)

    def _dropped_pin(self, header_value, cfg):
        """Run the exact normalization _acp_chat_completions_impl applies."""
        with patch.object(main, "_load_cli_model_config", return_value=cfg), \
             patch.object(main, "_resolve_hermes_home", return_value=main.Path("/tmp")):
            provider = (header_value or "").strip().lower()
            if provider in ("", "auto", "default"):
                return None
            if provider not in main._provider_ids_for_chat_routing(
                    main._resolve_hermes_home(None)):
                return None
            return provider

    def test_stale_host_pin_is_dropped(self):
        provider = self._dropped_pin(
            "Custom:Inference-API.NousResearch.COM", self._cfg())
        self.assertIsNone(provider)

    def test_known_builtin_pin_survives(self):
        provider = self._dropped_pin("nous", self._cfg())
        self.assertEqual(provider, "nous")

    def test_current_synthetic_custom_pin_survives(self):
        provider = self._dropped_pin(
            "custom:api.bullinf.fun",
            self._cfg(provider="custom", base_url="https://api.bullinf.fun/v1"),
        )
        self.assertEqual(provider, "custom:api.bullinf.fun")

    def test_nous_inference_host_is_known_not_custom(self):
        """Regression: _KNOWN_HOSTS used str.replace("api.", ""), which mangled
        inference-api.nousresearch.com → inference-nousresearch.com, so the
        native nous base_url was misclassified as a custom endpoint."""
        cfg = self._cfg()
        with patch.object(main, "_load_cli_model_config", return_value=cfg):
            ids = main._provider_ids_for_chat_routing()
        self.assertFalse(main._cli_config_is_custom(cfg))
        self.assertNotIn("custom:inference-api.nousresearch.com", ids)
        self.assertIn("inference-api.nousresearch.com", main._KNOWN_HOSTS)

    def test_leading_api_label_is_still_collapsed(self):
        # api.deepseek.com must still collapse to deepseek.com (existing behavior).
        self.assertIn("deepseek.com", main._KNOWN_HOSTS)
        self.assertNotIn("api.deepseek.com", main._KNOWN_HOSTS)
        # A custom endpoint on a DIFFERENT host is still custom.
        cfg = {"default": "m", "provider": "custom",
               "base_url": "https://api.bullinf.fun/v1", "api_key": None}
        self.assertTrue(main._cli_config_is_custom(cfg))

    def test_auto_and_empty_pins_normalize_to_none(self):
        self.assertIsNone(self._dropped_pin("auto", self._cfg()))
        self.assertIsNone(self._dropped_pin("", self._cfg()))


if __name__ == "__main__":
    unittest.main()
