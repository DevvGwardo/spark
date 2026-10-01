# Residual gaps (Phase 7+):
# - MoA on /v1/runs is opt-in: HERMES_RUNS_MOA=1 or gateway moa_runs capability.
# - Gateway POST /v1/runs with runs_parity accepts cwd, enabled_toolsets/toolsets,
#   provider, and reasoning_effort (probe features.runs_parity or HERMES_RUNS_PARITY=1).
# - Without runs_parity, those fields are omitted and agent-loop handles them.
# - computer_use on /v1/runs still lacks screenshot payloads in tool.completed SSE;
#   computer_use_frame screenshots require agent-loop tool_complete_callback.
# - repo_mode, github_pat, and custom_tools still require agent-loop.
# - /approve on runs path calls POST /v1/runs/{id}/approval; repo proposals stay agent-loop.
# - Approval UX for gateway tool approvals depends on gateway emitting approval.* SSE events.

from __future__ import annotations

import json
import logging
import os
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from urllib.parse import quote

import httpx

import hermes_ops
from hermes_ops import assert_safe_gateway_base_url, probe_gateway_capabilities

logger = logging.getLogger(__name__)

_TRUTHY = frozenset({"1", "true", "yes", "on"})
_VALID_REASONING_EFFORT = frozenset({
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
})
_AGENT_LOOP_PARITY_TOOLSETS = frozenset({"computer", "computer_use"})
_active_runs_lock = threading.Lock()
_active_runs: dict[str, "_ActiveRun"] = {}
# Connect fast; allow up to 5 minutes between SSE lines (long tool steps) so a
# hung gateway cannot pin a bridge worker forever with timeout=None.
_DEFAULT_RUN_SSE_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)


@dataclass
class _ActiveRun:
    run_id: str
    base_url: str
    api_key: Optional[str]
    cancelled: threading.Event = field(default_factory=threading.Event)


def normalize_reasoning_effort(raw: Any) -> Optional[str]:
    """Return a validated reasoning_effort string or None."""
    if not isinstance(raw, str):
        return None
    value = raw.strip().lower()
    return value if value in _VALID_REASONING_EFFORT else None


def parse_runs_moa_flag(*, env_value: Optional[str] = None) -> bool:
    """Return True when MoA may be routed via /v1/runs (HERMES_RUNS_MOA)."""
    raw = env_value if env_value is not None else os.environ.get("HERMES_RUNS_MOA")
    return str(raw or "").strip().lower() in _TRUTHY


def parse_runs_parity_flag(*, env_value: Optional[str] = None) -> bool:
    """Return True when Spark may send /v1/runs parity overrides (HERMES_RUNS_PARITY)."""
    raw = env_value if env_value is not None else os.environ.get("HERMES_RUNS_PARITY")
    return str(raw or "").strip().lower() in _TRUTHY


def extract_gateway_error_text(payload: dict[str, Any]) -> str:
    err = payload.get("error")
    if isinstance(err, dict):
        for key in ("message", "type", "code"):
            value = err.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(err, str) and err.strip():
        return err.strip()
    message = payload.get("message")
    if isinstance(message, str) and message.strip():
        return message.strip()
    try:
        return json.dumps(payload, ensure_ascii=False)[:500]
    except (TypeError, ValueError):
        return str(payload)[:500]


# ─── Capability cache for chat routing (spec 5.2) ────────────────────────────
# runs_parity_available / should_route_via_runs run on every chat request, in
# the async handler. They used to call probe_gateway_capabilities, whose cache
# miss is two synchronous urllib round-trips (up to 6s) on the event loop.
# They now read the last known capabilities and refresh them on a background
# thread (stale-while-revalidate); a cold cache answers "no gateway support",
# which routes to the always-safe agent loop until the first probe lands.

_caps_refresh_lock = threading.Lock()
_caps_refresh_inflight: set[tuple[str, bool]] = set()


