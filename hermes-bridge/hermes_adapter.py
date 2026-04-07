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
import httpx
from typing import Optional, Callable

# ---------------------------------------------------------------------------
# Brain HTTP cache — imported from standalone module
# ---------------------------------------------------------------------------
from brain_cache import (
    _brain_circuit,
    _BRAIN_GATEWAY_URL,
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
from run_agent import AIAgent as RealAIAgent  # noqa: E402
from tools.registry import registry  # noqa: E402

print(f"[hermes-adapter] Loaded real Hermes agent from {_HERMES_AGENT_DIR}", flush=True)

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

    def __init__(
        self,
        github_pat: Optional[str],
        owner: Optional[str],
        name: Optional[str],
        file_tree: list[str],
        edit_intent: bool,
        on_server_tool_event: Optional[Callable],
    ):
        self.github_pat = github_pat
        self.owner = owner
        self.name = name
        self.edit_intent = edit_intent
        self.on_server_tool_event = on_server_tool_event
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

    # --- Tool handlers (signature: handler(args_dict, **kwargs) -> str) ---

    def _handle_list_user_repos(self, args: dict, **kwargs) -> str:
        if not self.github_pat:
            return "Error: No GitHub token configured."
        try:
            url = "https://api.github.com/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator,organization_member"
            headers = {
                "Authorization": f"Bearer {self.github_pat}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "Hermes-Agent",
            }
            with httpx.Client(timeout=15) as client:
                resp = client.get(url, headers=headers)
                if resp.status_code == 401:
                    return "Error: GitHub token is invalid or expired."
                resp.raise_for_status()
            repos = resp.json()
            if not isinstance(repos, list) or not repos:
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
        # Return cached content for files edited in this session
        if path in self.session_cache:
            content = self.session_cache[path]
            self._emit({"type": "repo_file_read", "path": path, "content": content})
            return _cap(content) or "(empty file)"

        # Check cross-session staged edits buffer first
        if self.owner and self.name:
            staged_key = f"repo-staged:{self.owner}/{self.name}:{path}"
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
        content = args.get("content", "")
        description = args.get("description", "")
        original = self.session_cache.get(path, "")
        self.session_cache[path] = content
        # Invalidate pooled brain cache and stage to pooled edit buffer
        if self.owner and self.name:
            cache_key = f"repo-file:{self.owner}/{self.name}:{path}"
            _brain_safe_delete(cache_key)
            # Publish staged edit so follow-up requests see the new content
            staged_key = f"repo-staged:{self.owner}/{self.name}:{path}"
            _brain_safe_set(staged_key, content, ttl=REPO_CACHE_TTL)
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
        content = args.get("content", "")
        description = args.get("description", "")
        self.session_cache[path] = content
        # Invalidate pooled brain cache and publish to staged buffer
        if self.owner and self.name:
            cache_key = f"repo-file:{self.owner}/{self.name}:{path}"
            _brain_safe_delete(cache_key)
            staged_key = f"repo-staged:{self.owner}/{self.name}:{path}"
            _brain_safe_set(staged_key, content, ttl=REPO_CACHE_TTL)
        self._emit({
            "type": "repo_file_create",
            "path": path,
            "content": content,
            "description": description,
        })
        return f"Staged new file {path}: {description or 'created'}"

    def _handle_delete_repo_file(self, args: dict, **kwargs) -> str:
        path = args.get("path", "")
        self.session_cache.pop(path, None)
        # Invalidate pooled brain cache and staged buffer
        if self.owner and self.name:
            _brain_safe_delete(f"repo-file:{self.owner}/{self.name}:{path}")
            _brain_safe_delete(f"repo-staged:{self.owner}/{self.name}:{path}")
        self._emit({"type": "repo_file_delete", "path": path})
        return f"Staged deletion of {path}"

    def _handle_batch_edit(self, args: dict, **kwargs) -> str:
        changes = args.get("changes", [])
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

        if not self.github_pat:
            return (
                f"You are working on the GitHub repository {repo_full}.\n"
                "GitHub API access is not available (no token configured).\n"
                "Answer based on available context (file tree, issue text, conversation history).\n"
                f"{file_tree_section}"
            )

        return (
            f"You are working on the GitHub repository {repo_full}.\n"
            "You have tools to read, edit, create, and delete files in this repo.\n\n"
            "RULES:\n"
            "- Do NOT ask the user clarifying questions. Explore the repo yourself.\n"
            "- If a tool call fails (404), try alternative paths before giving up.\n"
            "- For read-only requests, inspect files and answer directly.\n"
            "- Only enter the edit workflow when the user explicitly asks for changes.\n\n"
            f"{file_tree_section}"
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

        self.repo_mode = repo_mode
        self.repo_edit_intent = repo_edit_intent

        # Map CloudChat toolset names to real agent toolset names
        real_toolsets = []
        for ts in (enabled_toolsets or ["web", "browser"]):
            mapped = _TOOLSET_MAP.get(ts, ts)
            if mapped not in real_toolsets:
                real_toolsets.append(mapped)
        # Add bonus toolsets the real agent supports
        for ts in _BONUS_TOOLSETS:
            if ts not in real_toolsets:
                real_toolsets.append(ts)

        # Set up repo tool provider (registered when run_conversation is called)
        self._repo_provider: Optional[RepoToolProvider] = None
        if repo_mode and github_repo_owner and github_repo_name:
            self._repo_provider = RepoToolProvider(
                github_pat=github_pat,
                owner=github_repo_owner,
                name=github_repo_name,
                file_tree=repo_file_tree or [],
                edit_intent=repo_edit_intent,
                on_server_tool_event=on_server_tool_event,
            )
            real_toolsets.append(_REPO_TOOLSET)

        # Build ephemeral system prompt for repo context
        self._ephemeral_system_prompt = None
        if self._repo_provider:
            self._ephemeral_system_prompt = self._repo_provider.build_repo_system_prompt()

        # Determine provider from base_url
        provider = None
        if "openrouter.ai" in (base_url or ""):
            provider = "openrouter"
        elif "minimax" in (base_url or ""):
            provider = "minimax"
        elif "anthropic" in (base_url or ""):
            provider = "anthropic"
        elif "openai.com" in (base_url or ""):
            provider = "openai"

        # Create the real AIAgent
        key_preview = f"{api_key[:8]}...{api_key[-4:]}" if api_key and len(api_key) > 12 else repr(api_key)
        print(
            f"[hermes-adapter] Creating agent: base_url={base_url} "
            f"api_key={key_preview} provider={provider} model={model}",
            flush=True,
        )
        self._agent = RealAIAgent(
            base_url=base_url,
            api_key=api_key,
            provider=provider,
            model=model,
            max_iterations=max_iterations,
            enabled_toolsets=real_toolsets,
            platform="cloudchat",
            quiet_mode=True,
            skip_context_files=False,
            skip_memory=False,
            persist_session=False,
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
        """
        if self._repo_provider:
            # Register repo tools for this request, deregister after
            with self._repo_provider:
                result = self._agent.run_conversation(
                    user_message=user_message,
                    system_message=self._ephemeral_system_prompt,
                    conversation_history=conversation_history or [],
                )
        else:
            result = self._agent.run_conversation(
                user_message=user_message,
                system_message=self._ephemeral_system_prompt,
                conversation_history=conversation_history or [],
            )

        # Log completion stats
        if isinstance(result, dict):
            api_calls = result.get("api_calls", 0)
            completed = result.get("completed", False)
            cost = result.get("estimated_cost_usd")
            print(
                f"[hermes-adapter] Conversation done. "
                f"api_calls={api_calls} completed={completed} "
                f"cost=${cost:.4f}" if cost else f"[hermes-adapter] Conversation done. api_calls={api_calls}",
                flush=True,
            )
