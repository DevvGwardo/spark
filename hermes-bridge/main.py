"""Hermes bridge entry point: app factory, middleware, error envelope, lifespan.

Routes live in ``routes/`` (one ``APIRouter`` per area) and the helpers they
share live in ``bridge_*`` / ``chat_*`` / ``acp_chat`` modules. This file only
wires them together, so ``python main.py`` (scripts/start-bridge.sh,
electron/bridge.ts) keeps working unchanged.
"""
import os
os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
from bridge_logger import log as _log
import asyncio
import sys
import time
from typing import Optional
import mcp_telemetry
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import bridge_config
import bridge_loop_monitor
import bridge_providers
import bridge_state
import bridge_workspace
from bridge_config import (
    DEFAULT_TOOLSETS,
    HERMES_BRIDGE_HOST,
    HERMES_PORT,
    _BRIDGE_AUTH_EXEMPT_PATHS,
    _bridge_token_matches,
    _extract_bridge_token,
    _is_loopback_host,
    _loopback_noauth_allowed,
)
from bridge_providers import DEFAULT_MODEL, MAX_AGENT_ITERATIONS
from bridge_state import _bridge_metrics_snapshot

app: FastAPI = None  # created after brain-lifespan is defined

# --- Brain MCP integration ---
# The brain subprocess handle and the JSON-RPC layer live in brain_client.py, not
# here. swarm_pattern.py needs the same RPC layer and used to reach it through
# `import main` — but the bridge runs as `python main.py` (scripts/start-bridge.sh),
# so that import loaded a SECOND copy of this file whose _brain_proc was always
# None. Every brain RPC made from a swarm therefore returned None, silently, while
# the real bridge instance kept a healthy handle in its own copy. Both modules now
# depend on brain_client; brain_client depends on neither, so there is no cycle.
#
# These names are re-exported into main's namespace for old import paths. The
# code that calls them now lives in other modules and reaches them as
# `brain_client.<name>`, so tests patch brain_client, not main.
import brain_client
from brain_client import (
    _brain_call_async,
    _brain_claim,
    _brain_contract_check,
    _brain_contract_get,
    _brain_contract_set,
    _brain_dm,
    _brain_get,
    _brain_post,
    _brain_pulse,
    _brain_release,
    _brain_rpc,
    _brain_set,
    _claimed_resources,
    _claimed_resources_lock,
)


brain_client.set_metrics_provider(_bridge_metrics_snapshot)


async def _bridge_lifespan(app):
    """FastAPI lifespan — bring up brain, cron and telemetry, then tear them down.

    Ordering is load-bearing. Brain is an optional integration whose startup can
    legitimately fail (no `node`, no brain-mcp checkout), so it goes first and is
    fully isolated. Cron and MCP telemetry are NOT optional and must come up
    whether or not brain connected.
    """
    global _cron_scheduler_task

    # These are bridge counters, not brain state. Previously they were only
    # initialized inside the brain startup block, so when brain was unavailable
    # _bridge_start_time stayed 0.0 and both /diag and the published
    # bridge:metrics reported a zero start_time. Initialize them unconditionally.
    # The counters live in bridge_state so every module shares one copy.
    with bridge_state._metrics_lock:
        bridge_state._bridge_start_time = time.time()
        bridge_state._bridge_total_requests = 0
        bridge_state._bridge_error_count = 0

    try:
        await brain_client.start_brain(
            brain_client.BrainConfig(
                port=HERMES_PORT,
                model=DEFAULT_MODEL,
                toolsets=DEFAULT_TOOLSETS,
                max_iterations=MAX_AGENT_ITERATIONS,
            )
        )
    except Exception as e:
        # start_brain already swallows its own failures; this is belt-and-braces so
        # a malformed config can never stop the bridge from serving.
        _log.error("brain", "brain startup failed", error=str(e))

    # These used to be @app.on_event("startup") handlers. FastAPI ignores on_event
    # entirely when `lifespan=` is supplied, which this app does — so neither ever
    # ran and the cron scheduler never ticked.
    try:
        _init_mcp_telemetry()
    except Exception as e:
        print(f"[mcp-telemetry] startup init failed: {e}", flush=True)
    _cron_scheduler_task = _start_cron_scheduler()

    # Chat routing reads gateway capabilities from a cache and never probes
    # inline (spec 5.2); warm it so the first request after startup has an answer.
    try:
        import hermes_runs

        hermes_runs.warm_gateway_capabilities()
    except Exception as e:  # noqa: BLE001 - optimisation only; routing falls back to agent-loop
        _log.warning("runs", "gateway capability warm-up failed", error=str(e))

    _lag_monitor = bridge_loop_monitor.start_if_enabled()

    yield

    if _lag_monitor is not None:
        _lag_monitor.cancel()

    # Tear down in reverse order. Cancellation is awaited so shutdown does not
    # leave orphaned tasks behind the ACP children.
    #
    # asyncio.CancelledError inherits BaseException, not Exception, so an
    # `except Exception` here does NOT catch the cancellation we just requested
    # and the error escapes the lifespan, breaking shutdown.
    if _cron_scheduler_task:
        _cron_scheduler_task.cancel()
        try:
            await _cron_scheduler_task
        except asyncio.CancelledError:
            pass  # expected — we just cancelled it
        except Exception as e:
            print(f"[cron] scheduler shutdown error: {e}", flush=True)
    _cron_scheduler_task = None

    await brain_client.stop_brain()

    # Shut down ACP sessions so spawned hermes-acp children don't outlive
    # the bridge on restart. Safe no-op when the SDK/transport is absent.
    try:
        import acp_transport

        await acp_transport.shutdown_all()
    except Exception:
        pass


