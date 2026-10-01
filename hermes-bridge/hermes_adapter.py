"""
Hermes Agent Adapter for CloudChat

Wraps the real Hermes AIAgent (from ~/.hermes/hermes-agent) to integrate
with CloudChat's hermes-bridge SSE streaming protocol.  Translates callbacks,
manages GitHub repo tools, and provides the same constructor interface that
main.py expects.

Falls back gracefully if hermes-agent is not installed — main.py catches
ImportError and uses the custom run_agent.py instead.
"""

import json
import contextlib
import os
import re
import sys
import threading
import httpx
from typing import Any, Optional, Callable
from bridge_events import (
    PLAN_MODE_PROMPT_SUFFIX,
    callback_accepts_kwarg,
    filter_toolsets_for_plan_mode,
    output_truncation_info,
)

# ---------------------------------------------------------------------------
# Brain HTTP cache — imported from standalone module
# ---------------------------------------------------------------------------
from brain_cache import (
    _BRAIN_GATEWAY_TOKEN,
    _brain_circuit,
    _BRAIN_GATEWAY_URL,
    _get_brain_token,
    _brain_http_call,
    brain_safe_set as _brain_safe_set,
    brain_safe_get as _brain_safe_get,
    brain_safe_delete as _brain_safe_delete,
)

# Brain HTTP cache functions (imported from brain_cache.py above)

from repo_tools import (
    CACHE_STATS,
    MAX_TOOL_RESPONSE,
    REPO_EDIT_TOOL_NAMES,
    REPO_TOOL_ORDER,
    REPO_TOOL_SCHEMAS,
    RepoToolsMixin,
    cap,
    repo_cache_ttl,
    repo_tree_ttl,
    shared_repo_file_key,
    shared_repo_tree_key,
    workspace_staged_key,
)


# --------------------------------------------------------------------------
# Cache TTL config (env var overrides with defaults)
# --------------------------------------------------------------------------
# Read the env here (not re-exported) so a module reload re-reads it.
REPO_CACHE_TTL = repo_cache_ttl()
REPO_TREE_TTL = repo_tree_ttl()

# --------------------------------------------------------------------------
# Cache hit/miss metrics
# --------------------------------------------------------------------------
# Shared with repo_tools (same dict object; only ever mutated in place).
_cache_stats = CACHE_STATS

# The real Hermes tool registry is process-global. Repo tools are registered
# with request-specific handlers, so overlapping repo runs must not mutate it
# concurrently or one run can call another run's repo/GitHub handlers.
_repo_tool_registry_lock = threading.Lock()


def _get_cache_stats() -> dict:
    return dict(_cache_stats)


def _reset_cache_stats():
    _cache_stats.clear()
    _cache_stats.update({"repo_file_hits": 0, "repo_file_misses": 0, "repo_tree_hits": 0, "repo_tree_misses": 0})


def mask_secret(value: object, keep: int = 2) -> str:
    """Render a secret safe for logs: length plus a short tail, never a prefix.

    The previous preview was f"{api_key[:8]}...{api_key[-4:]}", which leaked the
    first 8 characters of every provider key — enough to identify and correlate a
    credential, and enough for short keys to be printed in full via repr(). This
    reveals only the length and the final `keep` characters.

    A prefix is worse than a suffix: provider keys are frequently
    prefix-distinguishable (a shared project/org id), whereas the tail is the
    part an operator already has to compare to identify which key is loaded.
    """
    if value is None:
        return "<none>"
    text = value if isinstance(value, str) else str(value)
    if not text:
        return "<empty>"
    if len(text) <= keep:
        # Too short to reveal any tail without revealing the whole thing.
        return f"<redacted:len={len(text)}>"
    return f"<redacted:len={len(text)}:tail={text[-keep:]}>"


# ---------------------------------------------------------------------------
# Import the real Hermes agent
# ---------------------------------------------------------------------------

_HERMES_AGENT_DIR = os.environ.get(
    "HERMES_AGENT_DIR",
    os.path.expanduser("~/.hermes/hermes-agent"),
)

if _HERMES_AGENT_DIR not in sys.path:
    sys.path.insert(0, _HERMES_AGENT_DIR)

# This import will fail if hermes-agent is not installed, which is fine —
# main.py catches ImportError and falls back to the custom run_agent.py.
# Force import from hermes-agent dir — sys.path.insert(0) isn't enough if
# run_agent was already imported from the bridge directory.
import importlib.util


def _load_run_agent_from_spec(spec):
    """Execute a run_agent module spec, publishing it only once it fully loads.

    The module used to be inserted into sys.modules *before* exec_module ran. If
    the load then failed partway, a half-initialised `run_agent` stayed in
    sys.modules — and because it was present, main.py's ImportError fallback
    never fired and bound to the broken module instead of the bridge's own
    run_agent.py.

    On any failure the previous binding is restored (or the key removed), so a
    failed hermes-agent load cannot poison the fallback import path.
    """
    module = importlib.util.module_from_spec(spec)
    previous = sys.modules.get(spec.name)
    try:
        spec.loader.exec_module(module)
    except BaseException:
        if previous is not None:
            sys.modules[spec.name] = previous
        else:
            sys.modules.pop(spec.name, None)
        raise
    sys.modules[spec.name] = module
    return module


_run_agent_spec = importlib.util.spec_from_file_location(
    "run_agent",
    os.path.join(_HERMES_AGENT_DIR, "run_agent.py"),
)
_run_agent_mod = _load_run_agent_from_spec(_run_agent_spec)
RealAIAgent = _run_agent_mod.AIAgent

# Reuse the tools.registry module already loaded by run_agent.py's import chain
# (run_agent → toolsets → tools.registry). Creating a second module instance
# with importlib.util gives a DIFFERENT ToolRegistry — tools registered in it
# are invisible to validate_toolset() which uses the original from step 1.
# See: _get_plugin_toolset_names() does `from tools.registry import registry`.
if "tools.registry" in sys.modules:
    _tools_mod = sys.modules["tools.registry"]
    registry = _tools_mod.registry
else:
    # Fallback: run_agent import didn't pull in tools.registry (unexpected)
    _tools_spec = importlib.util.spec_from_file_location(
        "tools.registry",
        os.path.join(_HERMES_AGENT_DIR, "tools", "registry.py"),
    )
    _tools_mod = importlib.util.module_from_spec(_tools_spec)
    sys.modules["tools.registry"] = _tools_mod
    _tools_spec.loader.exec_module(_tools_mod)
    registry = _tools_mod.registry

print(f"[hermes-adapter] Loaded real Hermes agent from {_HERMES_AGENT_DIR}", flush=True)


# ---------------------------------------------------------------------------
# Fallback web_search / web_extract
#
# The real Hermes agent registers web_search/web_extract with
# check_fn=check_web_api_key, which requires FIRECRAWL/EXA/TAVILY/PARALLEL
# credentials.  When none are configured, registry.get_definitions() silently
# drops both tools — so the "Web" toggle in CloudChat is a no-op and models
# hallucinate an "I don't have internet access" response instead of calling a
# tool.  Register a DuckDuckGo-based fallback (same name, same toolset) so
# web_search is always available.  If a real backend key is configured, skip
# this so users keep the better Firecrawl/Exa/Tavily/Parallel results.
# ---------------------------------------------------------------------------

