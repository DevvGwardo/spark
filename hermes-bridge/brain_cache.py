"""
Brain HTTP cache — pooled cross-session caching via the brain gateway.

This module is standalone (no hermes-agent dependency) so it can be tested
independently of the adapter's other imports.
"""

import json
import os
import httpx
from typing import Optional
from urllib.parse import quote

# ---------------------------------------------------------------------------
# Brain gateway configuration
# ---------------------------------------------------------------------------
_BRAIN_GATEWAY_URL = "http://localhost:18789"
_BRAIN_GATEWAY_TOKEN: Optional[str] = None  # loaded lazily

# ---------------------------------------------------------------------------
# Circuit breaker for upstream API calls
# ---------------------------------------------------------------------------


class _CircuitBreaker:
    """Prevents cascading failures by opening the circuit after consecutive errors."""

    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failures = 0
        self.last_failure_time: Optional[float] = None
        self.state = "closed"  # closed | open | half-open

    def record_success(self):
        self.failures = 0
        self.state = "closed"

    def record_failure(self):
        self.failures += 1
        import time as _time

        self.last_failure_time = _time.monotonic()
        if self.failures >= self.failure_threshold:
            self.state = "open"

    def is_available(self) -> bool:
        if self.state == "closed":
            return True
        if self.state == "open":
            import time as _time

            if (
                self.last_failure_time
                and (_time.monotonic() - self.last_failure_time)
                >= self.recovery_timeout
            ):
                self.state = "half-open"
                return True
            return False
        return True  # half-open: allow one attempt

    def get_state(self) -> str:
        return self.state


# Circuit breaker for brain gateway (threshold=3, faster to open for unreliable network)
_brain_circuit = _CircuitBreaker(failure_threshold=3, recovery_timeout=15.0)

# ---------------------------------------------------------------------------
# Token loading
# ---------------------------------------------------------------------------


def _get_brain_token() -> Optional[str]:
    """Load Bearer token from openclaw.json gateway config, then HERMES_BRAIN_TOKEN env var."""
    global _BRAIN_GATEWAY_TOKEN
    if _BRAIN_GATEWAY_TOKEN is not None:
        return _BRAIN_GATEWAY_TOKEN
    try:
        import json as _json

        config_path = os.path.expanduser("~/.openclaw/openclaw.json")
        with open(config_path, "r") as f:
            cfg = _json.load(f)
        gateway = cfg.get("gateway", {})
        auth = gateway.get("auth", {})
        token = auth.get("token", "")
        if token:
            _BRAIN_GATEWAY_TOKEN = token
            return token
    except Exception:
        pass
    # Fallback: dedicated env var for the brain gateway token
    # (NOT MINIMAX_API_KEY — that is the LLM API key, not the gateway token)
    _BRAIN_GATEWAY_TOKEN = os.environ.get("HERMES_BRAIN_TOKEN", "")
    return _BRAIN_GATEWAY_TOKEN


# ---------------------------------------------------------------------------
# HTTP configuration
# ---------------------------------------------------------------------------
_HTTPX_TIMEOUT_EXCEPTION = getattr(httpx, "TimeoutException", TimeoutError)
_BRAIN_HTTP_TIMEOUT = float(os.environ.get("HERMES_BRAIN_HTTP_TIMEOUT", "5.0"))


def _brain_http_call(
    method: str, path: str, json_body: Optional[dict] = None
) -> Optional[dict]:
    """Make a synchronous HTTP call to the brain gateway. Returns None on failure."""
    token = _get_brain_token()
    if not token:
        print("[brain-cache] brain gateway token not available", flush=True)
        return None
    try:
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        with httpx.Client(timeout=_BRAIN_HTTP_TIMEOUT) as client:
            if method == "GET":
                resp = client.get(f"{_BRAIN_GATEWAY_URL}{path}", headers=headers)
            elif method == "POST":
                resp = client.post(
                    f"{_BRAIN_GATEWAY_URL}{path}",
                    headers=headers,
                    json=json_body,
                )
            else:
                return None
            if resp.status_code in (200, 201):
                return resp.json() if resp.content else {}
            if resp.status_code == 401:
                print(
                    f"[brain-cache] brain gateway auth failed (401) — token may be expired",
                    flush=True,
                )
            elif resp.status_code == 404:
                print(
                    f"[brain-cache] brain gateway endpoint not found: {path}",
                    flush=True,
                )
            return None
    except _HTTPX_TIMEOUT_EXCEPTION:
        print(
            f"[brain-cache] brain gateway timeout ({_BRAIN_HTTP_TIMEOUT}s) for {method} {path}",
            flush=True,
        )
        return None
    except Exception as e:
        print(
            f"[brain-cache] brain HTTP call failed for {method} {path}: {e}",
            flush=True,
        )
        return None


# ---------------------------------------------------------------------------
# Retry helper
# ---------------------------------------------------------------------------


def _retry_brain_call(func, *args, retries: int = 2, backoff: float = 0.5, **kwargs):
    """Call a brain gateway function with retry and exponential backoff."""
    import time as _time

    for attempt in range(retries + 1):
        if not _brain_circuit.is_available():
            print(
                f"[brain-cache] brain circuit is {'open' if _brain_circuit.get_state() == 'open' else 'half-open'}, skipping call",
                flush=True,
            )
            return None
        try:
            result = func(*args, **kwargs)
            if result is not None:
                _brain_circuit.record_success()
                return result
            _brain_circuit.record_failure()
        except Exception as e:
            print(
                f"[brain-cache] brain call attempt {attempt + 1} failed: {e}",
                flush=True,
            )
            _brain_circuit.record_failure()
        if attempt < retries:
            _time.sleep(backoff * (2**attempt))
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def brain_safe_set(key: str, value: str, ttl: int = 300) -> bool:
    """Store in brain cache with TTL and circuit-breaker retry."""
    result = _retry_brain_call(
        _brain_http_call, "POST", "/state/set", {"key": key, "value": value, "ttl": ttl}
    )
    return result is not None


def brain_safe_get(key: str) -> Optional[str]:
    """Retrieve from brain cache. Returns None on miss or brain unavailable."""
    result = _retry_brain_call(
        _brain_http_call, "GET", f"/state/get?key={quote(key, safe='')}"
    )
    if result and "value" in result:
        return result["value"]
    return None


def brain_safe_delete(key: str) -> bool:
    """Delete from brain cache. Graceful no-op if brain unavailable."""
    result = _retry_brain_call(
        _brain_http_call, "POST", "/state/delete", {"key": key}
    )
    return result is not None
