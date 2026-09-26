"""Structured SSE event envelopes shared by the agent-loop and ACP transports.

The bridge streams OpenAI-compatible ``chat.completion.chunk`` objects over
SSE. Besides the standard ``delta.content`` / ``delta.reasoning`` keys, the
frontend pre-scans every ``data:`` line for custom JSON fields
(``tool_activity``, ``approval_request``, ``computer_use_frame``, ...). This
module builds the payloads for the newer structured events —
``tool_call_begin`` / ``tool_call_delta`` / ``tool_call_end``,
``stream_retry``, ``plan_update`` and the enriched ``approval_request`` —
plus the plan-mode tool filtering helpers used by the agent-loop transports.

The field names and payload shapes defined here are a FIXED contract with the
server (``server/lib/hermes.ts``) and the frontend SSE scanner — do not
rename keys or change types. Everything in this module is pure (no I/O, no
bridge imports) so it can be unit-tested in isolation.
"""

from __future__ import annotations

import inspect
import json
import re
import time
from typing import Any, Callable, Optional

# The fixed set of decisions the UI can return for an approval request (kept
# in sync with the approval route's accepted option_ids).
AVAILABLE_APPROVAL_DECISIONS = [
    "approved",
    "approved_for_session",
    "denied",
    "timed_out",
    "abort",
]

# UI ladder / aliases → ACP option_ids hermes-agent actually understands.
# Edit approvals in hermes-agent only accept `allow_once` (see
# acp_adapter/edit_approval.py); sending `allow_session` is treated as deny
# ("patch tool keeps getting denied by the client").
_LADDER_TO_ACP_OPTION = {
    "approved": "allow_once",
    "approved_for_session": "allow_session",
    "allow_once": "allow_once",
    "allow_session": "allow_session",
    "allow_always": "allow_always",
    "prefix": "allow_always",
    "denied": "deny",
    "deny": "deny",
    "deny_always": "deny_always",
    "timed_out": "deny",
    "abort": "deny",
}

# Toolsets that are pure mutation/execution vectors — never registered in
# plan mode. Matches the legacy agent-loop toolset names and the real
# hermes-agent toolset names alike.
PLAN_MODE_BLOCKED_TOOLSETS = frozenset({"terminal", "shell", "code_execution"})

# Known mutating tool names (exact matches, lowercase).
_PLAN_MODE_MUTATING_NAMES = frozenset(
    {
        "run_command", "run_bash", "run_shell", "bash", "shell", "terminal",
        "execute_command", "command_exec", "sudo",
        "execute_python", "execute_python_file", "execute_code",
        "apply_patch", "apply_diff", "patch",
        "edit", "edit_file", "write", "write_file", "delete_file",
        "move_file", "rename_file", "remove_file",
    }
)

# Name prefixes that imply mutation (edit_*, write_*, create_*, ...).
_PLAN_MODE_MUTATING_PREFIXES = (
    "edit_", "write_", "delete_", "create_", "apply_", "remove_",
    "move_", "rename_", "mkdir", "rmdir", "chmod", "chown",
    "batch_edit",
)

# Read-only instruction appended to the user message when plan_mode is set on
# the ACP transport (best-effort hint; hermes-agent still owns its tools).
PLAN_MODE_PROMPT_SUFFIX = (
    "\n\n[Plan mode is active for this request: research and plan only. "
    "Do NOT modify files, run mutating shell commands, apply patches, or "
    "make any persistent changes. Prefer read-only tools.]"
)

# Cap for the single-step fallback plan payload (raw plan text can be long).
_MAX_FALLBACK_STEP_CHARS = 2000

_PLAN_STATUSES = {"pending", "in_progress", "completed"}


# ── Tool call events (structured tool_call_begin/delta/end) ─────────────────


def tool_call_begin_event(call_id: str, name: str, ts: Optional[float] = None) -> dict:
    """Envelope for the start of one tool invocation."""
    return {
        "type": "tool_call_begin",
        "call_id": str(call_id),
        "name": str(name),
        "ts": float(ts if ts is not None else time.time()),
    }


def tool_call_delta_event(call_id: str, output: str) -> dict:
    """Envelope for an append-only output chunk of a running tool call."""
    return {
        "type": "tool_call_delta",
        "call_id": str(call_id),
        "output": str(output or ""),
    }


