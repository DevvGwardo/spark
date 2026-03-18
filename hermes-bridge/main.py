import os
import json
import asyncio
import queue
import time
from typing import Optional
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

app = FastAPI(title="Hermes Bridge")

HERMES_PORT = int(os.environ.get("HERMES_PORT", "3003"))
OPENROUTER_KEY = os.environ.get("HERMES_OPENROUTER_KEY", "")
DEFAULT_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "web,browser")
DEFAULT_MODEL = os.environ.get("HERMES_DEFAULT_MODEL", "meta-llama/llama-4-maverick")


def _read_positive_int_env(name: str, fallback: int) -> int:
    raw_value = os.environ.get(name)
    if not raw_value:
        return fallback
    try:
        parsed_value = int(raw_value)
    except ValueError:
        return fallback
    return parsed_value if parsed_value > 0 else fallback


MAX_AGENT_ITERATIONS = _read_positive_int_env("HERMES_MAX_ITERATIONS", 60)
PASSTHROUGH_TIMEOUT_SECONDS = _read_positive_int_env(
    "HERMES_PROVIDER_TIMEOUT_SECONDS", 5400
)

AGENT_MODELS = [
    # Paid models
    {"id": "anthropic/claude-sonnet-4", "object": "model", "owned_by": "anthropic"},
    {"id": "openai/gpt-4.1-mini", "object": "model", "owned_by": "openai"},
    {"id": "google/gemini-3.1-flash-lite-preview-20260303", "object": "model", "owned_by": "google"},
    {"id": "google/gemini-2.5-flash", "object": "model", "owned_by": "google"},
    {"id": "deepseek/deepseek-v3.2-20251201", "object": "model", "owned_by": "deepseek"},
    {"id": "deepseek/deepseek-chat-v3.1", "object": "model", "owned_by": "deepseek"},
    {"id": "meta-llama/llama-4-maverick", "object": "model", "owned_by": "meta"},
    {"id": "meta-llama/llama-4-scout", "object": "model", "owned_by": "meta"},
    # Free models
    {"id": "deepseek/deepseek-r1-0528:free", "object": "model", "owned_by": "deepseek"},
    {"id": "google/gemini-2.0-flash-001", "object": "model", "owned_by": "google"},
    {"id": "nousresearch/hermes-3-llama-3.1-405b:free", "object": "model", "owned_by": "nousresearch"},
    {"id": "meta-llama/llama-3.3-70b-instruct:free", "object": "model", "owned_by": "meta"},
    {"id": "qwen/qwen3-next-80b-a3b-instruct:free", "object": "model", "owned_by": "qwen"},
    {"id": "mistralai/mistral-small-3.1-24b-instruct:free", "object": "model", "owned_by": "mistral"},
]


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/v1/models")
async def list_models():
    return {"object": "list", "data": AGENT_MODELS}


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = DEFAULT_MODEL
    messages: list[ChatMessage] = Field(default_factory=list)
    temperature: float = 0.7
    top_p: float = 0.9
    max_tokens: int = 16384
    stream: bool = True
    # Accept and ignore extra fields from AI SDK
    model_config = {"extra": "allow"}