app = FastAPI(title="Hermes Bridge", lifespan=_bridge_lifespan)


# --- Error envelope (spec Phase 1.4) ------------------------------------------------
# Every error leaving the bridge is {"error": {code, message, retryable, details?}}
# with a closed code enum, so the UI switches on `code` instead of pattern-matching
# message strings. Defined in bridge_errors.py, which also owns the enum; the
# Python and TypeScript enums are kept in sync by a contract test.

from bridge_errors import (  # noqa: E402
    BRIDGE_AUTH,
    BRIDGE_STARTING,
    BRIDGE_UNREACHABLE,
    INTERNAL,
    PROVIDER_ERROR,
    UPSTREAM_TIMEOUT,
    VALIDATION,
    BridgeError,
    HermesErrorEnvelope,
)


@app.exception_handler(BridgeError)
async def _handle_bridge_error(request: Request, exc: BridgeError):
    """Emit a BridgeError's own envelope, verbatim."""
    return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())


@app.exception_handler(HTTPException)
async def _handle_http_exception(request: Request, exc: HTTPException):
    """Map FastAPI's HTTPException onto the same envelope.

    FastAPI raises this for 404s and validation failures, which would otherwise
    reach the client as {"detail": ...} — a second, incompatible error shape.
    """
    # Map the status onto a code. A 401/403 is an auth failure; a 4xx that is not
    # 401/403/404 is a client-side validation problem.
    if exc.status_code in (401, 403):
        code, retryable = BRIDGE_AUTH, False
    elif exc.status_code == 404:
        code, retryable = VALIDATION, False
    elif exc.status_code == 503:
        code, retryable = BRIDGE_STARTING, True
    elif exc.status_code == 504:
        code, retryable = UPSTREAM_TIMEOUT, True
    elif 400 <= exc.status_code < 500:
        code, retryable = VALIDATION, False
    else:
        code, retryable = (INTERNAL if exc.status_code >= 500 else PROVIDER_ERROR), (
            exc.status_code >= 500
        )
    detail = exc.detail
    message = detail if isinstance(detail, str) else str(detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": code, "message": message, "retryable": retryable}},
    )


@app.exception_handler(Exception)
async def _handle_unexpected_error(request: Request, exc: Exception):
    """Last resort: never leak a traceback or a bare {"detail"} to the client.

    Registered as a catch-all so an unexpected failure still produces a
    contract-shaped envelope. The traceback goes to the log, not the wire.
    """
    import traceback

    print(f"[hermes-bridge] unhandled error: {exc!r}", file=sys.stderr)
    traceback.print_exc()
    envelope = BridgeError(INTERNAL, "The bridge hit an unexpected error.", retryable=False)
    return JSONResponse(status_code=500, content=envelope.to_envelope())


# Codes the bridge itself raises for transport-level conditions, re-exported so
# callers (and tests) do not have to reach into bridge_errors for the common ones.
BRIDGE_ERROR_CODES = frozenset({
    BRIDGE_UNREACHABLE, BRIDGE_STARTING, BRIDGE_AUTH,
    UPSTREAM_TIMEOUT, PROVIDER_ERROR, VALIDATION, INTERNAL,
})