def _register_fallback_web_tools() -> None:
    try:
        from tools.web_tools import check_web_api_key
    except Exception as e:
        print(f"[hermes-adapter] Skipping web fallback — real web_tools not importable: {e}", flush=True)
        return

    try:
        if check_web_api_key():
            return  # Real backend available; leave the real handlers alone
    except Exception:
        pass  # Treat check errors as "not available"

    # hermes-agent 0.20+ ships a keyless web tier (Tavily/Firecrawl/Keenable
    # round-robin + one-shot keyless rescue on failure) that is strictly better
    # than this DuckDuckGo scraper. Defer to it when the tier is enabled — only
    # register the DDG fallback when the user explicitly disabled keyless
    # fallback (web.keyless_fallback: false) AND has no backend keys.
    try:
        from agent.web_search_registry import _keyless_tier_enabled

        if _keyless_tier_enabled():
            print(
                "[hermes-adapter] No web API keys, but hermes-agent's keyless web "
                "tier is enabled — skipping DuckDuckGo fallback registration.",
                flush=True,
            )
            return
    except Exception as e:
        print(f"[hermes-adapter] Keyless-tier probe failed ({e}) — keeping DDG fallback", flush=True)

    import re
    from urllib.parse import quote_plus, unquote

    _TAG_RE = re.compile(r"<[^>]+>")
    _SCRIPT_RE = re.compile(r"<script[^>]*>.*?</script>", re.DOTALL)
    _STYLE_RE = re.compile(r"<style[^>]*>.*?</style>", re.DOTALL)
    _DDG_RESULT_RE = re.compile(
        r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>.*?'
        r'class="result__snippet"[^>]*>(.*?)</(?:a|td|div)',
        re.DOTALL,
    )
    _UA = "Mozilla/5.0 (compatible; CloudChat/1.0; +hermes-bridge)"

    def _strip_html(html: str) -> str:
        text = _SCRIPT_RE.sub("", html)
        text = _STYLE_RE.sub("", text)
        text = _TAG_RE.sub(" ", text)
        return re.sub(r"\s+", " ", text).strip()

    def _ddg_web_search(args, **_kw):
        query = (args or {}).get("query", "").strip()
        if not query:
            return json.dumps({"error": "query is required"})
        url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
        try:
            with httpx.Client(timeout=15, follow_redirects=True) as client:
                resp = client.get(url, headers={"User-Agent": _UA})
                resp.raise_for_status()
        except Exception as e:
            return json.dumps({"error": f"web_search failed: {e}"})
        results = []
        for href, title, snippet in _DDG_RESULT_RE.findall(resp.text)[:8]:
            real_url = href
            m = re.search(r"uddg=([^&]+)", href)
            if m:
                real_url = unquote(m.group(1))
            results.append({
                "title": _strip_html(title),
                "url": real_url,
                "snippet": _strip_html(snippet),
            })
        if not results:
            return json.dumps({"results": [], "note": "No results found."})
        return json.dumps({"results": results, "backend": "duckduckgo-fallback"}, indent=2)

    def _ddg_web_extract(args, **_kw):
        urls = (args or {}).get("urls") or []
        if not isinstance(urls, list) or not urls:
            return json.dumps({"error": "urls must be a non-empty array"})
        out = []
        for u in urls[:5]:
            if not isinstance(u, str) or not u.strip():
                out.append({"url": u, "error": "invalid url"})
                continue
            try:
                with httpx.Client(timeout=20, follow_redirects=True) as client:
                    resp = client.get(u, headers={"User-Agent": _UA})
                    resp.raise_for_status()
                text = _strip_html(resp.text)
                if len(text) > 5000:
                    text = text[:5000] + "\n\n[truncated at 5000 chars]"
                out.append({"url": u, "content": text})
            except Exception as e:
                out.append({"url": u, "error": f"fetch failed: {e}"})
        return json.dumps(out, indent=2)

    web_search_schema = {
        "name": "web_search",
        "description": (
            "Search the web via DuckDuckGo (CloudChat fallback — no API key required). "
            "Returns up to 8 results with titles, URLs, and snippets. Use this for current "
            "information, news, or anything beyond your training data."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The search query."},
            },
            "required": ["query"],
        },
    }
    web_extract_schema = {
        "name": "web_extract",
        "description": (
            "Fetch and extract plain-text content from URLs (CloudChat fallback). "
            "Pass up to 5 URLs per call; content over 5000 chars is truncated."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "urls": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "URLs to fetch (max 5).",
                    "maxItems": 5,
                },
            },
            "required": ["urls"],
        },
    }

    registry.register(
        name="web_search",
        toolset="web",
        schema=web_search_schema,
        handler=_ddg_web_search,
        check_fn=lambda: True,
        emoji="🔍",
        max_result_size_chars=100_000,
    )
    registry.register(
        name="web_extract",
        toolset="web",
        schema=web_extract_schema,
        handler=_ddg_web_extract,
        check_fn=lambda: True,
        emoji="📄",
        max_result_size_chars=100_000,
    )
    print(
        "[hermes-adapter] No Firecrawl/Exa/Tavily/Parallel backend configured — "
        "registered DuckDuckGo fallback for web_search / web_extract.",
        flush=True,
    )


_register_fallback_web_tools()


# ---------------------------------------------------------------------------
# Toolset name mapping: CloudChat names → real agent toolset names
# ---------------------------------------------------------------------------

_TOOLSET_MAP = {
    "web": "web",
    "browser": "browser",
    "terminal": "terminal",
    "files": "file",
    "code_execution": "code_execution",
    "vision": "vision",
    "computer": "computer_use",
    "computer_use": "computer_use",
    "delegation": "delegation",
    "clarify": "clarify",
    "context_engine": "context_engine",
    "video": "video",
    "video_gen": "video_gen",
}

# Toolsets that the real agent supports and we always enable
_BONUS_TOOLSETS = ["skills", "memory", "todo", "session_search"]
# Optional bonus toolsets enabled when the user toggles them in Spark
_OPTIONAL_BONUS = {"delegation": "delegation"}

# Repo tool toolset name (registered dynamically per request)
_REPO_TOOLSET = "cloudchat_repo"

# ---------------------------------------------------------------------------
# Repo tools — schemas and handlers live in repo_tools.py (shared with the
# legacy run_agent.AIAgent). Names below are re-exported for existing callers.
# ---------------------------------------------------------------------------

_REPO_TOOL_SCHEMAS = REPO_TOOL_SCHEMAS
_REPO_EDIT_TOOLS = REPO_EDIT_TOOL_NAMES
_MAX_TOOL_RESPONSE = MAX_TOOL_RESPONSE
_shared_repo_file_key = shared_repo_file_key
_shared_repo_tree_key = shared_repo_tree_key
_workspace_staged_key = workspace_staged_key
_cap = cap


# ---------------------------------------------------------------------------
# RepoToolProvider — registers GitHub API repo tools into the real agent
# ---------------------------------------------------------------------------