def _refresh_capabilities_in_background(base_url: str, api_key: Optional[str]) -> None:
    key = (base_url, bool(api_key))
    with _caps_refresh_lock:
        if key in _caps_refresh_inflight:
            return
        _caps_refresh_inflight.add(key)

    def _run() -> None:
        try:
            probe_gateway_capabilities(base_url=base_url, api_key=api_key, force=True)
        except Exception:  # noqa: BLE001 - background probe; routing keeps the last answer
            logger.debug("gateway capabilities refresh failed for %s", base_url, exc_info=True)
        finally:
            with _caps_refresh_lock:
                _caps_refresh_inflight.discard(key)

    threading.Thread(target=_run, name="hermes-caps-refresh", daemon=True).start()


def cached_gateway_capabilities(
    base_url: str = "http://127.0.0.1:8642",
    api_key: Optional[str] = None,
) -> dict[str, Any]:
    """Last known gateway capabilities, never blocking; refreshes in the background when stale."""
    try:
        caps, fresh = hermes_ops.peek_gateway_capabilities(base_url=base_url, api_key=api_key)
    except Exception:  # noqa: BLE001 - unsafe/invalid base URL means "no gateway"
        logger.debug("gateway capabilities peek failed for %s", base_url, exc_info=True)
        return {}
    if not fresh:
        _refresh_capabilities_in_background(base_url, api_key)
    return caps or {}


def warm_gateway_capabilities() -> threading.Thread:
    """Probe the local gateway in the background so the first chat request has an answer.

    Warms both cache keys chat routing can hit (with and without a gateway
    key). Key resolution reads hermes config files, so it happens on the
    background thread too.
    """
    def _run() -> None:
        base_url = resolve_gateway_base_url()
        try:
            import bridge_providers

            key = (
                os.environ.get("HERMES_API_KEY", "").strip()
                or os.environ.get("API_SERVER_KEY", "").strip()
                or (bridge_providers._get_local_gateway_key() or "")
            )
        except Exception:  # noqa: BLE001 - warm-up is an optimisation only
            logger.debug("gateway key resolution failed during warm-up", exc_info=True)
            key = ""
        for api_key in (None, key or None):
            try:
                probe_gateway_capabilities(base_url=base_url, api_key=api_key, force=True)
            except Exception:  # noqa: BLE001 - warm-up is an optimisation only
                logger.debug("gateway capabilities warm-up failed", exc_info=True)

    thread = threading.Thread(target=_run, name="hermes-caps-warm", daemon=True)
    thread.start()
    return thread


def _capabilities(base_url: str, api_key: Optional[str], blocking: bool) -> dict[str, Any]:
    if blocking:
        return probe_gateway_capabilities(base_url=base_url, api_key=api_key)
    return cached_gateway_capabilities(base_url=base_url, api_key=api_key)


def gateway_supports_moa_runs(
    base_url: str = "http://127.0.0.1:8642",
    api_key: Optional[str] = None,
    *,
    blocking: bool = True,
) -> bool:
    """Probe gateway /v1/capabilities for MoA run submission support."""
    try:
        caps = _capabilities(base_url, api_key, blocking)
    except Exception:  # noqa: BLE001 - an unreachable gateway means "unsupported"
        logger.debug("gateway capabilities probe failed", exc_info=True)
        return False
    features = caps.get("features")
    if isinstance(features, dict):
        for key in ("moa_runs", "moa_submission", "run_moa", "moa"):
            if features.get(key):
                return True
    for key in ("moa_runs", "moa_submission", "run_moa"):
        if caps.get(key):
            return True
    return False


def gateway_supports_runs_parity(
    base_url: str = "http://127.0.0.1:8642",
    api_key: Optional[str] = None,
    *,
    blocking: bool = True,
) -> bool:
    """Probe gateway /v1/capabilities for Spark /v1/runs override support."""
    try:
        caps = _capabilities(base_url, api_key, blocking)
    except Exception:  # noqa: BLE001 - an unreachable gateway means "unsupported"
        logger.debug("gateway capabilities probe failed", exc_info=True)
        return False
    features = caps.get("features")
    if isinstance(features, dict):
        if features.get("runs_parity") or features.get("spark_runs_overrides"):
            return True
    return bool(caps.get("runs_parity") or caps.get("spark_runs_overrides"))


