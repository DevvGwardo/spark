#!/usr/bin/env python3
"""Anthropic Messages API proxy -> Hermes Bridge (OpenAI chat/completions).

Lets Claude Code (or any Anthropic SDK) talk to the hermes bridge by setting:
  ANTHROPIC_BASE_URL=http://localhost:3003/v1
  ANTHROPIC_API_KEY=***

Usage:
  python anthropic_proxy.py              # default port 3003
  python anthropic_proxy.py --port 3004  # custom port
"""

import argparse
import json
import os
import time
import uuid
from typing import Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse

app = FastAPI(title="Hermes Anthropic Proxy")

HERMES_BRIDGE_URL = os.environ.get("HERMES_BRIDGE_URL", "http://localhost:3002/v1")


# Cache the bridge's default model
_bridge_default_model: Optional[str] = None

async def get_bridge_default_model() -> str:
    global _bridge_default_model
    if _bridge_default_model:
        return _bridge_default_model
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{HERMES_BRIDGE_URL.replace('/v1', '')}/health")
            data = resp.json()
            _bridge_default_model = data.get("hermes_default_model", "default")
            return _bridge_default_model
    except Exception:
        return "default"


def anthropic_to_openai(body: dict, model_override: str) -> tuple[dict, str]:
    """Convert Anthropic messages request -> OpenAI chat/completions."""
    messages = []
    system_parts = body.get("system", "")

    # System prompt -> system message
    if system_parts:
        if isinstance(system_parts, str):
            messages.append({"role": "system", "content": system_parts})
        elif isinstance(system_parts, list):
            text = "\n".join(
                b.get("text", "") for b in system_parts if b.get("type") == "text"
            )
            if text:
                messages.append({"role": "system", "content": text})

    # Convert Anthropic messages
    for msg in body.get("messages", []):
        role = msg["role"]
        content = msg.get("content", "")

        if isinstance(content, list):
            # Extract text parts, skip tool_use/tool_result for now
            text_parts = []
            for part in content:
                if part.get("type") == "text":
                    text_parts.append(part["text"])
                elif part.get("type") == "tool_use":
                    # Convert to function_call-like structure
                    text_parts.append(
                        f"[Tool: {part['name']}]\n{json.dumps(part.get('input', {}))}"
                    )
                elif part.get("type") == "tool_result":
                    for c in part.get("content", []):
                        if isinstance(c, dict) and c.get("type") == "text":
                            text_parts.append(f"[Tool Result]\n{c['text']}")
                        elif isinstance(c, str):
                            text_parts.append(f"[Tool Result]\n{c}")
            content = "\n".join(text_parts) if text_parts else ""

        messages.append({"role": role, "content": content})

    # Use bridge's configured default model, not what claude code sends
    openai_body = {
        "model": model_override,
        "messages": messages,
        "max_tokens": body.get("max_tokens", 4096),
        "temperature": body.get("temperature", 0.7),
        "stream": body.get("stream", False),
    }
    return openai_body, model_override


def openai_to_anthropic_response(data: dict, model: str) -> dict:
    """Convert OpenAI chat/completion -> Anthropic messages response."""
    choice = data.get("choices", [{}])[0]
    message = choice.get("message", {})
    content_text = message.get("content", "") or ""

    usage = data.get("usage", {})
    result = {
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": content_text}],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }
    return result


async def stream_openai_to_anthropic(openai_url: str, openai_body: dict, headers: dict):
    """Stream OpenAI SSE -> Anthropic SSE events."""
    model = openai_body.get("model", "default")
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"

    # message_start
    yield f"event: message_start\ndata: {json.dumps({'type': 'message_start', 'message': {'id': msg_id, 'type': 'message', 'role': 'assistant', 'model': model, 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 0, 'output_tokens': 0}}})}\n\n"

    # content_block_start
    block_index = 0
    yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': block_index, 'content_block': {'type': 'text', 'text': ''}})}\n\n"

    full_text = ""
    async with httpx.AsyncClient(timeout=600.0) as client:
        async with client.stream("POST", openai_url, json=openai_body, headers=headers) as resp:
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload.strip() == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    text = delta.get("content", "") or ""
                    if text:
                        full_text += text
                        yield f"event: content_block_delta\ndata: {json.dumps({'type': 'content_block_delta', 'index': block_index, 'delta': {'type': 'text_delta', 'text': text}})}\n\n"
                except json.JSONDecodeError:
                    continue

    # content_block_stop
    yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n"

    # message_delta (stop reason)
    yield f"event: message_delta\ndata: {json.dumps({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': len(full_text.split())}})}\n\n"

    # message_stop
    yield f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n"


@app.post("/v1/messages")
async def messages(request: Request):
    """Anthropic /v1/messages endpoint -> Hermes bridge."""
    body = await request.json()
    model = await get_bridge_default_model()
    openai_body, _ = anthropic_to_openai(body, model)
    stream = body.get("stream", False)

    openai_url = f"{HERMES_BRIDGE_URL}/chat/completions"
    forward_headers = {"Content-Type": "application/json"}

    # Forward any x-hermes-* headers
    for key, val in request.headers.items():
        if key.lower().startswith("x-hermes-"):
            forward_headers[key] = val

    if stream:
        return StreamingResponse(
            stream_openai_to_anthropic(openai_url, openai_body, forward_headers),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming — but bridge always streams, so collect the SSE
    try:
        openai_body_stream = {**openai_body, "stream": True}
        full_content = ""
        async with httpx.AsyncClient(timeout=600.0) as client:
            async with client.stream("POST", openai_url, json=openai_body_stream, headers=forward_headers) as resp:
                if resp.status_code != 200:
                    body_bytes = await resp.aread()
                    return JSONResponse(
                        status_code=resp.status_code,
                        content={"type": "error", "error": {"type": "api_error", "message": body_bytes.decode(errors="replace")[:500]}},
                    )
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:]
                    if payload.strip() == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        text = delta.get("content", "") or ""
                        full_content += text
                    except json.JSONDecodeError:
                        continue

        result = {
            "id": f"msg_{uuid.uuid4().hex[:24]}",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": full_content}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 0, "output_tokens": len(full_content.split())},
        }
        return JSONResponse(content=result)
    except Exception as e:
        return JSONResponse(
            status_code=502,
            content={"type": "error", "error": {"type": "api_error", "message": str(e)}},
        )


@app.get("/v1/models")
async def list_models():
    """Proxy model list from bridge."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{HERMES_BRIDGE_URL}/models")
            return JSONResponse(content=resp.json())
    except Exception:
        return JSONResponse(content={"object": "list", "data": []})


@app.get("/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{HERMES_BRIDGE_URL.replace('/v1', '')}/health")
            bridge_health = resp.json()
            return {"status": "ok", "bridge": bridge_health}
    except Exception as e:
        return {"status": "error", "detail": str(e)}


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Hermes Anthropic Proxy")
    parser.add_argument("--port", type=int, default=3003)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    print(f"[anthropic-proxy] Forwarding Anthropic /v1/messages -> {HERMES_BRIDGE_URL}/chat/completions")
    print(f"[anthropic-proxy] Listening on http://{args.host}:{args.port}/v1")
    print(f"\nSet in Claude Code:")
    print(f"  export ANTHROPIC_BASE_URL=http://localhost:{args.port}/v1")
    print(f"  export ANTHROPIC_API_KEY=***")

    uvicorn.run(app, host=args.host, port=args.port)