def sse_chunk(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


# Friendly display names for tool activity in the chat stream
_TOOL_DISPLAY_NAMES: dict[str, str] = {
    "web_search": "Searching the web",
    "browse_url": "Reading webpage",
    "run_command": "Running command",
    "read_file": "Reading file",
    "write_file": "Writing file",
    "execute_python": "Running Python",
    "read_repo_file": "Reading file",
    "edit_repo_file": "Editing file",
    "create_repo_file": "Creating file",
    "delete_repo_file": "Deleting file",
    "batch_edit_repo_files": "Editing files",
}


def _get_stream_chunk_size(text: str) -> int:
    """Use larger chunks for bulky payloads to avoid SSE event floods."""
    if len(text) > 4000:
        return 1024
    if len(text) > 1000:
        return 256
    return 20


def _format_tool_start_text(tool_name: str, tool_input: str) -> str:
    """Format a tool_start event as a concise markdown indicator.

    Instead of dumping raw JSON args (which can contain entire file contents),
    extract only the meaningful summary — e.g. the file path or search query.
    """
    display = _TOOL_DISPLAY_NAMES.get(tool_name, tool_name)
    summary = ""
    try:
        args = json.loads(tool_input) if tool_input else {}
    except (json.JSONDecodeError, TypeError):
        args = {}

    if tool_name in ("read_repo_file", "edit_repo_file", "create_repo_file",
                      "delete_repo_file", "read_file", "write_file"):
        path = args.get("path", "")
        if path:
            summary = f"`{path}`"
    elif tool_name == "batch_edit_repo_files":
        changes = args.get("changes", [])
        if isinstance(changes, list) and changes:
            paths = [c.get("path", "?") for c in changes[:5] if isinstance(c, dict)]
            summary = ", ".join(f"`{p}`" for p in paths)
            if len(changes) > 5:
                summary += f" +{len(changes) - 5} more"
    elif tool_name == "web_search":
        query = args.get("query", "")
        if query:
            summary = f'"{query}"'
    elif tool_name == "browse_url":
        url = args.get("url", "")
        if url:
            summary = f"`{url[:80]}{'…' if len(url) > 80 else ''}`"
    elif tool_name == "run_command":
        cmd = args.get("command", "")
        if cmd:
            summary = f"`{cmd[:80]}{'…' if len(cmd) > 80 else ''}`"
    elif tool_name == "execute_python":
        code = args.get("code", "")
        first_line = code.split("\n")[0][:60] if code else ""
        if first_line:
            summary = f"`{first_line}{'…' if len(code) > 60 else ''}`"

    if summary:
        return f"\n\n> **{display}** — {summary}\n\n"
    return f"\n\n> **{display}**\n\n"


def _format_tool_end_text(tool_name: str, tool_output: str) -> str:
    """Format a tool_end event as a brief completion note.

    Only shows a short, meaningful summary — never raw file contents.
    """
    display = _TOOL_DISPLAY_NAMES.get(tool_name, tool_name)
    normalized_output = (tool_output or "").strip()

    if normalized_output.lower().startswith(("error:", "failed:")):
        preview = normalized_output.split("\n", 1)[0][:120]
        return f"> *Failed:* `{preview}`\n\n"

    if tool_name in ("read_repo_file", "read_file"):
        char_count = len(tool_output) if tool_output else 0
        return f"> *Done — read {char_count:,} chars*\n\n"
    if tool_name in ("write_file",):
        return f"> *Done — {tool_output[:100]}*\n\n"
    if tool_name == "web_search":
        # Count results (JSON array)
        try:
            results = json.loads(tool_output) if tool_output else []
            count = len(results) if isinstance(results, list) else 0
            return f"> *Found {count} result{'s' if count != 1 else ''}*\n\n"
        except (json.JSONDecodeError, TypeError):
            return f"> *Search complete*\n\n"
    if tool_name == "browse_url":
        char_count = len(tool_output) if tool_output else 0
        return f"> *Fetched {char_count:,} chars*\n\n"
    if tool_name in ("run_command", "execute_python"):
        # Show a short preview of output
        preview = (tool_output or "").strip().split("\n")[0][:120]
        if preview:
            return f"> *Done:* `{preview}`\n\n"
        return f"> *Done (no output)*\n\n"

    # Fallback: just say it's done
    return f"> *{display} — done*\n\n"


def _build_agent_status(
    *,
    phase: str,
    label: str,
    started_at: float,
    iteration: Optional[int] = None,
) -> dict:
    status = {
        "phase": phase,
        "label": label,
        "elapsed_ms": max(0, int((time.monotonic() - started_at) * 1000)),
        "source": "hermes-bridge",
    }
    if iteration is not None:
        status["iteration"] = iteration
    return status


def make_delta_chunk(chunk_id: str, model: str, delta: dict, finish_reason: Optional[str] = None) -> dict:
    chunk: dict = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }],
    }
    # Include usage in the final chunk so the AI SDK's OpenAI-compatible
    # parser recognises this as a proper completion and maps finish_reason
    # to finishReason instead of defaulting to 'unknown'.
    if finish_reason is not None:
        chunk["usage"] = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    return chunk