def runs_parity_available(
    *,
    base_url: str = "http://127.0.0.1:8642",
    api_key: Optional[str] = None,
    env_override: Optional[bool] = None,
) -> bool:
    """True when gateway or env allows cwd/toolsets/provider runs overrides.

    Never probes inline: reads the cached capabilities (spec 5.2).
    """
    if env_override is True or parse_runs_parity_flag():
        return True
    if env_override is False:
        return False
    return gateway_supports_runs_parity(base_url=base_url, api_key=api_key, blocking=False)


def is_moa_runs_rejection(status_code: int, payload: dict[str, Any]) -> bool:
    """True when gateway rejected provider=moa on POST /v1/runs (safe agent-loop fallback)."""
    if status_code == 202:
        return False
    err_text = extract_gateway_error_text(payload).lower()
    if "moa" in err_text or "mixture of agents" in err_text:
        return True
    if status_code in {404, 501}:
        return True
    if status_code == 400 and any(token in err_text for token in ("provider", "unsupported", "not supported")):
        return True
    return False


def parse_default_toolsets(env_value: Optional[str] = None) -> list[str]:
    """Return the default Hermes toolset list (HERMES_TOOLSETS or bridge default)."""
    raw = env_value if env_value is not None else os.environ.get("HERMES_TOOLSETS", "web,browser,terminal")
    return [t.strip() for t in str(raw).split(",") if t.strip()]


def toolsets_are_non_default(
    enabled_toolsets: Optional[list[str]],
    *,
    default_toolsets: Optional[list[str]] = None,
) -> bool:
    """True when enabled toolsets differ from the bridge default."""
    enabled = [t.strip() for t in (enabled_toolsets or []) if str(t).strip()]
    default = list(default_toolsets if default_toolsets is not None else parse_default_toolsets())
    return sorted(enabled) != sorted(default)


def needs_agent_loop_parity(
    *,
    runs_parity_available: bool = False,
    worktree_active: bool = False,
    explicit_provider: Optional[str] = None,
    moa_provider_id: str = "moa",
    moa_runs_allowed: bool = False,
    enabled_toolsets: Optional[list[str]] = None,
    toolsets_overridden: bool = False,
    default_toolsets: Optional[list[str]] = None,
    repo_mode: bool = False,
    github_pat: Optional[str] = None,
    custom_tools: Optional[list[Any]] = None,
    reasoning_effort: Optional[str] = None,
    custom_cli_base_url: Optional[str] = None,
) -> tuple[bool, Optional[str]]:
    """Return (True, reason) when gateway /v1/runs cannot honor the request."""
    if worktree_active and not runs_parity_available:
        return True, "worktree isolation requires agent-loop (gateway runs use separate process cwd)"

    if enabled_toolsets_need_agent_loop_parity(enabled_toolsets):
        return True, "computer_use requires agent-loop (gateway runs lacks screenshot payloads)"

    # Gateway /v1/runs only accepts provider id under runs_parity — it cannot set
    # a CLI custom model.base_url / endpoint key. Force agent-loop for custom CLI.
    if custom_cli_base_url and str(custom_cli_base_url).strip():
        return True, "custom CLI base_url requires agent-loop (gateway /v1/runs cannot set base_url)"

    provider = str(explicit_provider or "").strip().lower()
    if provider and provider not in {"auto", "default"}:
        if provider == moa_provider_id:
            if not moa_runs_allowed:
                return True, "provider=moa requires agent-loop (gateway MoA not enabled)"
        elif provider == "custom" or provider.startswith("custom:"):
            return True, f"custom provider={provider} requires agent-loop (gateway /v1/runs cannot set base_url)"
        elif not runs_parity_available:
            return True, f"explicit provider={provider} not supported on /v1/runs (model alias only)"

    if not runs_parity_available:
        if toolsets_overridden:
            return True, "non-default toolsets require agent-loop"
        if enabled_toolsets and toolsets_are_non_default(
            enabled_toolsets,
            default_toolsets=default_toolsets,
        ):
            return True, "non-default toolsets require agent-loop"

        if normalize_reasoning_effort(reasoning_effort):
            return True, "reasoning_effort requires agent-loop"

    if repo_mode:
        return True, "repo_mode requires agent-loop"

    if github_pat and str(github_pat).strip():
        return True, "github_pat requires agent-loop"

    if custom_tools:
        return True, "custom_tools require agent-loop"

    return False, None


