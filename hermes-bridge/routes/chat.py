"""Routes: /v1/chat/completions (timeout + error envelope around chat_impl).

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from bridge_logger import log as _log
from bridge_providers import REQUEST_TIMEOUT_SECONDS
from chat_common import ChatCompletionRequest
from chat_impl import _chat_completions_impl

router = APIRouter()


@router.post("/v1/chat/completions")
async def chat_completions(request: Request, body: ChatCompletionRequest):
    try:
        if hasattr(asyncio, "timeout"):
            async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
                return await _chat_completions_impl(request, body)
        return await asyncio.wait_for(
            _chat_completions_impl(request, body),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={
                "error": {
                    "message": f"Request timed out after {REQUEST_TIMEOUT_SECONDS} seconds. The agent took too long to respond.",
                    "code": "REQUEST_TIMEOUT",
                }
            },
        )
    except Exception as e:  # noqa: BLE001 - last-resort handler: logged with traceback, enveloped for the client
        import traceback as _tb
        tb_str = _tb.format_exc()
        _log.error("chat", "unhandled error in chat_completions", error=str(e), traceback=tb_str)
        # Never leak tracebacks to clients — log full context server-side,
        # return only a structured error code and sanitized message.
        safe_message = str(e) if len(str(e)) < 500 else f"{str(e)[:497]}..."
        return JSONResponse(
            status_code=500,
            content={"error": {"message": safe_message, "code": "INTERNAL_ERROR"}},
        )