def tool_call_end_event(
    call_id: str,
    name: str,
    success: bool,
    exit_code: Optional[int] = None,
    duration_ms: int = 0,
    output_truncated: bool = False,
    output_truncated_lines: int = 0,
) -> dict:
    """Envelope for the completion of one tool invocation."""
    return {
        "type": "tool_call_end",
        "call_id": str(call_id),
        "name": str(name),
        "success": bool(success),
        "exit_code": int(exit_code) if isinstance(exit_code, int) else None,
        "duration_ms": int(duration_ms or 0),
        "output_truncated": bool(output_truncated),
        "output_truncated_lines": int(output_truncated_lines or 0),
    }


def stream_retry_event(attempt: int, max_attempts: int, reason: str, delay_ms: int) -> dict:
    """Envelope for one upstream-stream retry / transport reconnect."""
    return {
        "type": "stream_retry",
        "attempt": int(attempt),
        "max_attempts": int(max_attempts),
        "reason": str(reason or ""),
        "delay_ms": int(delay_ms or 0),
    }


def output_truncation_info(text: Optional[str], cap: int) -> tuple[bool, int]:
    """Return (was_truncated, lines_removed) when ``text`` is capped at ``cap`` chars.

    ``lines_removed`` counts newline-terminated lines in the removed tail, plus
    one for a trailing partial line.
    """
    full = text if text is not None else ""
    if len(full) <= cap:
        return False, 0
    removed = full[cap:]
    lines = removed.count("\n")
    if not removed.endswith("\n"):
        lines += 1
    return True, lines


def extract_exit_code(update: Any) -> Optional[int]:
    """Best-effort exit code from an ACP tool_call_update (raw_output may carry one)."""
    raw = getattr(update, "raw_output", None)
    if isinstance(raw, dict):
        for key in ("exit_code", "exitCode", "code"):
            value = raw.get(key)
            if isinstance(value, int):
                return value
            if isinstance(value, str) and value.strip().lstrip("-").isdigit():
                return int(value.strip())
    return None


# ── Plan update events ──────────────────────────────────────────────────────


_STEP_HEADING_RE = re.compile(r"^\*\*step\s+(\d+)\*\*[:\s]*(.*)$", re.IGNORECASE)
_STEP_HEADING_BOLD_RE = re.compile(r"^\*\*step\s+(\d+)[:.)]?\s*(.*?)\*\*$", re.IGNORECASE)
_STEP_HEADING_PLAIN_RE = re.compile(r"^step\s+(\d+)[:.)]\s*(.+)$", re.IGNORECASE)
_CHECKLIST_DONE_RE = re.compile(r"^[-*]\s*\[\s*x\s*\]\s*(.+)$", re.IGNORECASE)
_CHECKLIST_TODO_RE = re.compile(r"^[-*]\s*\[\s*\]\s*(.+)$")
_NUMBERED_RE = re.compile(r"^\d+[.)]\s+(.+)$")


def _normalize_plan_status(status: Any) -> str:
    """Map an arbitrary plan-entry status onto the contract's three statuses."""
    s = str(status or "").strip().lower()
    return s if s in _PLAN_STATUSES else "pending"


def plan_steps_from_text(text: Any) -> Optional[list[dict]]:
    """Parse numbered / markdown checklist lines into plan steps.

    Recognized shapes (in priority order):

    * ``**Step N** text`` / ``**Step N: text**`` / ``Step N: text`` → in_progress
    * ``- [x] text`` / ``- [X] text`` → completed
    * ``- [ ] text`` → pending
    * ``N. text`` / ``N) text`` → pending

    Returns None when nothing parseable was found.
    """
    if not isinstance(text, str) or not text.strip():
        return None
    steps: list[dict] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = _STEP_HEADING_RE.match(line)
        if match:
            steps.append(
                {"step": (match.group(2).strip() or f"Step {match.group(1)}"), "status": "in_progress"}
            )
            continue
        match = _STEP_HEADING_BOLD_RE.match(line)
        if match:
            steps.append(
                {"step": (match.group(2).strip() or f"Step {match.group(1)}"), "status": "in_progress"}
            )
            continue
        match = _STEP_HEADING_PLAIN_RE.match(line)
        if match:
            steps.append({"step": match.group(2).strip(), "status": "in_progress"})
            continue
        match = _CHECKLIST_DONE_RE.match(line)
        if match:
            steps.append({"step": match.group(1).strip(), "status": "completed"})
            continue
        match = _CHECKLIST_TODO_RE.match(line)
        if match:
            steps.append({"step": match.group(1).strip(), "status": "pending"})
            continue
        match = _NUMBERED_RE.match(line)
        if match:
            steps.append({"step": match.group(1).strip(), "status": "pending"})
            continue
    return steps or None