class RepoToolProvider(RepoToolsMixin):
    """Manages GitHub API repo tools as a dynamic toolset in the real agent."""

    # Friendly display names for repo tool marker text (matches main.py)
    _DISPLAY_NAMES: dict[str, str] = {
        "read_repo_file": "Reading file",
        "edit_repo_file": "Editing file",
        "create_repo_file": "Creating file",
        "delete_repo_file": "Deleting file",
        "batch_edit_repo_files": "Editing files",
        "git_log": "Viewing commit history",
        "git_show": "Showing commit",
        "git_diff": "Comparing refs",
    }

    def __init__(
        self,
        github_pat: Optional[str],
        owner: Optional[str],
        name: Optional[str],
        file_tree: list[str],
        edit_intent: bool,
        on_server_tool_event: Optional[Callable],
        workspace_id: Optional[str] = None,
        on_text: Optional[Callable] = None,
    ):
        self.github_pat = github_pat
        self.owner = owner
        self.name = name
        self.edit_intent = edit_intent
        self.on_server_tool_event = on_server_tool_event
        self.on_text = on_text
        self.workspace_id = workspace_id or 'default'
        self.session_cache: dict[str, str] = {}
        self._registered_tools: list[str] = []

        # Try to load cached file tree from brain, fall back to provided tree
        if owner and name:
            tree_key = f"repo-tree:{owner}/{name}"
            cached_tree = _brain_safe_get(tree_key)
            if cached_tree is not None:
                try:
                    self.file_tree = json.loads(cached_tree)
                    _cache_stats["repo_tree_hits"] += 1
                except Exception:
                    self.file_tree = file_tree
                    _cache_stats["repo_tree_misses"] += 1
            else:
                self.file_tree = file_tree
                _cache_stats["repo_tree_misses"] += 1
                # Cache the provided tree for cross-session use
                if file_tree:
                    _brain_safe_set(tree_key, json.dumps(file_tree), ttl=REPO_TREE_TTL)
        else:
            self.file_tree = file_tree

    # --- RepoToolsMixin host hooks ---
    # The cache hooks resolve this module's brain helpers at call time so
    # patching ``hermes_adapter._brain_safe_*`` still reaches the handlers.

    @property
    def repo_owner(self) -> Optional[str]:
        return self.owner

    @property
    def repo_name(self) -> Optional[str]:
        return self.name

    def _cache_get(self, key: str) -> Optional[str]:
        return _brain_safe_get(key)

    def _cache_set(self, key: str, value: str, ttl: int) -> bool:
        return _brain_safe_set(key, value, ttl=ttl)

    def _cache_delete(self, key: str) -> bool:
        return _brain_safe_delete(key)

    def _repo_cache_ttl(self) -> int:
        return REPO_CACHE_TTL

    def _emit_repo_event(self, event: dict) -> None:
        self._emit(event)

    def __enter__(self):
        self._register_tools()
        return self

    def __exit__(self, *args):
        self._deregister_tools()

    def _register_tools(self):
        """Register repo tools into the real agent's tool registry.

        Always registers the FULL repo toolset (read + edit). Gating edit
        tools on the per-message intent heuristic left agents unable to edit
        whenever the user's phrasing missed the edit patterns — hermes-desktop
        always has edit tools and relies on the system prompt to decide when
        to use them. The ``edit_intent`` flag remains for prompt guidance only.
        """
        handlers = self.repo_tool_handlers()
        for tool_name in REPO_TOOL_ORDER:
            schema = _REPO_TOOL_SCHEMAS.get(tool_name)
            handler = handlers.get(tool_name)
            if schema and handler:
                registry.register(
                    name=tool_name,
                    toolset=_REPO_TOOLSET,
                    schema=schema,
                    handler=handler,
                )
                self._registered_tools.append(tool_name)

        print(
            f"[hermes-adapter] Registered {len(self._registered_tools)} repo tools "
            f"for {self.owner}/{self.name}",
            flush=True,
        )

    def _deregister_tools(self):
        """Remove repo tools from the registry after the request."""
        for tool_name in self._registered_tools:
            registry.deregister(tool_name)
        if self._registered_tools:
            print(
                f"[hermes-adapter] Deregistered {len(self._registered_tools)} repo tools",
                flush=True,
            )
        self._registered_tools.clear()

    def _emit(self, event: dict):
        if self.on_server_tool_event:
            try:
                self.on_server_tool_event(event)
            except Exception as e:
                print(f"[hermes-adapter] Failed to emit server tool event: {e}", flush=True)

    def _emit_tool_marker(self, tool_name: str, detail: str = ""):
        """Inject visible marker text into the content stream for inline tool display."""
        if not self.on_text:
            return
        display = self._DISPLAY_NAMES.get(tool_name, tool_name)
        if detail:
            marker = f"\n\n> **{display}** — `{detail}`\n\n"
        else:
            marker = f"\n\n> **{display}**\n\n"
        self.on_text(marker)

    def _load_brain_memories(self) -> str:
        """Load relevant memories from brain via the HTTP brain-cache fallback.

        (The previous brain_recall RPC path was dead code: it was gated on
        ``_asyncio.get_event_loop().is_running()``, which is always False in
        the worker threads this runs in, so ``_recall_async`` never executed.
        The HTTP ``_brain_safe_get`` path below is the working one.)
        """
        memories = []
        repo_prefix = f"memory:repo:{self.owner}/{self.name}:"
        for topic in ["conventions", "gotchas", "preferences", "api-quirks"]:
            key = f"{repo_prefix}{topic}"
            val = _brain_safe_get(key)
            if val:
                memories.append(f"- {topic}: {val}")
        for topic in ["user-preferences", "coding-style"]:
            key = f"memory:global:{topic}"
            val = _brain_safe_get(key)
            if val:
                memories.append(f"- {topic}: {val}")

        if not memories:
            return ""
        return "\n## Known Patterns & Preferences\n" + "\n".join(memories) + "\n"

    def build_repo_system_prompt(self) -> str:
        """Build the repo context system prompt with pooled brain cache (TTL=600)."""
        repo_full = f"{self.owner}/{self.name}"

        # Try brain cache for repo-tree to avoid rebuilding from self.file_tree
        effective_tree = self.file_tree
        if self.owner and self.name:
            tree_cache_key = f"repo-tree:{self.owner}/{self.name}"
            cached_tree_raw = _brain_safe_get(tree_cache_key)
            if cached_tree_raw is not None:
                try:
                    effective_tree = json.loads(cached_tree_raw)
                    if not isinstance(effective_tree, list):
                        effective_tree = self.file_tree
                    _cache_stats["repo_tree_hits"] += 1
                except (json.JSONDecodeError, TypeError):
                    effective_tree = self.file_tree
                    _cache_stats["repo_tree_misses"] += 1
            elif self.file_tree:
                _cache_stats["repo_tree_misses"] += 1
                # Cache the received tree for future requests
                _brain_safe_set(tree_cache_key, json.dumps(self.file_tree), ttl=REPO_TREE_TTL)

        file_tree_section = ""
        if effective_tree:
            file_tree_section = (
                "\nRepository file tree:\n"
                + "\n".join(effective_tree[:500])
                + "\n\n"
            )

        memories_section = self._load_brain_memories()

        if not self.github_pat:
            return (
                f"You are working on the GitHub repository {repo_full}.\n"
                "GitHub API access is not available (no token configured).\n"
                "Answer based on available context (file tree, issue text, conversation history).\n"
                f"{file_tree_section}"
                f"{memories_section}"
            )

        return (
            f"You are working on the GitHub repository {repo_full}.\n"
            "You have tools to read, edit, create, and delete files in this repo.\n"
            "You can also inspect git history with git_log, git_show, and git_diff.\n\n"
            "RULES:\n"
            "- Do NOT ask the user clarifying questions. Explore the repo yourself.\n"
            "- If a tool call fails (404), try alternative paths before giving up.\n"
            "- For read-only requests, inspect files and answer directly.\n"
            "- Only enter the edit workflow when the user explicitly asks for changes.\n\n"
            f"{file_tree_section}"
            f"{memories_section}"
            "WORKFLOW FOR CHANGE REQUESTS:\n"
            "1. Use read_repo_file to understand the codebase.\n"
            "2. Use batch_edit_repo_files to apply changes.\n"
            "3. Address ALL requested changes, not just one.\n"
        )