# Origins the app UI may load from. The renderer talks to the bridge only via the
# Express proxy (server-side fetch, no Origin header); browsers from any other
# origin are rejected in the token guard below so webpages cannot drive the
# bridge's privileged endpoints (chat, approvals, workspace writes) via CSRF.
_BRIDGE_ALLOWED_ORIGINS = frozenset(
    {
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    }
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(_BRIDGE_ALLOWED_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _auth_error(status_code: int, message: str, *, retryable: bool) -> JSONResponse:
    """An auth rejection in the Phase 1.4 envelope, not a bare {"error": str}."""
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": "BRIDGE_AUTH", "message": message, "retryable": retryable}},
    )


@app.middleware("http")
async def bridge_token_guard(request: Request, call_next):
    """When HERMES_BRIDGE_TOKEN is set, require it for non-loopback clients.

    Loopback (Electron, local Express proxy) stays open so chat can keep using
    Authorization for provider API keys. /health and /diag stay exempt so
    ownership probes and health polls work before auth is wired.
    """
    origin = request.headers.get("origin")
    if origin is not None and origin not in _BRIDGE_ALLOWED_ORIGINS:
        return _auth_error(403, "Forbidden origin", retryable=False)
    if not bridge_config.HERMES_BRIDGE_TOKEN:
        # No token configured at all: nothing to check. This is the local-dev
        # default and is unchanged, so an unconfigured bridge still works.
        return await call_next(request)
    if request.url.path in _BRIDGE_AUTH_EXEMPT_PATHS:
        return await call_next(request)

    client_host = request.client.host if request.client else None
    if _is_loopback_host(client_host) and _loopback_noauth_allowed():
        return await call_next(request)

    # Loopback is no longer exempt. A process on the same machine can reach every
    # mutating bridge endpoint without a token otherwise (G2), which is what let
    # the chat approval forward and runs-cancel skip it entirely.
    if not _bridge_token_matches(_extract_bridge_token(request)):
        return _auth_error(
            401,
            "Missing or invalid Hermes bridge token.",
            retryable=False,
        )
    return await call_next(request)


def _init_mcp_telemetry():
    """Restore persisted MCP dashboard telemetry so metrics survive restarts.

    Called from the lifespan, not from @app.on_event("startup"): FastAPI skips
    on_event handlers entirely whenever `lifespan=` is supplied, so the decorated
    version of this function never ran.
    """
    try:
        db_path = bridge_workspace._HERMES_HOME / "mcp-telemetry.db"
        ok = mcp_telemetry.init_persistence(db_path)
        print(f"[mcp-telemetry] persistence {'enabled' if ok else 'unavailable'} ({db_path})", flush=True)
    except Exception as e:
        print(f"[mcp-telemetry] startup init failed: {e}", flush=True)


# --- Routes -----------------------------------------------------------------------
# FastAPI matches routes in registration order, so the routers are included in the
# order their routes were declared in main.py before the split. Do not reorder;
# test_bridge_route_table.py pins the resulting table.
from routes import (  # noqa: E402
    approvals as _approvals_routes,
    chat as _chat_routes,
    cron as _cron_routes,
    health as _health_routes,
    mcp as _mcp_routes,
    messaging as _messaging_routes,
    ops as _ops_routes,
    providers as _providers_routes,
    sessions as _sessions_routes,
    skills as _skills_routes,
    swarm as _swarm_routes,
    workspace as _workspace_routes,
)
from routes.cron import _start_cron_scheduler  # noqa: E402

_ROUTERS = (
    _health_routes,
    _providers_routes,
    _ops_routes,
    _chat_routes,
    _approvals_routes,
    _swarm_routes,
    _cron_routes,
    _sessions_routes,
    _workspace_routes,
    _mcp_routes,
    _skills_routes,
    _messaging_routes,
)
for _routes_module in _ROUTERS:
    app.include_router(_routes_module.router)


# --- Re-export shim (spec §6) -------------------------------------------------------
# Everything that used to be defined in this file still resolves as
# `main.<name>`, so old import paths keep working. Lookups are live: reading
# `main._bridge_start_time` returns bridge_state's current value, not a copy.
# Patching `main.<name>` does NOT reach the moved code — patch the module that
# owns the name instead.
import acp_chat  # noqa: E402
import chat_common  # noqa: E402
import chat_impl  # noqa: E402

_REEXPORT_MODULES = (
    bridge_config,
    bridge_state,
    bridge_workspace,
    bridge_providers,
    chat_common,
    chat_impl,
    acp_chat,
) + _ROUTERS


def __getattr__(name: str):
    for module in _REEXPORT_MODULES:
        if name in vars(module):
            return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Handle for the running cron scheduler, owned by the lifespan so shutdown can
# cancel it and tests can assert it is alive. None means "not started".
_cron_scheduler_task: Optional[asyncio.Task] = None


if __name__ == "__main__":
    # Belt-and-braces for the module-identity problem. Running `python main.py`
    # binds this file to the `__main__` object, so any `import main` elsewhere
    # would execute it a second time under a second module object with its own,
    # disconnected globals. Registering this module under the name "main" means
    # such an import resolves here instead of re-executing.
    #
    # brain_client.py is the real fix — nothing needs to import main any more —
    # but this keeps any third-party or legacy `import main` honest.
    sys.modules.setdefault("main", sys.modules["__main__"])

    import uvicorn
    try:
        print(
            f"[bridge] listening on {HERMES_BRIDGE_HOST}:{HERMES_PORT} "
            f"(token={'set' if bridge_config.HERMES_BRIDGE_TOKEN else 'unset'})",
            flush=True,
        )
        uvicorn.run(app, host=HERMES_BRIDGE_HOST, port=HERMES_PORT)
    except KeyboardInterrupt:
        pass