def plan_steps_from_entries(entries: Any) -> Optional[list[dict]]:
    """Build steps from structured ACP plan entries (objects or dicts).

    Each entry contributes its ``content`` as the step text and its ``status``
    (pending / in_progress / completed) mapped onto the contract's statuses.
    Returns None when there were no usable entries.
    """
    steps: list[dict] = []
    for entry in entries or []:
        if isinstance(entry, dict):
            content = entry.get("content") or entry.get("step") or ""
            status = entry.get("status")
        else:
            content = getattr(entry, "content", None) or getattr(entry, "step", None) or ""
            status = getattr(entry, "status", None)
        step = str(content).strip()
        if not step:
            continue
        steps.append({"step": step, "status": _normalize_plan_status(status)})
    return steps or None


def _plan_text_from_entries(entries: Any) -> str:
    """Join entry contents into one text blob (fallback plan text)."""
    parts: list[str] = []
    for entry in entries or []:
        if isinstance(entry, dict):
            content = entry.get("content") or entry.get("step") or ""
        else:
            content = getattr(entry, "content", None) or getattr(entry, "step", None) or ""
        if str(content).strip():
            parts.append(str(content).strip())
    return "\n".join(parts)


def build_plan_update_event(entries_or_text: Any) -> Optional[dict]:
    """Build the ``plan_update`` SSE payload from ACP entries or markdown text.

    Structured entries win; otherwise the text is parsed heuristically. When
    nothing parses, a single ``in_progress`` step carrying the raw plan text
    is emitted (unless there is no text at all, in which case None is
    returned and no event is sent).
    """
    if isinstance(entries_or_text, (list, tuple)):
        steps = plan_steps_from_entries(entries_or_text)
        text = _plan_text_from_entries(entries_or_text)
    else:
        text = str(entries_or_text or "")
        steps = plan_steps_from_text(text)
    if steps is not None:
        return {"type": "plan_update", "steps": steps}
    text = text.strip()
    if not text:
        return None
    return {
        "type": "plan_update",
        "steps": [{"step": text[:_MAX_FALLBACK_STEP_CHARS], "status": "in_progress"}],
    }


def todo_plan_steps(output: Any) -> Optional[list[dict]]:
    """Parse hermes ``todo`` tool JSON output into plan steps (best-effort).

    The todo tool returns a payload with a ``cli`` checklist string; when that
    parses into steps they are returned, otherwise None (caller skips the
    plan_update event).
    """
    if not isinstance(output, str) or not output.strip():
        return None
    try:
        payload = json.loads(output)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    cli = payload.get("cli")
    if isinstance(cli, str) and cli.strip():
        steps = plan_steps_from_text(cli)
        if steps is not None:
            return steps
    return None


# ── Enriched approval requests (ACP) ────────────────────────────────────────


def extract_approval_command(tool_call: Any) -> Optional[str]:
    """Best-effort shell command for a terminal approval.

    hermes puts the command in ``raw_input`` (dict ``command``/``cmd``/
    ``script``/``shell`` key, or a bare string). Returns None when the payload
    has no obvious command (e.g. file-edit approvals).
    """
    raw = getattr(tool_call, "raw_input", None)
    if isinstance(raw, dict):
        for key in ("command", "cmd", "script", "shell"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:2000]
    elif isinstance(raw, str) and raw.strip():
        return raw.strip()[:2000]
    return None


def _option_id_of(option: Any) -> str:
    if isinstance(option, dict):
        return str(option.get("option_id") or "").strip()
    return str(getattr(option, "option_id", "") or "").strip()


def offered_acp_option_ids(options: Optional[list]) -> set[str]:
    """ACP option_ids hermes actually offered on this permission request."""
    return {oid for oid in (_option_id_of(o) for o in (options or [])) if oid}