def build_run_submit_body(
    *,
    input_text: str,
    session_id: str,
    conversation_history: Optional[list[dict[str, str]]] = None,
    instructions: Optional[str] = None,
    model: Optional[str] = None,
    cwd: Optional[str] = None,
    enabled_toolsets: Optional[list[str]] = None,
    provider: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    include_parity_fields: bool = False,
) -> dict[str, Any]:
    """Build POST /v1/runs body; parity fields only when gateway supports them."""
    body: dict[str, Any] = {
        "input": input_text,
        "session_id": session_id,
    }
    if conversation_history:
        body["conversation_history"] = conversation_history
    if instructions:
        body["instructions"] = instructions
    if model:
        body["model"] = model
    if include_parity_fields:
        if cwd:
            body["cwd"] = cwd
        if enabled_toolsets:
            body["enabled_toolsets"] = enabled_toolsets
        provider_name = str(provider or "").strip().lower()
        if provider_name and provider_name not in {"auto", "default"}:
            body["provider"] = provider_name
        effort = normalize_reasoning_effort(reasoning_effort)
        if effort:
            body["reasoning_effort"] = effort
    return body


def register_active_run(
    conversation_id: str,
    *,
    run_id: str,
    base_url: str,
    api_key: Optional[str],
) -> None:
    """Track an in-flight gateway run for cancel/approve by conversation id."""
    key = str(conversation_id or "").strip()
    if not key or not str(run_id or "").strip():
        return
    with _active_runs_lock:
        _active_runs[key] = _ActiveRun(
            run_id=str(run_id).strip(),
            base_url=base_url,
            api_key=api_key,
        )


def unregister_active_run(conversation_id: str, run_id: Optional[str] = None) -> None:
    """Drop a conversation's active-run handle, but only if it is still ours.

    The handle is keyed by conversation, so a run that finishes late would
    otherwise delete the handle belonging to a newer overlapping run on the same
    conversation — leaving that run uncancellable. Comparing run_id makes the
    delete conditional: the entry is removed only when it still belongs to the
    run asking.

    run_id is optional for call sites that genuinely mean "clear whatever is
    there" (an explicit reset), but every completion path passes it.
    """
    key = str(conversation_id or "").strip()
    if not key:
        return
    with _active_runs_lock:
        if run_id is not None:
            active = _active_runs.get(key)
            if active is None or active.run_id != str(run_id).strip():
                # A newer run owns this conversation now; leave its handle alone.
                return
        _active_runs.pop(key, None)


def is_run_cancelled(conversation_id: str) -> bool:
    key = str(conversation_id or "").strip()
    if not key:
        return False
    with _active_runs_lock:
        active = _active_runs.get(key)
        return bool(active and active.cancelled.is_set())


def cancel_active_run(conversation_id: str) -> bool:
    """Signal cancel and POST /v1/runs/{id}/stop for the active gateway run (blocking)."""
    target = _take_cancel_target(conversation_id)
    if target is None:
        return False
    run_id, base_url, api_key = target
    try:
        stop_run(base_url=base_url, api_key=api_key, run_id=run_id)
    except Exception:  # noqa: BLE001 - the cancel flag is set; the pump stops the run on its next event
        logger.debug("gateway stop_run failed for %s", run_id, exc_info=True)
    return True


def _take_cancel_target(conversation_id: str) -> Optional[tuple[str, str, Optional[str]]]:
    key = str(conversation_id or "").strip()
    if not key:
        return None
    with _active_runs_lock:
        active = _active_runs.get(key)
        if not active:
            return None
        active.cancelled.set()
        return active.run_id, active.base_url, active.api_key


