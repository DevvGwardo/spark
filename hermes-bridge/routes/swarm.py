"""Routes: /v1/swarm (Architect -> Implementor -> Reviewer pipeline).

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import os
import time

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from bridge_config import DEFAULT_TOOLSETS
from bridge_events import agent_status_event, swarm_result_server_tool_event
from bridge_providers import DEFAULT_MODEL
from bridge_state import _mark_request_finished
import bridge_providers
from chat_common import (
    ChatMessage,
    _finalize_tracked_session,
    _resolve_workspace_id,
    make_delta_chunk,
    sse_chunk,
)
from session_tracker import _normalize_chat_messages

router = APIRouter()


# ------------------------------------------------------------------
# Swarm endpoint — Architect → Implementor → Reviewer pipeline
# ------------------------------------------------------------------

class SwarmRequest(BaseModel):
    """Request body for the /v1/swarm endpoint."""
    model: str = DEFAULT_MODEL
    messages: list[ChatMessage] = Field(default_factory=list)
    stream: bool = True
    model_config = {"extra": "allow"}


@router.post("/v1/swarm")
async def swarm_endpoint(request: Request, body: SwarmRequest):
    """Run the 3-phase swarm pipeline and stream SSE progress events."""
    from swarm_pattern import run_swarm

    toolsets_header = request.headers.get("x-hermes-toolsets", DEFAULT_TOOLSETS)
    enabled_toolsets = [t.strip() for t in toolsets_header.split(",") if t.strip()]
    repo_owner = request.headers.get("x-hermes-repo-owner", "")
    repo_name = request.headers.get("x-hermes-repo-name", "")
    github_pat = request.headers.get("x-hermes-github-pat", "")
    workspace_id = _resolve_workspace_id(request, body)

    extra = body.model_extra or {}
    custom_tools = [t for t in extra.get("custom_tools", []) if isinstance(t, dict)]
    repo_file_tree_raw = extra.get("repo_file_tree", [])
    repo_file_tree = [p for p in repo_file_tree_raw if isinstance(p, str) and p.strip()] if isinstance(repo_file_tree_raw, list) else []

    repo_mode = bool(repo_owner and repo_name)

    # Extract last user message
    conversation_history = _normalize_chat_messages(body.messages, model=body.model, strip_images=True)
    last_user_idx = None
    for i in range(len(conversation_history) - 1, -1, -1):
        if conversation_history[i]["role"] == "user":
            last_user_idx = i
            break
    user_message = conversation_history[last_user_idx]["content"] if last_user_idx is not None else ""

    chunk_id = f"chatcmpl-swarm-{os.urandom(8).hex()}"
    started_at = time.monotonic()

    def _finalize_session(success: bool, error_message: str | None = None) -> None:
        # When /v1/chat/completions forwards a swarm-mode turn here, it has already
        # registered a tracked session keyed on the same workspace id; close it out.
        # A direct /v1/swarm call has no tracked session and this is a no-op.
        # (This name used to be an undefined reference to chat_impl's closure, so
        # every swarm turn ended with a NameError inside the stream.)
        _, using_real_agent = bridge_providers._resolve_chat_agent_class()
        _finalize_tracked_session(
            workspace_id,
            success=success,
            error_message=error_message,
            persist_stub=not using_real_agent,
        )

    async def swarm_stream():
        # Opening role chunk
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"role": "assistant"}))
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
            "agent_status": agent_status_event(
                phase="swarm_starting",
                label="Starting swarm pipeline...",
                started_at=started_at,
            ),
        }))
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
            "content": "\n\n> **Swarm Pipeline** — Architect → Implementor → Reviewer\n\n"
        }))

        try:
            result = await run_swarm(
                user_message=user_message,
                conversation_history=conversation_history,
                enabled_toolsets=enabled_toolsets,
                repo_mode=repo_mode,
                repo_owner=repo_owner or None,
                repo_name=repo_name or None,
                github_pat=github_pat or None,
                custom_tools=custom_tools,
                repo_file_tree=repo_file_tree,
            )

            # Stream the result summary
            verdict = result.get("verdict", "unknown")
            review_notes = result.get("review_notes", "")
            plan = result.get("plan", [])
            staged = result.get("staged_files", {})
            elapsed_ms = result.get("elapsed_ms", 0)
            success = result.get("success", False)

            # Plan summary
            if plan:
                plan_text = "\n### Plan\n"
                for step in plan:
                    plan_text += f"- [{step.get('action')}] `{step.get('path')}` — {step.get('description')}\n"
                yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": plan_text}))

            # Staged files summary
            if staged:
                staged_text = f"\n### Staged Files ({len(staged)})\n"
                for path in staged:
                    staged_text += f"- `{path}`\n"
                yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": staged_text}))

            # Verdict
            verdict_text = f"\n### Verdict: {'Approved' if verdict == 'approved' else 'Changes Requested'}\n"
            if review_notes:
                verdict_text += f"\n{review_notes}\n"
            verdict_text += f"\n*Completed in {elapsed_ms}ms*\n"
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": verdict_text}))

            # Structured swarm result as data event
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                "agent_status": agent_status_event(
                    phase="swarm_done",
                    label=f"Swarm {'approved' if success else 'needs changes'}",
                    started_at=started_at,
                ),
            }))

            # Include the full result in a server_tool_event so the frontend can access it
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                "server_tool_event": swarm_result_server_tool_event(
                    success=success,
                    verdict=verdict,
                    review_notes=review_notes,
                    staged_files=list(staged.keys()),
                    plan=plan,
                    elapsed_ms=elapsed_ms,
                ),
            }))
            _mark_request_finished(
                model=body.model,
                success=success,
                summary=f"model={body.model} mode=swarm verdict={verdict} elapsed_ms={elapsed_ms}",
            )
            _finalize_session(success)

        except Exception as e:  # noqa: BLE001 - reported in-stream to the client as a pipeline error
            error_text = f"\n\n**Swarm Pipeline Error:** {str(e)}\n"
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": error_text}))
            yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                "agent_status": agent_status_event(
                    phase="swarm_error",
                    label=f"Pipeline error: {str(e)[:60]}",
                    started_at=started_at,
                ),
            }))
            _mark_request_finished(
                model=body.model,
                success=False,
                summary=f"model={body.model} mode=swarm error={str(e)[:80]}",
            )
            _finalize_session(False, str(e)[:200])

        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {}, finish_reason="stop"))
        yield "data: [DONE]\n\n"

    return StreamingResponse(swarm_stream(), media_type="text/event-stream")
