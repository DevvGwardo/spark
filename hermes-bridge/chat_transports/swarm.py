"""SwarmTransport: ``x-hermes-execution-mode: swarm`` hands off to /v1/swarm."""
from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi.responses import JSONResponse

import routes.swarm
from bridge_state import _mark_request_finished
from chat_transports.base import BaseChatTransport, TransportCapabilities
from moa_config import MOA_PROVIDER_ID

if TYPE_CHECKING:  # fastapi is stubbed without Response in the unit tests
    from fastapi.responses import Response


class SwarmTransport(BaseChatTransport):
    name = "swarm"
    capabilities = TransportCapabilities()

    async def handle(self) -> Response:
        ctx = self.ctx
        body = ctx.body
        if ctx.resolved_provider == MOA_PROVIDER_ID:
            _mark_request_finished(
                model=body.model,
                success=False,
                summary=f"model={body.model} mode=swarm error=moa-not-supported",
            )
            ctx.finalize_session(False, "MoA is not supported in swarm mode yet.")
            return JSONResponse(
                status_code=400,
                content={"error": {"message": "MoA presets currently run through the normal Hermes agent loop, not swarm mode."}},
            )
        # Redirect to the dedicated swarm endpoint handler
        print(f"[hermes-bridge] Swarm mode. model={body.model} msgs={len(ctx.request_messages)}", flush=True)
        swarm_body = routes.swarm.SwarmRequest(
            model=body.model,
            messages=ctx.request_messages,
            stream=body.stream,
            **(body.model_extra or {}),
        )
        return await routes.swarm.swarm_endpoint(ctx.request, swarm_body)
