"""
GitHub repo tools shared by both agent paths.

One implementation of the repo tool schemas and handlers (list_user_repos,
read_repo_file, git_log, git_show, git_diff, edit/create/delete_repo_file,
batch_edit_repo_files), used by:

* ``hermes_adapter.RepoToolProvider`` — registers the handlers into the real
  hermes-agent tool registry, and
* ``run_agent.AIAgent`` — the legacy bridge agent loop, which dispatches the
  same handlers from ``_execute_repo_tool``.

Both hosts mix in :class:`RepoToolsMixin` and supply a handful of attributes
(``github_pat``, ``repo_owner``, ``repo_name``, ``workspace_id``,
``session_cache``) plus optional hooks for events, inline tool markers and the
brain cache.

Edits are never written to GitHub: edit/create/delete are *staged* — kept in
the per-request ``session_cache``, published to a workspace-scoped brain
buffer so later requests in the same conversation read the staged version,
and emitted as ``repo_file_*`` server tool events for the UI to review.
"""

from __future__ import annotations

import base64
import os
import time
from typing import Optional
from urllib.parse import quote

import httpx

from brain_cache import brain_safe_delete, brain_safe_get, brain_safe_set


def repo_cache_ttl() -> int:
    """TTL (seconds) for pooled repo-file and staged-edit brain entries."""
    return int(os.environ.get("HERMES_REPO_CACHE_TTL", "300"))


def repo_tree_ttl() -> int:
    """TTL (seconds) for the pooled repo file-tree brain entry."""
    return int(os.environ.get("HERMES_REPO_TREE_TTL", "600"))


REPO_CACHE_TTL = repo_cache_ttl()
REPO_TREE_TTL = repo_tree_ttl()

# Process-wide cache hit/miss counters. Mutated in place only, so modules that
# re-export it (hermes_adapter._cache_stats) keep seeing the same dict.
CACHE_STATS = {"repo_file_hits": 0, "repo_file_misses": 0, "repo_tree_hits": 0, "repo_tree_misses": 0}

MAX_TOOL_RESPONSE = 25_000

GITHUB_API = "https://api.github.com"

# ---------------------------------------------------------------------------
# Schemas (OpenAI function-calling format, sans the {"type": "function"} wrapper)
# ---------------------------------------------------------------------------

REPO_TOOL_SCHEMAS: dict[str, dict] = {
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
    "git_log": {
        "name": "git_log",
        "description": (
            "View the repository's git commit history (read-only). Use this to understand "
            "recent changes, who changed what, and when. Optionally filter to commits that "
            "touched a specific file or directory."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Optional file or directory path to filter history to commits that touched it.",
                },
                "ref": {
                    "type": "string",
                    "description": "Optional branch, tag, or commit SHA to start from. Defaults to the repository's default branch.",
                },
                "max_count": {
                    "type": "integer",
                    "description": "How many commits to return (default 15, max 50).",
                },
            },
        },
    },
    "git_show": {
        "name": "git_show",
        "description": (
            "Show a single commit (read-only): its message, author, date, and the diff/patch "
            "for each changed file. Use a SHA from git_log."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "sha": {
                    "type": "string",
                    "description": "The commit SHA (or ref) to show.",
                },
            },
            "required": ["sha"],
        },
    },
    "git_diff": {
        "name": "git_diff",
        "description": (
            "Show the diff between two git refs (read-only), e.g. two branches, tags, or commit "
            "SHAs. Returns the changed-files summary and per-file patches."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "base": {
                    "type": "string",
                    "description": "The base ref (branch, tag, or SHA) to compare from.",
                },
                "head": {
                    "type": "string",
                    "description": "The head ref (branch, tag, or SHA) to compare to.",
                },
            },
            "required": ["base", "head"],
        },
    },
}

# Catalog order: read-only tools first, then the staged-edit tools.
REPO_TOOL_ORDER: tuple[str, ...] = (
    "list_user_repos",
    "read_repo_file",
    "git_log",
    "git_show",
    "git_diff",
    "edit_repo_file",
    "create_repo_file",
    "delete_repo_file",
    "batch_edit_repo_files",
)

REPO_TOOL_NAMES = set(REPO_TOOL_ORDER)
# Read-only repo tools — always safe to expose, even when edit intent is off.
REPO_READONLY_TOOL_NAMES = {"read_repo_file", "list_user_repos", "git_log", "git_show", "git_diff"}
REPO_EDIT_TOOL_NAMES = {"batch_edit_repo_files", "edit_repo_file", "create_repo_file", "delete_repo_file"}