async def cancel_active_run_async(conversation_id: str) -> bool:
    """``cancel_active_run`` for async callers: the stop POST uses httpx.AsyncClient."""
    target = _take_cancel_target(conversation_id)
    if target is None:
        return False
    run_id, base_url, api_key = target
    try:
        await stop_run_async(base_url=base_url, api_key=api_key, run_id=run_id)
    except Exception:  # noqa: BLE001 - the cancel flag is set; the pump stops the run on its next event
        logger.debug("gateway stop_run failed for %s", run_id, exc_info=True)
    return True


def approve_active_run(
    conversation_id: str,
    *,
    choice: str = "approve",
    resolve_all: bool = False,
) -> tuple[bool, Optional[int]]:
    """POST /v1/runs/{id}/approval for the active gateway run, if any."""
    key = str(conversation_id or "").strip()
    if not key:
        return False, None
    with _active_runs_lock:
        active = _active_runs.get(key)
        if not active:
            return False, None
        run_id = active.run_id
        base_url = active.base_url
        api_key = active.api_key
    try:
        status_code, _payload = approve_run(
            base_url=base_url,
            api_key=api_key,
            run_id=run_id,
            choice=choice,
            resolve_all=resolve_all,
        )
        return True, status_code
    except Exception:  # noqa: BLE001 - reported to the caller as "not delivered"
        logger.debug("gateway approve_run failed for %s", run_id, exc_info=True)
        return False, None


async def approve_active_run_async(
    conversation_id: str,
    *,
    choice: str = "approve",
    resolve_all: bool = False,
) -> tuple[bool, Optional[int]]:
    """``approve_active_run`` for async callers: the approval POST uses httpx.AsyncClient."""
    key = str(conversation_id or "").strip()
    if not key:
        return False, None
    with _active_runs_lock:
        active = _active_runs.get(key)
        if not active:
            return False, None
        run_id, base_url, api_key = active.run_id, active.base_url, active.api_key
    try:
        status_code, _payload = await approve_run_async(
            base_url=base_url,
            api_key=api_key,
            run_id=run_id,
            choice=choice,
            resolve_all=resolve_all,
        )
        return True, status_code
    except Exception:  # noqa: BLE001 - reported to the caller as "not delivered"
        logger.debug("gateway approve_run failed for %s", run_id, exc_info=True)
        return False, None


def parse_use_runs_flag(
    *,
    env_value: Optional[str] = None,
    header_value: Optional[str] = None,
    body_value: Any = None,
) -> bool:
    """Return True when any Hermes runs flag source is enabled."""
    if env_value is not None and str(env_value).strip().lower() in _TRUTHY:
        return True
    if header_value is not None and str(header_value).strip().lower() in _TRUTHY:
        return True
    if body_value is True:
        return True
    if isinstance(body_value, str) and body_value.strip().lower() in _TRUTHY:
        return True
    return False


def gateway_supports_runs(
    base_url: str = "http://127.0.0.1:8642",
    api_key: Optional[str] = None,
    *,
    blocking: bool = True,
) -> bool:
    """Probe gateway /v1/capabilities for run_submission."""
    try:
        caps = _capabilities(base_url, api_key, blocking)
    except Exception:  # noqa: BLE001 - an unreachable gateway means "unsupported"
        logger.debug("gateway capabilities probe failed", exc_info=True)
        return False
    return bool(caps.get("run_submission"))


def enabled_toolsets_need_agent_loop_parity(
    enabled_toolsets: Optional[list[str]] = None,
) -> bool:
    """True when enabled toolsets need agent-loop features missing from /v1/runs."""
    if not enabled_toolsets:
        return False
    for toolset in enabled_toolsets:
        if str(toolset or "").strip().lower() in _AGENT_LOOP_PARITY_TOOLSETS:
            return True
    return False