def available_decisions_from_acp_options(options: Optional[list]) -> list[str]:
    """Map offered ACP option_ids onto the UI ladder.

    Edit prompts only offer ``allow_once`` + ``deny`` — do not advertise
    ``approved_for_session`` or the UI's session button will send an id
    hermes treats as a denial.
    """
    offered = offered_acp_option_ids(options)
    decisions: list[str] = []
    if not offered or "allow_once" in offered:
        decisions.append("approved")
    if "allow_session" in offered:
        decisions.append("approved_for_session")
    decisions.append("denied")
    return decisions


def clamp_acp_option_id(raw: Any, offered: Optional[set[str]] = None) -> str:
    """Normalize a UI/bridge decision onto an option_id hermes offered.

    Broader grants (session/always) collapse to ``allow_once`` when that is
    the only allow option — which is how hermes-agent edit approvals work.
    """
    option_id = _LADDER_TO_ACP_OPTION.get(str(raw or "").strip(), str(raw or "").strip())
    if not option_id:
        return "deny"
    offered_ids = offered or set()
    if option_id in ("deny", "deny_always"):
        return option_id
    if not offered_ids or option_id in offered_ids:
        return option_id
    if option_id in ("allow_session", "allow_always") and "allow_once" in offered_ids:
        return "allow_once"
    return "deny"


def build_approval_request_event(
    *,
    approval_id: str,
    session_id: str,
    tool: Optional[str],
    kind: str,
    summary: str,
    excerpt: str,
    options: list,
    command: Optional[str] = None,
    cwd: Optional[str] = None,
    reason: Optional[str] = None,
) -> dict:
    """Envelope for an approval request (additive on top of the legacy keys)."""
    return {
        "type": "approval_request",
        "approval_id": str(approval_id),
        "session_id": str(session_id),
        "tool": tool,
        "kind": str(kind),
        "summary": str(summary),
        "excerpt": str(excerpt),
        "options": list(options or []),
        "command": command,
        "cwd": cwd,
        "reason": reason,
        "available_decisions": available_decisions_from_acp_options(options),
    }


# ── Plan-mode tool filtering ────────────────────────────────────────────────


def is_mutating_tool_name(name: Any) -> bool:
    """True for tool names that mutate state (plan mode strips these)."""
    n = str(name or "").strip().lower()
    if not n:
        return False
    if n in _PLAN_MODE_MUTATING_NAMES:
        return True
    return n.startswith(_PLAN_MODE_MUTATING_PREFIXES)


def filter_toolsets_for_plan_mode(toolsets: Any) -> list[str]:
    """Drop whole toolsets that are pure mutation/execution vectors."""
    return [t for t in (toolsets or []) if str(t).strip().lower() not in PLAN_MODE_BLOCKED_TOOLSETS]


def filter_tool_defs_for_plan_mode(tool_defs: Any) -> list[dict]:
    """Keep only non-mutating OpenAI-style tool definitions.

    Mixed toolsets (e.g. ``files`` with read_file + write_file) keep their
    read-only tools; mutating tools are dropped by name.
    """
    kept: list[dict] = []
    for td in tool_defs or []:
        if not isinstance(td, dict):
            kept.append(td)
            continue
        fn = td.get("function")
        name = fn.get("name", "") if isinstance(fn, dict) else ""
        if not is_mutating_tool_name(name):
            kept.append(td)
    return kept


# ── Callback kwarg probing ──────────────────────────────────────────────────

_CALLBACK_KWARG_CACHE: dict[tuple[int, str], bool] = {}


def callback_accepts_kwarg(cb: Optional[Callable], kwarg: str) -> bool:
    """True when ``cb`` can be called with the named keyword argument.

    Agents pass the structured tool-call kwargs (``call_id`` etc.) through to
    bridge callbacks, but some consumers (cron jobs, tests) register plain
    positional callbacks — probing keeps both working. Results are cached by
    callback identity.
    """
    if cb is None:
        return False
    key = (id(cb), kwarg)
    cached = _CALLBACK_KWARG_CACHE.get(key)
    if cached is not None:
        return cached
    try:
        sig = inspect.signature(cb)
    except (TypeError, ValueError):
        _CALLBACK_KWARG_CACHE[key] = False
        return False
    params = sig.parameters
    accepts = kwarg in params or any(
        p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
    )
    _CALLBACK_KWARG_CACHE[key] = accepts
    return accepts
