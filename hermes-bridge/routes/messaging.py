"""Routes: /messaging/platforms and the Discord/Slack OAuth callbacks.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import subprocess

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from bridge_workspace import _ops_thread
from messaging_platforms import (
    complete_oauth as _complete_oauth,
    disconnect_platform as _disconnect_platform,
    get_oauth_status as _get_oauth_status,
    get_platform as _get_platform,
    list_platforms as _list_platforms,
    test_platform_connection as _test_platform_connection,
    update_platform_config as _update_platform_config,
    update_platform_env as _update_platform_env,
)

router = APIRouter()


# ------------------------------------------------------------------
# Messaging Platform Configuration
# ------------------------------------------------------------------



@router.get("/messaging/platforms")
async def messaging_list_platforms():
    try:
        return JSONResponse(content={"platforms": _list_platforms()})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/messaging/platforms/{platform_id}")
async def messaging_get_platform(platform_id: str):
    result = _get_platform(platform_id)
    if not result:
        return JSONResponse(status_code=404, content={"error": f"Platform '{platform_id}' not found"})
    return JSONResponse(content={"platform": result})


@router.put("/messaging/platforms/{platform_id}/env")
async def messaging_update_env(platform_id: str, request: Request):
    try:
        body = await request.json()
        updates = body.get("env", {})
        if not isinstance(updates, dict):
            return JSONResponse(status_code=400, content={"error": "'env' must be a dict"})
        result = _update_platform_env(platform_id, updates)
        return JSONResponse(content={"platform": result})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.put("/messaging/platforms/{platform_id}/config")
async def messaging_update_config(platform_id: str, request: Request):
    try:
        body = await request.json()
        updates = body.get("config", {})
        if not isinstance(updates, dict):
            return JSONResponse(status_code=400, content={"error": "'config' must be a dict"})
        result = _update_platform_config(platform_id, updates)
        return JSONResponse(content={"platform": result})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.delete("/messaging/platforms/{platform_id}")
async def messaging_disconnect_platform(platform_id: str):
    try:
        result = _disconnect_platform(platform_id)
        return JSONResponse(content={"platform": result})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/messaging/platforms/{platform_id}/test")
async def messaging_test_platform(platform_id: str):
    try:
        result = _test_platform_connection(platform_id)
        return JSONResponse(content=result)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/messaging/platforms/{platform_id}/restart-gateway")
async def messaging_restart_gateway(platform_id: str):
    """Restart the gateway for a specific platform."""
    try:
        result = await _ops_thread(
            subprocess.run,
            ["hermes", "gateway", "restart", "--platform", platform_id],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            return JSONResponse(
                status_code=500,
                content={"error": f"restart failed: {result.stderr.strip()}"},
            )
        return JSONResponse(content={"success": True, "message": f"Gateway restarted for platform {platform_id}"})
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "restart timed out"})
    except FileNotFoundError:
        return JSONResponse(status_code=500, content={"error": "hermes command not found"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ─── OAuth 1-Click Setup ──────────────────────────────────────────────────

@router.get("/messaging/platforms/{platform_id}/oauth")
async def messaging_oauth_status(platform_id: str):
    """Return OAuth setup status and auth URL for a platform."""
    try:
        result = _get_oauth_status(platform_id)
        return JSONResponse(content=result)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/messaging/platforms/{platform_id}/oauth/complete")
async def messaging_oauth_complete(platform_id: str, request: Request):
    """Exchange an OAuth code for tokens and save them."""
    try:
        body = await request.json()
        code = body.get("code")
        if not code:
            return JSONResponse(status_code=400, content={"error": "Missing 'code' in request body"})
        result = _complete_oauth(platform_id, code)
        return JSONResponse(content=result)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ─── OAuth Callback (used when user clicks "Authorize" in popup) ───────────
# This route is hit by the OAuth provider after the user authorizes.
# It exchanges the code for tokens server-side and shows a success page
# that closes the popup and signals the opener.

@router.get("/discord/callback")
async def discord_oauth_callback(request: Request):
    from fastapi.responses import HTMLResponse
    code = request.query_params.get("code")
    error = request.query_params.get("error")
    if error or not code:
        return HTMLResponse(
            status_code=400,
            content="<html><body><h2>Discord authorization failed</h2>"
            f"<p>{error or 'No code received'}</p>"
            "<script>window.close()</script></body></html>",
        )
    try:
        _complete_oauth("discord", code)
        return HTMLResponse(
            status_code=200,
            content="<html><body>"
            "<h2> Discord connected!</h2>"
            "<p>You can close this window now.</p>"
            "<script>"
            "if (window.opener) { window.opener.postMessage('oauth-success:discord', '*'); }"
            "setTimeout(() => window.close(), 1500);"
            "</script></body></html>",
        )
    except Exception as e:
        return HTMLResponse(
            status_code=500,
            content=f"<html><body><h2>Error</h2><p>{str(e)}</p>"
            "<script>setTimeout(() => window.close(), 3000)</script></body></html>",
        )


@router.get("/slack/callback")
async def slack_oauth_callback(request: Request):
    from fastapi.responses import HTMLResponse
    code = request.query_params.get("code")
    error = request.query_params.get("error")
    if error or not code:
        return HTMLResponse(
            status_code=400,
            content="<html><body><h2>Slack authorization failed</h2>"
            f"<p>{error or 'No code received'}</p>"
            "<script>window.close()</script></body></html>",
        )
    try:
        _complete_oauth("slack", code)
        return HTMLResponse(
            status_code=200,
            content="<html><body>"
            "<h2> Slack connected!</h2>"
            "<p>You can close this window now.</p>"
            "<script>"
            "if (window.opener) { window.opener.postMessage('oauth-success:slack', '*'); }"
            "setTimeout(() => window.close(), 1500);"
            "</script></body></html>",
        )
    except Exception as e:
        return HTMLResponse(
            status_code=500,
            content=f"<html><body><h2>Error</h2><p>{str(e)}</p>"
            "<script>setTimeout(() => window.close(), 3000)</script></body></html>",
        )
