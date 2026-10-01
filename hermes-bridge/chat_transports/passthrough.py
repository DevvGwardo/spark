"""PassthroughTransport: proxy the request straight to the provider, no agent."""
from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi.responses import JSONResponse

from bridge_state import _mark_request_finished
from chat_common import _passthrough_chat_completions
from chat_transports.base import BaseChatTransport, TransportCapabilities
from moa_config import MOA_PROVIDER_ID

if TYPE_CHECKING:  # fastapi is stubbed without Response in the unit tests
    from fastapi.responses import Response


class PassthroughTransport(BaseChatTransport):
    name = "passthrough"
    capabilities = TransportCapabilities()

    async def handle(self) -> Response:
        ctx = self.ctx
        body = ctx.body
        if ctx.resolved_provider == MOA_PROVIDER_ID:
            _mark_request_finished(
                model=body.model,
                success=False,
                summary=f"model={body.model} mode=passthrough error=moa-not-supported",
            )
            ctx.finalize_session(False, "MoA is not supported in passthrough mode.")
            return JSONResponse(
                status_code=400,
                content={"error": {"message": "MoA presets require the Hermes agent loop so the aggregator can use tools."}},
            )
        print(
            f"[hermes-bridge] Passthrough mode. model={body.model} msgs={len(ctx.request_messages)} extra_keys={list((body.model_extra or {}).keys())}",
            flush=True,
        )
        return await _passthrough_chat_completions(
            body,
            ctx.agent_api_key,
            base_url=ctx.agent_base_url,
            finalize_request=lambda success: (
                ctx.finalize_session(success),
                _mark_request_finished(
                    model=body.model,
                    success=success,
                    summary=f"model={body.model} mode=passthrough success={str(success).lower()}",
                ),
            ),
        )
