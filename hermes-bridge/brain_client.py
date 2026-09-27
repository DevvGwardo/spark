"""
brain_client.py — brain-mcp subprocess + JSON-RPC client for hermes-bridge.

Extracted from main.py so that swarm_pattern.py can reach the brain RPC layer
without importing main.

WHY THIS IS A SEPARATE MODULE
The bridge is launched as `python main.py` (scripts/start-bridge.sh:45), which
binds main's code to the `__main__` module object. A `import main` from any other
module therefore executed main.py a *second* time under a second module object.
Because the brain subprocess handle lived in that first copy, every brain RPC made
through the imported copy saw `_brain_proc is None` and silently returned None,
while the real bridge instance kept its own, healthy handle. The symptom was
"swarm brain calls always return None" with no error anywhere.

Owning the handle in a third module removes the cycle: main.py and
swarm_pattern.py both depend on brain_client, and brain_client depends on neither.

All brain calls are fire-and-forget — the bridge continues if brain is unavailable.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

# The mcp SDK is not used for transport (raw JSON-RPC is used instead, because the
# SDK's stdio transport was broken), but its availability is still the historical
# gate for enabling brain integration at all. Preserved as-is so this extraction
# does not silently change when brain turns on.
try:
    from mcp import ClientSession  # noqa: F401

    _MCP_AVAILABLE = True
except ImportError:  # pragma: no cover - depends on the install environment
    _MCP_AVAILABLE = False


# --- Module state -----------------------------------------------------------------
# All brain process state lives here, in one module, so exactly one copy of it
# exists no matter how many modules import it.

_brain_session: Optional["ClientSession"] = None
_brain_initialized = False
_brain_ctx_stack = None  # holds the raw context manager object

_brain_proc: Optional[asyncio.subprocess.Process] = None
_brain_reader_task: Optional[asyncio.Task] = None
_brain_pending: dict[int, asyncio.Future] = {}
_brain_msg_id: int = 0
_main_event_loop: Optional[asyncio.AbstractEventLoop] = None
_heartbeat_task: Optional[asyncio.Task] = None

_claimed_resources: set = set()
_claimed_resources_lock = threading.Lock()

# main.py owns the bridge metrics counters; brain_client asks for a snapshot rather
# than importing main (which would recreate the very cycle this module removes).
_metrics_provider: Optional[Callable[[], dict]] = None


@dataclass
class BrainConfig:
    """Everything from main.py that the brain startup sequence needs to publish."""

    port: int
    model: str
    toolsets: str
    max_iterations: int


def set_metrics_provider(provider: Callable[[], dict]) -> None:
    """Register the callable brain_client uses to sample bridge metrics.

    Must return a dict with any of: uptime, active_requests, total_requests,
    error_count, claimed_resources.
    """
    global _metrics_provider
    _metrics_provider = provider


# --- Discovery (B5) ----------------------------------------------------------------
# Previously hard-coded to `~/brain-mcp/dist/index.js` with a fallback to
# `/Users/devgwardo/brain-mcp/dist/index.js`, and spawned via the absolute path
# `/opt/homebrew/bin/node`. Both broke on any machine that was not the original
# author's. Resolution is now: explicit env override, then a portable default
# relative to $HOME, then skip.


def resolve_brain_script() -> Optional[str]:
    """Return the brain-mcp entry script, or None when it is not installed.

    BRAIN_MCP_PATH wins, so a checkout can live anywhere. Otherwise look at the
    conventional ~/brain-mcp/dist/index.js. Returns None rather than guessing when
    nothing is found — callers treat that as "run without brain".
    """
    override = (os.environ.get("BRAIN_MCP_PATH") or "").strip()
    if override:
        return override if os.path.exists(override) else None
    conventional = os.path.join(os.path.expanduser("~"), "brain-mcp", "dist", "index.js")
    return conventional if os.path.exists(conventional) else None


def resolve_node_binary() -> Optional[str]:
    """Return a usable `node` executable path, or None when node is not installed."""
    override = (os.environ.get("BRAIN_NODE_PATH") or "").strip()
    if override:
        return override if os.path.exists(override) else None
    found = shutil.which("node")
    if found:
        return found
    # Common install locations, for the case where PATH is minimal (a launchd job
    # or a service manager often hands over a minimal PATH).
    for candidate in ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"):
        if os.path.exists(candidate):
            return candidate
    return None


def _brain_subprocess_env() -> dict:
    """Env for the brain subprocess.

    Inherits the bridge's own environment and sets BRAIN_ROOM. The previous
    hard-coded PATH ("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin") meant a
    node installed anywhere else could not resolve its own child processes.
    """
    env = dict(os.environ)
    env["BRAIN_ROOM"] = os.path.expanduser("~")
    return env


# --- Transport --------------------------------------------------------------------


async def _brain_reader() -> None:
    """Read JSON-RPC responses from brain-mcp and resolve pending futures."""
    while True:
        try:
            line = await _brain_proc.stdout.readline()
        except Exception:
            # Stream failure — treat as end of stream and disable brain.
            break
        if not line:
            # EOF — the brain process closed its stdout.
            break
        try:
            msg = json.loads(line.decode())
        except Exception as e:
            # A single malformed line must not kill the reader for the
            # process lifetime (previously: `except Exception: break`,
            # which left _brain_initialized True and made every _brain_rpc
            # hang for its 10s timeout). Skip the line and keep reading.
            print(f"[hermes-bridge] brain: skipping malformed line: {e}", flush=True)
            continue
        mid = msg.get("id")
        if mid is not None and mid in _brain_pending:
            fut = _brain_pending.pop(mid)
            if not fut.done():
                fut.set_result(msg)
    # Process/stream ended — mark brain unavailable so callers stop
    # retrying instead of hanging on 10s timeouts.
    global _brain_initialized
    _brain_initialized = False
    print("[hermes-bridge] brain: reader exited (process/stream ended); brain calls disabled", flush=True)


async def _brain_rpc(method: str, params: dict) -> Optional[dict]:
    """Send a JSON-RPC request and wait for response. Returns the result dict."""
    global _brain_msg_id
    if _brain_proc is None or _brain_proc.returncode is not None:
        return None
    mid = _brain_msg_id
    _brain_msg_id += 1
    msg = json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}) + "\n"
    fut: asyncio.Future = asyncio.Future()
    _brain_pending[mid] = fut
    try:
        _brain_proc.stdin.write(msg.encode())
        await _brain_proc.stdin.drain()
        result = await asyncio.wait_for(fut, timeout=10)
        return result.get("result")
    except Exception:
        _brain_pending.pop(mid, None)
        return None


async def _brain_call_async(tool: str, args: dict) -> Optional[dict]:
    """Make a brain tool call, returns result dict or None."""
    return await _brain_rpc("tools/call", {"name": tool, "arguments": args})


# --- Lifecycle --------------------------------------------------------------------


async def start_brain(config: BrainConfig) -> bool:
    """Spawn brain-mcp and publish the bridge's contracts. Returns True if connected.

    Never raises: brain is an optional integration, and the bridge must boot
    without it. Callers get False plus a log line when it is skipped or fails.
    """
    global _brain_proc, _brain_reader_task, _main_event_loop, _heartbeat_task

    if not _MCP_AVAILABLE:
        print("[hermes-bridge] Brain MCP disabled (mcp package unavailable)", flush=True)
        return False

    brain_path = resolve_brain_script()
    if not brain_path:
        print(
            "[hermes-bridge] Brain MCP not installed — set BRAIN_MCP_PATH to enable it; "
            "continuing without brain",
            flush=True,
        )
        return False

    node_bin = resolve_node_binary()
    if not node_bin:
        print("[hermes-bridge] Brain MCP skipped: no `node` binary on PATH", flush=True)
        return False

    try:
        _brain_proc = await asyncio.create_subprocess_exec(
            node_bin, brain_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_brain_subprocess_env(),
        )
    except Exception as e:
        print(f"[hermes-bridge] Brain MCP spawn failed: {e}", flush=True)
        _brain_proc = None
        return False

    _brain_reader_task = asyncio.create_task(_brain_reader())

    await _brain_rpc("initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "hermes-bridge", "version": "1.0"},
    })
    # Register and set initial state
    await _brain_rpc("tools/call", {"name": "brain_register", "arguments": {"name": "hermes-bridge"}})
    await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "hermes-bridge:active_sessions", "value": "0", "scope": "global"}})
    await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "hermes-bridge:model", "value": config.model, "scope": "global"}})
    await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "hermes-bridge:toolsets", "value": config.toolsets, "scope": "global"}})

    import platform
    import sys

    # Publish bridge health metadata
    health_meta = json.dumps({
        "port": config.port,
        "model": config.model,
        "toolsets": config.toolsets,
        "max_iterations": config.max_iterations,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
        "platform": platform.platform(),
    })
    await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "bridge:health", "value": health_meta, "scope": "global"}})

    # Publish bridge contracts (inter-agent interface agreements)
    contracts = json.dumps({
        "hermes-bridge:v1": {
            "description": "Hermes agent bridge — OpenAI-compatible /v1/chat/completions proxy with repo tools",
            "port": config.port,
            "model": config.model,
            "toolsets": config.toolsets,
            "max_iterations": config.max_iterations,
            "endpoints": ["/health", "/v1/models", "/v1/chat/completions", "/v1/swarm"],
            "headers": {
                "x-hermes-toolsets": "comma-separated toolset list",
                "x-hermes-execution-mode": "agent-loop | passthrough | swarm",
                "x-hermes-repo-owner": "GitHub repo owner (for repo mode)",
                "x-hermes-repo-name": "GitHub repo name (for repo mode)",
                "x-hermes-github-pat": "GitHub PAT for repo operations",
                "x-hermes-repo-edit-intent": "1 to enable edit-mode tools",
                "x-hermes-worktree": "1 to run in an isolated git worktree",
                "x-hermes-repo-root": "Local git repo root for worktree creation",
            },
        },
    })
    await _brain_rpc("tools/call", {"name": "brain_contract_set", "arguments": {"key": "hermes-bridge:contracts", "value": contracts, "scope": "global"}})

    metrics_contract = json.dumps({
        "description": "Bridge operational metrics published by hermes-bridge",
        "keys": {
            "bridge:health": "JSON — port, model, toolsets, platform info",
            "bridge:metrics": "JSON — api_calls, estimated_cost_usd, active_requests, error_rate, uptime, start_time",
            "hermes-bridge:active_request": "Current request metadata (owner/repo/model/toolsets)",
            "hermes-bridge:active_sessions": "Number of active sessions (global counter)",
        },
    })
    await _brain_rpc("tools/call", {"name": "brain_contract_set", "arguments": {"key": "bridge:metrics:contract", "value": metrics_contract, "scope": "global"}})

    # Publish swarm pattern contracts (3-phase pipeline interface)
    swarm_contract = json.dumps({
        "description": "Architect → Implementor → Reviewer swarm pipeline for hermes-bridge",
        "modules": {
            "hermes-bridge/swarm_pattern.py": {
                "SwarmCoordinator": {
                    "run_phase_architect": {"phase": "architect", "brain_keys": {"writes": ["request:<id>:ctx"], "polls": ["plan:<id>"]}},
                    "run_phase_implementor": {"phase": "implementor", "brain_keys": {"writes": ["request:<id>:phase", "staging:<id>:<filepath>"], "polls": ["request:<id>:staging_keys"]}},
                    "run_phase_reviewer": {"phase": "reviewer", "brain_keys": {"writes": ["request:<id>:verdict"], "polls": ["request:<id>:staging_keys"]}},
                    "_finish": {"phase": "done", "brain_keys": {"writes": ["request:<id>:status"], "polls": ["request:<id>:phase"]}},
                },
                "run_swarm": {
                    "params": ["user_message", "conversation_history", "enabled_toolsets", "repo_mode", "repo_owner", "repo_name", "github_pat"],
                    "returns": {"success": "bool", "verdict": "str", "review_notes": "str", "staged_files": "dict", "elapsed_ms": "int"},
                },
            },
        },
    })
    await _brain_rpc("tools/call", {"name": "brain_contract_set", "arguments": {"key": "swarm:contracts", "value": swarm_contract, "scope": "global"}})

    # Publish initial health metrics with uptime tracking
    health_metrics = json.dumps({
        "active_requests": 0,
        "error_rate": 0.0,
        "uptime": 0.0,
        "start_time": time.time(),
        "port": config.port,
        "model": config.model,
        "toolsets": config.toolsets,
        "platform": platform.platform(),
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
    })
    await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "bridge:metrics", "value": health_metrics, "scope": "global"}})

    # Verify contracts are readable (contract check on self)
    try:
        result = await _brain_rpc("tools/call", {"name": "brain_contract_check", "arguments": {}})
        if result:
            print(f"[hermes-bridge] Contract check passed: {result}", flush=True)
    except Exception:
        pass

    global _brain_initialized
    _brain_initialized = True
    # Capture the running event loop for thread-safe brain calls
    _main_event_loop = asyncio.get_running_loop()
    # Start background heartbeat task
    _heartbeat_task = asyncio.create_task(_bridge_heartbeat())
    print(f"[hermes-bridge] Brain MCP connected PID={_brain_proc.pid}", flush=True)
    return True


async def _bridge_heartbeat() -> None:
    """Background task: pulse brain with bridge health every 30 seconds."""
    while True:
        try:
            await asyncio.sleep(30)
            metrics = _metrics_provider() if _metrics_provider else {}
            start_time = float(metrics.get("start_time") or 0.0)
            uptime = int(time.time() - start_time) if start_time > 0 else 0
            with _claimed_resources_lock:
                claimed = len(_claimed_resources)
            pulse_msg = f"uptime={uptime}s active={metrics.get('active_requests', 0)} claimed={claimed}"
            _brain_pulse("working", pulse_msg)
            health = {
                "uptime": uptime,
                "active_requests": metrics.get("active_requests", 0),
                "total_requests": metrics.get("total_requests", 0),
                "error_count": metrics.get("error_count", 0),
                "claimed_resources": claimed,
            }
            _brain_set("bridge:health", json.dumps(health))
        except asyncio.CancelledError:
            break
        except Exception:
            pass  # Silently continue on errors


async def stop_brain() -> None:
    """Tear down the brain subprocess and its background tasks."""
    global _brain_initialized
    if _heartbeat_task:
        _heartbeat_task.cancel()
        try:
            # Awaited directly rather than via wait_for: cancelling and then
            # awaiting raises CancelledError, which is a BaseException and would
            # slip past `except Exception`.
            await _heartbeat_task
        except asyncio.CancelledError:
            pass  # expected — we just cancelled it
        except Exception:
            pass
    if _brain_reader_task:
        _brain_reader_task.cancel()
    if _brain_proc:
        try:
            _brain_proc.terminate()
            await asyncio.wait_for(_brain_proc.wait(), timeout=3)
        except Exception:
            pass
    _brain_initialized = False


# --- Sync helpers (callable from worker threads) -----------------------------------


def _extract_text(result: Optional[dict]) -> Optional[str]:
    """Pull the text payload out of a brain tool result."""
    if isinstance(result, dict):
        content = result.get("content") or result.get("value")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    return item.get("text")
        if isinstance(content, str):
            return content
    return None


def _brain_get(key: str, scope: str = "global") -> Optional[str]:
    """Helper to read brain state text. Thread-safe via run_coroutine_threadsafe."""
    if not _brain_initialized or _brain_proc is None:
        return None
    try:
        if _main_event_loop and _main_event_loop.is_running():
            # Use run_coroutine_threadsafe to schedule on the main event loop
            future = asyncio.run_coroutine_threadsafe(
                _brain_call_async("brain_get", {"key": key, "scope": scope}),
                _main_event_loop,
            )
            result = future.result(timeout=5)
        else:
            result = None
    except Exception:
        return None
    return _extract_text(result)


def _brain_set(key: str, value: str, scope: str = "global") -> None:
    """Helper to set brain state. Thread-safe via run_coroutine_threadsafe."""
    if not _brain_initialized or _brain_proc is None:
        return
    try:
        if _main_event_loop and _main_event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                _brain_call_async("brain_set", {"key": key, "value": value, "scope": scope}),
                _main_event_loop,
            )
    except Exception:
        pass


def _brain_post(content: str, channel: str = "general") -> None:
    """Helper to post to brain channel. Thread-safe via run_coroutine_threadsafe."""
    if not _brain_initialized or _brain_proc is None:
        return
    try:
        if _main_event_loop and _main_event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                _brain_call_async("brain_post", {"content": content, "channel": channel}),
                _main_event_loop,
            )
    except Exception:
        pass


def _brain_pulse(status: str = "working", progress: str = "") -> None:
    """Helper to send brain pulse. Thread-safe via run_coroutine_threadsafe."""
    if not _brain_initialized or _brain_proc is None:
        return
    try:
        if _main_event_loop and _main_event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                _brain_call_async("brain_pulse", {"status": status, "progress": progress}),
                _main_event_loop,
            )
    except Exception:
        pass


def _brain_claim(resource: str, ttl: int = 60) -> Optional[bool]:
    """Helper to claim a brain resource. Thread-safe via run_coroutine_threadsafe.
    Also tracks the resource in _claimed_resources for bulk cleanup."""
    if not _brain_initialized or _brain_proc is None:
        return None
    try:
        with _claimed_resources_lock:
            _claimed_resources.add(resource)
        if _main_event_loop and _main_event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                _brain_call_async("brain_claim", {"resource": resource, "ttl": ttl}),
                _main_event_loop,
            )
            return True  # Fire-and-forget from threads; claim will auto-expire via TTL
    except Exception:
        return None
    return None


def _brain_release(resource: str) -> None:
    """Helper to release a brain resource. Thread-safe via run_coroutine_threadsafe."""
    if not _brain_initialized or _brain_proc is None:
        return
    try:
        with _claimed_resources_lock:
            _claimed_resources.discard(resource)
        if _main_event_loop and _main_event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                _brain_call_async("brain_release", {"resource": resource}),
                _main_event_loop,
            )
    except Exception:
        pass


def _brain_dm(target: str, content: str) -> None:
    """Helper to send a direct message to another agent via brain DM. Thread-safe."""
    if not _brain_initialized or _brain_proc is None:
        return
    try:
        if _main_event_loop and _main_event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                _brain_call_async("brain_dm", {"target": target, "content": content}),
                _main_event_loop,
            )
    except Exception:
        pass


def _brain_contract_set(key: str, value: str, scope: str = "global") -> None:
    """Helper to publish a bridge contract. Thread-safe."""
    if not _brain_initialized or _brain_proc is None:
        return
    try:
        if _main_event_loop and _main_event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                _brain_call_async("brain_contract_set", {"key": key, "value": value, "scope": scope}),
                _main_event_loop,
            )
    except Exception:
        pass


def _brain_contract_get(key: str, scope: str = "global") -> Optional[str]:
    """Helper to read a published contract, returns value or None. Thread-safe."""
    if not _brain_initialized or _brain_proc is None:
        return None
    try:
        if _main_event_loop and _main_event_loop.is_running():
            future = asyncio.run_coroutine_threadsafe(
                _brain_call_async("brain_contract_get", {"key": key, "scope": scope}),
                _main_event_loop,
            )
            result = future.result(timeout=5)
        else:
            result = None
    except Exception:
        return None
    return _extract_text(result)


def _brain_contract_check(key: str, expected: str) -> bool:
    """Check that a published contract matches expected value. Returns True if match or brain unavailable."""
    val = _brain_contract_get(key)
    if val is None:
        return True  # brain unavailable — assume match
    return val == expected