def openai_tool_definitions() -> list[dict]:
    """Repo tool schemas wrapped as OpenAI ``{"type": "function"}`` tool defs."""
    return [{"type": "function", "function": REPO_TOOL_SCHEMAS[name]} for name in REPO_TOOL_ORDER]


# ---------------------------------------------------------------------------
# Brain cache keys and output helpers
# ---------------------------------------------------------------------------

def shared_repo_file_key(owner: str, repo: str, path: str) -> str:
    """Pooled (cross-conversation) cache of a file's GitHub contents."""
    return f"repo-file:{owner}/{repo}:{path}"


def shared_repo_tree_key(owner: str, repo: str) -> str:
    """Pooled (cross-conversation) cache of a repo's file tree."""
    return f"repo-tree:{owner}/{repo}"


def workspace_staged_key(workspace_id: str, owner: str, repo: str, path: str) -> str:
    """Workspace-scoped staged-edit buffer for one file."""
    return f"repo-staged:{workspace_id}:{owner}/{repo}:{path}"


def cap(text: str) -> str:
    """Cap tool output at MAX_TOOL_RESPONSE chars, keeping head and tail halves."""
    if len(text) <= MAX_TOOL_RESPONSE:
        return text
    half = MAX_TOOL_RESPONSE // 2
    return text[:half] + f"\n\n... ({len(text) - MAX_TOOL_RESPONSE} chars truncated) ...\n\n" + text[-half:]


def parse_next_link(link_header: str) -> str | None:
    """Parse GitHub's Link header to find the next page URL."""
    if not link_header:
        return None
    for part in link_header.split(","):
        if 'rel="next"' in part:
            return part.split(";")[0].strip().strip("<>")
    return None


def format_commit_patch(files: list, per_file_cap: int = 4000) -> str:
    """Render GitHub commit/compare ``files`` as a readable unified diff."""
    chunks = []
    for f in files:
        if not isinstance(f, dict):
            continue
        filename = f.get("filename", "?")
        status = f.get("status", "modified")
        add = f.get("additions", 0)
        dele = f.get("deletions", 0)
        header = f"diff --- {filename} ({status}, +{add} -{dele})"
        patch = f.get("patch")
        if patch:
            if len(patch) > per_file_cap:
                patch = patch[:per_file_cap] + f"\n[... patch truncated, {len(patch) - per_file_cap} more chars ...]"
            chunks.append(f"{header}\n{patch}")
        else:
            # Binary files and very large diffs have no patch from the API.
            chunks.append(f"{header}\n(no textual diff available — binary or too large)")
    return "\n\n".join(chunks) if chunks else "(no file changes)"


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