# ---------------------------------------------------------------------------
# Custom MCP tools (CloudChat → real agent registry)
# ---------------------------------------------------------------------------

# Toolset name for CloudChat custom MCP tools (registered dynamically per request)
_CUSTOM_MCP_TOOLSET = "cloudchat_mcp"
# Cap custom MCP tool output to protect the model context window.
_CUSTOM_MCP_MAX_RESULT_CHARS = int(
    os.environ.get("HERMES_CUSTOM_MCP_MAX_RESULT_CHARS", "100000")
)
# Per-tool-call timeout for remote MCP execution (Streamable HTTP).
_CUSTOM_MCP_TIMEOUT_SECONDS = int(
    os.environ.get("HERMES_CUSTOM_MCP_TIMEOUT_SECONDS", "30")
)


def _execute_remote_mcp_tool(
    server_url: str,
    tool_name: str,
    arguments: dict,
    api_key: Optional[str] = None,
) -> str:
    """Execute a tool on a remote MCP server via Streamable HTTP transport.

    Mirrors ``run_agent._execute_mcp_tool`` so the real-agent path behaves
    identically to the custom fallback agent. Sends a JSON-RPC ``tools/call``
    request and returns the text content from the response.
    """
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments,
        },
    }

    try:
        with httpx.Client(timeout=_CUSTOM_MCP_TIMEOUT_SECONDS) as client:
            resp = client.post(server_url, json=payload, headers=headers)
            resp.raise_for_status()
        data = resp.json()

        # JSON-RPC error
        if "error" in data:
            err = data["error"]
            return f"MCP error ({err.get('code', '?')}): {err.get('message', str(err))}"

        # Extract result content — MCP returns {content: [{type, text}]}
        result = data.get("result", {})
        if isinstance(result, dict):
            content_parts = result.get("content", [])
            if isinstance(content_parts, list):
                texts = [
                    p.get("text", "")
                    for p in content_parts
                    if isinstance(p, dict) and p.get("type") == "text"
                ]
                if texts:
                    return "\n".join(texts)
            # Fallback: if result has a plain text field
            if isinstance(result.get("text"), str):
                return result["text"]
        # Fallback: return raw JSON
        return json.dumps(result) if result else "(empty MCP result)"
    except httpx.TimeoutException:
        return f"Error: MCP server at {server_url} timed out after {_CUSTOM_MCP_TIMEOUT_SECONDS}s"
    except httpx.HTTPStatusError as exc:
        return f"Error: MCP server returned HTTP {exc.response.status_code}: {exc.response.text[:300]}"
    except Exception as e:
        return f"Error calling MCP tool '{tool_name}': {e}"


class CustomMCPServerProvider:
    """Registers CloudChat custom MCP tools into the real agent's tool registry.

    The frontend sends custom tool definitions (OpenAI function-calling
    format) with the owning MCP server's URL/API key. The custom fallback
    agent (``run_agent.AIAgent``) executes these directly, but the real
    hermes-agent never saw them — they were silently dropped. Register them
    here under a dedicated toolset with a handler that proxies ``tools/call``
    to the server, so the real agent can call them like any built-in tool.

    IMPORTANT: registration must happen BEFORE the real agent is constructed
    (``get_tool_definitions()`` runs in ``__init__``); deregister after the
    run. Same contract as ``RepoToolProvider``.
    """

    def __init__(
        self,
        custom_tools: list[dict],
        on_server_tool_event: Optional[Callable] = None,
    ):
        self._custom_tools = list(custom_tools or [])
        self._on_server_tool_event = on_server_tool_event
        self._registered_tools: list[str] = []
        # tool_name -> {"url", "api_key"} routing table for execution
        self._routes: dict[str, dict] = {}

    def _register_tools(self) -> None:
        """Convert OpenAI-format definitions and register handlers."""
        seen: set[str] = set()
        for ct in self._custom_tools:
            fn = ct.get("function", {}) if isinstance(ct, dict) else {}
            if not isinstance(fn, dict):
                continue
            name = str(fn.get("name", "") or "").strip()
            if not name:
                continue
            if name in seen:
                print(
                    f"[hermes-adapter] Custom MCP tool '{name}' defined by "
                    "multiple servers — keeping the first definition",
                    flush=True,
                )
                continue
            seen.add(name)

            description = str(fn.get("description", "") or "")
            parameters = fn.get("parameters") or {"type": "object", "properties": {}}
            schema = {
                "name": name,
                "description": description,
                "parameters": parameters,
            }
            server_url = str(ct.get("mcp_server_url", "") or "").strip()
            api_key = ct.get("mcp_server_api_key")
            self._routes[name] = {"url": server_url, "api_key": api_key}

            def _handler(args, _name=name, **_kw):
                route = self._routes.get(_name) or {}
                return _execute_remote_mcp_tool(
                    route.get("url", ""),
                    _name,
                    args or {},
                    route.get("api_key"),
                )

            registry.register(
                name=name,
                toolset=_CUSTOM_MCP_TOOLSET,
                schema=schema,
                handler=_handler,
                # A user-configured MCP tool intentionally shadows any
                # built-in with the same name.
                override=True,
                max_result_size_chars=_CUSTOM_MCP_MAX_RESULT_CHARS,
            )
            self._registered_tools.append(name)

        if self._registered_tools:
            print(
                f"[hermes-adapter] Registered {len(self._registered_tools)} custom MCP tool(s) "
                f"with the real agent: {', '.join(self._registered_tools)}",
                flush=True,
            )

    def _deregister_tools(self) -> None:
        """Remove custom MCP tools from the registry after the request."""
        for tool_name in self._registered_tools:
            registry.deregister(tool_name)
        if self._registered_tools:
            print(
                f"[hermes-adapter] Deregistered {len(self._registered_tools)} custom MCP tool(s)",
                flush=True,
            )
        self._registered_tools.clear()


# ---------------------------------------------------------------------------
# Fallback provider switch detection (Hermes status_callback)
# ---------------------------------------------------------------------------

