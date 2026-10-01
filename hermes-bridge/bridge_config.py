"""Bridge process configuration from the environment, plus token-auth helpers.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import hmac
import os
import sys
from typing import Optional

from fastapi import Request


HERMES_PORT = int(os.environ.get("HERMES_PORT", "3002"))
# Default to loopback so LAN clients cannot reach mutating ops. Override with
# HERMES_BRIDGE_HOST=0.0.0.0 only when intentionally exposing the bridge.
HERMES_BRIDGE_HOST = os.environ.get("HERMES_BRIDGE_HOST", "127.0.0.1").strip() or "127.0.0.1"
OPENROUTER_KEY = os.environ.get("HERMES_OPENROUTER_KEY", "")
MINIMAX_KEY = os.environ.get("HERMES_MINIMAX_KEY", "")
HERMES_BRIDGE_TOKEN = os.environ.get("HERMES_BRIDGE_TOKEN", "")
HERMES_BRIDGE_VERSION = os.environ.get("HERMES_BRIDGE_VERSION", "dev")
DEFAULT_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "web,browser,terminal")
# Paths that stay reachable without the token even from loopback.
#
# /health  — readiness and ownership polling; must answer before a caller can
#            possibly have authenticated.
# /diag    — the Electron supervisor's ownership check. It probes /diag precisely
#            to decide whether a bridge process on the port is *its own*; gating
#            that would make an un-authenticated prober unable to adopt or verify
#            the process it launched, and it would then tear the bridge down as
#            "unowned". The supervisor now also sends the token (see
#            electron/bridge.ts), so this exemption is belt-and-braces and can be
#            dropped once /diag stops being an adoption probe.
_BRIDGE_AUTH_EXEMPT_PATHS = frozenset({"/health", "/diag"})

# One-release escape hatch. Phase 2.4 tightened loopback to require the token,
# which closes G2: the chat approval forward and the runs-cancel path had been
# relying on loopback being open. If this locks out an external script or the
# mobile path, set HERMES_BRIDGE_ALLOW_LOOPBACK_NOAUTH=1 to restore the old
# behaviour. Every use is logged, so the hatch is visible rather than silent.
_BRIDGE_ALLOW_LOOPBACK_NOAUTH = (
    os.environ.get("HERMES_BRIDGE_ALLOW_LOOPBACK_NOAUTH", "").strip() == "1"
)
_warned_loopback_noauth = False


def _loopback_noauth_allowed() -> bool:
    """Escape-hatch check, warned about once per process on first use."""
    global _warned_loopback_noauth
    if not _BRIDGE_ALLOW_LOOPBACK_NOAUTH:
        return False
    if not _warned_loopback_noauth:
        _warned_loopback_noauth = True
        print(
            "[hermes-bridge] WARNING: HERMES_BRIDGE_ALLOW_LOOPBACK_NOAUTH=1 is set — "
            "loopback requests are being accepted without the bridge token. This "
            "re-opens G2 and must be removed.",
            file=sys.stderr,
            flush=True,
        )
    return True


def _is_loopback_host(host: Optional[str]) -> bool:
    if not host:
        return False
    h = host.split("%", 1)[0].strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    return h in ("127.0.0.1", "::1", "localhost")


def _bridge_token_matches(provided: str) -> bool:
    if not provided or not HERMES_BRIDGE_TOKEN:
        return False
    try:
        return hmac.compare_digest(provided.encode("utf-8"), HERMES_BRIDGE_TOKEN.encode("utf-8"))
    except (TypeError, ValueError):
        return False


def _extract_bridge_token(request: Request) -> str:
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("x-hermes-bridge-token") or "").strip()