def should_route_via_runs(
    *,
    flag_enabled: bool,
    provider: str,
    moa_provider_id: str,
    base_url: str = "http://127.0.0.1:8642",
    api_key: Optional[str] = None,
    runs_moa_flag: Optional[bool] = None,
    enabled_toolsets: Optional[list[str]] = None,
) -> bool:
    """Gate: flag on + gateway run_submission; MoA only when explicitly enabled.

    Never probes inline: reads the cached capabilities (spec 5.2).
    """
    if not flag_enabled:
        return False
    if enabled_toolsets_need_agent_loop_parity(enabled_toolsets):
        return False
    if not gateway_supports_runs(base_url=base_url, api_key=api_key, blocking=False):
        return False
    if provider == moa_provider_id:
        moa_enabled = (
            parse_runs_moa_flag()
            if runs_moa_flag is None
            else bool(runs_moa_flag)
        )
        if moa_enabled:
            return True
        return gateway_supports_moa_runs(base_url=base_url, api_key=api_key, blocking=False)
    return True


def split_messages_for_run(
    messages: list[dict[str, Any]],
) -> tuple[str, list[dict[str, str]], Optional[str]]:
    """Split chat messages into runs API input, history, and instructions."""
    system_parts: list[str] = []
    conv: list[dict[str, str]] = []
    for message in messages:
        role = str(message.get("role") or "").strip()
        content = message.get("content")
        if not isinstance(content, str):
            continue
        text = content.strip()
        if not text:
            continue
        if role == "system":
            system_parts.append(text)
            continue
        if role in {"user", "assistant"}:
            conv.append({"role": role, "content": text})

    if not conv or conv[-1]["role"] != "user":
        return "", conv, ("\n\n".join(system_parts) if system_parts else None)

    last_user = conv[-1]["content"]
    history = conv[:-1]
    instructions = "\n\n".join(system_parts) if system_parts else None
    return last_user, history, instructions


def translate_run_event(event: dict[str, Any]) -> list[tuple[str, Any, ...]]:
    """Map gateway /v1/runs SSE JSON to agent-loop queue event tuples."""
    if not isinstance(event, dict):
        return []

    ev = str(event.get("event") or "").strip()
    if ev == "message.delta":
        delta = event.get("delta")
        if isinstance(delta, str) and delta:
            return [("text", delta)]
        return []

    if ev == "tool.started":
        tool = str(event.get("tool") or "tool")
        preview = str(event.get("preview") or "")
        args = event.get("args")
        if isinstance(args, dict) and args:
            tool_input = json.dumps(args, ensure_ascii=False)
        else:
            tool_input = preview
        events: list[tuple[str, Any, ...]] = [("tool_start", tool, tool_input)]
        try:
            from computer_use_frames import build_computer_use_frame_payload, is_computer_use_tool

            if is_computer_use_tool(tool):
                frame = build_computer_use_frame_payload(
                    tool_name=tool,
                    args=args if isinstance(args, dict) else tool_input,
                    result=None,
                    status="running",
                )
                if frame:
                    events.append(("computer_use_frame", frame))
        except Exception:
            pass
        return events

    if ev == "tool.completed":
        tool = str(event.get("tool") or "tool")
        duration = event.get("duration")
        is_error = bool(event.get("error"))
        suffix = ""
        if isinstance(duration, (int, float)):
            suffix = f" ({duration:.1f}s)"
        status = "Error" if is_error else "Completed"
        events = [("tool_end", tool, f"{status}{suffix}")]
        # Gateway tool.completed has no result field today — no screenshot frames.
        # When upstream adds result/args, translate to computer_use_frame here.
        result = event.get("result")
        if result is not None:
            try:
                from computer_use_frames import build_computer_use_frame_payload, is_computer_use_tool

                if is_computer_use_tool(tool):
                    frame = build_computer_use_frame_payload(
                        tool_name=tool,
                        args=event.get("args"),
                        result=result,
                        status="completed",
                    )
                    if frame:
                        events.append(("computer_use_frame", frame))
            except Exception:
                pass
        return events

    if ev == "reasoning.available":
        text = event.get("text")
        if isinstance(text, str) and text:
            return [("reasoning", text)]
        return []

    if ev in {"approval.pending", "approval.request", "approval.required"}:
        return [
            (
                "server_tool_event",
                {
                    "type": "approval",
                    "tool": str(event.get("tool") or event.get("name") or "tool"),
                    "preview": str(event.get("preview") or event.get("message") or ""),
                    "run_id": event.get("run_id"),
                },
            )
        ]

    if ev == "moa.reference":
        label = str(event.get("name") or event.get("label") or "")
        text = str(event.get("text") or event.get("preview") or "")
        meta = {
            "label": label,
            "index": event.get("moa_index", event.get("index")),
            "count": event.get("moa_count", event.get("count")),
        }
        meta_json = json.dumps(meta, ensure_ascii=False)
        return [
            ("tool_start", "moa.reference", meta_json),
            ("tool_end", "moa.reference", (text or "")[:4000]),
        ]

    if ev == "moa.aggregating":
        aggregator = str(event.get("name") or event.get("aggregator") or "")
        meta = {
            "aggregator": aggregator,
            "ref_count": event.get("moa_ref_count", event.get("ref_count")),
        }
        meta_json = json.dumps(meta, ensure_ascii=False)
        end_text = (
            f"Aggregating with {aggregator}"
            if aggregator
            else "Aggregating reference models"
        )
        return [
            ("tool_start", "moa.aggregating", meta_json),
            ("tool_end", "moa.aggregating", end_text),
        ]

    if ev == "run.failed":
        error = str(event.get("error") or "Run failed")
        return [("text", f"\n\n**Error:** {error}\n")]

    if ev == "run.completed":
        output = event.get("output")
        if isinstance(output, str) and output.strip():
            return [("text", output)]
        return []

    return []