def _build_passthrough_payload(body: ChatCompletionRequest) -> dict:
    payload = body.model_dump()
    payload.update(body.model_extra or {})
    return payload


def _passthrough_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://cloud-chat-hub.local",
        "X-Title": "Hermes Agent",
    }


def _passthrough_error_response(status_code: int, response_body: bytes) -> JSONResponse:
    if not response_body:
        return JSONResponse(status_code=status_code, content={"error": {"message": "Upstream provider error"}})
    try:
        return JSONResponse(status_code=status_code, content=json.loads(response_body.decode("utf-8")))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(
            status_code=status_code,
            content={"error": {"message": response_body.decode("utf-8", errors="replace")}},
        )


async def _passthrough_chat_completions(body: ChatCompletionRequest, api_key: str):
    payload = _build_passthrough_payload(body)
    request_headers = _passthrough_headers(api_key)

    async with httpx.AsyncClient(timeout=PASSTHROUGH_TIMEOUT_SECONDS) as client:
        request = client.build_request(
            "POST",
            "https://openrouter.ai/api/v1/chat/completions",
            headers=request_headers,
            json=payload,
        )
        upstream = await client.send(request, stream=bool(payload.get("stream", True)))
        if upstream.status_code >= 400:
            error_body = await upstream.aread()
            await upstream.aclose()
            return _passthrough_error_response(upstream.status_code, error_body)

        if not payload.get("stream", True):
            response_body = await upstream.aread()
            await upstream.aclose()
            try:
                return JSONResponse(status_code=upstream.status_code, content=json.loads(response_body.decode("utf-8")))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return JSONResponse(
                    status_code=upstream.status_code,
                    content={"error": {"message": response_body.decode("utf-8", errors="replace")}},
                )

        async def stream_bytes():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()

        media_type = upstream.headers.get("content-type", "text/event-stream")
        return StreamingResponse(stream_bytes(), media_type=media_type)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, body: ChatCompletionRequest):
    toolsets_header = request.headers.get("x-hermes-toolsets", DEFAULT_TOOLSETS)
    enabled_toolsets = [t.strip() for t in toolsets_header.split(",") if t.strip()]
    execution_mode = request.headers.get("x-hermes-execution-mode", "agent-loop").strip().lower() or "agent-loop"
    repo_owner = request.headers.get("x-hermes-repo-owner", "")
    repo_name = request.headers.get("x-hermes-repo-name", "")
    github_pat = request.headers.get("x-hermes-github-pat", "")
    repo_edit_intent = request.headers.get("x-hermes-repo-edit-intent", "") == "1"

    # Detect repo mode from either the request body tools OR the repo headers.
    # In agent-loop mode the server sends repo info via headers (not body tools),
    # so we must check both sources to enable repo_mode correctly.
    has_repo_tools = False
    extra = body.model_extra or {}
    tools_list = extra.get("tools")
    if isinstance(tools_list, (list, dict)):
        tool_names = set()
        if isinstance(tools_list, dict):
            tool_names = set(tools_list.keys())
        elif isinstance(tools_list, list):
            for t in tools_list:
                fn = t.get("function", {}) if isinstance(t, dict) else {}
                name = fn.get("name", "")
                if name:
                    tool_names.add(name)
        has_repo_tools = "edit_repo_file" in tool_names
    # Also enable repo mode when repo headers are present (agent-loop proxy path)
    if not has_repo_tools and repo_owner and repo_name and github_pat:
        has_repo_tools = True

    api_key = OPENROUTER_KEY
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        api_key = auth_header[7:]

    if not api_key:
        return JSONResponse(status_code=401, content={"error": {"message": "No API key provided. Set HERMES_OPENROUTER_KEY or pass Authorization header."}})

    if execution_mode == "passthrough":
        print(
            f"[hermes-bridge] Passthrough mode. model={body.model} msgs={len(body.messages)} extra_keys={list((body.model_extra or {}).keys())}",
            flush=True,
        )
        return await _passthrough_chat_completions(body, api_key)

    from run_agent import AIAgent

    chunk_id = f"chatcmpl-hermes-{os.urandom(8).hex()}"
    # Thread-safe queue for all events (text and tool activity)
    event_queue: queue.Queue = queue.Queue()
    done_event = asyncio.Event()
    loop = asyncio.get_event_loop()

    def on_tool_start(tool_name: str, tool_input: str):
        # Emit tool start as visible text so user sees activity
        event_queue.put(("tool_start", tool_name, tool_input))

    def on_tool_end(tool_name: str, tool_input: str, tool_output: str):
        event_queue.put(("tool_end", tool_name, tool_output[:500]))

    def on_text(text: str):
        # Stream normal text in small chunks for responsiveness
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            event_queue.put(("text", text[i:i + chunk_size]))

    def on_thinking(iteration: int):
        event_queue.put(("thinking", iteration))

    def on_server_tool_event(event: dict):
        event_queue.put(("server_tool_event", event))

    def _run_agent_sync():
        try:
            # Log message roles for debugging system prompt delivery
            msg_roles = [m.role for m in body.messages]
            has_extra_system = bool((body.model_extra or {}).get("system"))
            print(f"[hermes-bridge] Starting agent. mode={execution_mode} model={body.model} repo_mode={has_repo_tools} has_github={'yes' if github_pat else 'no'} repo={repo_owner}/{repo_name} toolsets={enabled_toolsets} msgs={len(body.messages)} roles={msg_roles} extra_system={has_extra_system}", flush=True)
            if has_repo_tools and not github_pat:
                print(f"[hermes-bridge] WARNING: repo_mode is active but no GitHub PAT provided — read_repo_file will fail", flush=True)
            agent = AIAgent(
                base_url="https://openrouter.ai/api/v1",
                api_key=api_key,
                model=body.model,
                max_iterations=MAX_AGENT_ITERATIONS,
                enabled_toolsets=enabled_toolsets,
                repo_mode=has_repo_tools,
                repo_edit_intent=repo_edit_intent,
                github_pat=github_pat if github_pat else None,
                github_repo_owner=repo_owner if repo_owner else None,
                github_repo_name=repo_name if repo_name else None,
                on_tool_start=on_tool_start,
                on_tool_end=on_tool_end,
                on_text=on_text,
                on_server_tool_event=on_server_tool_event,
            )
            agent.on_thinking = on_thinking

            conversation_history = [
                {"role": m.role, "content": m.content} for m in body.messages
            ]

            # The AI SDK may send the system prompt as a separate top-level
            # "system" field instead of (or in addition to) a system message
            # in the messages array.  Merge it if present.
            extra = body.model_extra or {}
            extra_system = extra.get("system")
            if isinstance(extra_system, str) and extra_system.strip():
                # Check if there's already a system message
                has_system = any(m.get("role") == "system" for m in conversation_history)
                if has_system:
                    for m in conversation_history:
                        if m.get("role") == "system":
                            m["content"] = extra_system + "\n\n" + (m["content"] or "")
                            break
                else:
                    conversation_history.insert(0, {"role": "system", "content": extra_system})

            # Find the last user message and pass everything before it
            # (including all assistant messages) as history.  Previous code
            # blindly took conversation_history[-1] which could strip an
            # assistant response when the SDK appends messages after it,
            # or — more critically — drop the assistant's analysis from
            # history when the last user message sits right after it.
            last_user_idx = None
            for i in range(len(conversation_history) - 1, -1, -1):
                if conversation_history[i]["role"] == "user":
                    last_user_idx = i
                    break

            if last_user_idx is not None:
                user_message = conversation_history[last_user_idx]["content"]
                # History = everything except the last user message itself.
                # This keeps all prior assistant messages (with their issue
                # analysis, etc.) in context for follow-up requests.
                history = conversation_history[:last_user_idx] + conversation_history[last_user_idx + 1:]
            else:
                user_message = ""
                history = list(conversation_history)

            print(f"[hermes-bridge] User message: {user_message[:100]}... history_msgs={len(history)} has_system={any(m.get('role') == 'system' for m in history)}", flush=True)
            agent.run_conversation(
                user_message=user_message,
                conversation_history=history,
            )
            print(f"[hermes-bridge] Agent conversation completed.", flush=True)
        except Exception as e:
            print(f"[hermes-bridge] Agent error: {e}", flush=True)
            event_queue.put(("text", f"\n\n[Error: {str(e)}]"))
        finally:
            loop.call_soon_threadsafe(done_event.set)

    async def event_stream():
        # Role chunk
        print(f"[hermes-bridge] SSE stream started. chunk_id={chunk_id}", flush=True)
        stream_started_at = time.monotonic()
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"role": "assistant"}))
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
            "agent_status": _build_agent_status(
                phase="starting",
                label="Starting Hermes agent loop...",
                started_at=stream_started_at,
            ),
        }))

        agent_task = asyncio.ensure_future(asyncio.to_thread(_run_agent_sync))
        event_count = 0
        idle_ticks = 0  # counts consecutive empty polls (~50ms each)
        HEARTBEAT_INTERVAL = 60  # ticks ≈ 3 seconds of silence

        while not done_event.is_set() or not event_queue.empty():
            drained = False
            while not event_queue.empty():
                drained = True
                idle_ticks = 0
                try:
                    event = event_queue.get_nowait()
                except queue.Empty:
                    break

                event_count += 1
                if event[0] == "text":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": event[1]}))
                elif event[0] == "tool_start":
                    tool_name, tool_input = event[1], event[2]
                    # Emit as both visible text and structured tool_activity
                    text = _format_tool_start_text(tool_name, tool_input)
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": {"tool": tool_name, "status": "running", "input": tool_input, "output": None}
                    }))
                elif event[0] == "tool_end":
                    tool_name, tool_output = event[1], event[2]
                    text = _format_tool_end_text(tool_name, tool_output)
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": {"tool": tool_name, "status": "completed", "input": "", "output": tool_output}
                    }))
                elif event[0] == "thinking":
                    iteration = event[1]
                    status_label = (
                        "Analyzing repository context..."
                        if has_repo_tools and iteration == 1
                        else "Analyzing your request..."
                        if iteration == 1
                        else f"Planning iteration {iteration}..."
                    )
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "agent_status": _build_agent_status(
                            phase="thinking",
                            label=status_label,
                            started_at=stream_started_at,
                            iteration=iteration,
                        ),
                    }))
                    if iteration > 1:
                        # Show a thinking indicator between iterations so the
                        # user knows the agent is still working
                        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                            "content": "\n\n> *Thinking...*\n\n"
                        }))
                elif event[0] == "server_tool_event":
                    event_data = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "server_tool_event": event_data
                    }))

            if not done_event.is_set():
                idle_ticks += 1
                # Send SSE comment as keepalive to prevent connection timeout
                if idle_ticks % HEARTBEAT_INTERVAL == 0:
                    yield ": heartbeat\n\n"
                await asyncio.sleep(0.05)

        # Final chunk
        print(f"[hermes-bridge] SSE stream ending. Total events emitted: {event_count}", flush=True)
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {}, finish_reason="stop"))
        yield "data: [DONE]\n\n"

        await agent_task

    return StreamingResponse(event_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=HERMES_PORT)
