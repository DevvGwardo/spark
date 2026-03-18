import asyncio
import os
import sys
import types
import unittest


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
    def __init__(self, chunks):
        self.status_code = 200
        self.headers = {"content-type": "text/event-stream"}
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


if __name__ == "__main__":
    unittest.main()