def _gateway_headers(
    api_key: Optional[str],
    session_key: Optional[str] = None,
) -> dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    key = (api_key or "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    sk = (session_key or "").strip()
    if sk:
        headers["X-Hermes-Session-Key"] = sk
    return headers


def submit_run(
    *,
    base_url: str,
    api_key: Optional[str],
    input_text: str,
    session_id: str,
    conversation_history: Optional[list[dict[str, str]]] = None,
    instructions: Optional[str] = None,
    model: Optional[str] = None,
    session_key: Optional[str] = None,
    cwd: Optional[str] = None,
    enabled_toolsets: Optional[list[str]] = None,
    provider: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    include_parity_fields: bool = False,
    timeout: float = 30.0,
) -> tuple[int, dict[str, Any]]:
    """POST /v1/runs — returns (status_code, json_body)."""
    base_url = assert_safe_gateway_base_url(base_url)
    url = base_url.rstrip("/") + "/v1/runs"
    body = build_run_submit_body(
        input_text=input_text,
        session_id=session_id,
        conversation_history=conversation_history,
        instructions=instructions,
        model=model,
        cwd=cwd,
        enabled_toolsets=enabled_toolsets,
        provider=provider,
        reasoning_effort=reasoning_effort,
        include_parity_fields=include_parity_fields,
    )

    with httpx.Client(timeout=timeout) as client:
        resp = client.post(
            url,
            headers=_gateway_headers(api_key, session_key=session_key),
            json=body,
        )
        try:
            payload = resp.json()
        except json.JSONDecodeError:
            payload = {"error": resp.text[:300]}
        if not isinstance(payload, dict):
            payload = {"error": "Invalid gateway response"}
        return resp.status_code, payload


def stop_run(
    *,
    base_url: str,
    api_key: Optional[str],
    run_id: str,
    timeout: float = 15.0,
) -> tuple[int, dict[str, Any]]:
    """POST /v1/runs/{run_id}/stop."""
    base_url = assert_safe_gateway_base_url(base_url)
    safe_id = quote(str(run_id).strip(), safe="")
    url = base_url.rstrip("/") + f"/v1/runs/{safe_id}/stop"
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(url, headers=_gateway_headers(api_key), json={})
        try:
            payload = resp.json() if resp.content else {}
        except json.JSONDecodeError:
            payload = {"error": resp.text[:300]}
        if not isinstance(payload, dict):
            payload = {}
        return resp.status_code, payload


def approve_run(
    *,
    base_url: str,
    api_key: Optional[str],
    run_id: str,
    choice: str,
    resolve_all: bool = False,
    timeout: float = 15.0,
) -> tuple[int, dict[str, Any]]:
    """POST /v1/runs/{run_id}/approval."""
    base_url = assert_safe_gateway_base_url(base_url)
    safe_id = quote(str(run_id).strip(), safe="")
    url = base_url.rstrip("/") + f"/v1/runs/{safe_id}/approval"
    body = {"choice": choice, "all": resolve_all}
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(url, headers=_gateway_headers(api_key), json=body)
        try:
            payload = resp.json() if resp.content else {}
        except json.JSONDecodeError:
            payload = {"error": resp.text[:300]}
        if not isinstance(payload, dict):
            payload = {}
        return resp.status_code, payload


def _small_json_payload(resp) -> dict[str, Any]:
    try:
        payload = resp.json() if resp.content else {}
    except json.JSONDecodeError:
        payload = {"error": resp.text[:300]}
    return payload if isinstance(payload, dict) else {}


async def stop_run_async(
    *,
    base_url: str,
    api_key: Optional[str],
    run_id: str,
    timeout: float = 15.0,
) -> tuple[int, dict[str, Any]]:
    """POST /v1/runs/{run_id}/stop without blocking the event loop."""
    base_url = assert_safe_gateway_base_url(base_url)
    safe_id = quote(str(run_id).strip(), safe="")
    url = base_url.rstrip("/") + f"/v1/runs/{safe_id}/stop"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, headers=_gateway_headers(api_key), json={})
        return resp.status_code, _small_json_payload(resp)