class RepoToolsMixin:
    """GitHub repo tool handlers. Handler signature: ``handler(args, **kwargs) -> str``.

    The host class must provide ``github_pat``, ``repo_owner``, ``repo_name``,
    ``workspace_id`` (str) and ``session_cache`` (dict[str, str]). It may
    override the ``_emit_repo_event``, ``_emit_tool_marker`` and ``_cache_*``
    hooks.
    """

    github_pat: Optional[str]
    workspace_id: str
    session_cache: dict[str, str]

    _parse_next_link = staticmethod(parse_next_link)
    _format_commit_patch = staticmethod(format_commit_patch)

    # --- host hooks -------------------------------------------------------

    @property
    def repo_owner(self) -> Optional[str]:  # pragma: no cover - overridden by hosts
        raise NotImplementedError

    @property
    def repo_name(self) -> Optional[str]:  # pragma: no cover - overridden by hosts
        raise NotImplementedError

    def _emit_repo_event(self, event: dict) -> None:
        """Forward a ``repo_file_*`` server tool event to the UI."""

    def _emit_tool_marker(self, tool_name: str, detail: str = "") -> None:
        """Announce a tool call inline in the content stream (optional)."""

    def _cache_get(self, key: str) -> Optional[str]:
        return brain_safe_get(key)

    def _cache_set(self, key: str, value: str, ttl: int) -> bool:
        return brain_safe_set(key, value, ttl=ttl)

    def _cache_delete(self, key: str) -> bool:
        return brain_safe_delete(key)

    def _repo_cache_ttl(self) -> int:
        return REPO_CACHE_TTL

    def _should_pool_file(self, content: str) -> bool:
        """Whether a freshly read file may go into the cross-conversation pool.

        Hosts that post-process ``_read_github_file`` output (e.g. truncate it)
        return False for altered content so the pool only holds real files.
        """
        return True

    # --- dispatch ---------------------------------------------------------

    def repo_tool_handlers(self) -> dict:
        return {
            "list_user_repos": self._handle_list_user_repos,
            "read_repo_file": self._handle_read_repo_file,
            "git_log": self._handle_git_log,
            "git_show": self._handle_git_show,
            "git_diff": self._handle_git_diff,
            "edit_repo_file": self._handle_edit_repo_file,
            "create_repo_file": self._handle_create_repo_file,
            "delete_repo_file": self._handle_delete_repo_file,
            "batch_edit_repo_files": self._handle_batch_edit,
        }

    def dispatch_repo_tool(self, tool_name: str, args: dict) -> str:
        handler = self.repo_tool_handlers().get(tool_name)
        if handler is None:
            return f"Unknown repo tool: {tool_name}"
        return handler(args if isinstance(args, dict) else {})

    # --- list_user_repos --------------------------------------------------

    def _list_user_repos(self) -> str:
        """List every repo the token can see (follows pagination, retries 429)."""
        if not self.github_pat:
            return "Error: No GitHub token configured."
        try:
            url = f"{GITHUB_API}/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member"
            headers = {
                "Authorization": f"Bearer {self.github_pat}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "Hermes-Agent",
            }
            all_repos = []
            rate_limit_retries = 0
            with httpx.Client(timeout=15) as client:
                while url:
                    resp = client.get(url, headers=headers)
                    if resp.status_code == 401:
                        return "Error: GitHub token is invalid or expired."
                    if resp.status_code == 429:
                        rate_limit_retries += 1
                        if rate_limit_retries > 3:
                            raise RuntimeError(
                                "GitHub API rate limited (429) after 3 retries — try again later."
                            )
                        raw_retry_after = resp.headers.get("Retry-After", "5")
                        try:
                            retry_after = min(max(int(raw_retry_after), 1), 30)
                        except ValueError:
                            retry_after = 5
                        time.sleep(retry_after)
                        continue
                    resp.raise_for_status()
                    page = resp.json()
                    if isinstance(page, list):
                        all_repos.extend(page)
                    url = self._parse_next_link(resp.headers.get("Link", ""))
            if not all_repos:
                return "No repositories found."
            lines = []
            for repo in all_repos:
                full_name = repo.get("full_name", "?")
                desc = repo.get("description") or ""
                priv = " (private)" if repo.get("private") else ""
                lines.append(f"- {full_name}{priv}: {desc[:80]}" if desc else f"- {full_name}{priv}")
            return f"Found {len(all_repos)} accessible repositories:\n" + "\n".join(lines)
        except Exception as e:  # noqa: BLE001 - tool handler: the error is returned to the model as the result
            return f"Error listing repositories: {e}"

    def _handle_list_user_repos(self, args: dict, **kwargs) -> str:
        return self._list_user_repos()

    # --- read_repo_file ---------------------------------------------------

    def _handle_read_repo_file(self, args: dict, **kwargs) -> str:
        path = args.get("path", "")
        self._emit_tool_marker("read_repo_file", path)
        owner, name = self.repo_owner, self.repo_name
        # Files edited in this session: return the staged content so the model
        # never re-applies a change on top of the pre-edit GitHub version.
        if path in self.session_cache:
            content = self.session_cache[path]
            self._emit_repo_event({"type": "repo_file_read", "path": path, "content": content})
            return cap(content) or "(empty file)"

        # Cross-session staged edits buffer (workspace-scoped).
        if owner and name:
            staged = self._cache_get(workspace_staged_key(self.workspace_id, owner, name, path))
            if staged is not None:
                self.session_cache[path] = staged
                self._emit_repo_event({"type": "repo_file_read", "path": path, "content": staged, "staged": True})
                return cap(staged) or "(empty file)"

        # Pooled brain cache before hitting the GitHub API.
        if owner and name:
            cached = self._cache_get(shared_repo_file_key(owner, name, path))
            if cached is not None:
                CACHE_STATS["repo_file_hits"] += 1
                self.session_cache[path] = cached
                self._emit_repo_event({"type": "repo_file_read", "path": path, "content": cached, "cached": True})
                return cap(cached) or "(empty file)"
            CACHE_STATS["repo_file_misses"] += 1

        result = self._read_github_file(path)
        if not result.startswith("Error"):
            self.session_cache[path] = result
            if owner and name and self._should_pool_file(result):
                self._cache_set(shared_repo_file_key(owner, name, path), result, self._repo_cache_ttl())
            self._emit_repo_event({"type": "repo_file_read", "path": path, "content": result})
        return cap(result) or "(empty file)"

    def _read_github_file(self, path: str) -> str:
        """Read a file (or list a directory) via the GitHub contents API."""
        owner, name = self.repo_owner, self.repo_name
        if not self.github_pat or not owner or not name:
            return "Error: GitHub access not configured."
        try:
            encoded_owner = quote(owner, safe="")
            encoded_repo = quote(name, safe="")
            encoded_path = quote(path, safe="/")
            url = f"{GITHUB_API}/repos/{encoded_owner}/{encoded_repo}/contents/{encoded_path}"
            headers = {
                "Authorization": f"Bearer {self.github_pat}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "Hermes-Agent",
            }
            with httpx.Client(timeout=15) as client:
                resp = client.get(url, headers=headers)
                if resp.status_code == 404:
                    # Distinguish file-not-found from repo-level access issues
                    # by probing the repo root.
                    if path and path != "/":
                        root_url = f"{GITHUB_API}/repos/{encoded_owner}/{encoded_repo}/contents/"
                        root_resp = client.get(root_url, headers=headers)
                        if root_resp.status_code == 404:
                            return (
                                f"Error: Repository {owner}/{name} was not found (404). "
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
            content = data.get("content", "")
            # The contents API always base64-encodes file bodies; treat a
            # missing ``encoding`` the same way (``"none"`` = too large).
            if data.get("encoding", "base64") == "base64":
                return base64.b64decode(content).decode("utf-8", errors="replace")
            return content
        except Exception as e:  # noqa: BLE001 - tool handler: the error is returned to the model as the result
            return f"Error reading '{path}': {e}"

    # --- staged edits -----------------------------------------------------

    def _stage(self, path: str, content: str) -> None:
        """Invalidate the pooled copy and publish ``content`` to the staged buffer."""
        owner, name = self.repo_owner, self.repo_name
        if owner and name:
            self._cache_delete(shared_repo_file_key(owner, name, path))
            self._cache_set(
                workspace_staged_key(self.workspace_id, owner, name, path),
                content,
                self._repo_cache_ttl(),
            )

    def _handle_edit_repo_file(self, args: dict, **kwargs) -> str:
        path = args.get("path", "")
        self._emit_tool_marker("edit_repo_file", path)
        content = args.get("content", "")
        description = args.get("description", "")
        original = self.session_cache.get(path, "")
        self.session_cache[path] = content
        self._stage(path, content)
        self._emit_repo_event({
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
        self._stage(path, content)
        self._emit_repo_event({
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
        owner, name = self.repo_owner, self.repo_name
        if owner and name:
            self._cache_delete(shared_repo_file_key(owner, name, path))
            self._cache_delete(workspace_staged_key(self.workspace_id, owner, name, path))
        self._emit_repo_event({"type": "repo_file_delete", "path": path})
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
            if not isinstance(change, dict):
                continue
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

    # --- git history (read-only) -----------------------------------------

    def _github_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.github_pat}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Hermes-Agent",
        }

    def _github_creds_missing(self) -> Optional[str]:
        missing = []
        if not self.github_pat:
            missing.append("GitHub PAT")
        if not self.repo_owner:
            missing.append("repo owner")
        if not self.repo_name:
            missing.append("repo name")
        if missing:
            return (
                f"Error: Cannot access git history — missing GitHub credentials "
                f"({', '.join(missing)}). The user needs to configure a GitHub "
                f"Personal Access Token in Settings."
            )
        return None

    def _github_get(self, sub_path: str, params: Optional[dict] = None):
        """GET a repo-scoped REST endpoint. Returns ``(data, None)`` or ``(None, error_str)``."""
        owner, name = self.repo_owner, self.repo_name
        encoded_owner = quote(owner or "", safe="")
        encoded_repo = quote(name or "", safe="")
        url = f"{GITHUB_API}/repos/{encoded_owner}/{encoded_repo}/{sub_path}"
        try:
            with httpx.Client(timeout=15) as client:
                resp = client.get(url, headers=self._github_headers(), params=params or {})
            if resp.status_code == 401:
                return None, "Error: GitHub token is invalid or expired. The user should update their token in Settings."
            if resp.status_code == 403:
                return None, (
                    f"Error: Access denied (HTTP 403) for {owner}/{name}. "
                    f"The GitHub token may lack the required permissions (needs 'repo' scope for private repositories)."
                )
            if resp.status_code == 404:
                return None, (
                    f"Error: Not found (HTTP 404) for {owner}/{name}. "
                    f"The repo, branch, or commit ref may not exist or the token may lack access. "
                    f"Call list_user_repos to see accessible repositories."
                )
            resp.raise_for_status()
            return resp.json(), None
        except Exception as e:  # noqa: BLE001 - reported to the caller as the error half of the tuple
            return None, f"Error reaching the GitHub API: {e}"

    def _handle_git_log(self, args: dict, **kwargs) -> str:
        path = args.get("path", "") or ""
        ref = args.get("ref", "") or ""
        max_count = args.get("max_count", 15)
        self._emit_tool_marker("git_log", path or ref or "recent commits")

        creds_err = self._github_creds_missing()
        if creds_err:
            return creds_err
        try:
            per_page = max(1, min(int(max_count or 15), 50))
        except (TypeError, ValueError):
            per_page = 15
        params: dict = {"per_page": per_page}
        if path:
            params["path"] = path
        if ref:
            params["sha"] = ref
        data, err = self._github_get("commits", params)
        if err:
            return err
        scope = f" touching '{path}'" if path else ""
        if not isinstance(data, list) or not data:
            return f"No commits found{scope}."
        lines = []
        for c in data:
            if not isinstance(c, dict):
                continue
            sha = (c.get("sha") or "")[:8]
            commit = c.get("commit") or {}
            author = commit.get("author") or {}
            name = author.get("name", "?")
            date = (author.get("date", "") or "")[:10]
            message = (commit.get("message", "") or "").split("\n", 1)[0]
            lines.append(f"{sha}  {date}  {name}: {message}")
        ref_note = f" from '{ref}'" if ref else ""
        return cap(f"Last {len(lines)} commit(s){scope}{ref_note}:\n" + "\n".join(lines))

    def _handle_git_show(self, args: dict, **kwargs) -> str:
        sha = args.get("sha", "") or ""
        self._emit_tool_marker("git_show", sha)

        creds_err = self._github_creds_missing()
        if creds_err:
            return creds_err
        if not sha:
            return "Error: 'sha' is required. Use a SHA from git_log."
        data, err = self._github_get(f"commits/{quote(sha, safe='')}")
        if err:
            return err
        if not isinstance(data, dict):
            return f"Error: Unexpected response for commit '{sha}'."
        commit = data.get("commit") or {}
        author = commit.get("author") or {}
        files = data.get("files") if isinstance(data.get("files"), list) else []
        stats = data.get("stats") or {}
        header = (
            f"commit {data.get('sha', sha)}\n"
            f"Author: {author.get('name', '?')} <{author.get('email', '')}>\n"
            f"Date:   {author.get('date', '')}\n"
            f"Files:  {len(files)} changed, +{stats.get('additions', 0)} -{stats.get('deletions', 0)}\n\n"
            f"{commit.get('message', '')}\n"
        )
        return cap(header + "\n" + self._format_commit_patch(files))

    def _handle_git_diff(self, args: dict, **kwargs) -> str:
        base = args.get("base", "") or ""
        head = args.get("head", "") or ""
        self._emit_tool_marker("git_diff", f"{base}...{head}" if base and head else "")

        creds_err = self._github_creds_missing()
        if creds_err:
            return creds_err
        if not base or not head:
            return "Error: both 'base' and 'head' refs are required."
        # GitHub's compare basehead uses a triple-dot range.
        basehead = f"{quote(base, safe='')}...{quote(head, safe='')}"
        data, err = self._github_get(f"compare/{basehead}")
        if err:
            return err
        if not isinstance(data, dict):
            return f"Error: Unexpected response comparing '{base}...{head}'."
        files = data.get("files") if isinstance(data.get("files"), list) else []
        header = (
            f"Comparing {base}...{head}\n"
            f"Status: {data.get('status', '?')} (ahead {data.get('ahead_by', 0)}, "
            f"behind {data.get('behind_by', 0)}), {data.get('total_commits', 0)} commit(s), "
            f"{len(files)} file(s) changed\n"
        )
        return cap(header + "\n" + self._format_commit_patch(files))
