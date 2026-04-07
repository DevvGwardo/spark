import os
import json
import asyncio
import time
from typing import Optional
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

app: FastAPI = None  # created after brain-lifespan is defined

# --- Brain MCP integration ---
# Uses MCP Python SDK to spawn brain-mcp server as a stdio subprocess.
# All brain calls are fire-and-forget — bridge continues if brain is unavailable.
try:
    from mcp.client.stdio import StdioServerParameters, stdio_client
    from mcp import ClientSession

    _brain_session: Optional[ClientSession] = None
    _brain_initialized = False
    _brain_ctx_stack = None  # holds the raw context manager object

    # --- Raw JSON-RPC over subprocess (bypasses MCP SDK's broken stdio transport) ---
    _brain_proc: asyncio.subprocess.Process = None
    _brain_reader_task: asyncio.Task = None
    _brain_pending: dict[int, asyncio.Future] = {}
    _brain_msg_id: int = 0

    async def _brain_reader():
        """Read JSON-RPC responses from brain-mcp and resolve pending futures."""
        import json
        while True:
            try:
                line = await _brain_proc.stdout.readline()
                if not line:
                    break
                msg = json.loads(line.decode())
                mid = msg.get("id")
                if mid is not None and mid in _brain_pending:
                    fut = _brain_pending.pop(mid)
                    if not fut.done():
                        fut.set_result(msg)
            except Exception:
                break

    async def _brain_rpc(method: str, params: dict) -> dict:
        """Send a JSON-RPC request and wait for response. Returns the result dict."""
        import json
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

    async def _brain_lifespan(app):
        """FastAPI lifespan — spawns brain-mcp as async subprocess, shuts down cleanly."""
        global _brain_proc, _brain_reader_task, _brain_initialized, _bridge_start_time, _bridge_total_requests, _bridge_error_count
        try:
            brain_path = os.path.expanduser("~/brain-mcp/dist/index.js")
            if not os.path.exists(brain_path):
                brain_path = "/Users/devgwardo/brain-mcp/dist/index.js"
            _brain_proc = await asyncio.create_subprocess_exec(
                "/opt/homebrew/bin/node", brain_path,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={
                    "BRAIN_ROOM": os.path.expanduser("~"),
                    "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
                },
            )
            _brain_reader_task = asyncio.create_task(_brain_reader())
            # Initialize MCP session
            await _brain_rpc("initialize", {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "hermes-bridge", "version": "1.0"},
            })
            # Register and set initial state
            await _brain_rpc("tools/call", {"name": "brain_register", "arguments": {"name": "hermes-bridge"}})
            await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "hermes-bridge:active_sessions", "value": "0", "scope": "global"}})
            await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "hermes-bridge:model", "value": DEFAULT_MODEL, "scope": "global"}})
            await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "hermes-bridge:toolsets", "value": DEFAULT_TOOLSETS, "scope": "global"}})
            # Publish bridge health metadata
            import platform, sys
            health_meta = json.dumps({
                "port": HERMES_PORT,
                "model": DEFAULT_MODEL,
                "toolsets": DEFAULT_TOOLSETS,
                "max_iterations": MAX_AGENT_ITERATIONS,
                "python": f"{sys.version_info.major}.{sys.version_info.minor}",
                "platform": platform.platform(),
            })
            await _brain_rpc("tools/call", {"name": "brain_set", "arguments": {"key": "bridge:health", "value": health_meta, "scope": "global"}})
            # Publish bridge contracts (inter-agent interface agreements)
            _bridge_start_time = time.time()
            _bridge_total_requests = 0
            _bridge_error_count = 0
            contracts = json.dumps({
                "hermes-bridge:v1": {
                    "description": "Hermes agent bridge — OpenAI-compatible /v1/chat/completions proxy with repo tools",
                    "port": HERMES_PORT,
                    "model": DEFAULT_MODEL,
                    "toolsets": DEFAULT_TOOLSETS,
                    "max_iterations": MAX_AGENT_ITERATIONS,
                    "endpoints": ["/health", "/v1/models", "/v1/chat/completions"],
                    "headers": {
                        "x-hermes-toolsets": "comma-separated toolset list",
                        "x-hermes-execution-mode": "agent-loop | passthrough",
                        "x-hermes-repo-owner": "GitHub repo owner (for repo mode)",
                        "x-hermes-repo-name": "GitHub repo name (for repo mode)",
                        "x-hermes-github-pat": "GitHub PAT for repo operations",
                        "x-hermes-repo-edit-intent": "1 to enable edit-mode tools",
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
                            "run_phase_architect": {"phase": "architect", "brain_keys": {"writes": "request:<id>:ctx", "polls": "plan:<id>"}},
                            "run_phase_implementor": {"phase": "implementor", "brain_keys": {"writes": "request:<id>:phase", "staging:<id>:<filepath>", "polls": "request:<id>:staging_keys"}},
                            "run_phase_reviewer": {"phase": "reviewer", "brain_keys": {"writes": "request:<id>:verdict", "polls": "request:<id>:staging_keys"}},
                            "_finish": {"phase": "done", "brain_keys": {"writes": "request:<id>:status", "polls": "request:<id>:phase"}},
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
                "start_time": _bridge_start_time,
                "port": HERMES_PORT,
                "model": DEFAULT_MODEL,
                "toolsets": DEFAULT_TOOLSETS,
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
            _brain_initialized = True
            print(f"[hermes-bridge] Brain MCP connected PID={_brain_proc.pid}", flush=True)
        except Exception as e:
            print(f"[hermes-bridge] Brain MCP init failed: {e}", flush=True)
            _brain_initialized = False

        yield

        if _brain_reader_task:
            _brain_reader_task.cancel()
        if _brain_proc:
            try:
                _brain_proc.terminate()
                await asyncio.wait_for(_brain_proc.wait(), timeout=3)
            except Exception:
                pass
        _brain_initialized = False

    async def _brain_call_async(tool: str, args: dict):
        """Make a brain tool call, returns result dict or None."""
        return await _brain_rpc("tools/call", {"name": tool, "arguments": args})

    def _brain_set(key: str, value: str, scope: str = "global"):
        """Helper to set brain state, silently fails if brain unavailable."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(_brain_call_async("brain_set", {"key": key, "value": value, "scope": scope}))
            else:
                loop.run_until_complete(_brain_call_async("brain_set", {"key": key, "value": value, "scope": scope}))
        except Exception:
            pass

    def _brain_post(content: str, channel: str = "general"):
        """Helper to post to brain channel, silently fails if brain unavailable."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(_brain_call_async("brain_post", {"content": content, "channel": channel}))
            else:
                loop.run_until_complete(_brain_call_async("brain_post", {"content": content, "channel": channel}))
        except Exception:
            pass

    def _brain_pulse(status: str = "working", progress: str = ""):
        """Helper to send brain pulse, silently fails if brain unavailable."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(_brain_call_async("brain_pulse", {"status": status, "progress": progress}))
            else:
                loop.run_until_complete(_brain_call_async("brain_pulse", {"status": status, "progress": progress}))
        except Exception:
            pass

    def _brain_claim(resource: str, ttl: int = 60):
        """Helper to claim a brain resource, returns task or None."""
        if not _brain_initialized or _brain_proc is None:
            return None
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                return loop.create_task(_brain_call_async("brain_claim", {"resource": resource, "ttl": ttl}))
            else:
                return loop.run_until_complete(_brain_call_async("brain_claim", {"resource": resource, "ttl": ttl}))
        except Exception:
            return None

    def _brain_release(resource: str):
        """Helper to release a brain resource."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(_brain_call_async("brain_release", {"resource": resource}))
            else:
                loop.run_until_complete(_brain_call_async("brain_release", {"resource": resource}))
        except Exception:
            pass

    def _brain_dm(target: str, content: str):
        """Helper to send a direct message to another agent via brain DM."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(_brain_call_async("brain_dm", {"target": target, "content": content}))
            else:
                loop.run_until_complete(_brain_call_async("brain_dm", {"target": target, "content": content}))
        except Exception:
            pass

    def _brain_contract_set(key: str, value: str, scope: str = "global"):
        """Helper to publish a bridge contract, silently fails if brain unavailable."""
        if not _brain_initialized or _brain_proc is None:
            return
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(_brain_call_async("brain_contract_set", {"key": key, "value": value, "scope": scope}))
            else:
                loop.run_until_complete(_brain_call_async("brain_contract_set", {"key": key, "value": value, "scope": scope}))
        except Exception:
            pass

    def _brain_contract_get(key: str, scope: str = "global") -> Optional[str]:
        """Helper to read a published contract, returns value or None."""
        if not _brain_initialized or _brain_proc is None:
            return None
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                fut = loop.create_task(_brain_call_async("brain_contract_get", {"key": key, "scope": scope}))
                return loop.run_until_complete(asyncio.wait_for(fut, timeout=5))
            else:
                return loop.run_until_complete(_brain_call_async("brain_contract_get", {"key": key, "scope": scope}))
        except Exception:
            return None

    def _brain_contract_check(key: str, expected: str) -> bool:
        """Check that a published contract matches expected value. Returns True if match or brain unavailable."""
        val = _brain_contract_get(key)
        if val is None:
            return True  # brain unavailable — assume match
        return val == expected

    def _update_bridge_metrics(success: bool, increment_active: bool = False, decrement_active: bool = False):
        """Update bridge health metrics (active_requests, error_rate, uptime)."""
        global _bridge_total_requests, _bridge_error_count, _bridge_start_time, _bridge_active_requests
        if not _brain_initialized or _brain_proc is None:
            return
        if decrement_active:
            _bridge_active_requests = max(0, _bridge_active_requests - 1)
        if increment_active:
            _bridge_active_requests += 1
        if not success:
            _bridge_error_count += 1
        error_rate = round(_bridge_error_count / max(_bridge_total_requests, 1), 4)
        uptime = round(time.time() - _bridge_start_time, 1) if _bridge_start_time > 0 else 0.0
        metrics = json.dumps({
            "active_requests": _bridge_active_requests,
            "error_rate": error_rate,
            "uptime": uptime,
            "start_time": _bridge_start_time,
            "total_requests": _bridge_total_requests,
            "error_count": _bridge_error_count,
        })
        _brain_set("bridge:metrics", metrics)

except ImportError:
    # mcp package not available, bridge runs without brain integration
    _brain_session = None
    _brain_initialized = False
    _brain_ctx_stack = None
    _brain_proc = None
    _brain_reader_task = None
    _brain_pending = {}
    _brain_msg_id = 0
    _bridge_start_time: float = 0.0
    _bridge_total_requests: int = 0
    _bridge_error_count: int = 0

    async def _brain_rpc(method: str, params: dict):
        return None
    async def _brain_reader():
        pass
    async def _brain_lifespan(app):
        yield
    async def _brain_call_async(*args, **kwargs):
        return None
    def _brain_set(*args, **kwargs):
        pass
    def _brain_post(*args, **kwargs):
        pass
    def _brain_pulse(*args, **kwargs):
        pass
    def _brain_claim(*args, **kwargs):
        return None
    def _brain_release(*args, **kwargs):
        pass
    def _brain_dm(*args, **kwargs):
        pass
    def _brain_contract_set(*args, **kwargs):
        pass
    def _brain_contract_get(*args, **kwargs):
        return None
    def _brain_contract_check(*args, **kwargs):
        return True
    def _update_bridge_metrics(*args, **kwargs):
        pass

HERMES_PORT = int(os.environ.get("HERMES_PORT", "3002"))
OPENROUTER_KEY = os.environ.get("HERMES_OPENROUTER_KEY", "")
MINIMAX_KEY = os.environ.get("HERMES_MINIMAX_KEY", "")
DEFAULT_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "web,browser")
DEFAULT_MODEL = os.environ.get("HERMES_DEFAULT_MODEL", "meta-llama/llama-4-maverick")

# MiniMax direct routing — models matching this prefix bypass OpenRouter
MINIMAX_BASE_URL = "https://api.minimax.io/v1"
MINIMAX_MODEL_PREFIX = "MiniMax-"

# ------------------------------------------------------------------
# Circuit breaker for upstream API calls
# ------------------------------------------------------------------
class CircuitBreaker:
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
        self.last_failure_time = time.monotonic()
        if self.failures >= self.failure_threshold:
            self.state = "open"

    def is_available(self) -> bool:
        if self.state == "closed":
            return True
        if self.state == "open":
            if self.last_failure_time and (time.monotonic() - self.last_failure_time) >= self.recovery_timeout:
                self.state = "half-open"
                return True
            return False
        # half-open: allow one attempt
        return True

    def get_state(self) -> str:
        return self.state


# Circuit breakers per upstream provider
_openrouter_circuit = CircuitBreaker(failure_threshold=5, recovery_timeout=30.0)
_minimax_circuit = CircuitBreaker(failure_threshold=5, recovery_timeout=30.0)
_brain_circuit = CircuitBreaker(failure_threshold=3, recovery_timeout=15.0)

# ------------------------------------------------------------------
# Retry helper for brain gateway calls
# ------------------------------------------------------------------
def _retry_brain_call(func, *args, retries: int = 2, backoff: float = 0.5, **kwargs):
    """Call a brain gateway function with retry and exponential backoff."""
    for attempt in range(retries + 1):
        if not _brain_circuit.is_available():
            return None
        try:
            result = func(*args, **kwargs)
            if result is not None:
                _brain_circuit.record_success()
                return result
            # None means brain unavailable — treat as failure
            _brain_circuit.record_failure()
        except Exception as e:
            print(f"[hermes-bridge] brain call attempt {attempt + 1} failed: {e}", flush=True)
            _brain_circuit.record_failure()
        if attempt < retries:
            time.sleep(backoff * (2 ** attempt))
    return None

# ------------------------------------------------------------------
# Error message helpers for common failures
# ------------------------------------------------------------------
def _no_api_key_error(provider: str) -> JSONResponse:
    messages = {
        "openrouter": "No API key provided. Set HERMES_OPENROUTER_KEY, pass Authorization: Bearer <key> header, or run the local OpenClaw gateway.",
        "minimax": "MiniMax API key required. Set HERMES_MINIMAX_KEY, configure a MiniMax key in Settings, or run the local OpenClaw gateway.",
        "github": "GitHub token required for repository operations. Provide x-hermes-github-pat header or configure a GitHub token in Settings.",
    }
    return JSONResponse(
        status_code=401,
        content={"error": {"message": messages.get(provider, "API key required.")}},
    )


def _repo_not_found_error(owner: str, repo: str) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={
            "error": {
                "message": f"Repository '{owner}/{repo}' not found or not accessible. Check the repository name and ensure your GitHub token has access.",
                "code": "REPO_NOT_FOUND",
            }
        },
    )


def _github_token_expired_error() -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={
            "error": {
                "message": "GitHub token is invalid or expired. Please update your GitHub Personal Access Token in Settings.",
                "code": "GITHUB_TOKEN_EXPIRED",
            }
        },
    )


def _circuit_open_error(provider: str) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "message": f"{provider} service is temporarily unavailable (circuit open). Please retry shortly.",
                "code": "CIRCUIT_OPEN",
            }
        },
    )


# ------------------------------------------------------------------
# Metrics helper
# ------------------------------------------------------------------
_bridge_start_time: float = 0.0
_bridge_total_requests: int = 0
_bridge_error_count: int = 0


def _update_bridge_metrics(success: bool):
    global _bridge_total_requests, _bridge_error_count
    _bridge_total_requests += 1
    if not success:
        _bridge_error_count += 1
    error_rate = _bridge_error_count / max(_bridge_total_requests, 1)
    uptime = time.time() - _bridge_start_time if _bridge_start_time else 0
    import platform, sys
    metrics = json.dumps({
        "api_calls": _bridge_total_requests,
        "error_rate": round(error_rate, 4),
        "active_requests": 0,
        "uptime": round(uptime, 1),
        "start_time": _bridge_start_time,
    })
    _brain_set("bridge:metrics", metrics, "global")


def _get_local_gateway_key() -> Optional[str]:
    """Read the gateway auth token from local openclaw.json config.

    Returns the gateway's Bearer token (gateway.auth.token) if the gateway
    is configured and the file is readable. Returns None if not configured
    or file missing/parseable.
    """
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    try:
        with open(config_path, "r") as f:
            config = json.load(f)
        token = config.get("gateway", {}).get("auth", {}).get("token")
        if token and isinstance(token, str) and len(token) > 0:
            return token
    except Exception:
        pass
    return None


def _read_positive_int_env(name: str, fallback: int) -> int:
    raw_value = os.environ.get(name)
    if not raw_value:
        return fallback
    try:
        parsed_value = int(raw_value)
    except ValueError:
        return fallback
    return parsed_value if parsed_value > 0 else fallback


MAX_AGENT_ITERATIONS = _read_positive_int_env("HERMES_MAX_ITERATIONS", 60)
PASSTHROUGH_TIMEOUT_SECONDS = _read_positive_int_env(
    "HERMES_PROVIDER_TIMEOUT_SECONDS", 5400
)
REQUEST_TIMEOUT_SECONDS = _read_positive_int_env("HERMES_REQUEST_TIMEOUT_SECONDS", 600)

AGENT_MODELS = [
    # Paid models
    {"id": "anthropic/claude-sonnet-4", "object": "model", "owned_by": "anthropic"},
    {"id": "openai/gpt-4.1-mini", "object": "model", "owned_by": "openai"},
    {"id": "MiniMax-M2.7", "object": "model", "owned_by": "minimax"},
    {"id": "MiniMax-M2.7-highspeed", "object": "model", "owned_by": "minimax"},
    {"id": "google/gemini-3.1-flash-lite-preview", "object": "model", "owned_by": "google"},
    {"id": "google/gemini-2.5-flash", "object": "model", "owned_by": "google"},
    {"id": "deepseek/deepseek-v3.2", "object": "model", "owned_by": "deepseek"},
    {"id": "deepseek/deepseek-chat-v3.1", "object": "model", "owned_by": "deepseek"},
    {"id": "meta-llama/llama-4-maverick", "object": "model", "owned_by": "meta"},
    {"id": "meta-llama/llama-4-scout", "object": "model", "owned_by": "meta"},
    # Free models
    {"id": "deepseek/deepseek-r1-0528", "object": "model", "owned_by": "deepseek"},
    {"id": "google/gemini-2.0-flash-001", "object": "model", "owned_by": "google"},
    {"id": "nousresearch/hermes-3-llama-3.1-405b:free", "object": "model", "owned_by": "nousresearch"},
    {"id": "meta-llama/llama-3.3-70b-instruct:free", "object": "model", "owned_by": "meta"},
    {"id": "qwen/qwen3-next-80b-a3b-instruct:free", "object": "model", "owned_by": "qwen"},
    {"id": "mistralai/mistral-small-3.1-24b-instruct:free", "object": "model", "owned_by": "mistral"},
]

app = FastAPI(title="Hermes Bridge", lifespan=_brain_lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "brain_initialized": _brain_initialized, "active_requests": _bridge_active_requests}


@app.get("/v1/models")
async def list_models():
    return {"object": "list", "data": AGENT_MODELS}


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = DEFAULT_MODEL
    messages: list[ChatMessage] = Field(default_factory=list)
    temperature: float = 0.7
    top_p: float = 0.9
    max_tokens: int = 16384
    stream: bool = True
    # Accept and ignore extra fields from AI SDK
    model_config = {"extra": "allow"}


def sse_chunk(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


# Friendly display names for tool activity in the chat stream
_TOOL_DISPLAY_NAMES: dict[str, str] = {
    "web_search": "Searching the web",
    "browse_url": "Reading webpage",
    "run_command": "Running command",
    "read_file": "Reading file",
    "write_file": "Writing file",
    "execute_python": "Running Python",
    "list_user_repos": "Listing repositories",
    "read_repo_file": "Reading file",
    "edit_repo_file": "Editing file",
    "create_repo_file": "Creating file",
    "delete_repo_file": "Deleting file",
    "batch_edit_repo_files": "Editing files",
}

# Tools that modify repository state — brain_claim protection applied in on_tool_start/end
REPO_EDIT_TOOL_NAMES = frozenset({
    "edit_repo_file",
    "create_repo_file",
    "delete_repo_file",
    "batch_edit_repo_files",
})


def _get_stream_chunk_size(text: str) -> int:
    """Use larger chunks for bulky payloads to avoid SSE event floods."""
    if len(text) > 4000:
        return 1024
    if len(text) > 1000:
        return 256
    return 20


def _format_tool_start_text(tool_name: str, tool_input: str) -> str:
    """Format a tool_start event as a concise markdown indicator.

    Instead of dumping raw JSON args (which can contain entire file contents),
    extract only the meaningful summary — e.g. the file path or search query.
    """
    display = _TOOL_DISPLAY_NAMES.get(tool_name, tool_name)
    summary = ""
    try:
        args = json.loads(tool_input) if tool_input else {}
    except (json.JSONDecodeError, TypeError):
        args = {}

    if tool_name in ("read_repo_file", "edit_repo_file", "create_repo_file",
                      "delete_repo_file", "read_file", "write_file"):
        path = args.get("path", "")
        if path:
            summary = f"`{path}`"
    elif tool_name == "batch_edit_repo_files":
        changes = args.get("changes", [])
        if isinstance(changes, list) and changes:
            paths = [c.get("path", "?") for c in changes[:5] if isinstance(c, dict)]
            summary = ", ".join(f"`{p}`" for p in paths)
            if len(changes) > 5:
                summary += f" +{len(changes) - 5} more"
    elif tool_name == "web_search":
        query = args.get("query", "")
        if query:
            summary = f'"{query}"'
    elif tool_name == "browse_url":
        url = args.get("url", "")
        if url:
            summary = f"`{url[:80]}{'…' if len(url) > 80 else ''}`"
    elif tool_name == "run_command":
        cmd = args.get("command", "")
        if cmd:
            summary = f"`{cmd[:80]}{'…' if len(cmd) > 80 else ''}`"
    elif tool_name == "execute_python":
        code = args.get("code", "")
        first_line = code.split("\n")[0][:60] if code else ""
        if first_line:
            summary = f"`{first_line}{'…' if len(code) > 60 else ''}`"

    if summary:
        return f"\n\n> **{display}** — {summary}\n\n"
    return f"\n\n> **{display}**\n\n"


def _format_tool_end_text(tool_name: str, tool_output: str) -> str:
    """Format a tool_end event as a brief completion note.

    Only shows a short, meaningful summary — never raw file contents.
    """
    display = _TOOL_DISPLAY_NAMES.get(tool_name, tool_name)
    normalized_output = (tool_output or "").strip()

    if normalized_output.lower().startswith(("error:", "failed:")):
        preview = normalized_output.split("\n", 1)[0][:120]
        return f"> *Failed:* `{preview}`\n\n"

    if tool_name in ("read_repo_file", "read_file"):
        char_count = len(tool_output) if tool_output else 0
        return f"> *Done — read {char_count:,} chars*\n\n"
    if tool_name in ("write_file",):
        return f"> *Done — {tool_output[:100]}*\n\n"
    if tool_name == "web_search":
        # Count results (JSON array)
        try:
            results = json.loads(tool_output) if tool_output else []
            count = len(results) if isinstance(results, list) else 0
            return f"> *Found {count} result{'s' if count != 1 else ''}*\n\n"
        except (json.JSONDecodeError, TypeError):
            return f"> *Search complete*\n\n"
    if tool_name == "browse_url":
        char_count = len(tool_output) if tool_output else 0
        return f"> *Fetched {char_count:,} chars*\n\n"
    if tool_name in ("run_command", "execute_python"):
        # Show a short preview of output
        preview = (tool_output or "").strip().split("\n")[0][:120]
        if preview:
            return f"> *Done:* `{preview}`\n\n"
        return f"> *Done (no output)*\n\n"

    # Fallback: just say it's done
    return f"> *{display} — done*\n\n"


def _build_agent_status(
    *,
    phase: str,
    label: str,
    started_at: float,
    iteration: Optional[int] = None,
) -> dict:
    status = {
        "phase": phase,
        "label": label,
        "elapsed_ms": max(0, int((time.monotonic() - started_at) * 1000)),
        "source": "hermes-bridge",
    }
    if iteration is not None:
        status["iteration"] = iteration
    return status


def make_delta_chunk(chunk_id: str, model: str, delta: dict, finish_reason: Optional[str] = None) -> dict:
    chunk: dict = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }],
    }
    # Include usage in the final chunk so the AI SDK's OpenAI-compatible
    # parser recognises this as a proper completion and maps finish_reason
    # to finishReason instead of defaulting to 'unknown'.
    if finish_reason is not None:
        chunk["usage"] = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    return chunk


def _build_passthrough_payload(body: ChatCompletionRequest) -> dict:
    payload = body.model_dump()
    payload.update(body.model_extra or {})
    return payload


def _passthrough_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://cloud-chat-hub.local",
        "X-Title": "Hermes Agent",
    }


def _passthrough_error_response(status_code: int, response_body: bytes) -> JSONResponse:
    if not response_body:
        return JSONResponse(status_code=status_code, content={"error": {"message": "Upstream provider error"}})
    try:
        return JSONResponse(status_code=status_code, content=json.loads(response_body.decode("utf-8")))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(
            status_code=status_code,
            content={"error": {"message": response_body.decode("utf-8", errors="replace")}},
        )


async def _passthrough_chat_completions(body: ChatCompletionRequest, api_key: str):
    payload = _build_passthrough_payload(body)
    request_headers = _passthrough_headers(api_key)

    try:
        async with httpx.AsyncClient(timeout=PASSTHROUGH_TIMEOUT_SECONDS) as client:
            request = client.build_request(
                "POST",
                "https://openrouter.ai/api/v1/chat/completions",
                headers=request_headers,
                json=payload,
            )
            upstream = await client.send(request, stream=bool(payload.get("stream", True)))
            if upstream.status_code >= 400:
                error_body = await upstream.aread()
                await upstream.aclose()
                # Record circuit breaker failure for upstream errors
                if "minimax" in body.model.lower():
                    _minimax_circuit.record_failure()
                else:
                    _openrouter_circuit.record_failure()
                return _passthrough_error_response(upstream.status_code, error_body)

            # Record success
            if "minimax" in body.model.lower():
                _minimax_circuit.record_success()
            else:
                _openrouter_circuit.record_success()

        if not payload.get("stream", True):
            response_body = await upstream.aread()
            await upstream.aclose()
            try:
                return JSONResponse(status_code=upstream.status_code, content=json.loads(response_body.decode("utf-8")))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return JSONResponse(
                    status_code=upstream.status_code,
                    content={"error": {"message": response_body.decode("utf-8", errors="replace")}},
                )

        async def stream_bytes():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()

        media_type = upstream.headers.get("content-type", "text/event-stream")
        return StreamingResponse(stream_bytes(), media_type=media_type)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, body: ChatCompletionRequest):
    try:
        async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
            return await _chat_completions_impl(request, body)
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={
                "error": {
                    "message": f"Request timed out after {REQUEST_TIMEOUT_SECONDS} seconds. The agent took too long to respond.",
                    "code": "REQUEST_TIMEOUT",
                }
            },
        )


async def _chat_completions_impl(request: Request, body: ChatCompletionRequest):
    toolsets_header = request.headers.get("x-hermes-toolsets", DEFAULT_TOOLSETS)
    enabled_toolsets = [t.strip() for t in toolsets_header.split(",") if t.strip()]
    execution_mode = request.headers.get("x-hermes-execution-mode", "agent-loop").strip().lower() or "agent-loop"
    repo_owner = request.headers.get("x-hermes-repo-owner", "")
    repo_name = request.headers.get("x-hermes-repo-name", "")
    github_pat = request.headers.get("x-hermes-github-pat", "")
    repo_edit_intent = request.headers.get("x-hermes-repo-edit-intent", "") == "1"

    # Detect repo mode from either the request body tools OR the repo headers.
    # In agent-loop mode the server sends repo info via headers (not body tools),
    # so we must check both sources to enable repo_mode correctly.
    has_repo_tools = False
    extra = body.model_extra or {}
    tools_list = extra.get("tools")
    if isinstance(tools_list, (list, dict)):
        tool_names = set()
        if isinstance(tools_list, list):
            for fn in tools_list:
                name = fn.get("name", "") if isinstance(fn, dict) else ""
                if name:
                    tool_names.add(name)
        has_repo_tools = "edit_repo_file" in tool_names
    # Also enable repo mode when repo headers are present (agent-loop proxy path).
    # Enable even without a PAT so the agent gets the repo system prompt
    # (which explains the limitation) instead of being told about a repo
    # in the server system prompt with no tools to access it.
    if not has_repo_tools and repo_owner and repo_name:
        has_repo_tools = True

    # Brain MCP: track active request with rich job metadata (after has_repo_tools is defined)
    _bridge_total_requests += 1
    active_job_meta = json.dumps({
        "owner": repo_owner or None,
        "repo": repo_name or None,
        "model": body.model,
        "toolsets": enabled_toolsets,
        "repo_mode": has_repo_tools,
        "edit_intent": repo_edit_intent,
        "request_num": _bridge_total_requests,
    })
    _brain_set("hermes-bridge:active_request", active_job_meta)
    _brain_set("hermes-bridge:active_sessions", "1", "global")
    _brain_set("hermes-bridge:model", body.model, "global")
    # Increment active request counter and publish updated metrics
    _update_bridge_metrics(success=True, increment_active=True)
    _brain_set("hermes-bridge:toolsets", ",".join(enabled_toolsets), "global")

    # Key priority: 1. Local gateway token, 2. HERMES_OPENROUTER_KEY env var, 3. Authorization: Bearer header
    auth_header = request.headers.get("authorization", "")
    api_key = (
        _get_local_gateway_key()
        or OPENROUTER_KEY
        or (auth_header[7:] if auth_header.startswith("Bearer ") else "")
    )

    # MiniMax direct routing: when model starts with "MiniMax-", route to
    # the MiniMax API instead of OpenRouter.  Key priority:
    #   1. Local gateway token (for users running the gateway)
    #   2. HERMES_MINIMAX_KEY env var
    #   3. X-Hermes-Minimax-Key header (forwarded from user's settings)
    is_minimax_model = body.model.startswith(MINIMAX_MODEL_PREFIX)
    if is_minimax_model:
        if not _minimax_circuit.is_available():
            return _circuit_open_error("MiniMax")
        minimax_key = (
            _get_local_gateway_key()
            or MINIMAX_KEY
            or request.headers.get("x-hermes-minimax-key", "").strip()
        )
        if not minimax_key:
            return _no_api_key_error("minimax")
        agent_base_url = MINIMAX_BASE_URL
        agent_api_key = minimax_key
    else:
        if not _openrouter_circuit.is_available():
            return _circuit_open_error("OpenRouter")
        if not api_key:
            return _no_api_key_error("openrouter")
        agent_base_url = "https://openrouter.ai/api/v1"
        agent_api_key = api_key

    if execution_mode == "passthrough":
        print(
            f"[hermes-bridge] Passthrough mode. model={body.model} msgs={len(body.messages)} extra_keys={list((body.model_extra or {}).keys())}",
            flush=True,
        )
        return await _passthrough_chat_completions(body, agent_api_key if is_minimax_model else api_key)

    try:
        from hermes_adapter import HermesAgentAdapter as AIAgent
        _using_real_agent = True
    except Exception as _adapter_err:
        print(f"[hermes-bridge] Adapter import failed: {_adapter_err}", flush=True)
        from run_agent import AIAgent
        _using_real_agent = False

    chunk_id = f"chatcmpl-hermes-{os.urandom(8).hex()}"
    # Brain MCP: publish per-request job metadata keyed by chunk_id so the overseer
    # can correlate in-flight requests and inspect individual job state.
    try:
        _brain_set(f"bridge:active-request:{chunk_id}", active_job_meta)
    except Exception:
        pass
    # Thread-safe asyncio queue for all events (text and tool activity)
    # Replaces sync queue.Queue — now native async, no to_thread bridging needed
    event_queue: asyncio.Queue = asyncio.Queue()
    done_event = asyncio.Event()

    # Queue wrapper for safe thread → async put
    def _qput(item):
        asyncio.get_event_loop().call_soon_threadsafe(event_queue.put_nowait, item)

    def on_tool_start(tool_name: str, tool_input: str):
        # Emit tool start as visible text so user sees activity
        _qput(("tool_start", tool_name, tool_input))
        # Brain MCP: claim resource for edit operations to prevent conflicts
        if tool_name in REPO_EDIT_TOOL_NAMES:
            try:
                args = json.loads(tool_input) if tool_input else {}
                path = args.get("path", "unknown")
                # Namespace the claim by owner/repo to prevent cross-repo lock collisions
                if repo_owner and repo_name:
                    claim_resource = f"hermes-bridge:repo:{repo_owner}/{repo_name}:{path}"
                else:
                    claim_resource = f"hermes-bridge:repo:unknown:{path}"
                _brain_claim(claim_resource, ttl=120)
            except (json.JSONDecodeError, TypeError, KeyError):
                pass

    def on_tool_end(tool_name: str, tool_input: str, tool_output: str):
        _qput(("tool_end", tool_name, tool_output[:500]))
        # Brain MCP: release resource for edit operations
        if tool_name in REPO_EDIT_TOOL_NAMES:
            try:
                args = json.loads(tool_input) if tool_input else {}
                path = args.get("path", "unknown")
                # Must match the claim key format used in on_tool_start
                if repo_owner and repo_name:
                    release_resource = f"hermes-bridge:repo:{repo_owner}/{repo_name}:{path}"
                else:
                    release_resource = f"hermes-bridge:repo:unknown:{path}"
                _brain_release(release_resource)
            except (json.JSONDecodeError, TypeError, KeyError):
                pass

    def on_text(text: str):
        # Stream normal text in small chunks for responsiveness
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            _qput(("text", text[i:i + chunk_size]))

    def on_thinking(iteration: int):
        _qput(("thinking", iteration))
        # Brain MCP: pulse on each thinking iteration
        _brain_pulse("working", f"iteration={iteration} model={body.model}")

    def on_reasoning(text: str):
        # Stream reasoning in small chunks for responsiveness
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            _qput(("reasoning", text[i:i + chunk_size]))

    def on_server_tool_event(event: dict):
        _qput(("server_tool_event", event))

    def _run_agent_sync():
        try:
            print(f"[hermes-bridge] Using {'real' if _using_real_agent else 'custom'} Hermes agent", flush=True)
            # Log message roles for debugging system prompt delivery
            msg_roles = [m.role for m in body.messages]
            has_extra_system = bool((body.model_extra or {}).get("system"))
            print(f"[hermes-bridge] Starting agent. mode={execution_mode} model={body.model} repo_mode={has_repo_tools} has_github={'yes' if github_pat else 'no'} repo={repo_owner}/{repo_name} toolsets={enabled_toolsets} msgs={len(body.messages)} roles={msg_roles} extra_system={has_extra_system}", flush=True)
            if has_repo_tools and not github_pat:
                print(f"[hermes-bridge] WARNING: repo_mode is active but no GitHub PAT provided — read_repo_file will fail", flush=True)
            # Extract repo file tree from request body (sent by server for Hermes agent-loop)
            repo_file_tree_raw = (body.model_extra or {}).get("repo_file_tree")
            repo_file_tree = (
                [p for p in repo_file_tree_raw if isinstance(p, str) and p.strip()]
                if isinstance(repo_file_tree_raw, list)
                else []
            )
            if repo_file_tree:
                print(f"[hermes-bridge] Received repo file tree: {len(repo_file_tree)} paths", flush=True)
            # Extract custom MCP tool definitions from request body
            custom_tools_raw = (body.model_extra or {}).get("custom_tools")
            custom_tools = (
                [t for t in custom_tools_raw if isinstance(t, dict)]
                if isinstance(custom_tools_raw, list)
                else []
            )
            if custom_tools:
                print(f"[hermes-bridge] Received {len(custom_tools)} custom MCP tool(s)", flush=True)
            agent = AIAgent(
                base_url=agent_base_url,
                api_key=agent_api_key,
                model=body.model,
                max_iterations=MAX_AGENT_ITERATIONS,
                enabled_toolsets=enabled_toolsets,
                repo_mode=has_repo_tools,
                repo_edit_intent=repo_edit_intent,
                github_pat=github_pat if github_pat else None,
                github_repo_owner=repo_owner if repo_owner else None,
                github_repo_name=repo_name if repo_name else None,
                repo_file_tree=repo_file_tree,
                custom_tools=custom_tools,
                on_tool_start=on_tool_start,
                on_tool_end=on_tool_end,
                on_text=on_text,
                on_server_tool_event=on_server_tool_event,
            )
            agent.on_thinking = on_thinking
            agent.on_reasoning = on_reasoning

            conversation_history = [
                {"role": m.role, "content": m.content} for m in body.messages
            ]

            # The AI SDK may send the system prompt as a separate top-level
            # "system" field instead of (or in addition to) a system message
            # in the messages array.  Merge it if present.
            extra = body.model_extra or {}
            extra_system = extra.get("system")
            if isinstance(extra_system, str) and extra_system.strip():
                # Check if there's already a system message
                has_system = any(m.get("role") == "system" for m in conversation_history)
                if has_system:
                    for m in conversation_history:
                        if m.get("role") == "system":
                            m["content"] = extra_system + "\n\n" + (m["content"] or "")
                            break
                else:
                    conversation_history.insert(0, {"role": "system", "content": extra_system})

            # Find the last user message and pass everything before it
            # (including all assistant messages) as history.  Previous code
            # blindly took conversation_history[-1] which could strip an
            # assistant response when the SDK appends messages after it,
            # or — more critically — drop the assistant's analysis from
            # history when the last user message sits right after it.
            last_user_idx = None
            for i in range(len(conversation_history) - 1, -1, -1):
                if conversation_history[i]["role"] == "user":
                    last_user_idx = i
                    break

            if last_user_idx is not None:
                user_message = conversation_history[last_user_idx]["content"]
                # History = everything except the last user message itself.
                # This keeps all prior assistant messages (with their issue
                # analysis, etc.) in context for follow-up requests.
                history = conversation_history[:last_user_idx] + conversation_history[last_user_idx + 1:]
            else:
                user_message = ""
                history = list(conversation_history)

            print(f"[hermes-bridge] User message: {user_message[:100]}... history_msgs={len(history)} has_system={any(m.get('role') == 'system' for m in history)}", flush=True)
            agent.run_conversation(
                user_message=user_message,
                conversation_history=history,
            )
            print(f"[hermes-bridge] Agent conversation completed.", flush=True)
            # Brain MCP: pulse on successful completion
            _brain_pulse("working", "completed")
            # Update bridge health metrics (decrement active request counter)
            _update_bridge_metrics(success=True, decrement_active=True)
        except Exception as e:
            print(f"[hermes-bridge] Agent error: {e}", flush=True)
            _qput(("text", f"\n\n[Error: {str(e)}]"))
            # Brain MCP: report failure
            _brain_pulse("failed", f"error={str(e)[:100]}")
            _update_bridge_metrics(success=False, decrement_active=True)
        finally:
            asyncio.get_running_loop().call_soon(done_event.set)

    async def event_stream():
        # Role chunk
        print(f"[hermes-bridge] SSE stream started. chunk_id={chunk_id}", flush=True)
        stream_started_at = time.monotonic()
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"role": "assistant"}))
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
            "agent_status": _build_agent_status(
                phase="starting",
                label="Starting Hermes agent loop...",
                started_at=stream_started_at,
            ),
        }))

        agent_task = asyncio.ensure_future(asyncio.to_thread(_run_agent_sync))
        event_count = 0
        idle_ticks = 0  # counts consecutive empty polls (~50ms each)
        HEARTBEAT_INTERVAL = 60  # ticks ≈ 3 seconds of silence

        while not done_event.is_set() or not event_queue.empty():
            drained = False
            while not event_queue.empty():
                drained = True
                idle_ticks = 0
                try:
                    event = event_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break

                event_count += 1
                if event[0] == "text":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": event[1]}))
                elif event[0] == "tool_start":
                    tool_name, tool_input = event[1], event[2]
                    # Emit as both visible text and structured tool_activity
                    text = _format_tool_start_text(tool_name, tool_input)
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": {"tool": tool_name, "status": "running", "input": tool_input, "output": None}
                    }))
                elif event[0] == "tool_end":
                    tool_name, tool_output = event[1], event[2]
                    text = _format_tool_end_text(tool_name, tool_output)
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": {"tool": tool_name, "status": "completed", "input": "", "output": tool_output}
                    }))
                elif event[0] == "thinking":
                    iteration = event[1]
                    status_label = (
                        "Analyzing repository context..."
                        if has_repo_tools and iteration == 1
                        else "Analyzing your request..."
                        if iteration == 1
                        else f"Planning iteration {iteration}..."
                    )
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "agent_status": _build_agent_status(
                            phase="thinking",
                            label=status_label,
                            started_at=stream_started_at,
                            iteration=iteration,
                        ),
                    }))
                    if iteration > 1:
                        # Show a thinking indicator between iterations so the
                        # user knows the agent is still working
                        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                            "content": "\n\n> *Thinking...*\n\n"
                        }))
                elif event[0] == "reasoning":
                    reasoning_text = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "reasoning": reasoning_text
                    }))
                elif event[0] == "server_tool_event":
                    event_data = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "server_tool_event": event_data
                    }))

            if not done_event.is_set():
                idle_ticks += 1
                # Send SSE comment as keepalive to prevent connection timeout
                if idle_ticks % HEARTBEAT_INTERVAL == 0:
                    yield ": heartbeat\n\n"
                await asyncio.sleep(0.05)

        # Final chunk
        print(f"[hermes-bridge] SSE stream ending. Total events emitted: {event_count}", flush=True)
        # Brain MCP: post completion status and update metrics
        elapsed_ms = int((time.monotonic() - stream_started_at) * 1000)
        _brain_post(f"hermes-bridge completed: model={body.model} events={event_count} elapsed_ms={elapsed_ms}", channel="hermes-bridge")
        _brain_set("hermes-bridge:active_request", "")
        _brain_set("hermes-bridge:active_sessions", "0", "global")
        _brain_set("hermes-bridge:last_completion", f"model={body.model} events={event_count} elapsed_ms={elapsed_ms}", "global")
        # Bridge metrics — publish final state via _update_bridge_metrics (called from
        # _run_agent_sync) plus api_calls for the completed request
        _brain_set("bridge:metrics", json.dumps({
            "active_requests": _bridge_active_requests,
            "error_rate": round(_bridge_error_count / max(_bridge_total_requests, 1), 4),
            "uptime": round(time.time() - _bridge_start_time, 1) if _bridge_start_time > 0 else 0.0,
            "start_time": _bridge_start_time,
            "total_requests": _bridge_total_requests,
            "error_count": _bridge_error_count,
            "api_calls": event_count,
            "estimated_cost_usd": round(event_count * 0.001, 4),
        }))
        # Brain MCP: per-request metrics keyed by chunk_id for per-request auditing
        try:
            _brain_set(f"bridge:metrics:{chunk_id}", json.dumps({
                "tokens": 0,
                "api_calls": event_count,
                "cost": round(event_count * 0.001, 4),
                "elapsed_ms": elapsed_ms,
                "model": body.model,
                "repo_mode": has_repo_tools,
            }))
        except Exception:
            pass
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {}, finish_reason="stop"))
        yield "data: [DONE]\n\n"

        await agent_task

    return StreamingResponse(event_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=HERMES_PORT)