_FALLBACK_SWITCH_ARROW_RE = re.compile(
    r"Switched to fallback model:\s*.+?\s+via\s+.+?\s+→\s+(.+?)\s+via\s+(.+?)\s*$"
)
_FALLBACK_SWITCH_SHORT_RE = re.compile(
    r"↻\s*Switched to fallback:\s*(.+?)\s+\((.+?)\)\s*$"
)


def parse_fallback_switch_status(message: str) -> Optional[dict[str, str]]:
    """Parse a completed Hermes fallback switch from status_callback text.

    Returns {"provider", "model"} for the activated fallback, or None when the
    message is unrelated or only describes an in-progress switch attempt.
    """
    if not message or not isinstance(message, str):
        return None
    text = message.strip()
    lowered = text.lower()
    if "switched to fallback" not in lowered and "↻" not in text:
        return None
    if "switching to fallback" in lowered and "switched to fallback" not in lowered:
        return None

    match = _FALLBACK_SWITCH_ARROW_RE.search(text)
    if match:
        return {"model": match.group(1).strip(), "provider": match.group(2).strip()}

    match = _FALLBACK_SWITCH_SHORT_RE.search(text)
    if match:
        return {"model": match.group(1).strip(), "provider": match.group(2).strip()}

    return None


# ---------------------------------------------------------------------------
# HermesAgentAdapter — main adapter class
# ---------------------------------------------------------------------------