async def approve_run_async(
    *,
    base_url: str,
    api_key: Optional[str],
    run_id: str,
    choice: str,
    resolve_all: bool = False,
    timeout: float = 15.0,
) -> tuple[int, dict[str, Any]]:
    """POST /v1/runs/{run_id}/approval without blocking the event loop."""
    base_url = assert_safe_gateway_base_url(base_url)
    safe_id = quote(str(run_id).strip(), safe="")
    url = base_url.rstrip("/") + f"/v1/runs/{safe_id}/approval"
    body = {"choice": choice, "all": resolve_all}
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, headers=_gateway_headers(api_key), json=body)
        return resp.status_code, _small_json_payload(resp)


_SSE_DATA_RE = re.compile(r"^data:\s*(.+)\s*$")


def iter_run_sse_events(
    *,
    base_url: str,
    api_key: Optional[str],
    run_id: str,
    timeout: Optional[httpx.Timeout] = None,
):
    """Yield parsed JSON dicts from GET /v1/runs/{run_id}/events SSE."""
    base_url = assert_safe_gateway_base_url(base_url)
    safe_id = quote(str(run_id).strip(), safe="")
    url = base_url.rstrip("/") + f"/v1/runs/{safe_id}/events"
    headers = {"Accept": "text/event-stream"}
    key = (api_key or "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"

    client_timeout = timeout if timeout is not None else _DEFAULT_RUN_SSE_TIMEOUT
    with httpx.Client(timeout=client_timeout) as client:
        with client.stream("GET", url, headers=headers) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                if line.startswith(":"):
                    continue
                match = _SSE_DATA_RE.match(line)
                if not match:
                    continue
                raw = match.group(1).strip()
                if raw == "[DONE]":
                    break
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    yield parsed


def pump_run_events(
    *,
    base_url: str,
    api_key: Optional[str],
    run_id: str,
    emit: Callable[..., None],
    should_stop: Optional[Callable[[], bool]] = None,
) -> None:
    """Stream gateway run events into agent-loop queue tuples via emit()."""
    for event in iter_run_sse_events(
        base_url=base_url,
        api_key=api_key,
        run_id=run_id,
    ):
        if should_stop and should_stop():
            stop_run(base_url=base_url, api_key=api_key, run_id=run_id)
            break
        ev_name = str(event.get("event") or "")
        if ev_name == "run.completed":
            for translated in translate_run_event(event):
                emit(*translated)
            break
        if ev_name == "run.failed":
            for translated in translate_run_event(event):
                emit(*translated)
            break
        for translated in translate_run_event(event):
            emit(*translated)


def resolve_gateway_base_url() -> str:
    return (
        os.environ.get("HERMES_API_BASE", "").strip()
        or "http://127.0.0.1:8642"
    )
