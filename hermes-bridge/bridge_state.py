"""Process-wide bridge request counters and the brain metrics publisher.

The counters are rebound at runtime (``global`` in the helpers here, and by the
lifespan in main.py), so other modules must read them as
``bridge_state._bridge_active_requests`` rather than importing the names.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import json
import threading
import time
from typing import Optional

import brain_client


def _bridge_metrics_snapshot() -> dict:
    """Sample the bridge counters for brain_client's heartbeat.

    Reads this module's globals at call time so rebinding them is picked up live.
    """
    return {
        "start_time": _bridge_start_time,
        "active_requests": _bridge_active_requests,
        "total_requests": _bridge_total_requests,
        "error_count": _bridge_error_count,
    }


# ------------------------------------------------------------------
# Metrics helper
# ------------------------------------------------------------------
_bridge_start_time: float = 0.0
_bridge_total_requests: int = 0
_bridge_error_count: int = 0
_bridge_active_requests: int = 0
# The counters are bumped from the request handlers AND from agent worker
# threads (the streaming paths finish on a thread), so `+= 1` on a module global
# can lose updates. Every read-modify-write goes through this lock (G16). The
# brain publish happens after it is released — it can block on IO.
_metrics_lock = threading.Lock()


def _update_bridge_metrics(
    success: bool,
    increment_active: bool = False,
    decrement_active: bool = False,
):
    global _bridge_error_count, _bridge_active_requests
    with _metrics_lock:
        if decrement_active:
            _bridge_active_requests = max(0, _bridge_active_requests - 1)
        if increment_active:
            _bridge_active_requests += 1
        if not success:
            _bridge_error_count += 1
        error_rate = _bridge_error_count / max(_bridge_total_requests, 1)
        uptime = time.time() - _bridge_start_time if _bridge_start_time else 0
        metrics = json.dumps({
            "api_calls": _bridge_total_requests,
            "error_rate": round(error_rate, 4),
            "active_requests": _bridge_active_requests,
            "uptime": round(uptime, 1),
            "start_time": _bridge_start_time,
            "total_requests": _bridge_total_requests,
            "error_count": _bridge_error_count,
        })
    brain_client._brain_set("bridge:metrics", metrics, "global")


def _mark_request_started(
    *,
    model: str,
    enabled_toolsets: list[str],
    repo_mode: bool,
    repo_owner: str,
    repo_name: str,
    repo_edit_intent: bool,
) -> str:
    global _bridge_total_requests
    with _metrics_lock:
        _bridge_total_requests += 1
        request_num = _bridge_total_requests
    _update_bridge_metrics(success=True, increment_active=True)
    active_job_meta = json.dumps({
        "owner": repo_owner or None,
        "repo": repo_name or None,
        "model": model,
        "toolsets": enabled_toolsets,
        "repo_mode": repo_mode,
        "edit_intent": repo_edit_intent,
        "request_num": request_num,
    })
    brain_client._brain_set("hermes-bridge:active_request", active_job_meta)
    brain_client._brain_set("hermes-bridge:active_sessions", str(_bridge_active_requests), "global")
    brain_client._brain_set("hermes-bridge:model", model, "global")
    brain_client._brain_set("hermes-bridge:toolsets", ",".join(enabled_toolsets), "global")
    return active_job_meta


def _mark_request_finished(*, model: str, success: bool, summary: Optional[str] = None):
    _update_bridge_metrics(success=success, decrement_active=True)
    brain_client._brain_set("hermes-bridge:active_request", "")
    brain_client._brain_set("hermes-bridge:active_sessions", str(_bridge_active_requests), "global")
    if summary:
        brain_client._brain_set("hermes-bridge:last_completion", summary, "global")