class HermesAgentAdapter:
    """Wraps the real Hermes AIAgent for CloudChat's hermes-bridge.

    Accepts the same constructor kwargs as the custom run_agent.AIAgent
    so main.py requires minimal changes.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        max_iterations: int = 30,
        enabled_toolsets: Optional[list[str]] = None,
        repo_mode: bool = False,
        worktree_mode: bool = False,
        repo_edit_intent: bool = False,
        github_pat: Optional[str] = None,
        github_repo_owner: Optional[str] = None,
        github_repo_name: Optional[str] = None,
        repo_file_tree: Optional[list[str]] = None,
        custom_tools: Optional[list[dict]] = None,
        workspace_id: Optional[str] = None,
        reasoning_effort: Optional[str] = None,
        provider_override: Optional[str] = None,
        # Which Hermes profile's config.yaml to read. None means the default
        # ~/.hermes. main.py resolves the active profile per request and passes
        # the resulting home, so a non-default profile's provider/model config is
        # no longer ignored in favour of whatever ~/.hermes happens to contain.
        hermes_home: Optional[str] = None,
        # Plan mode: drop mutating toolsets (terminal, code_execution, shell)
        # so the real agent can only research / plan.
        plan_mode: bool = False,
        on_tool_start: Optional[Callable] = None,
        on_tool_end: Optional[Callable] = None,
        on_text: Optional[Callable] = None,
        on_server_tool_event: Optional[Callable] = None,
        on_fallback_switch: Optional[Callable[[str, str], None]] = None,
        on_computer_use_frame: Optional[Callable[[dict], None]] = None,
        on_stream_retry: Optional[Callable] = None,
        # Structured AgentNotice from the real agent (credits warnings, run
        # budget wrap-ups, etc.) — driver-agnostic payload with
        # text/level/kind/ttl_ms/key. Surfaces as an SSE agent_notice event.
        on_notice: Optional[Callable[[dict], None]] = None,
        on_notice_clear: Optional[Callable[[str], None]] = None,
        # Wall-clock budget for the whole run (seconds). Passed through to the
        # real AIAgent (agent.run_budget_seconds); 0/unset = unlimited.
        run_budget_seconds: Optional[int] = None,
        # Spec 4.3: hermes approval prompt for dangerous commands. hermes has
        # no constructor hook for it — it is a per-thread callback
        # (tools.terminal_tool.set_approval_callback) consulted only in an
        # interactive context — so run_conversation installs it around the turn.
        approval_callback: Optional[Callable[..., str]] = None,
    ):
        self.on_tool_start = on_tool_start
        self.on_tool_end = on_tool_end
        self.on_text = on_text
        self.on_server_tool_event = on_server_tool_event
        self.on_fallback_switch = on_fallback_switch
        self.on_computer_use_frame = on_computer_use_frame
        self.on_notice = on_notice
        self.on_notice_clear = on_notice_clear
        self.run_budget_seconds = run_budget_seconds
        self.approval_callback = approval_callback
        # Accepted for parity with the bridge's agent_kwargs; the real agent
        # retries its upstream calls internally (no callback to hook).
        self.on_stream_retry = on_stream_retry
        self.workspace_id = workspace_id or None
        # Active profile home. Resolved once here so the config lookup below does
        # not re-derive it (and so tests can pin it).
        self.hermes_home = str(hermes_home) if hermes_home else os.path.expanduser("~/.hermes")
        self.on_thinking: Optional[Callable] = None
        self.on_reasoning: Optional[Callable] = None
        self._streamed_text_chunks: list[str] = []
        self._last_status_message: Optional[str] = None
        self._last_fallback_switch_key: Optional[str] = None
        self._repo_registry_lock_acquired = False

        self.repo_mode = repo_mode
        self.worktree_mode = worktree_mode
        self.repo_edit_intent = repo_edit_intent
        self.plan_mode = bool(plan_mode)

        # Map CloudChat toolset names to real agent toolset names
        real_toolsets = []
        enabled = list(enabled_toolsets or ["web", "browser", "terminal"])
        for ts in enabled:
            mapped = _TOOLSET_MAP.get(ts, ts)
            if mapped not in real_toolsets:
                real_toolsets.append(mapped)
        # Add bonus toolsets the real agent supports
        for ts in _BONUS_TOOLSETS:
            if ts not in real_toolsets:
                real_toolsets.append(ts)
        # Optional toolsets the UI can toggle (e.g. delegation)
        for key, mapped in _OPTIONAL_BONUS.items():
            if key in enabled or mapped in enabled:
                if mapped not in real_toolsets:
                    real_toolsets.append(mapped)

        # Plan mode: never register pure mutation/execution toolsets. Mixed
        # toolsets (e.g. ``file`` with read_file + write_file) keep their
        # read-only tools; the plan-mode prompt suffix below reinforces the
        # read-only constraint at the instruction level.
        if self.plan_mode:
            filtered = filter_toolsets_for_plan_mode(real_toolsets)
            if filtered != real_toolsets:
                print(
                    f"[hermes-adapter] plan_mode: dropped mutating toolset(s) "
                    f"{sorted(set(real_toolsets) - set(filtered))}",
                    flush=True,
                )
                real_toolsets = filtered

        # Set up repo tool provider.
        # IMPORTANT: Tools must be registered BEFORE creating the agent because
        # the real hermes-agent calls get_tool_definitions() in __init__, which
        # checks the registry at that moment. If tools aren't registered yet,
        # validate_toolset() returns False and the toolset is silently skipped.
        try:
            self._repo_provider: Optional[RepoToolProvider] = None
            # Worktree mode uses local file/terminal tools on the worktree cwd;
            # GitHub API repo tools would edit the remote, not the isolated clone.
            if repo_mode and github_repo_owner and github_repo_name and not worktree_mode:
                _repo_tool_registry_lock.acquire()
                self._repo_registry_lock_acquired = True
                self._repo_provider = RepoToolProvider(
                    github_pat=github_pat,
                    owner=github_repo_owner,
                    name=github_repo_name,
                    file_tree=repo_file_tree or [],
                    edit_intent=repo_edit_intent,
                    on_server_tool_event=on_server_tool_event,
                    workspace_id=workspace_id,
                    on_text=on_text,
                )
                real_toolsets.append(_REPO_TOOLSET)
                # Pre-register tools so the agent discovers them during __init__
                self._repo_provider._register_tools()

            # Register CloudChat custom MCP tools (from user-configured MCP
            # servers) into the real agent's registry BEFORE agent creation.
            # Without this the real hermes-agent silently drops custom_tools
            # and the agent never sees the user's MCP servers.
            self._custom_mcp_provider: Optional[CustomMCPServerProvider] = None
            if custom_tools:
                self._custom_mcp_provider = CustomMCPServerProvider(
                    custom_tools,
                    on_server_tool_event=on_server_tool_event,
                )
                self._custom_mcp_provider._register_tools()
                real_toolsets.append(_CUSTOM_MCP_TOOLSET)

            # Build ephemeral system prompt for repo context.
            # Always include today's date so web_search / news-style queries
            # aren't anchored to the model's training cutoff year.
            from datetime import datetime
            date_preamble = f"Today's date is {datetime.now().astimezone().strftime('%Y-%m-%d')}."
            repo_prompt = (
                self._repo_provider.build_repo_system_prompt() if self._repo_provider else ""
            )
            worktree_prompt = ""
            if worktree_mode:
                worktree_prompt = (
                    "You are running in an isolated local git worktree. "
                    "Use file, terminal, and code_execution tools to read and edit "
                    "the repository on disk. GitHub API repo tools are disabled for "
                    "this session — do not attempt edit_repo_file or similar remote edits."
                )
            prompt_parts = [date_preamble]
            if worktree_prompt:
                prompt_parts.append(worktree_prompt)
            if repo_prompt:
                prompt_parts.append(repo_prompt)
            self._cu_poller = None
            self._cu_poller_lock = threading.Lock()
            if any(ts in real_toolsets for ts in ("computer_use", "computer")):
                from computer_use_frames import (
                    COMPUTER_USE_CAPTURE_HINT,
                    install_spark_keep_cu_screenshots_patch,
                )

                os.environ["SPARK_KEEP_CU_SCREENSHOTS"] = "1"
                install_spark_keep_cu_screenshots_patch()
                prompt_parts.append(COMPUTER_USE_CAPTURE_HINT)
            if self.plan_mode:
                prompt_parts.append(PLAN_MODE_PROMPT_SUFFIX.strip())
            self._ephemeral_system_prompt = "\n\n".join(prompt_parts).strip()

            # Determine provider from base_url or hermes config.
            # Maps the base_url host to the corresponding hermes-agent provider ID.
            provider = provider_override.strip() if isinstance(provider_override, str) and provider_override.strip() else None
            _bu = (base_url or "").lower()
            if provider:
                pass
            elif "openrouter.ai" in _bu:
                provider = "openrouter"
            elif "minimax" in _bu:
                provider = "minimax"
            elif "api.anthropic.com" in _bu:
                provider = "anthropic"
            elif "api.openai.com" in _bu:
                provider = "openai"
            elif "api.deepseek.com" in _bu:
                provider = "deepseek"
            elif "generativelanguage.googleapis.com" in _bu or "googleapis.com" in _bu:
                provider = "gemini"
            elif "api.x.ai" in _bu:
                provider = "xai"
            elif "api.groq.com" in _bu:
                provider = "groq"
            elif "api.mistral.ai" in _bu:
                provider = "mistral"
            elif "moonshot" in _bu or "kimi" in _bu:
                provider = "kimi-coding"
            elif "z.ai" in _bu or "bigmodel" in _bu:
                provider = "zai"
            elif "dashscope" in _bu or "aliyuncs.com" in _bu:
                provider = "alibaba"
            elif "huggingface" in _bu:
                provider = "huggingface"
            elif "cerebras" in _bu:
                provider = "cerebras"
            elif "together.xyz" in _bu:
                provider = "together"
            elif "nousresearch" in _bu or "nous" in _bu:
                provider = "nous"
            # If base_url doesn't match known providers, check the active
            # profile's hermes config. This used to read a hard-coded
            # ~/.hermes/config.yaml, so a non-default profile silently inherited
            # the default profile's provider.
            if not provider:
                try:
                    import yaml
                    cfg_path = os.path.join(self.hermes_home, "config.yaml")
                    if os.path.isfile(cfg_path):
                        with open(cfg_path) as f:
                            cfg = yaml.safe_load(f) or {}
                        cfg_provider = (cfg.get("model", {}) or {}).get("provider", "")
                        if cfg_provider:
                            provider = cfg_provider
                except Exception:
                    pass

            # Create the real AIAgent
            print(
                f"[hermes-adapter] Creating agent: base_url={base_url} "
                f"api_key={mask_secret(api_key)} provider={provider} model={model}",
                flush=True,
            )
            # Only pass parameters the real hermes-agent AIAgent actually accepts.
            # The real signature is: base_url, api_key, provider, api_mode, model,
            # max_iterations, enabled_toolsets, quiet_mode, platform, callbacks, etc.
            # Reasoning effort from CloudChat's Effort slider → the real agent's
            # reasoning_config ({"enabled": False} for "none", else {"enabled", "effort"}).
            reasoning_config = None
            if reasoning_effort:
                try:
                    from hermes_constants import parse_reasoning_effort
                    reasoning_config = parse_reasoning_effort(reasoning_effort)
                except Exception:
                    reasoning_config = (
                        {"enabled": False} if reasoning_effort == "none"
                        else {"enabled": True, "effort": reasoning_effort}
                    )

            # For MoA, base_url/api_key are placeholders — MoAClient owns real slots.
            # Still pass them so non-MoA paths keep working.
            agent_kwargs = {
                "base_url": base_url,
                "api_key": api_key,
                "provider": provider,
                "model": model,
                "max_iterations": max_iterations,
                "enabled_toolsets": real_toolsets,
                "reasoning_config": reasoning_config,
                # hermes-desktop way of sessions: the conversation identity IS the
                # session identity. Passing the conversation's workspace_id as the
                # real agent's session_id gives ONE stable state.db session per
                # conversation (same id across turns, full transcript, searchable,
                # resumable). Without it the agent auto-generates a fresh id every
                # turn, fragmenting the conversation across session rows.
                "session_id": self.workspace_id or None,
                "platform": "cloudchat",
                "quiet_mode": True,
                # Callbacks — translated to CloudChat's format
                "stream_delta_callback": self._on_stream_delta,
                "tool_start_callback": self._on_tool_start,
                "tool_complete_callback": self._on_tool_complete,
                "reasoning_callback": self._on_reasoning,
                "step_callback": self._on_step,
                "status_callback": self._on_status,
                # Structured AgentNotice (credits warnings, run-budget wrap-up)
                # + its clear twin — forwarded as SSE agent_notice events.
                "notice_callback": self._on_notice,
                "notice_clear_callback": self._on_notice_clear,
                # MoA reference/aggregator events arrive via tool_progress_callback
                "tool_progress_callback": self._on_tool_progress,
            }
            if getattr(self, "run_budget_seconds", None):
                agent_kwargs["run_budget_seconds"] = int(self.run_budget_seconds)
            self._agent = RealAIAgent(**agent_kwargs)

            print(
                f"[hermes-adapter] Real agent created. model={model} "
                f"toolsets={real_toolsets} repo_mode={repo_mode} worktree_mode={worktree_mode}",
                flush=True,
            )
        except Exception:
            self._cleanup_repo_tools()
            raise


    def _cleanup_repo_tools(self):
        try:
            if self._repo_provider:
                self._repo_provider._deregister_tools()
        finally:
            if self._repo_registry_lock_acquired:
                self._repo_registry_lock_acquired = False
                _repo_tool_registry_lock.release()

    # --- Callback translators ---

    def _on_stream_delta(self, delta):
        """Real agent streams per-token. Forward directly to on_text."""
        if delta is not None and delta and self.on_text:
            self._streamed_text_chunks.append(str(delta))
            self.on_text(delta)

    def _on_tool_start(self, tc_id: str, name: str, args: dict):
        """Map real agent's tool_start_callback to CloudChat's on_tool_start."""
        self._start_cu_frame_poller(name, args)
        self._emit_computer_use_frame(name, args, None, status="running")
        if self.on_tool_start:
            tool_input = json.dumps(args) if args else ""
            if callback_accepts_kwarg(self.on_tool_start, "call_id"):
                self.on_tool_start(name, tool_input, call_id=tc_id)
            else:
                self.on_tool_start(name, tool_input)

    def _emit_lsp_diagnostic_event(self, path_hint: str, diag_text: str, source_tool: str) -> None:
        """Surface Hermes post-write LSP diagnostics as structured tool_activity."""
        meta = {"path": path_hint, "source_tool": source_tool}
        meta_json = json.dumps(meta, ensure_ascii=False)
        if self.on_tool_start:
            self.on_tool_start("lsp.diagnostic", meta_json)
        if self.on_tool_end:
            self.on_tool_end("lsp.diagnostic", meta_json, diag_text)

    def _extract_lsp_diagnostics(self, result: str) -> Optional[tuple[str, str]]:
        """Parse lsp_diagnostics from Hermes file-tool JSON results."""
        text = (result or "").strip()
        if not text:
            return None
        diag: Optional[str] = None
        path_hint = ""
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                raw_diag = parsed.get("lsp_diagnostics")
                if isinstance(raw_diag, str) and raw_diag.strip():
                    diag = raw_diag.strip()
                path_hint = str(parsed.get("path") or parsed.get("file") or "").strip()
        except json.JSONDecodeError:
            if "lsp_diagnostics" in text or "<diagnostics" in text:
                diag = text
        if not diag:
            return None
        if not path_hint and "<diagnostics file=" in diag:
            match = re.search(r'<diagnostics file="([^"]+)"', diag)
            if match:
                path_hint = match.group(1)
        return path_hint, diag[:4000]

    def _start_cu_frame_poller(self, name: str, args: dict) -> None:
        from computer_use_frames import ComputerUseFramePoller, is_computer_use_tool

        if not is_computer_use_tool(name) or not self.on_computer_use_frame:
            return
        with self._cu_poller_lock:
            self._stop_cu_frame_poller_locked()
            poller = ComputerUseFramePoller(
                tool_name=name,
                args=args,
                on_frame=self.on_computer_use_frame,
            )
            poller.start()
            self._cu_poller = poller

    def _stop_cu_frame_poller_locked(self) -> None:
        if self._cu_poller is not None:
            self._cu_poller.stop()
            self._cu_poller = None

    def _stop_cu_frame_poller(self) -> None:
        with self._cu_poller_lock:
            self._stop_cu_frame_poller_locked()

    def _emit_computer_use_frame(self, name: str, args: Any, result: Any, status: str = "completed") -> None:
        if not self.on_computer_use_frame:
            return
        try:
            from computer_use_frames import (
                build_computer_use_frame_payload,
                is_computer_use_tool,
                try_supplemental_capture,
            )

            payload = build_computer_use_frame_payload(
                tool_name=name,
                args=args,
                result=result,
                status=status,
            )
            if payload is None and status == "completed" and is_computer_use_tool(name):
                supplemental = try_supplemental_capture()
                if supplemental:
                    payload = build_computer_use_frame_payload(
                        tool_name=name,
                        args=args,
                        result=result,
                        status=status,
                        image=supplemental,
                    )
            if payload:
                self.on_computer_use_frame(payload)
        except Exception as exc:
            print(f"[hermes-adapter] computer_use frame error: {exc}", flush=True)

    def _on_tool_complete(self, tc_id: str, name: str, args: dict, result: str):
        """Map real agent's tool_complete_callback to CloudChat's on_tool_end."""
        self._stop_cu_frame_poller()
        lsp = self._extract_lsp_diagnostics(result or "")
        if lsp:
            path_hint, diag_text = lsp
            self._emit_lsp_diagnostic_event(path_hint, diag_text, name)
        self._emit_computer_use_frame(name, args, result, status="completed")
        if self.on_tool_end:
            # Composer task panel tools need their JSON output intact (see
            # main.py on_tool_end) — main.py applies the per-tool cap.
            from computer_use_frames import computer_use_text_summary, is_computer_use_tool

            if is_computer_use_tool(name):
                output = computer_use_text_summary(result)
                truncated, truncated_lines = output_truncation_info(result, len(output))
            else:
                cap = 4000 if name in ("todo", "delegate_task", "process", "terminal") else 500
                output = (result or "")[:cap]
                truncated, truncated_lines = output_truncation_info(result, cap)
            tool_input = json.dumps(args) if args else ""
            if callback_accepts_kwarg(self.on_tool_end, "call_id"):
                self.on_tool_end(
                    name,
                    tool_input,
                    output,
                    call_id=tc_id,
                    output_truncated=truncated,
                    output_truncated_lines=truncated_lines,
                )
            else:
                self.on_tool_end(name, tool_input, output)

    def _on_reasoning(self, text: str):
        """Forward reasoning deltas."""
        if text and self.on_reasoning:
            self.on_reasoning(text)

    def _on_step(self, api_call_count: int, prev_tools: list):
        """Map step_callback to on_thinking with iteration count."""
        if self.on_thinking:
            self.on_thinking(api_call_count)

    def _on_status(self, category: str, message: str):
        """Log status events and surface completed fallback provider switches."""
        if message:
            self._last_status_message = message
            switch = parse_fallback_switch_status(message)
            if switch and self.on_fallback_switch:
                switch_key = f"{switch['provider']}:{switch['model']}"
                if switch_key != self._last_fallback_switch_key:
                    self._last_fallback_switch_key = switch_key
                    self.on_fallback_switch(switch["provider"], switch["model"])
        print(f"[hermes-adapter] status/{category}: {message}", flush=True)

    def _on_notice(self, notice):
        """Forward a structured AgentNotice (credits/run-budget warnings) to SSE."""
        try:
            payload = {
                "text": str(getattr(notice, "text", "") or ""),
                "level": str(getattr(notice, "level", "") or "info"),
                "kind": str(getattr(notice, "kind", "") or "sticky"),
                "ttl_ms": getattr(notice, "ttl_ms", None),
                "key": getattr(notice, "key", None),
            }
        except Exception:
            # A malformed notice must never break the agent loop (D-D fail-open)
            return
        print(f"[hermes-adapter] notice/{payload['level']}: {payload['text'][:120]}", flush=True)
        if self.on_notice and payload["text"]:
            try:
                self.on_notice(payload)
            except Exception:
                pass

    def _on_notice_clear(self, key):
        """Forward a notice-clear (sticky notice recovered) to SSE."""
        if self.on_notice_clear and key:
            try:
                self.on_notice_clear(str(key))
            except Exception:
                pass

    def _on_tool_progress(self, event_type, name=None, preview=None, args=None, **kwargs):
        """Forward Hermes tool_progress events — especially MoA advisor blocks.

        Hermes MoA emits:
          - moa.reference  (name=label, preview=text, moa_index, moa_count)
          - moa.aggregating (name=aggregator, moa_ref_count)
        These are display-only; they never mutate conversation history.
        We surface them as tool_activity so Spark's AgentActivity UI can render
        collapsible advisor cards without a new SSE channel.
        """
        try:
            event = str(event_type or "")
            if event == "moa.reference":
                label = str(name or "")
                text = str(preview or "")
                meta = {
                    "label": label,
                    "index": kwargs.get("moa_index"),
                    "count": kwargs.get("moa_count"),
                }
                meta_json = json.dumps(meta, ensure_ascii=False)
                if self.on_tool_start:
                    self.on_tool_start("moa.reference", meta_json)
                if self.on_tool_end:
                    # Cap advisor text — full essays blow the activity panel
                    self.on_tool_end("moa.reference", meta_json, (text or "")[:4000])
                return
            if event == "moa.aggregating":
                aggregator = str(name or "")
                meta = {
                    "aggregator": aggregator,
                    "ref_count": kwargs.get("moa_ref_count"),
                }
                meta_json = json.dumps(meta, ensure_ascii=False)
                if self.on_tool_start:
                    self.on_tool_start("moa.aggregating", meta_json)
                if self.on_tool_end:
                    self.on_tool_end(
                        "moa.aggregating",
                        meta_json,
                        f"Aggregating with {aggregator}" if aggregator else "Aggregating reference models",
                    )
                return
            # tool_progress tool.completed lacks args/result — screenshots are
            # emitted from tool_complete_callback (_on_tool_complete) only.
            # Other progress events (tool.started etc.) are covered by
            # tool_start_callback / tool_complete_callback — ignore to avoid dupes.
        except Exception as exc:
            print(f"[hermes-adapter] tool_progress error: {exc}", flush=True)

    # --- Approvals and interrupt (spec 4.3 / 4.4) ---

    @contextlib.contextmanager
    def _approval_context(self):
        """Install the bridge approval callback for this turn's thread.

        Mirrors hermes' own ACP adapter: set the per-thread approval callback
        and mark the context interactive so the approval gate consults it
        instead of auto-resolving. hermes copies both into its tool worker
        threads (tools.thread_context). Restored afterwards because the
        bridge reuses worker threads across requests.
        """
        callback = getattr(self, "approval_callback", None)
        if callback is None:
            yield
            return
        try:
            from tools import terminal_tool
            from tools.approval_context import (
                reset_hermes_interactive_context,
                set_hermes_interactive_context,
            )
        except ImportError as exc:
            print(f"[hermes-adapter] approvals unavailable on this hermes-agent ({exc}); tools auto-resolve", flush=True)
            yield
            return
        previous = terminal_tool._get_approval_callback()
        terminal_tool.set_approval_callback(callback)
        token = set_hermes_interactive_context(True)
        try:
            yield
        finally:
            reset_hermes_interactive_context(token)
            terminal_tool.set_approval_callback(previous)

    def interrupt(self) -> bool:
        """Ask the real agent to stop (Stop button / client disconnect).

        Safe from any thread: hermes' ``AIAgent.interrupt`` only sets flags,
        which the agent loop checks between API calls and tool steps.
        """
        agent = getattr(self, "_agent", None)
        interrupt = getattr(agent, "interrupt", None)
        if not callable(interrupt):
            return False
        try:
            interrupt(hard_cancel=True)
        except TypeError:
            # Older hermes-agent: no hard_cancel keyword.
            interrupt()
        return True

    # --- Main entry point ---

    def run_conversation(
        self,
        user_message: str,
        conversation_history: Optional[list[dict]] = None,
    ):
        """Run the real Hermes agent on this message.

        The real agent handles the full tool loop internally. All output
        is streamed via callbacks — nothing meaningful is returned here
        for the SSE bridge (main.py streams from the event queue).

        Note: repo tools are already registered in __init__ (before agent
        creation). We deregister after the conversation completes.
        """
        self._streamed_text_chunks = []
        self._last_status_message = None
        self._last_fallback_switch_key = None
        try:
            with self._approval_context():
                result = self._agent.run_conversation(
                    user_message=user_message,
                    system_message=self._ephemeral_system_prompt,
                    conversation_history=conversation_history or [],
                )
        finally:
            self._stop_cu_frame_poller()
            try:
                from computer_use_frames import restore_spark_keep_cu_screenshots_patch

                restore_spark_keep_cu_screenshots_patch()
            except Exception:
                pass
            # Deregister repo tools after the conversation to clean up the registry
            self._cleanup_repo_tools()
            # Deregister custom MCP tools after the conversation too
            if self._custom_mcp_provider:
                self._custom_mcp_provider._deregister_tools()

        streamed_text = "".join(chunk for chunk in self._streamed_text_chunks if isinstance(chunk, str))
        streamed_visible_text = bool(streamed_text.strip())

        # Log completion stats
        if isinstance(result, dict):
            final_response = result.get("final_response")
            if (
                isinstance(final_response, str)
                and final_response.strip()
                and self.on_text
                and not streamed_visible_text
            ):
                self.on_text(final_response)
                streamed_visible_text = True

            if not streamed_visible_text and self.on_text:
                fallback_message = None
                if isinstance(self._last_status_message, str) and self._last_status_message.strip():
                    fallback_message = self._last_status_message
                else:
                    error_message = result.get("error")
                    if isinstance(error_message, str) and error_message.strip():
                        fallback_message = f"Error: {error_message}"

                if fallback_message:
                    self.on_text(fallback_message)

            api_calls = result.get("api_calls", 0)
            completed = result.get("completed", False)
            cost = result.get("estimated_cost_usd")
            print(
                f"[hermes-adapter] Conversation done. "
                f"api_calls={api_calls} completed={completed} "
                f"cost=${cost:.4f}" if cost else f"[hermes-adapter] Conversation done. api_calls={api_calls}",
                flush=True,
            )

        return result
