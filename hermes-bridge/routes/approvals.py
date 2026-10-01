"""Routes: /v1/approvals/{approval_id} (ACP permission decisions).

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()


@router.post("/v1/approvals/{approval_id}")
async def acp_approval_route(approval_id: str, body: dict = None):
    """Resolve a pending ACP permission request with the user's decision.

    Body: ``{"option_id": "allow_once" | "allow_session" | "allow_always" | "deny"}``
    Mirrors the UI's once/session/always scopes; the hermes ACP adapter maps
    these onto its own approval semantics.
    """
    try:
        import acp_transport

        option_id = ""
        if isinstance(body, dict):
            option_id = str(body.get("option_id") or "").strip()
        if not option_id:
            return JSONResponse(status_code=400, content={"error": {"message": "option_id is required"}})
        delivered = await acp_transport.resolve_approval(approval_id, option_id)
        if not delivered:
            return JSONResponse(status_code=404, content={"error": {"message": f"Unknown or expired approval: {approval_id}"}})
        return {"ok": True, "approval_id": approval_id, "option_id": option_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": {"message": str(e)}})
