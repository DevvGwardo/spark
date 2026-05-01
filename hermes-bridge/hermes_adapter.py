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
import os
import sys
import time
import httpx
from typing import Optional, Callable
from urllib.parse import quote

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


# --------------------------------------------------------------------------
# Cache TTL config (env var overrides with defaults)
# --------------------------------------------------------------------------
REPO_CACHE_TTL = int(os.environ.get("HERMES_REPO_CACHE_TTL", "300"))
REPO_TREE_TTL = int(os.environ.get("HERMES_REPO_TREE_TTL", "600"))

# --------------------------------------------------------------------------
# Cache hit/miss metrics
# --------------------------------------------------------------------------
_cache_stats = {"repo_file_hits": 0, "repo_file_misses": 0, "repo_tree_hits": 0, "repo_tree_misses": 0}


def _get_cache_stats() -> dict:
    return dict(_cache_stats)


def _reset_cache_stats():
    _cache_stats.clear()
    _cache_stats.update({"repo_file_hits": 0, "repo_file_misses": 0, "repo_tree_hits": 0, "repo_tree_misses": 0})


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
_run_agent_spec = importlib.util.spec_from_file_location(
    "run_agent",
    os.path.join(_HERMES_AGENT_DIR, "run_agent.py"),
)
_run_agent_mod = importlib.util.module_from_spec(_run_agent_spec)
sys.modules["run_agent"] = _run_agent_mod
_run_agent_spec.loader.exec_module(_run_agent_mod)
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
}

# Toolsets that the real agent supports and we always enable
_BONUS_TOOLSETS = ["skills", "memory", "todo", "session_search"]

# Repo tool toolset name (registered dynamically per request)
_REPO_TOOLSET = "cloudchat_repo"

# ---------------------------------------------------------------------------
# Repo tool schemas (OpenAI function-calling format, sans wrapper)
# ---------------------------------------------------------------------------

_REPO_TOOL_SCHEMAS = {
    "list_user_repos": {
        "name": "list_user_repos",
        "description": (
            "List all repositories accessible with the current GitHub token. "
            "Use this when the active repo cannot be found (404) to discover available repos."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    "read_repo_file": {
        "name": "read_repo_file",
        "description": "Read the contents of a file from the repository.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "The file path to read"},
            },
            "required": ["path"],
        },
    },
    "edit_repo_file": {
        "name": "edit_repo_file",
        "description": "Edit an existing file in the repository. Call read_repo_file first to see current contents.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "The file path to edit"},
                "content": {"type": "string", "description": "The new full file content"},
                "description": {"type": "string", "description": "What was changed"},
            },
            "required": ["path", "content"],
        },
    },
    "create_repo_file": {
        "name": "create_repo_file",
        "description": "Create a new file in the repository.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "The file path to create"},
                "content": {"type": "string", "description": "The file content"},
                "description": {"type": "string", "description": "What this file is for"},
            },
            "required": ["path", "content"],
        },
    },
    "delete_repo_file": {
        "name": "delete_repo_file",
        "description": "Delete a file from the repository.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "The file path to delete"},
            },
            "required": ["path"],
        },
    },
    "batch_edit_repo_files": {
        "name": "batch_edit_repo_files",
        "description": "Edit multiple files in a single operation.",
        "parameters": {
            "type": "object",
            "properties": {
                "changes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "content": {"type": "string"},
                            "action": {"type": "string", "enum": ["edit", "create", "delete"]},
                            "description": {"type": "string"},
                        },
                        "required": ["path", "action"],
                    },
                    "description": "Array of file changes to apply",
                },
            },
            "required": ["changes"],
        },
    },
}

_REPO_EDIT_TOOLS = {"edit_repo_file", "create_repo_file", "delete_repo_file", "batch_edit_repo_files"}
_MAX_TOOL_RESPONSE = 25_000


def _shared_repo_file_key(owner: str, repo: str, path: str) -> str:
    return f"repo-file:{owner}/{repo}:{path}"


def _shared_repo_tree_key(owner: str, repo: str) -> str:
    return f"repo-tree:{owner}/{repo}"


def _workspace_staged_key(workspace_id: str, owner: str, repo: str, path: str) -> str:
    return f"repo-staged:{workspace_id}:{owner}/{repo}:{path}"


def _cap(text: str) -> str:
    if len(text) <= _MAX_TOOL_RESPONSE:
        return text
    half = _MAX_TOOL_RESPONSE // 2
    return text[:half] + f"\n\n... ({len(text) - _MAX_TOOL_RESPONSE} chars truncated) ...\n\n" + text[-half:]


