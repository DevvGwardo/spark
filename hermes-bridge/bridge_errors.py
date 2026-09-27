"""
bridge_errors.py — the error contract shared by the bridge, Node and the UI.

Every Hermes failure that reaches the client is one envelope:

    {"error": {"code": <Code>, "message": <str>, "retryable": <bool>, "details": <obj>}}

The `code` enum is closed. Callers switch on it instead of pattern-matching a
human-readable message, which is what the UI used to do — `ChatErrorBanner`
carried three regexes, including one that scraped suggested model names out of
a sentence. Anything a caller needs to act on belongs in `details`, as data.

`hermes-bridge/generate_error_schema.py` turns these models into
`shared/hermes-errors.schema.json`, from which
`scripts/generate-hermes-contract.mjs` emits the zod validators and TS types the
Node and UI sides use. Changing a code here and not regenerating fails CI.

Codes are deliberately coarse and about *what the caller should do*, not about
which layer failed: retry, fix the model, fix the request, or give up.
"""

from __future__ import annotations

from typing import Any, Optional

try:  # pragma: no cover - exercised via the suite's stub in tests
    from pydantic import BaseModel, Field
except ImportError:  # pragma: no cover
    BaseModel = object  # type: ignore[assignment,misc]

    def Field(default=None, default_factory=None, **kwargs):  # type: ignore[misc]
        return default


# The closed enum. Order is irrelevant; membership is what matters.
# Keep in sync with HERMES_ERROR_CODES in the TypeScript contract, which CI checks.
BRIDGE_UNREACHABLE = "BRIDGE_UNREACHABLE"
BRIDGE_STARTING = "BRIDGE_STARTING"
BRIDGE_AUTH = "BRIDGE_AUTH"
UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT"
MODEL_INCOMPATIBLE = "MODEL_INCOMPATIBLE"
PROVIDER_ERROR = "PROVIDER_ERROR"
APPROVAL_EXPIRED = "APPROVAL_EXPIRED"
VALIDATION = "VALIDATION"
INTERNAL = "INTERNAL"

ERROR_CODES: tuple[str, ...] = (
    BRIDGE_UNREACHABLE,
    BRIDGE_STARTING,
    BRIDGE_AUTH,
    UPSTREAM_TIMEOUT,
    MODEL_INCOMPATIBLE,
    PROVIDER_ERROR,
    APPROVAL_EXPIRED,
    VALIDATION,
    INTERNAL,
)

# Whether a retry of the identical request could plausibly succeed. The UI uses
# this to decide whether to offer a Retry button, so it is a contract field
# rather than something each layer re-derives.
RETRYABLE_CODES: frozenset[str] = frozenset({
    BRIDGE_UNREACHABLE,
    BRIDGE_STARTING,
    UPSTREAM_TIMEOUT,
    PROVIDER_ERROR,
})


class HermesErrorDetails(BaseModel):
    """Structured extras a caller can act on.

    Every field is optional because which ones are populated depends on the code.
    They are typed as open objects rather than rejected when absent, because
    hermes-agent and the gateway can add context without a bridge release.
    """

    model_config = {"extra": "allow"}

    # MODEL_INCOMPATIBLE
    current_model: Optional[str] = None
    suggested_models: Optional[list] = None
    # BRIDGE_STARTING / BRIDGE_UNREACHABLE
    bridge_url: Optional[str] = None
    retry_after_ms: Optional[int] = None
    # APPROVAL_EXPIRED
    approval_id: Optional[str] = None
    # PROVIDER_ERROR / INTERNAL — a provider-side error string, kept separate
    # from `message` so the UI can style it as a cause rather than the summary.
    provider_message: Optional[str] = None
    provider_status: Optional[int] = None


class HermesErrorBody(BaseModel):
    """The inner body: what went wrong, and whether trying again could work."""

    code: str
    message: str
    retryable: bool = False
    details: Optional[HermesErrorDetails] = None


class HermesErrorEnvelope(BaseModel):
    """The wire shape: always wrapped in `error`."""

    error: HermesErrorBody


class BridgeError(Exception):
    """A Hermes failure that already knows its envelope.

    Raising this from anywhere in the bridge lets the FastAPI handler emit the
    contract shape directly, instead of the layer that catches it having to
    reconstruct a code from an exception string.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: Optional[bool] = None,
        details: Optional[dict] = None,
        status_code: int = 502,
    ) -> None:
        super().__init__(message)
        if code not in ERROR_CODES:
            raise ValueError(f"unknown Hermes error code: {code!r}")
        self.code = code
        self.message = message
        # An explicit retryable wins; otherwise fall back to the code's default.
        self.retryable = RETRYABLE_CODES.__contains__(code) if retryable is None else bool(retryable)
        self.details = dict(details) if details else None
        self.status_code = status_code

    def to_envelope(self) -> dict:
        """The wire dict. `details` is omitted when empty rather than sent null."""
        body: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.details:
            body["details"] = self.details
        return {"error": body}


def is_retryable(code: str) -> bool:
    """Whether a code is retryable by default. Single source for both runtimes."""
    return code in RETRYABLE_CODES
