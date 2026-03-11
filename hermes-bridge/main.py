import os
import json
import asyncio
import queue
from typing import Optional
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

app = FastAPI(title="Hermes Bridge")

HERMES_PORT = int(os.environ.get("HERMES_PORT", "3002"))
OPENROUTER_KEY = os.environ.get("HERMES_OPENROUTER_KEY", "")
DEFAULT_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "web,browser,vision")

NOUS_MODELS = [
    {"id": "nousresearch/hermes-3-llama-3.1-405b", "object": "model", "owned_by": "nousresearch"},
    {"id": "nousresearch/hermes-3-llama-3.1-70b", "object": "model", "owned_by": "nousresearch"},
]


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/v1/models")
async def list_models():
    return {"object": "list", "data": NOUS_MODELS}


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "nousresearch/hermes-3-llama-3.1-70b"
    messages: list[ChatMessage]
    temperature: float = 0.7
    top_p: float = 0.9
    max_tokens: int = 16384
    stream: bool = True


def sse_chunk(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def make_delta_chunk(chunk_id: str, model: str, delta: dict, finish_reason: Optional[str] = None) -> dict:
    return {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, body: ChatCompletionRequest):
    toolsets_header = request.headers.get("x-hermes-toolsets", DEFAULT_TOOLSETS)
    enabled_toolsets = [t.strip() for t in toolsets_header.split(",") if t.strip()]

    api_key = OPENROUTER_KEY
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        api_key = auth_header[7:]

    if not api_key:
        return JSONResponse(status_code=401, content={"error": {"message": "No API key provided. Set HERMES_OPENROUTER_KEY or pass Authorization header."}})

    from run_agent import AIAgent

    chunk_id = f"chatcmpl-hermes-{os.urandom(8).hex()}"
    # Use thread-safe queues since AIAgent callbacks run in a background thread
    tool_activity_queue: queue.Queue = queue.Queue()
    text_queue: queue.Queue = queue.Queue()
    done_event = asyncio.Event()
    loop = asyncio.get_event_loop()

    def on_tool_start(tool_name: str, tool_input: str):
        tool_activity_queue.put_nowait({
            "tool": tool_name,
            "status": "running",
            "input": tool_input,
            "output": None,
        })

    def on_tool_end(tool_name: str, tool_input: str, tool_output: str):
        tool_activity_queue.put_nowait({
            "tool": tool_name,
            "status": "completed",
            "input": tool_input,
            "output": tool_output[:2000],
        })

    def on_text(text: str):
        text_queue.put_nowait(text)

    def _run_agent_sync():
        try:
            agent = AIAgent(
                base_url="https://openrouter.ai/api/v1",
                api_key=api_key,
                model=body.model,
                max_iterations=30,
                enabled_toolsets=enabled_toolsets,
                on_tool_start=on_tool_start,
                on_tool_end=on_tool_end,
                on_text=on_text,
            )

            conversation_history = [
                {"role": m.role, "content": m.content} for m in body.messages
            ]

            user_message = conversation_history[-1]["content"] if conversation_history else ""
            history = conversation_history[:-1] if len(conversation_history) > 1 else []

            agent.run_conversation(
                user_message=user_message,
                conversation_history=history,
            )
        except Exception as e:
            text_queue.put_nowait(f"\n\n[Error: {str(e)}]")
        finally:
            loop.call_soon_threadsafe(done_event.set)

    async def event_stream():
        # Role chunk
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"role": "assistant"}))

        agent_task = asyncio.ensure_future(asyncio.to_thread(_run_agent_sync))

        while not done_event.is_set() or not tool_activity_queue.empty() or not text_queue.empty():
            # Drain tool activity
            while not tool_activity_queue.empty():
                activity = tool_activity_queue.get_nowait()
                yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                    "content": "",
                    "tool_activity": activity,
                }))

            # Drain text
            while not text_queue.empty():
                text = text_queue.get_nowait()
                yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))

            if not done_event.is_set():
                await asyncio.sleep(0.05)

        # Final chunk
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {}, finish_reason="stop"))
        yield "data: [DONE]\n\n"

        await agent_task

    return StreamingResponse(event_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=HERMES_PORT)