# ---------------------------------------------------------------------------
# RepoToolProvider — registers GitHub API repo tools into the real agent
# ---------------------------------------------------------------------------

class RepoToolProvider:
    """Manages GitHub API repo tools as a dynamic toolset in the real agent."""

    # Friendly display names for repo tool marker text (matches main.py)
    _DISPLAY_NAMES: dict[str, str] = {
        "read_repo_file": "Reading file",
        "edit_repo_file": "Editing file",
        "create_repo_file": "Creating file",
        "delete_repo_file": "Deleting file",
        "batch_edit_repo_files": "Editing files",
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

    def __enter__(self):
        self._register_tools()
        return self

    def __exit__(self, *args):
        self._deregister_tools()

    def _register_tools(self):
        """Register repo tools into the real agent's tool registry."""
        tools_to_register = ["list_user_repos", "read_repo_file"]
        if self.edit_intent:
            tools_to_register.extend([
                "edit_repo_file", "create_repo_file",
                "delete_repo_file", "batch_edit_repo_files",
            ])

        handlers = {
            "list_user_repos": self._handle_list_user_repos,
            "read_repo_file": self._handle_read_repo_file,
            "edit_repo_file": self._handle_edit_repo_file,
            "create_repo_file": self._handle_create_repo_file,
            "delete_repo_file": self._handle_delete_repo_file,
            "batch_edit_repo_files": self._handle_batch_edit,
        }

        for tool_name in tools_to_register:
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
            f"for {self.owner}/{self.name} (edit_intent={self.edit_intent})",
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

    # --- Tool handlers (signature: handler(args_dict, **kwargs) -> str) ---

    @staticmethod
    def _parse_next_link(link_header: str) -> str | None:
        """Parse GitHub's Link header to find the next page URL."""
        if not link_header:
            return None
        for part in link_header.split(","):
            if 'rel="next"' in part:
                url = part.split(";")[0].strip().strip("<>")
                return url
        return None

    def _handle_list_user_repos(self, args: dict, **kwargs) -> str:
        if not self.github_pat:
            return "Error: No GitHub token configured."
        try:
            url = "https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member"
            headers = {
                "Authorization": f"Bearer {self.github_pat}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "Hermes-Agent",
            }
            all_repos = []
            with httpx.Client(timeout=15) as client:
                while url:
                    resp = client.get(url, headers=headers)
                    if resp.status_code == 401:
                        return "Error: GitHub token is invalid or expired."
                    if resp.status_code == 429:
                        retry_after = int(resp.headers.get("Retry-After", "5"))
                        time.sleep(retry_after)
                        continue
                    resp.raise_for_status()
                    page = resp.json()
                    if isinstance(page, list):
                        all_repos.extend(page)
                    url = self._parse_next_link(resp.headers.get("Link", ""))
            repos = all_repos
            if not repos:
                return "No repositories found."
            lines = []
            for repo in repos:
                full_name = repo.get("full_name", "?")
                desc = repo.get("description") or ""
                priv = " (private)" if repo.get("private") else ""
                lines.append(f"- {full_name}{priv}: {desc[:80]}" if desc else f"- {full_name}{priv}")
            return f"Found {len(repos)} accessible repositories:\n" + "\n".join(lines)
        except Exception as e:
            return f"Error listing repositories: {e}"

    def _handle_read_repo_file(self, args: dict, **kwargs) -> str:
        path = args.get("path", "")
        self._emit_tool_marker("read_repo_file", path)
        # Return cached content for files edited in this session
        if path in self.session_cache:
            content = self.session_cache[path]
            self._emit({"type": "repo_file_read", "path": path, "content": content})
            return _cap(content) or "(empty file)"

        # Check cross-session staged edits buffer first (workspace-scoped)
        if self.owner and self.name:
            staged_key = _workspace_staged_key(self.workspace_id, self.owner, self.name, path)
            staged = _brain_safe_get(staged_key)
            if staged is not None:
                self.session_cache[path] = staged
                self._emit({"type": "repo_file_read", "path": path, "content": staged, "staged": True})
                return _cap(staged) or "(empty file)"

        # Check cross-session brain cache before hitting GitHub API
        if self.owner and self.name:
            cache_key = f"repo-file:{self.owner}/{self.name}:{path}"
            cached = _brain_safe_get(cache_key)
            if cached is not None:
                _cache_stats["repo_file_hits"] += 1
                self.session_cache[path] = cached
                self._emit({"type": "repo_file_read", "path": path, "content": cached, "cached": True})
                return _cap(cached) or "(empty file)"
            _cache_stats["repo_file_misses"] += 1

        result = self._read_github_file(path)
        if not result.startswith("Error"):
            self.session_cache[path] = result
            # Pool to brain cache so other requests can reuse it
            if self.owner and self.name:
                _brain_safe_set(f"repo-file:{self.owner}/{self.name}:{path}", result, ttl=REPO_CACHE_TTL)
            self._emit({"type": "repo_file_read", "path": path, "content": result})
        return _cap(result) or "(empty file)"

    def _handle_edit_repo_file(self, args: dict, **kwargs) -> str:
        path = args.get("path", "")
        self._emit_tool_marker("edit_repo_file", path)
        content = args.get("content", "")
        description = args.get("description", "")
        original = self.session_cache.get(path, "")
        self.session_cache[path] = content
        # Invalidate pooled brain cache and stage to workspace-scoped edit buffer
        if self.owner and self.name:
            _brain_safe_delete(_shared_repo_file_key(self.owner, self.name, path))
            _brain_safe_set(
                _workspace_staged_key(self.workspace_id, self.owner, self.name, path),
                content,
                ttl=REPO_CACHE_TTL,
            )
        self._emit({
            "type": "repo_file_edit",
            "path": path,
            "content": content,
            "originalContent": original,
            "description": description,
        })
        return f"Staged edit for {path}: {description or 'updated'}"

    def _handle_create_repo_file(self, args: dict, **kwargs) -> str:
        path = args.get("path", "")
        self._emit_tool_marker("create_repo_file", path)
        content = args.get("content", "")
        description = args.get("description", "")
        self.session_cache[path] = content
        # Invalidate pooled brain cache and publish to workspace-scoped staged buffer
        if self.owner and self.name:
            _brain_safe_delete(_shared_repo_file_key(self.owner, self.name, path))
            _brain_safe_set(
                _workspace_staged_key(self.workspace_id, self.owner, self.name, path),
                content,
                ttl=REPO_CACHE_TTL,
            )
        self._emit({
            "type": "repo_file_create",
            "path": path,
            "content": content,
            "description": description,
        })
        return f"Staged new file {path}: {description or 'created'}"

    def _handle_delete_repo_file(self, args: dict, **kwargs) -> str:
        path = args.get("path", "")
        self._emit_tool_marker("delete_repo_file", path)
        self.session_cache.pop(path, None)
        # Invalidate pooled brain cache and workspace-scoped staged buffer
        if self.owner and self.name:
            _brain_safe_delete(_shared_repo_file_key(self.owner, self.name, path))
            _brain_safe_delete(_workspace_staged_key(self.workspace_id, self.owner, self.name, path))
        self._emit({"type": "repo_file_delete", "path": path})
        return f"Staged deletion of {path}"

    def _handle_batch_edit(self, args: dict, **kwargs) -> str:
        changes = args.get("changes", [])
        if isinstance(changes, list) and changes:
            paths = [c.get("path", "?") for c in changes[:5] if isinstance(c, dict)]
            detail = ", ".join(paths)
            if len(changes) > 5:
                detail += f" +{len(changes) - 5} more"
            self._emit_tool_marker("batch_edit_repo_files", detail)
        else:
            self._emit_tool_marker("batch_edit_repo_files")
        if not isinstance(changes, list):
            return "Error: 'changes' must be an array."
        results = []
        for change in changes:
            action = change.get("action", "edit")
            path = change.get("path", "")
            content = change.get("content", "")
            desc = change.get("description", "")
            if action == "delete":
                results.append(self._handle_delete_repo_file({"path": path}))
            elif action == "create":
                results.append(self._handle_create_repo_file({"path": path, "content": content, "description": desc}))
            else:
                results.append(self._handle_edit_repo_file({"path": path, "content": content, "description": desc}))
        return "\n".join(results)

    def _read_github_file(self, path: str) -> str:
        """Read a file from GitHub API."""
        if not self.github_pat or not self.owner or not self.name:
            return "Error: GitHub access not configured."
        try:
            encoded_owner = quote(self.owner, safe="")
            encoded_repo = quote(self.name, safe="")
            encoded_path = quote(path, safe="/")
            url = f"https://api.github.com/repos/{encoded_owner}/{encoded_repo}/contents/{encoded_path}"
            headers = {
                "Authorization": f"Bearer {self.github_pat}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "Hermes-Agent",
            }
            with httpx.Client(timeout=15) as client:
                resp = client.get(url, headers=headers)
                if resp.status_code == 404:
                    if path and path != "" and path != "/":
                        root_url = f"https://api.github.com/repos/{encoded_owner}/{encoded_repo}/contents/"
                        root_resp = client.get(root_url, headers=headers)
                        if root_resp.status_code == 404:
                            return (
                                f"Error: Repository {self.owner}/{self.name} not found (404). "
                                f"Call list_user_repos to see accessible repositories."
                            )
                    parent_dir = "/".join(path.split("/")[:-1]) if "/" in path else ""
                    hint = f" Try read_repo_file on '{parent_dir}'." if parent_dir else " Try read_repo_file with path '' to list root."
                    return f"Error: File not found at '{path}'.{hint}"
                if resp.status_code == 403:
                    return f"Error: Access denied (403) for '{path}'."
                resp.raise_for_status()
            data = resp.json()
            if isinstance(data, list):
                entries = []
                for item in data:
                    t = item.get("type", "file")
                    n = item.get("name", "?")
                    entries.append(f"{'[dir] ' if t == 'dir' else ''}{n}")
                return f"Directory listing for '{path or '/'}':\n" + "\n".join(sorted(entries))
            import base64 as b64
            content = data.get("content", "")
            encoding = data.get("encoding", "")
            if encoding == "base64":
                return b64.b64decode(content).decode("utf-8", errors="replace")
            return content
        except Exception as e:
            return f"Error reading '{path}': {e}"

    def _load_brain_memories(self) -> str:
        """Load relevant memories from brain via brain_recall for injection into system prompt.

        Uses brain_recall (via _brain_call_async RPC) to search the brain's persistent
        memory store for repo-specific and global memories. Falls back to _brain_safe_get
        (HTTP-based) if the async call isn't available.
        """
        import main as _main_mod
        memories = []

        # Try brain_recall (proper brain MCP memory search) first
        try:
            import asyncio as _asyncio

            async def _recall_async():
                if hasattr(_main_mod, "_brain_call_async"):
                    return await _main_mod._brain_call_async("brain_recall", {"query": f"{self.owner}/{self.name}"})
                return None

            result = _asyncio.run(_recall_async()) if _asyncio.get_event_loop().is_running() else None
            if result and isinstance(result, dict):
                content = result.get("content") or ""
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "text":
                            memories.append(item.get("text", ""))
                elif isinstance(content, str) and content.strip():
                    memories.append(content.strip())
        except Exception:
            pass  # Fall back to _brain_safe_get

        # Fallback: load known memory keys via HTTP brain cache
        if not memories:
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

        memories_section = self._load_brain_memories()

        return (
            f"You are working on the GitHub repository {repo_full}.\n"
            "You have tools to read, edit, create, and delete files in this repo.\n\n"
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
        repo_edit_intent: bool = False,
        github_pat: Optional[str] = None,
        github_repo_owner: Optional[str] = None,
        github_repo_name: Optional[str] = None,
        repo_file_tree: Optional[list[str]] = None,
        custom_tools: Optional[list[dict]] = None,
        workspace_id: Optional[str] = None,
        on_tool_start: Optional[Callable] = None,
        on_tool_end: Optional[Callable] = None,
        on_text: Optional[Callable] = None,
        on_server_tool_event: Optional[Callable] = None,
    ):
        self.on_tool_start = on_tool_start
        self.on_tool_end = on_tool_end
        self.on_text = on_text
        self.on_server_tool_event = on_server_tool_event
        self.on_thinking: Optional[Callable] = None
        self.on_reasoning: Optional[Callable] = None
        self._streamed_text_chunks: list[str] = []
        self._last_status_message: Optional[str] = None

        self.repo_mode = repo_mode
        self.repo_edit_intent = repo_edit_intent

        # Map CloudChat toolset names to real agent toolset names
        real_toolsets = []
        for ts in (enabled_toolsets or ["web", "browser", "terminal"]):
            mapped = _TOOLSET_MAP.get(ts, ts)
            if mapped not in real_toolsets:
                real_toolsets.append(mapped)
        # Add bonus toolsets the real agent supports
        for ts in _BONUS_TOOLSETS:
            if ts not in real_toolsets:
                real_toolsets.append(ts)

        # Set up repo tool provider.
        # IMPORTANT: Tools must be registered BEFORE creating the agent because
        # the real hermes-agent calls get_tool_definitions() in __init__, which
        # checks the registry at that moment. If tools aren't registered yet,
        # validate_toolset() returns False and the toolset is silently skipped.
        self._repo_provider: Optional[RepoToolProvider] = None
        if repo_mode and github_repo_owner and github_repo_name:
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

        # Build ephemeral system prompt for repo context.
        # Always include today's date so web_search / news-style queries
        # aren't anchored to the model's training cutoff year.
        from datetime import datetime
        date_preamble = f"Today's date is {datetime.now().astimezone().strftime('%Y-%m-%d')}."
        repo_prompt = (
            self._repo_provider.build_repo_system_prompt() if self._repo_provider else ""
        )
        self._ephemeral_system_prompt = (
            f"{date_preamble}\n\n{repo_prompt}".strip() if repo_prompt else date_preamble
        )

        # Determine provider from base_url or hermes config
        provider = None
        if "openrouter.ai" in (base_url or ""):
            provider = "openrouter"
        elif "minimax" in (base_url or ""):
            provider = "minimax"
        elif "anthropic" in (base_url or ""):
            provider = "anthropic"
        elif "openai.com" in (base_url or ""):
            provider = "openai"
        elif "nousresearch" in (base_url or "") or "nous" in (base_url or ""):
            provider = "nous"
        # If base_url doesn't match known providers, check hermes config
        if not provider:
            try:
                import yaml
                cfg_path = os.path.expanduser("~/.hermes/config.yaml")
                with open(cfg_path) as f:
                    cfg = yaml.safe_load(f) or {}
                cfg_provider = (cfg.get("model", {}) or {}).get("provider", "")
                if cfg_provider:
                    provider = cfg_provider
            except Exception:
                pass

        # Create the real AIAgent
        key_preview = f"{api_key[:8]}...{api_key[-4:]}" if api_key and len(api_key) > 12 else repr(api_key)
        print(
            f"[hermes-adapter] Creating agent: base_url={base_url} "
            f"api_key={key_preview} provider={provider} model={model}",
            flush=True,
        )
        # Only pass parameters the real hermes-agent AIAgent actually accepts.
        # The real signature is: base_url, api_key, provider, api_mode, model,
        # max_iterations, enabled_toolsets, quiet_mode, platform, callbacks, etc.
        self._agent = RealAIAgent(
            base_url=base_url,
            api_key=api_key,
            provider=provider,
            model=model,
            max_iterations=max_iterations,
            enabled_toolsets=real_toolsets,
            platform="cloudchat",
            quiet_mode=True,
            # Callbacks — translated to CloudChat's format
            stream_delta_callback=self._on_stream_delta,
            tool_start_callback=self._on_tool_start,
            tool_complete_callback=self._on_tool_complete,
            reasoning_callback=self._on_reasoning,
            step_callback=self._on_step,
            status_callback=self._on_status,
        )

        print(
            f"[hermes-adapter] Real agent created. model={model} "
            f"toolsets={real_toolsets} repo_mode={repo_mode}",
            flush=True,
        )

    # --- Callback translators ---

    def _on_stream_delta(self, delta):
        """Real agent streams per-token. Forward directly to on_text."""
        if delta is not None and delta and self.on_text:
            self._streamed_text_chunks.append(str(delta))
            self.on_text(delta)

    def _on_tool_start(self, tc_id: str, name: str, args: dict):
        """Map real agent's tool_start_callback to CloudChat's on_tool_start."""
        if self.on_tool_start:
            self.on_tool_start(name, json.dumps(args) if args else "")

    def _on_tool_complete(self, tc_id: str, name: str, args: dict, result: str):
        """Map real agent's tool_complete_callback to CloudChat's on_tool_end."""
        if self.on_tool_end:
            self.on_tool_end(name, json.dumps(args) if args else "", (result or "")[:500])

    def _on_reasoning(self, text: str):
        """Forward reasoning deltas."""
        if text and self.on_reasoning:
            self.on_reasoning(text)

    def _on_step(self, api_call_count: int, prev_tools: list):
        """Map step_callback to on_thinking with iteration count."""
        if self.on_thinking:
            self.on_thinking(api_call_count)

    def _on_status(self, category: str, message: str):
        """Log status events for debugging."""
        if message:
            self._last_status_message = message
        print(f"[hermes-adapter] status/{category}: {message}", flush=True)

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
        try:
            result = self._agent.run_conversation(
                user_message=user_message,
                system_message=self._ephemeral_system_prompt,
                conversation_history=conversation_history or [],
            )
        finally:
            # Deregister repo tools after the conversation to clean up the registry
            if self._repo_provider:
                self._repo_provider._deregister_tools()

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
