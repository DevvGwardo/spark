"""ACP transport — drive the REAL hermes-agent via Agent Client Protocol.

CloudChat spawns ``hermes-acp`` (hermes-agent's ACP stdio server, from the
installed ``agent-client-protocol`` SDK) once per conversation and relays its
``task/update`` notifications into the bridge's SSE pipeline. The real hermes
agent loop runs inside CloudChat — with hermes-agent's own tools, MCP
servers, skills, and approval gates — instead of the reimplemented loop in
``run_agent.py``.

Two kinds of agent->client messages matter here:

* ``session_update`` notifications — streamed content (``agent_message_chunk``
  / ``agent_thought_chunk``) and tool calls (``tool_call`` start,
  ``tool_call_update`` complete/failed). Translated to the SSE event shapes
  the CloudChat UI already renders.
* ``request_permission`` — hermes pauses a risky tool (edit, terminal, …)
  and asks the client to approve. The bridge surfaces an ``approval_request``
  SSE event, and ``resolve_approval()`` (called from the bridge's
  ``POST /v1/approvals/{id}`` route) completes the parked future with the
  user's decision.

The connection is asyncio-native and must live on the bridge's main event
loop, so the client dispatches from that loop while ``run_prompt_blocking``
bridges into it from a worker thread (mirroring how the agent-loop transport
runs ``AIAgent.run_conversation`` in a thread).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from bridge_events import (
    PLAN_MODE_PROMPT_SUFFIX,
    build_approval_request_event,
    clamp_acp_option_id,
    extract_approval_command,
    extract_exit_code,
    offered_acp_option_ids,
    stream_retry_event,
    tool_call_begin_event,
    tool_call_delta_event,
    tool_call_end_event,
)

logger = logging.getLogger("acp_transport")

# ── Environment / availability ──────────────────────────────────────────────

_ACP_CMD_ENV = "HERMES_ACP_CMD"


def acp_available() -> tuple[bool, str]:
    """Return (available, reason). ``acp_available()[0]`` is False when the
    SDK is missing, no ``hermes-acp`` binary exists, or the installed
    hermes-agent lacks the ACP adapter."""
    try:
        import acp  # noqa: F401
    except ImportError:
        return False, "agent-client-protocol SDK not installed in bridge venv"
    cmd = _acp_command()
    if cmd is None:
        return False, "hermes-acp binary not found on PATH (install hermes-agent 0.19+)"
    return True, f"hermes-acp at {cmd}"


def _acp_command() -> Optional[list[str]]:
    """Resolve the hermes-acp command. Prefer the env override (handy when the
    binary isn't on the bridge's PATH), then ``hermes-acp`` on PATH."""
    raw = os.environ.get(_ACP_CMD_ENV, "").strip()
    if raw:
        return [raw]
    path = shutil.which("hermes-acp")
    if path:
        return [path]
    return None


# ── Content extraction (ACP blocks -> plain text) ───────────────────────────


def _block_text(block: Any) -> str:
    """Extract text from an ACP content block (any nesting level)."""
    if block is None:
        return ""
    # A bare list at any level (e.g. ``update.content`` itself) is a container
    # of blocks — flatten it before looking at ``type``/``content`` attributes.
    if isinstance(block, (list, tuple)):
        parts = [_block_text(b) for b in block]
        return "\n".join(p for p in parts if p)
    # Discriminated by ``type``: text / image / audio / resource / content / diff / terminal
    btype = getattr(block, "type", None)
    if btype == "text":
        return str(getattr(block, "text", "") or "")
    inner = getattr(block, "content", None)
    if isinstance(inner, (list, tuple)):
        parts = [_block_text(b) for b in inner]
        return "\n".join(p for p in parts if p)
    if inner is not None and not isinstance(inner, str):
        return _block_text(inner)
    return ""


def _tool_output(update: Any) -> str:
    """Best-effort human-readable output for a tool_call_update."""
    if update is None:
        return ""
    text = _block_text(getattr(update, "content", None))
    if text:
        return text
    raw = getattr(update, "raw_output", None)
    if isinstance(raw, str):
        return raw
    if raw is not None:
        try:
            return json.dumps(raw, ensure_ascii=False)[:4000]
        except (TypeError, ValueError):
            return str(raw)[:4000]
    return ""


def _tool_input_for_display(update: Any) -> str:
    """Compact input string for tool_activity events. hermes sends tool starts
    without ``raw_input``, so derive it from the content blocks when present.

    File tools (``read_file``/``search_files``/…) intentionally send
    ``content=None`` on start — the path lives in ``locations`` instead. Fall
    back to the first location as ``{"path": ...}`` JSON so tool_activity
    consumers (UI label parsing via ``args.path``, start-text summaries) can
    attribute the call to its file. Without this every read renders as an
    unattributed ``read: ?`` line.
    """
    raw = getattr(update, "raw_input", None)
    if isinstance(raw, (str, dict, list)):
        try:
            return json.dumps(raw, ensure_ascii=False) if not isinstance(raw, str) else raw
        except (TypeError, ValueError):
            return str(raw)
    text = _block_text(getattr(update, "content", None))
    if text:
        return text
    locations = getattr(update, "locations", None)
    if isinstance(locations, (list, tuple)) and locations:
        first = locations[0]
        path = getattr(first, "path", None)
        if isinstance(path, str) and path.strip():
            payload: dict[str, Any] = {"path": path.strip()}
            line = getattr(first, "line", None)
            if isinstance(line, int) and line > 0:
                payload["line"] = line
            try:
                return json.dumps(payload, ensure_ascii=False)
            except (TypeError, ValueError):
                return path.strip()
    return ""


# ── The ACP client ──────────────────────────────────────────────────────────


class BridgeAcpClient:
    """The client half of ACP: receives hermes-agent's notifications.

    Not a subclass of ``acp.Client`` (that is a Protocol); the router calls
    these methods via ``getattr``. ``session_update`` and ``request_permission``
    are required by the protocol — everything else has router defaults.
    """

    def __init__(
        self,
        emit: Callable[[str, Any], None],
        approvals: dict[str, asyncio.Future],
        cwd: Optional[str] = None,
    ) -> None:
        self.emit = emit
        self._approvals = approvals
        self._cwd = cwd
        # tool_call_id -> {"title", "input", "ts"} for the structured
        # tool_call_begin/delta/end envelopes (started on ``tool_call``,
        # completed on ``tool_call_update`` with status completed/failed).
        self._tool_meta: dict[str, dict] = {}

    def on_connect(self, conn: Any) -> None:
        self._conn = conn

    # -- required by the protocol --------------------------------------------

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        try:
            self._dispatch(session_id, update)
        except Exception as exc:  # never let a translate error kill the loop
            logger.warning("acp session_update dispatch failed: %s", exc, exc_info=True)

    async def request_permission(
        self,
        options: list[Any],
        session_id: str,
        tool_call: Any,
        **kwargs: Any,
    ) -> Any:
        """hermes paused a tool and wants the user's decision.

        Emit an ``approval_request`` SSE event, park a future keyed by
        approval_id, and block until the bridge's approval route resolves it.
        """
        from acp.schema import (
            AllowedOutcome,
            DeniedOutcome,
            RequestPermissionResponse,
        )

        approval_id = f"acp-{uuid.uuid4().hex[:16]}"
        options_clean = []
        for o in options or []:
            oid = str(getattr(o, "option_id", None) or (o.get("option_id") if isinstance(o, dict) else "") or "")
            if not oid:
                continue
            name = str(
                getattr(o, "name", None)
                or (o.get("name") if isinstance(o, dict) else "")
                or oid
            )
            options_clean.append({"option_id": oid, "name": name})
        title = str(getattr(tool_call, "title", "") or "tool")
        detail = _tool_input_for_display(tool_call) or title

        self.emit(
            "approval_request",
            build_approval_request_event(
                approval_id=approval_id,
                session_id=session_id,
                tool=title,
                kind=str(getattr(tool_call, "kind", "") or "other"),
                summary=title,
                excerpt=detail,
                options=options_clean,
                command=extract_approval_command(tool_call),
                cwd=self._cwd,
                reason=None,  # not present in the ACP request_permission payload
            ),
        )

        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._approvals[approval_id] = future
        try:
            decision = await asyncio.wait_for(future, timeout=APPROVAL_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            decision = {"option_id": "deny"}
        finally:
            self._approvals.pop(approval_id, None)

        option_id = clamp_acp_option_id(
            decision.get("option_id") if isinstance(decision, dict) else decision,
            offered_acp_option_ids(options_clean),
        )
        if option_id in ("deny", "deny_always") or option_id == "":
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
        return RequestPermissionResponse(outcome=AllowedOutcome(outcome="selected", option_id=option_id))

    # -- optional client-side tools (delegated execution) ---------------------
    # hermes executes tools agent-side in ACP mode; these hooks exist for
    # protocol completeness. Returning None uses the router's safe defaults.

    async def create_terminal(self, command: str, session_id: str, **kwargs: Any) -> None:
        return None

    async def read_text_file(self, path: str, session_id: str, **kwargs: Any) -> None:
        return None

    async def write_text_file(self, content: str, path: str, session_id: str, **kwargs: Any) -> None:
        return None

    # -- dispatch ------------------------------------------------------------

    def _dispatch(self, session_id: str, update: Any) -> None:
        kind = getattr(update, "session_update", None)
        if kind in ("agent_message_chunk", "user_message_chunk"):
            text = _block_text(getattr(update, "content", None))
            if text:
                self.emit("text", text)
        elif kind == "agent_thought_chunk":
            text = _block_text(getattr(update, "content", None))
            if text:
                self.emit("reasoning", text)
        elif kind == "tool_call":
            # New tool call started.
            call_id = str(getattr(update, "tool_call_id", "") or "")
            title = str(getattr(update, "title", "") or "tool")
            tool_input = _tool_input_for_display(update)
            self._tool_meta[call_id] = {
                "title": title,
                "input": tool_input,
                "ts": time.time(),
            }
            self.emit("tool_call_begin", tool_call_begin_event(call_id, title))
            self.emit("tool_start", title, tool_input)
        elif kind == "tool_call_update":
            call_id = str(getattr(update, "tool_call_id", "") or "")
            meta = self._tool_meta.get(call_id)
            title = (meta or {}).get("title") or str(getattr(update, "title", "") or "tool")
            tool_input = (meta or {}).get("input") or ""
            status = getattr(update, "status", None)
            if status in ("completed", "failed"):
                self._tool_meta.pop(call_id, None)
                started_ts = (meta or {}).get("ts")
                duration_ms = int((time.time() - started_ts) * 1000) if started_ts else 0
                self.emit(
                    "tool_call_end",
                    tool_call_end_event(
                        call_id,
                        title,
                        success=status == "completed",
                        exit_code=extract_exit_code(update),
                        duration_ms=duration_ms,
                    ),
                )
                self.emit("tool_end", title, tool_input, _tool_output(update))
            else:
                # In-progress update — stream the output chunk as a delta.
                output = _tool_output(update)
                if output:
                    self.emit("tool_call_delta", tool_call_delta_event(call_id, output))
        elif kind == "plan_update":
            # The SDK nests entries under ``plan`` (PlanUpdate.plan.entries);
            # tolerate a top-level ``entries`` shape too. Markdown plans carry
            # ``content`` instead of entries — forward the raw text so the
            # bridge can still surface a structured checklist.
            plan = getattr(update, "plan", None) or update
            entries = getattr(plan, "entries", None) or getattr(update, "entries", None)
            if isinstance(entries, list) and entries:
                self.emit("plan", entries)
            else:
                # Markdown plans carry a plain-string ``content`` (no entries).
                raw_content = getattr(plan, "content", None)
                if isinstance(raw_content, str):
                    text = raw_content
                else:
                    text = _block_text(raw_content) or _block_text(getattr(update, "content", None))
                if text:
                    self.emit("plan", text)
        # usage_update / session_info_update / config_option_update /
        # current_mode_update / available_commands_update are not rendered
        # in CloudChat's chat stream — ignored.


# ── Session registry & process management ───────────────────────────────────


@dataclass
class _AcpHandle:
    conversation_id: str
    cwd: str
    proc: Any  # asyncio subprocess
    conn: Any  # ClientSideConnection
    session_id: str
    client: BridgeAcpClient
    loop: asyncio.AbstractEventLoop
    approvals: dict[str, asyncio.Future] = field(default_factory=dict)
    last_used: float = field(default_factory=time.time)
    # True while a prompt is in flight on this handle — the idle reaper must
    # never close a session mid-turn (a long stream can legitimately exceed
    # IDLE_TIMEOUT_SECONDS).
    busy: bool = False
    # Open file object for the per-conversation stderr log; closed when the
    # handle is torn down so the fd doesn't leak.
    stderr_file: Any = None

    def touch(self) -> None:
        self.last_used = time.time()

    async def close(self) -> None:
        """Tear down the session: politely ask the agent to close, then
        hard-kill + reap the process and release the stderr log fd.

        Never awaits indefinitely: ``close_session`` is bounded by
        ``CLOSE_SESSION_TIMEOUT_SECONDS`` so an unresponsive agent can't
        wedge session management. Callers must NOT hold ``_sessions_lock``
        across this call.
        """
        try:
            await asyncio.wait_for(
                self.conn.close_session(self.session_id),
                timeout=CLOSE_SESSION_TIMEOUT_SECONDS,
            )
        except Exception:
            pass
        if self.proc is not None:
            try:
                if self.proc.returncode is None:
                    self.proc.kill()
            except Exception:
                pass
            try:
                await self.proc.wait()
            except Exception:
                pass
        if self.stderr_file is not None:
            try:
                self.stderr_file.close()
            except Exception:
                pass
            self.stderr_file = None


_sessions: dict[str, _AcpHandle] = {}
_sessions_lock = asyncio.Lock()

# How long to wait for the agent to acknowledge close_session before we
# hard-kill the process. Keep it short — this runs on the bridge's event loop.
CLOSE_SESSION_TIMEOUT_SECONDS = 5.0


def _env_float(name: str, default: float) -> float:
    """Parse a positive float from the environment with a fallback default.

    A missing, non-numeric, or non-positive value falls back to ``default``
    instead of raising at import time (a bad value must not break the bridge).
    """
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("ignoring invalid %s=%r (using default %s)", name, raw, default)
        return default
    if value <= 0:
        logger.warning("ignoring non-positive %s=%r (using default %s)", name, raw, default)
        return default
    return value


APPROVAL_TIMEOUT_SECONDS = _env_float("HERMES_ACP_APPROVAL_TIMEOUT", 3600)
IDLE_TIMEOUT_SECONDS = _env_float("HERMES_ACP_IDLE_TIMEOUT", 1800)
PROMPT_TIMEOUT_SECONDS = _env_float("HERMES_ACP_PROMPT_TIMEOUT", 3600)

# Spawn resilience: how many times ensure_session retries starting hermes-acp
# before giving up, and the base backoff between attempts (doubles each time).
ACP_SPAWN_MAX_ATTEMPTS = max(1, int(os.environ.get("HERMES_ACP_SPAWN_MAX_ATTEMPTS", "3")))
ACP_SPAWN_BACKOFF_BASE_MS = max(0, int(os.environ.get("HERMES_ACP_SPAWN_BACKOFF_BASE_MS", "250")))

# Client-controlled conversation ids must be scrubbed before they end up in a
# filename (they can carry path separators / traversal sequences).
_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]")

# Bare pool-only provider ids that the bridge/CLI surface as synthetic
# `custom:<name>` rows. hermes knows each bare id natively (provider catalog +
# credential pool), so `custom:opencode-go` must be handed to set_session_model
# as `opencode-go` — a `custom:<name>:<model>` triple for a non-config.yaml
# provider is parsed as ("custom", "<name>:<model>") and the upstream 400s
# with "<name>:<model> is not a valid model ID".
_POOL_ONLY_BARE_PROVIDERS = frozenset({
    "opencode-go",
    "opencode-zen",
    "opencode.ai",
})


def build_session_model_id(provider: str, model: Optional[str]) -> str:
    """Compose the `provider:model` id handed to hermes set_session_model.

    Pool-only synthetic rows (custom:opencode-go, custom:opencode.ai, …) are a
    bridge/CLI routing concept. hermes' parse_model_input only re-joins
    `custom:<name>:<model>` triples for config.yaml custom providers, so a
    triple like `custom:opencode-go:muse-spark-1.3-contributor` resolves to
    ("custom", "opencode-go:muse-spark-1.3-contributor") and the upstream
    400s with "<prefixed> is not a valid model ID". The bare pool provider is
    a known hermes provider — strip the synthetic prefix before composing.
    """
    session_provider = provider
    if session_provider.startswith("custom:"):
        bare = session_provider[len("custom:"):]
        if bare in _POOL_ONLY_BARE_PROVIDERS:
            session_provider = bare
    return f"{session_provider}:{model}" if model else session_provider


def _safe_conversation_id(conversation_id: str) -> str:
    """Sanitize a conversation id for use in filenames (safe charset, capped)."""
    safe = _SAFE_ID_RE.sub("_", str(conversation_id)).strip("_")
    return (safe or "unknown")[:40]


def _same_dir(a: str, b: str) -> bool:
    """True when two cwd strings denote the same directory.

    realpath collapses symlinks (notably /tmp -> /private/tmp on macOS);
    normcase guards case-insensitive filesystems. Falls back to string
    equality when either side is unresolvable.
    """
    try:
        return os.path.normcase(os.path.realpath(a)) == os.path.normcase(
            os.path.realpath(b)
        )
    except OSError:
        return (a or "") == (b or "")


async def ensure_session(
    *,
    loop: asyncio.AbstractEventLoop,
    conversation_id: str,
    cwd: str,
    emit: Callable[[str, Any], None],
    provider: Optional[str] = None,
    model: Optional[str] = None,
    plan_mode: bool = False,
) -> _AcpHandle:
    """Return a live ACP session for this conversation, spawning hermes-acp on first use.

    Spawns are retried with backoff (each retry surfaces a ``stream_retry``
    SSE event); a respawn over a dead process also emits one ``stream_retry``
    so the UI can explain the hiccup. ``plan_mode`` is passed to hermes-acp as
    an environment hint (``HERMES_ACP_PLAN_MODE=1``) — best-effort, never
    blocks spawning.
    """
    import acp
    from acp.schema import ClientCapabilities, Implementation

    async with _sessions_lock:
        handle = _sessions.get(conversation_id)
        if handle is not None and handle.proc.returncode is None:
            if _same_dir(handle.cwd, cwd):
                handle.touch()
                return handle
            # The conversation moved to a different checkout (repo switch) —
            # a reused session would resolve relative reads/searches against
            # the old cwd and fail every one. Tear down and respawn there.
            _sessions.pop(conversation_id, None)
            loop.create_task(_close_handle_quietly(handle))
            handle = None
            emit(
                "stream_retry",
                stream_retry_event(
                    attempt=1,
                    max_attempts=ACP_SPAWN_MAX_ATTEMPTS,
                    reason="acp-transport-cwd-switch",
                    delay_ms=0,
                ),
            )
        if handle is not None:
            # The previous hermes-acp process died — drop the handle and
            # release its stderr log fd in the background before respawning.
            _sessions.pop(conversation_id, None)
            loop.create_task(_close_handle_quietly(handle))
            emit(
                "stream_retry",
                stream_retry_event(
                    attempt=1,
                    max_attempts=ACP_SPAWN_MAX_ATTEMPTS,
                    reason="acp-transport-reconnect",
                    delay_ms=0,
                ),
            )

        cmd = _acp_command()
        if cmd is None:
            raise RuntimeError("hermes-acp binary not found on PATH")

        spawn_env = None
        if plan_mode:
            spawn_env = dict(os.environ)
            spawn_env["HERMES_ACP_PLAN_MODE"] = "1"

        last_error: Optional[BaseException] = None
        for spawn_attempt in range(1, ACP_SPAWN_MAX_ATTEMPTS + 1):
            try:
                handle = await _spawn_session(
                    loop=loop,
                    conversation_id=conversation_id,
                    cwd=cwd,
                    cmd=cmd,
                    emit=emit,
                    provider=provider,
                    model=model,
                    plan_mode=plan_mode,
                    spawn_env=spawn_env,
                )
                _sessions[conversation_id] = handle
                logger.info(
                    "acp session %s ready for conversation %s (cwd=%s)",
                    handle.session_id,
                    conversation_id,
                    cwd,
                )
                return handle
            except BaseException as exc:  # noqa: BLE001 - spawn must be retried
                last_error = exc
                if spawn_attempt >= ACP_SPAWN_MAX_ATTEMPTS:
                    raise
                delay_ms = ACP_SPAWN_BACKOFF_BASE_MS * (2 ** (spawn_attempt - 1))
                emit(
                    "stream_retry",
                    stream_retry_event(
                        attempt=spawn_attempt,
                        max_attempts=ACP_SPAWN_MAX_ATTEMPTS,
                        reason=f"acp-spawn-failed:{exc.__class__.__name__}",
                        delay_ms=delay_ms,
                    ),
                )
                if delay_ms > 0:
                    await asyncio.sleep(delay_ms / 1000)

        # Should not reach here — the loop either returns or re-raises.
        raise RuntimeError("hermes-acp spawn failed") from last_error


async def _spawn_session(
    *,
    loop: asyncio.AbstractEventLoop,
    conversation_id: str,
    cwd: str,
    cmd: list[str],
    emit: Callable[[str, Any], None],
    provider: Optional[str],
    model: Optional[str],
    plan_mode: bool,
    spawn_env: Optional[dict],
) -> _AcpHandle:
    """Spawn hermes-acp and initialize a session (single attempt; raises on failure)."""
    import acp
    from acp.schema import ClientCapabilities, Implementation

    client = BridgeAcpClient(emit=emit, approvals={}, cwd=cwd)
    # Drain stderr to a per-conversation log file so a chatty agent can
    # never deadlock the stdio pipe, and failures are debuggable. The
    # conversation id is client-controlled — sanitize it before it goes
    # into a filename.
    import tempfile

    stderr_path = os.path.join(
        tempfile.gettempdir(),
        f"hermes-acp-{_safe_conversation_id(conversation_id)}.log",
    )
    stderr_file = None
    proc = None
    try:
        stderr_file = open(stderr_path, "ab", buffering=0)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd or None,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr_file,
            env=spawn_env,
            # hermes-acp emits large JSON-RPC lines (initialize/new_session
            # payloads can carry the full provider catalog + MCP tool lists).
            # The default 64KB StreamReader limit makes the acp SDK's readline
            # receive loop raise "Separator is not found" on them.
            limit=4 * 1024 * 1024,
        )
        conn = acp.connect_to_agent(client, proc.stdin, proc.stdout, use_unstable_protocol=True)

        init = await conn.initialize(
            protocol_version=acp.PROTOCOL_VERSION,
            client_info=Implementation(name="cloud-chat-hub", version="1.0.0"),
            client_capabilities=ClientCapabilities(),
        )
        auth_methods = getattr(init, "auth_methods", None) or []
        if auth_methods:
            first = auth_methods[0]
            method_id = str(getattr(first, "method_id", "") or "").strip()
            if method_id:
                try:
                    await conn.authenticate(method_id)
                except Exception as exc:
                    logger.warning("acp authenticate(%s) failed: %s", method_id, exc)

        ns = await conn.new_session(cwd=cwd or ".")
        session_id = str(getattr(ns, "session_id", "") or "")
        if not session_id:
            raise RuntimeError("hermes-acp returned no session id")

        if provider and provider not in ("auto", "default"):
            model_id = build_session_model_id(provider, model)
            try:
                await conn.set_session_model(model_id, session_id)
            except Exception as exc:
                logger.warning("acp set_session_model(%s) failed: %s", model_id, exc)
    except BaseException:
        # Setup failed partway — never leave an orphaned hermes-acp or a
        # leaked stderr log fd behind. Kill + reap, close the log, re-raise.
        if proc is not None:
            try:
                if proc.returncode is None:
                    proc.kill()
            except Exception:
                pass
            try:
                await proc.wait()
            except Exception:
                pass
        if stderr_file is not None:
            try:
                stderr_file.close()
            except Exception:
                pass
        raise

    return _AcpHandle(
        conversation_id=conversation_id,
        cwd=cwd,
        proc=proc,
        conn=conn,
        session_id=session_id,
        client=client,
        loop=loop,
        approvals=client._approvals,
        stderr_file=stderr_file,
    )


async def _close_handle_quietly(handle: _AcpHandle) -> None:
    """Close a handle in the background; never raises, never blocks callers."""
    try:
        await handle.close()
    except Exception:
        pass


def run_prompt_blocking(
    *,
    loop: asyncio.AbstractEventLoop,
    conversation_id: str,
    cwd: str,
    user_message: str,
    emit: Callable[[str, Any], None],
    provider: Optional[str] = None,
    model: Optional[str] = None,
    timeout: Optional[float] = None,
    plan_mode: bool = False,
) -> None:
    """Blocking bridge used from the worker thread (mirrors the agent-loop transport)."""
    import acp
    import inspect

    prompt_timeout = timeout or PROMPT_TIMEOUT_SECONDS

    async def _impl() -> None:
        handle = await ensure_session(
            loop=loop,
            conversation_id=conversation_id,
            cwd=cwd,
            emit=emit,
            provider=provider,
            model=model,
            plan_mode=plan_mode,
        )
        # Mark the handle busy for the whole turn so the idle reaper never
        # SIGKILLs a session mid-prompt (a long stream can legitimately
        # outlast IDLE_TIMEOUT_SECONDS).
        handle.busy = True
        try:
            # Notifications must stream into THIS request's queue. The client is
            # shared across prompts on the same conversation, so repoint its emit
            # callback for the duration of this prompt.
            handle.client.emit = emit
            handle.touch()
            prompt_text = user_message
            if plan_mode:
                prompt_text = prompt_text + PLAN_MODE_PROMPT_SUFFIX
            blocks = [acp.text_block(prompt_text)]
            # The `prompt` arg order changed between SDK versions: 0.9.0 is
            # `prompt(prompt, session_id)`, 0.11+ is `prompt(session_id, prompt)`.
            # Inspect the bound method so the transport works on whichever venv
            # the bridge is running under (bridge .venv vs hermes-agent venv).
            first_param = next(
                (n for n, p in inspect.signature(handle.conn.prompt).parameters.items() if n not in ("self", "kwargs")),
                "session_id",
            )
            if first_param == "session_id":
                call = handle.conn.prompt(handle.session_id, blocks)
            else:
                call = handle.conn.prompt(blocks, handle.session_id)
            # Bound the turn: a stuck or over-long prompt must not run forever,
            # and its late output must not bleed into the next request.
            await asyncio.wait_for(call, timeout=prompt_timeout)
        except asyncio.TimeoutError:
            # The turn overran its deadline. Cancel it and tear the session
            # down so stale notifications from this turn are dropped instead
            # of being repointed into the next request on this conversation.
            async with _sessions_lock:
                _sessions.pop(conversation_id, None)
            await handle.close()
            raise TimeoutError(f"hermes-acp prompt timed out after {prompt_timeout:.0f}s") from None
        finally:
            handle.busy = False

    future = asyncio.run_coroutine_threadsafe(_impl(), loop)
    # Backstop only: _impl owns the timeout (wait_for cancels the turn and
    # tears the session down before this can fire).
    future.result(timeout=prompt_timeout + CLOSE_SESSION_TIMEOUT_SECONDS + 30)


async def resolve_approval(approval_id: str, option_id: str) -> bool:
    """Complete a parked approval future. Returns True when the decision was delivered."""
    # Normalize UI ladder ids (`approved`) so request_permission can clamp
    # against the option list hermes actually offered.
    normalized = clamp_acp_option_id(option_id)
    for handle in list(_sessions.values()):
        future = handle.approvals.get(approval_id)
        if future is not None and not future.done():
            future.set_result({"option_id": normalized})
            return True
    return False


async def reap_idle_sessions() -> int:
    """Close sessions idle for IDLE_TIMEOUT_SECONDS. Returns how many were closed.

    Handles with a prompt in flight (``busy``) are never reaped — a long turn
    streaming content must not be killed mid-prompt. Handles are popped under
    the lock but closed after releasing it: ``close()`` may wait up to
    ``CLOSE_SESSION_TIMEOUT_SECONDS`` on an unresponsive agent and must not
    block session management.
    """
    now = time.time()
    closed = 0
    stale: list[_AcpHandle] = []
    async with _sessions_lock:
        for cid, handle in list(_sessions.items()):
            if handle.busy:
                continue
            if now - handle.last_used > IDLE_TIMEOUT_SECONDS:
                _sessions.pop(cid, None)
                stale.append(handle)
    for handle in stale:
        try:
            await handle.close()
            closed += 1
        except Exception:
            pass
    return closed


async def shutdown_all() -> None:
    """Close every live ACP session (used on bridge shutdown)."""
    async with _sessions_lock:
        handles = list(_sessions.values())
        _sessions.clear()
    for handle in handles:
        try:
            await handle.close()
        except Exception:
            pass
