"""
AIAgent: Agentic loop over OpenRouter with tool calling.

Sends messages to a Nous Hermes model, handles tool calls (web search,
browse URL, etc.), and streams results back via callbacks.
"""

import json
import os
import shlex
import httpx
import re
from typing import Optional, Callable
from urllib.parse import quote, quote_plus


def _read_positive_int_env(name: str, fallback: int) -> int:
    raw_value = os.environ.get(name)
    if not raw_value:
        return fallback
    try:
        parsed_value = int(raw_value)
    except ValueError:
        return fallback
    return parsed_value if parsed_value > 0 else fallback


PROVIDER_TIMEOUT_SECONDS = _read_positive_int_env(
    "HERMES_PROVIDER_TIMEOUT_SECONDS", 5400
)
RUN_COMMAND_TIMEOUT_SECONDS = _read_positive_int_env(
    "HERMES_RUN_COMMAND_TIMEOUT_SECONDS", 5400
)
EXECUTE_PYTHON_TIMEOUT_SECONDS = _read_positive_int_env(
    "HERMES_EXECUTE_PYTHON_TIMEOUT_SECONDS", RUN_COMMAND_TIMEOUT_SECONDS
)

# Maximum characters allowed in any single tool response.
# Matches Claude Code's ~25K token cap. Prevents context blowout on large outputs.
MAX_TOOL_RESPONSE_CHARS = _read_positive_int_env(
    "HERMES_MAX_TOOL_RESPONSE_CHARS", 25000
)

KNOWN_UNSUPPORTED_TOOL_MODELS = {
    "nousresearch/hermes-3-llama-3.1-405b:free",
}

SUGGESTED_TOOL_MODELS = (
    "google/gemini-3.1-flash-lite-preview-20260303",
    "deepseek/deepseek-v3.2-20251201",
    "meta-llama/llama-4-maverick",
    "openai/gpt-4.1-mini",
    "google/gemini-2.5-flash",
)

# Approximate char threshold before context compaction kicks in.
# ~4 chars/token, so 25K tokens ≈ 100K chars. Compact when we pass 60% of that.
CONTEXT_COMPACTION_CHAR_THRESHOLD = _read_positive_int_env(
    "HERMES_CONTEXT_COMPACTION_THRESHOLD", 60000
)

REPO_MODE_BLOCKED_TOOLSETS = {
    "terminal",
    "files",
    "code_execution",
}

REPO_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "read_repo_file",
            "description": "Read the contents of a file from the repository.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The file path to read",
                    }
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_repo_file",
            "description": "Edit an existing file in the repository. Call read_repo_file first to see current contents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The file path to edit",
                    },
                    "content": {
                        "type": "string",
                        "description": "The new full file content",
                    },
                    "description": {
                        "type": "string",
                        "description": "What was changed",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_repo_file",
            "description": "Create a new file in the repository.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The file path to create",
                    },
                    "content": {
                        "type": "string",
                        "description": "The file content",
                    },
                    "description": {
                        "type": "string",
                        "description": "What this file is for",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_repo_file",
            "description": "Delete a file from the repository.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The file path to delete",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Why this file is being deleted",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "batch_edit_repo_files",
            "description": "Edit multiple files at once. Preferred over individual edit_repo_file calls when changing multiple files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "changes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string"},
                                "action": {"type": "string", "enum": ["create", "edit", "delete"]},
                                "content": {"type": "string"},
                                "description": {"type": "string"},
                            },
                            "required": ["path", "action", "content"],
                        },
                        "description": "List of file changes to apply",
                    },
                },
                "required": ["changes"],
            },
        },
    },
]

REPO_TOOL_NAMES = {t["function"]["name"] for t in REPO_TOOL_DEFINITIONS}
REPO_EDIT_TOOL_NAMES = {
    "batch_edit_repo_files",
    "edit_repo_file",
    "create_repo_file",
    "delete_repo_file",
}
REPO_CONTINUATION_RETRY_LIMIT = 2
REPO_TOOL_ENFORCEMENT_RETRY_LIMIT = 2
FIX_INTENT_CONTINUATION_LIMIT = 2
REPO_EDIT_INTENT_MARKERS = (
    "apply the change",
    "apply the changes",
    "apply changes",
    "make the change",
    "make the changes",
    "implement the change",
    "implement the changes",
    "update the file",
    "update the files",
    "edit the file",
    "edit the files",
    "modify the file",
    "modify the files",
    "batch_edit_repo_files",
    "edit_repo_file",
    "create_repo_file",
    "delete_repo_file",
)

TOOL_DEFINITIONS = {
    "web": [
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web for information. Returns a list of results with titles, URLs, and snippets.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query",
                        }
                    },
                    "required": ["query"],
                },
            },
        }
    ],
    "browser": [
        {
            "type": "function",
            "function": {
                "name": "browse_url",
                "description": "Fetch a webpage and return its text content. Use this to read articles, documentation, or any web page.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "The URL to fetch",
                        }
                    },
                    "required": ["url"],
                },
            },
        }
    ],
    "terminal": [
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Execute a shell command and return stdout/stderr. Use with caution.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The shell command to execute",
                        }
                    },
                    "required": ["command"],
                },
            },
        }
    ],
    "files": [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the contents of a file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path to read",
                        }
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write content to a file. Creates the file if it doesn't exist.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path to write to",
                        },
                        "content": {
                            "type": "string",
                            "description": "The content to write",
                        },
                    },
                    "required": ["path", "content"],
                },
            },
        },
    ],
    "code_execution": [
        {
            "type": "function",
            "function": {
                "name": "execute_python",
                "description": "Execute Python code and return the output.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "Python code to execute",
                        }
                    },
                    "required": ["code"],
                },
            },
        }
    ],
}

# Some models (e.g. Gemini via OpenRouter) return PascalCase or variant tool
# names.  Map known variants back to the canonical snake_case name.
_TOOL_NAME_ALIASES: dict[str, str] = {}


def _build_tool_aliases():
    """Build aliases from CamelCase/PascalCase variants of every known tool name."""
    all_names: list[str] = list(REPO_TOOL_NAMES)
    for toolset in TOOL_DEFINITIONS.values():
        for t in toolset:
            all_names.append(t["function"]["name"])
    for name in all_names:
        # PascalCase variant: batch_edit_repo_files -> BatchEditRepoFiles
        pascal = "".join(part.capitalize() for part in name.split("_"))
        _TOOL_NAME_ALIASES[pascal.lower()] = name
        _TOOL_NAME_ALIASES[pascal] = name
        # Also handle with trailing "s" or "Changes" some models add
        _TOOL_NAME_ALIASES[(pascal + "Changes").lower()] = name
        _TOOL_NAME_ALIASES[pascal + "Changes"] = name
        # lowercase concatenated
        _TOOL_NAME_ALIASES[name.replace("_", "").lower()] = name


_build_tool_aliases()


def _normalize_tool_name(name: str) -> str:
    """Resolve a tool name to its canonical snake_case form."""
    if name in REPO_TOOL_NAMES:
        return name
    # Check direct match in all known tool names
    all_known = set()
    for toolset in TOOL_DEFINITIONS.values():
        for t in toolset:
            all_known.add(t["function"]["name"])
    if name in all_known:
        return name
    # Check aliases
    return _TOOL_NAME_ALIASES.get(name, _TOOL_NAME_ALIASES.get(name.lower(), name))


def _get_tool_call_names(message: dict) -> list[str]:
    names: list[str] = []
    for tool_call in message.get("tool_calls") or []:
        function = tool_call.get("function") or {}
        raw_name = function.get("name")
        if not isinstance(raw_name, str) or not raw_name:
            continue
        names.append(_normalize_tool_name(raw_name))
    return names


def _messages_include_tool_call(messages: list[dict], tool_names: set[str]) -> bool:
    for message in messages:
        if not isinstance(message, dict):
            continue
        if any(name in tool_names for name in _get_tool_call_names(message)):
            return True
    return False


def _get_recent_tool_call_names(messages: list[dict]) -> list[str]:
    """Return tool names from the most recent assistant tool-call turn.

    When the provider stops after a read-only acknowledgement, the trailing
    messages are the tool results from the latest turn. Restrict continuation
    checks to that final tool phase instead of the full conversation so an
    earlier edit does not suppress recovery for a later read-only stall.
    """
    trailing_tool_messages: list[dict] = []

    for message in reversed(messages):
        if not isinstance(message, dict):
            break

        role = message.get("role")
        if role == "tool":
            trailing_tool_messages.append(message)
            continue

        if role == "assistant" or _get_tool_call_names(message):
            if trailing_tool_messages:
                return _get_tool_call_names(message)
            break

        break

    return []


_FIX_INTENT_PATTERN = re.compile(
    r"\b(fix|apply|implement|update|change|modify|edit|resolve|patch|correct)\b",
    re.IGNORECASE,
)


def _latest_user_message_has_fix_intent(messages: list[dict]) -> bool:
    """Check if the most recent user message contains fix/edit intent verbs."""
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        if message.get("role") == "user":
            content = message.get("content", "")
            if isinstance(content, list):
                # Handle multi-part content (e.g. [{type: "text", text: "..."}])
                content = " ".join(
                    part.get("text", "") for part in content if isinstance(part, dict)
                )
            if isinstance(content, str) and _FIX_INTENT_PATTERN.search(content):
                return True
            return False
    return False


def _recent_repo_turn_stalled_on_read(messages: list[dict]) -> bool:
    recent_tool_names = _get_recent_tool_call_names(messages)
    return (
        "read_repo_file" in recent_tool_names and
        recent_tool_names[-1:] == ["read_repo_file"]
    )


def _looks_like_repo_edit_ack(content: Optional[str]) -> bool:
    if not content:
        return False

    normalized = content.strip().lower()
    if not normalized or len(normalized) > 1600:
        return False

    mentions_future_work = bool(
        re.search(r"\b(i['']ll|i will|let me|next[, ]+i['']ll|now[, ]+i['']ll)\b", normalized)
    )
    if not mentions_future_work:
        return False

    return any(marker in normalized for marker in REPO_EDIT_INTENT_MARKERS)


def _strip_html(html: str) -> str:
    text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _extract_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        text = response.text.strip()
        return text or response.reason_phrase

    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            metadata = error.get("metadata")
            if isinstance(metadata, dict):
                raw = metadata.get("raw")
                if isinstance(raw, str) and raw.strip():
                    return raw
            message = error.get("message")
            if isinstance(message, str) and message.strip():
                return message
        elif isinstance(error, str) and error.strip():
            return error

    return json.dumps(payload)


def _cap_tool_response(result: str) -> str:
    """Cap tool output to MAX_TOOL_RESPONSE_CHARS, preserving head and tail."""
    if len(result) <= MAX_TOOL_RESPONSE_CHARS:
        return result
    # Keep first 80% and last 20% of the budget to preserve both context and recent output
    head_budget = int(MAX_TOOL_RESPONSE_CHARS * 0.8)
    tail_budget = MAX_TOOL_RESPONSE_CHARS - head_budget - 200  # leave room for notice
    omitted = len(result) - head_budget - tail_budget
    return (
        result[:head_budget]
        + f"\n\n[... {omitted:,} characters omitted — output truncated to {MAX_TOOL_RESPONSE_CHARS:,} chars ...]\n\n"
        + result[-tail_budget:]
    )


def _execute_tool(name: str, arguments: dict) -> str:
    """Execute a tool and return its result as a string."""
    try:
        if name == "web_search":
            return _cap_tool_response(_tool_web_search(arguments["query"]))
        elif name == "browse_url":
            return _cap_tool_response(_tool_browse_url(arguments["url"]))
        elif name == "run_command":
            return _cap_tool_response(_tool_run_command(arguments["command"]))
        elif name == "read_file":
            return _cap_tool_response(_tool_read_file(arguments["path"]))
        elif name == "write_file":
            return _cap_tool_response(_tool_write_file(arguments["path"], arguments["content"]))
        elif name == "execute_python":
            return _cap_tool_response(_tool_execute_python(arguments["code"]))
        else:
            return f"Unknown tool: {name}"
    except Exception as e:
        return f"Error executing {name}: {str(e)}"


def _tool_web_search(query: str) -> str:
    url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
    headers = {"User-Agent": "Mozilla/5.0 (compatible; HermesAgent/1.0)"}
    with httpx.Client(timeout=15, follow_redirects=True) as client:
        resp = client.get(url, headers=headers)
        resp.raise_for_status()

    results = []
    # Parse DuckDuckGo HTML results
    blocks = re.findall(
        r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>.*?'
        r'class="result__snippet"[^>]*>(.*?)</(?:a|td|div)',
        resp.text,
        re.DOTALL,
    )
    for href, title, snippet in blocks[:8]:
        # DuckDuckGo wraps URLs in a redirect; extract the actual URL
        real_url = href
        ud_match = re.search(r"uddg=([^&]+)", href)
        if ud_match:
            from urllib.parse import unquote
            real_url = unquote(ud_match.group(1))
        results.append({
            "title": _strip_html(title).strip(),
            "url": real_url,
            "snippet": _strip_html(snippet).strip(),
        })

    if not results:
        return "No search results found."
    return json.dumps(results, indent=2)


def _tool_browse_url(url: str) -> str:
    headers = {"User-Agent": "Mozilla/5.0 (compatible; HermesAgent/1.0)"}
    try:
        with httpx.Client(timeout=20, follow_redirects=True) as client:
            resp = client.get(url, headers=headers)
            resp.raise_for_status()
    except httpx.TimeoutException:
        return (
            f"Error: Request to '{url}' timed out after 20 seconds. "
            "Try a different URL or simplify the request."
        )
    except httpx.HTTPStatusError as exc:
        return (
            f"Error: HTTP {exc.response.status_code} fetching '{url}'. "
            f"The page may not exist or may require authentication. "
            "Try a different URL or use web_search to find an alternative source."
        )
    text = _strip_html(resp.text)
    if len(text) > 15000:
        text = text[:15000] + "\n\n[Content truncated at 15,000 chars]"
    return text


def _tool_run_command(command: str) -> str:
    import subprocess
    try:
        result = subprocess.run(
            shlex.split(command) if isinstance(command, str) else command,
            shell=False,
            capture_output=True,
            text=True,
            timeout=RUN_COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return (
            f"Error: Command timed out after {RUN_COMMAND_TIMEOUT_SECONDS} seconds.\n"
            f"Command: {command}\n"
            "Try breaking the command into smaller steps or increasing the timeout."
        )
    output = ""
    if result.stdout:
        output += result.stdout
    if result.stderr:
        output += ("\n" if output else "") + result.stderr
    if result.returncode != 0:
        output += f"\n[Exit code: {result.returncode}]"
        # Add guidance for common exit codes
        if result.returncode == 127:
            output += "\nHint: Command not found. Check if the program is installed and in PATH."
        elif result.returncode == 126:
            output += "\nHint: Permission denied. The file may not be executable."
        elif result.returncode == 2:
            output += "\nHint: Incorrect usage or bad arguments. Check the command syntax."
    return output or "(no output)"


def _tool_read_file(path: str) -> str:
    import os as _os
    if not _os.path.exists(path):
        # List sibling files to help the agent find the right path
        parent = _os.path.dirname(path) or "."
        hint = ""
        if _os.path.isdir(parent):
            siblings = sorted(_os.listdir(parent))[:20]
            if siblings:
                hint = f" Available files in '{parent}': {', '.join(siblings)}"
                if len(_os.listdir(parent)) > 20:
                    hint += f" (+{len(_os.listdir(parent)) - 20} more)"
        return f"Error: File not found at '{path}'.{hint}"
    try:
        with open(path, "r") as f:
            content = f.read()
    except PermissionError:
        return f"Error: Permission denied reading '{path}'. Check file permissions."
    except UnicodeDecodeError:
        return f"Error: '{path}' is a binary file and cannot be read as text."
    if len(content) > 20000:
        content = content[:20000] + "\n\n[Content truncated at 20,000 chars]"
    return content


def _tool_write_file(path: str, content: str) -> str:
    import os as _os
    target_dir = _os.path.dirname(path) or "."
    try:
        _os.makedirs(target_dir, exist_ok=True)
    except PermissionError:
        return f"Error: Permission denied creating directory '{target_dir}'."
    try:
        with open(path, "w") as f:
            f.write(content)
    except PermissionError:
        return f"Error: Permission denied writing to '{path}'. Check file permissions."
    return f"Written {len(content)} bytes to {path}"


def _tool_execute_python(code: str) -> str:
    import subprocess
    result = subprocess.run(
        ["python3", "-c", code],
        capture_output=True,
        text=True,
        timeout=EXECUTE_PYTHON_TIMEOUT_SECONDS,
    )
    output = ""
    if result.stdout:
        output += result.stdout
    if result.stderr:
        output += ("\n" if output else "") + result.stderr
    return output or "(no output)"


class AIAgent:
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
        on_tool_start: Optional[Callable] = None,
        on_tool_end: Optional[Callable] = None,
        on_text: Optional[Callable] = None,
        on_server_tool_event: Optional[Callable] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.max_iterations = max_iterations
        requested_toolsets = enabled_toolsets or ["web", "browser", "vision"]
        if repo_mode:
            requested_toolsets = [
                toolset for toolset in requested_toolsets
                if toolset not in REPO_MODE_BLOCKED_TOOLSETS
            ]
        self.enabled_toolsets = requested_toolsets
        self.repo_mode = repo_mode
        self.repo_edit_intent = repo_edit_intent
        self.github_pat = github_pat
        self.github_repo_owner = github_repo_owner
        self.github_repo_name = github_repo_name
        self.on_tool_start = on_tool_start
        self.on_tool_end = on_tool_end
        self.on_text = on_text
        self.on_server_tool_event = on_server_tool_event
        self.on_thinking: Optional[Callable] = None
        self.session_cache: dict[str, str] = {}

        # Build tool list from enabled toolsets
        self.tools = []
        for toolset in self.enabled_toolsets:
            self.tools.extend(TOOL_DEFINITIONS.get(toolset, []))

        # Add repo tools when in repo mode
        if self.repo_mode:
            if not self.repo_edit_intent:
                repo_tools = []
                if self.github_pat and self.github_repo_owner and self.github_repo_name:
                    repo_tools = [
                        t for t in REPO_TOOL_DEFINITIONS
                        if t["function"]["name"] == "read_repo_file"
                    ]
            else:
                repo_tools = REPO_TOOL_DEFINITIONS
            self.tools.extend(repo_tools)

    def _emit_event(self, event: dict) -> None:
        """Safely emit a server tool event, logging but not raising on failure."""
        if not self.on_server_tool_event:
            return
        try:
            self.on_server_tool_event(event)
        except Exception as e:
            print(f"[hermes-agent] Failed to emit server tool event: {e}", flush=True)

    def _estimate_message_chars(self, messages: list[dict]) -> int:
        """Rough character count across all messages."""
        total = 0
        for m in messages:
            content = m.get("content") or ""
            total += len(content)
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                total += len(fn.get("arguments") or "")
        return total

    def _compact_context(self, messages: list[dict]) -> list[dict]:
        """Compact older messages when context exceeds threshold.

        Preserves:
        - System message (index 0)
        - Original user message (index 1)
        - Last 6 messages (recent context)

        Summarizes everything in between into a single assistant message.
        """
        total_chars = self._estimate_message_chars(messages)
        if total_chars < CONTEXT_COMPACTION_CHAR_THRESHOLD:
            return messages
        if len(messages) <= 8:
            return messages

        # Identify preserved regions
        system_msgs = []
        start_idx = 0
        if messages[0].get("role") == "system":
            system_msgs = [messages[0]]
            start_idx = 1

        # Find original user message
        original_user = messages[start_idx] if start_idx < len(messages) else None
        preserved_start = [m for m in system_msgs]
        if original_user:
            preserved_start.append(original_user)
            start_idx += 1

        # Keep last 6 messages as recent context, but ensure we don't orphan
        # tool result messages from their corresponding assistant tool_calls.
        recent_count = min(6, len(messages) - start_idx)
        split_idx = len(messages) - recent_count

        # Walk the split point backwards if it would orphan tool results.
        # A "tool" role message must always be preceded by the assistant
        # message that contains its matching tool_calls.
        while split_idx < len(messages) and messages[split_idx].get("role") == "tool":
            split_idx -= 1
            if split_idx <= start_idx:
                # Can't compact — everything is tool call pairs
                return messages

        middle = messages[start_idx : split_idx]
        recent = messages[split_idx :]

        if not middle:
            return messages

        # Build summary of middle section
        summary_parts = []
        tools_used = []
        files_read = []
        files_edited = []

        for m in middle:
            role = m.get("role", "")
            content = (m.get("content") or "").strip()

            if role == "assistant" and content:
                # Keep first 200 chars of assistant messages
                summary_parts.append(f"Assistant: {content[:200]}{'...' if len(content) > 200 else ''}")

            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                tool_name = fn.get("name", "unknown")
                tools_used.append(tool_name)
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                path = args.get("path", "")
                if tool_name == "read_repo_file" and path:
                    files_read.append(path)
                elif tool_name in REPO_EDIT_TOOL_NAMES and path:
                    files_edited.append(path)

            if role == "tool" and content:
                # Summarize tool results to just their length
                summary_parts.append(f"Tool result: {len(content)} chars")

        summary = "[Context compacted to save space]\n"
        if files_read:
            summary += f"Files read: {', '.join(files_read)}\n"
        if files_edited:
            summary += f"Files edited: {', '.join(files_edited)}\n"
        if tools_used:
            unique_tools = list(dict.fromkeys(tools_used))
            summary += f"Tools used: {', '.join(unique_tools)} ({len(tools_used)} total calls)\n"
        if summary_parts:
            summary += "Summary of prior work:\n" + "\n".join(summary_parts[:10])
            if len(summary_parts) > 10:
                summary += f"\n... and {len(summary_parts) - 10} more exchanges"

        compacted_msg = {"role": "assistant", "content": summary}
        result = preserved_start + [compacted_msg] + recent
        old_chars = total_chars
        new_chars = self._estimate_message_chars(result)
        print(
            f"[hermes-agent] Context compacted: {len(messages)} msgs ({old_chars:,} chars) -> "
            f"{len(result)} msgs ({new_chars:,} chars), saved {old_chars - new_chars:,} chars",
            flush=True,
        )
        return result

    def _execute_repo_tool(self, tool_name: str, arguments: dict) -> str:
        """Execute a repo tool, emit events, and return the result string."""
        if tool_name == "read_repo_file":
            path = arguments.get("path", "")
            if self.on_tool_start:
                self.on_tool_start("read_repo_file", path)
            try:
                result = self._read_github_file(path)
            finally:
                if self.on_tool_end:
                    self.on_tool_end("read_repo_file", path, f"Read {len(result) if 'result' in dir() else 0} chars from {path}")
            if not result.startswith("Error"):
                self.session_cache[path] = result
            result = _cap_tool_response(result)
            if result == "":
                result = "(empty file)"
            self._emit_event({"type": "repo_file_read", "path": path, "content": result})
            return result

        if tool_name == "edit_repo_file":
            path = arguments.get("path", "")
            content = arguments.get("content", "")
            description = arguments.get("description", "")
            original_content = self.session_cache.get(path, "")
            self.session_cache[path] = content
            if self.on_tool_start:
                self.on_tool_start("edit_repo_file", path)
            self._emit_event({
                "type": "repo_file_edit",
                "path": path,
                "content": content,
                "originalContent": original_content,
                "description": description,
            })
            if self.on_tool_end:
                self.on_tool_end("edit_repo_file", path, f"Staged edit to {path}")
            return f"Staged edit to {path}"

        if tool_name == "create_repo_file":
            path = arguments.get("path", "")
            content = arguments.get("content", "")
            description = arguments.get("description", "")
            self.session_cache[path] = content
            if self.on_tool_start:
                self.on_tool_start("create_repo_file", path)
            self._emit_event({
                "type": "repo_file_create",
                "path": path,
                "content": content,
                "description": description,
            })
            if self.on_tool_end:
                self.on_tool_end("create_repo_file", path, f"Staged new file {path}")
            return f"Staged new file {path}"

        if tool_name == "delete_repo_file":
            path = arguments.get("path", "")
            reason = arguments.get("reason", "")
            original_content = self.session_cache.pop(path, "")
            if self.on_tool_start:
                self.on_tool_start("delete_repo_file", path)
            self._emit_event({
                "type": "repo_file_delete",
                "path": path,
                "originalContent": original_content,
                "reason": reason,
            })
            if self.on_tool_end:
                self.on_tool_end("delete_repo_file", path, f"Staged deletion of {path}")
            return f"Staged deletion of {path}"

        if tool_name == "batch_edit_repo_files":
            changes = arguments.get("changes", [])
            if not isinstance(changes, list):
                return f"Error: 'changes' must be a list, got {type(changes).__name__}"
            batch_changes = []
            results_list = []
            for change in changes:
                if not isinstance(change, dict):
                    continue
                c_path = change.get("path", "")
                c_action = change.get("action", "edit")
                c_content = change.get("content", "")
                c_description = change.get("description", "")
                c_original = self.session_cache.get(c_path, "")
                if c_action == "delete":
                    self.session_cache.pop(c_path, None)
                else:
                    self.session_cache[c_path] = c_content
                batch_changes.append({
                    "path": c_path,
                    "action": c_action,
                    "content": c_content,
                    "originalContent": c_original,
                    "description": c_description,
                })
                results_list.append(f"Staged {c_action} on {c_path}")
            if self.on_tool_start:
                paths = [c["path"] for c in batch_changes[:5]]
                self.on_tool_start("batch_edit_repo_files", json.dumps({"changes": [{"path": p} for p in paths]}))
            self._emit_event({"type": "repo_batch_edit", "changes": batch_changes})
            if self.on_tool_end:
                self.on_tool_end("batch_edit_repo_files", "", f"Staged {len(batch_changes)} file changes")
            return "\n".join(results_list) if results_list else "No valid changes to apply"

        return f"Unknown repo tool: {tool_name}"

    def _read_github_file(self, path: str) -> str:
        """Read a file from GitHub using the API. Falls back to a hint if no credentials."""
        if not self.github_pat or not self.github_repo_owner or not self.github_repo_name:
            missing = []
            if not self.github_pat:
                missing.append("GitHub PAT")
            if not self.github_repo_owner:
                missing.append("repo owner")
            if not self.github_repo_name:
                missing.append("repo name")
            print(f"[hermes-agent] Cannot read '{path}': missing {', '.join(missing)}", flush=True)
            return (
                f"Error: Cannot read '{path}' — missing GitHub credentials ({', '.join(missing)}). "
                f"The user needs to configure a GitHub Personal Access Token in Settings."
            )
        try:
            encoded_owner = quote(self.github_repo_owner, safe="")
            encoded_repo = quote(self.github_repo_name, safe="")
            encoded_path = quote(path, safe="/")
            url = f"https://api.github.com/repos/{encoded_owner}/{encoded_repo}/contents/{encoded_path}"
            headers = {
                "Authorization": f"Bearer {self.github_pat}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "Hermes-Agent",
            }
            with httpx.Client(timeout=15) as client:
                resp = client.get(url, headers=headers)
                if resp.status_code == 404:
                    # Try to list the parent directory to help the agent
                    parent_dir = "/".join(path.split("/")[:-1]) if "/" in path else ""
                    hint = f" Try read_repo_file on the parent directory '{parent_dir}' to see available files." if parent_dir else ""
                    return f"Error: File not found at '{path}' in {self.github_repo_owner}/{self.github_repo_name}.{hint}"
                resp.raise_for_status()
            data = resp.json()
            if isinstance(data, list):
                # GitHub returns a list for directories
                entries = [item.get("name", "?") for item in data[:20] if isinstance(item, dict)]
                listing = ", ".join(entries)
                if len(data) > 20:
                    listing += f" (+{len(data) - 20} more)"
                return f"Error: '{path}' is a directory, not a file. Contents: {listing}"
            if not data.get("content"):
                return f"Error: File content unavailable for '{path}'. The file may be empty or too large for the GitHub API."
            import base64
            content = base64.b64decode(data["content"]).decode("utf-8")
            # Intelligent truncation: keep first and last sections so the agent
            # sees both the file header/imports and the tail (often where recent
            # changes live).
            if len(content) > MAX_TOOL_RESPONSE_CHARS:
                lines = content.split("\n")
                total_lines = len(lines)
                # Keep first 60% and last 40% of lines within budget
                head_lines = int(total_lines * 0.6)
                tail_lines = total_lines - head_lines
                head = "\n".join(lines[:head_lines])
                tail = "\n".join(lines[-tail_lines:])
                # If still too long, fall back to char-based truncation
                if len(head) + len(tail) > MAX_TOOL_RESPONSE_CHARS:
                    head_budget = int(MAX_TOOL_RESPONSE_CHARS * 0.6)
                    tail_budget = MAX_TOOL_RESPONSE_CHARS - head_budget - 200
                    head = content[:head_budget]
                    tail = content[-tail_budget:]
                omitted = total_lines - head_lines - tail_lines
                content = (
                    head
                    + f"\n\n[... {omitted} lines omitted — file has {total_lines} total lines ...]\n\n"
                    + tail
                )
            print(f"[hermes-agent] Read {path} from GitHub: {len(content)} chars", flush=True)
            return content
        except Exception as e:
            print(f"[hermes-agent] Failed to read {path} from GitHub: {e}", flush=True)
            return f"Error reading file '{path}' from GitHub: {str(e)}"

    def _call_api(
        self,
        messages: list[dict],
        forced_repo_tool_choice: Optional[str] = None,
    ) -> dict:
        """Make a non-streaming chat completion request to the configured provider."""
        if self.tools and self.model in KNOWN_UNSUPPORTED_TOOL_MODELS:
            suggested_models = ", ".join(SUGGESTED_TOOL_MODELS)
            raise RuntimeError(
                f"Model '{self.model}' is not compatible with Hermes tool calls on OpenRouter. "
                f"Choose a tool-capable model like {suggested_models}."
            )

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://cloud-chat-hub.local",
            "X-Title": "Hermes Agent",
        }
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.7,
            "max_tokens": 16384 if self.repo_mode else 4096,
        }
        if self.tools:
            tools = self.tools
            tool_choice: object = "auto"

            if self.repo_mode and forced_repo_tool_choice == "required":
                tool_choice = "required"

            payload["tools"] = tools
            payload["tool_choice"] = tool_choice

        with httpx.Client(timeout=PROVIDER_TIMEOUT_SECONDS) as client:
            try:
                resp = client.post(
                    f"{self.base_url}/chat/completions",
                    headers=headers,
                    json=payload,
                )
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                error_message = _extract_error_message(exc.response)
                raise RuntimeError(
                    f"Provider error ({exc.response.status_code}) for model '{self.model}': {error_message}"
                ) from exc
            except httpx.HTTPError as exc:
                raise RuntimeError(
                    f"Failed to reach provider endpoint at {self.base_url}: {exc}"
                ) from exc
            return resp.json()

    def _build_repo_system_prompt(self) -> str:
        """Build a system prompt snippet describing the active repo and available tools."""
        if not self.repo_mode or not self.github_repo_owner or not self.github_repo_name:
            return ""
        repo_full = f"{self.github_repo_owner}/{self.github_repo_name}"
        current_turn_instruction = (
            "Current repo turn intent: the user is asking for repository changes. "
            "Read files as needed and then apply the edits."
            if self.repo_edit_intent
            else "Current repo turn intent: the user is asking for read-only repository help. "
            "You may inspect files with read_repo_file, but do not edit files "
            "unless the user explicitly asks for modifications."
        )
        repo_access_instruction = ""
        if not self.github_pat:
            repo_access_instruction = (
                "\nGitHub file access is unavailable for this request because no GitHub token was provided.\n"
                "Do not call read_repo_file and do not search the web to compensate.\n"
                "Answer using only the issue text and any supplied context. Mention the limitation once and avoid repeating the issue description at length.\n"
            )
        return (
            f"You are working on the GitHub repository {repo_full}.\n"
            "You have tools to read, edit, create, and delete files in this repo.\n\n"
            "First determine whether the current user turn is asking for read-only repository help or for actual code changes.\n"
            "- If the user is asking what the repo is, how it works, where something lives, or for analysis/review, stay read-only: inspect files as needed and answer directly.\n"
            "- Only enter the edit workflow when the user explicitly asks you to modify the repository.\n"
            "- Never treat repo selection by itself as permission to edit.\n\n"
            "Operate like a code agent: inspect the repo with tools, make concrete changes with tools when requested, "
            "and keep narration brief.\n\n"
            "WORKFLOW — FOR CHANGE REQUESTS ONLY:\n"
            "1. Use read_repo_file to read files and understand the codebase.\n"
            "2. Use batch_edit_repo_files to apply changes.\n"
            "3. Do NOT ask the user which file to edit — explore the repo yourself using read_repo_file.\n"
            "4. Do NOT ask clarifying questions. Use your judgment, explore the repo to understand the codebase, and make changes directly. If the request is ambiguous, make reasonable assumptions and explain them.\n"
            "5. When making changes, address ALL requested changes, not just one.\n"
            "6. When you need more repository context, use the actual repo tools instead of prose about what you will do next.\n"
            "7. Do NOT paste code blocks, pseudo-code, or raw file content when repo tools are available. Use the tools.\n"
            f"{repo_access_instruction}"
            f"\n{current_turn_instruction}\n"
        )

    def _should_continue_repo_turn(
        self,
        messages: list[dict],
        content: Optional[str],
        continuation_attempts: int,
    ) -> bool:
        if not self.repo_mode:
            return False
        if continuation_attempts >= REPO_CONTINUATION_RETRY_LIMIT:
            return False
        if not _recent_repo_turn_stalled_on_read(messages):
            return False

        if not self.repo_edit_intent:
            return True

        return True

    def _build_repo_continuation_message(self) -> str:
        if not self.repo_edit_intent:
            return (
                "[System: Continue the read-only repository analysis now. Use read_repo_file if you still need "
                "context, then answer the user's question directly. Do not call any repo edit "
                "tool unless the user explicitly asks for modifications.]"
            )

        return (
            "[System: Continue the already approved repository change now. Do not describe the next step in prose. "
            "Use the actual repo tools immediately. If you still need more context, call read_repo_file. "
            "If you are ready to change files, call batch_edit_repo_files or the appropriate repo edit tool now. "
            "Only send normal prose after the repo tool calls are complete.]"
        )

    def _get_forced_repo_tool_choice(self, messages: list[dict]) -> Optional[str]:
        if not self.repo_mode:
            return None

        if not self.repo_edit_intent:
            return None

        if _recent_repo_turn_stalled_on_read(messages):
            return "required"

        recent_tool_names = set(_get_recent_tool_call_names(messages))
        if any(name in REPO_EDIT_TOOL_NAMES for name in recent_tool_names):
            return None

        # If the user explicitly asked to fix/edit/implement and no edit tools
        # have been called yet in this turn, force tool use so the model acts
        # instead of narrating.
        if (
            not any(name in REPO_EDIT_TOOL_NAMES for name in recent_tool_names)
            and not _messages_include_tool_call(messages, REPO_EDIT_TOOL_NAMES)
            and _latest_user_message_has_fix_intent(messages)
        ):
            return "required"

        if _messages_include_tool_call(messages, REPO_EDIT_TOOL_NAMES):
            return None

        if recent_tool_names:
            return None

        return "required"

    def _build_repo_tool_enforcement_message(self, forced_repo_tool_choice: str) -> str:
        return (
            "[System: Repo mode requires actual tool use, not narration. Your next response must contain "
            "one or more repo tool calls only. If you still need context, call read_repo_file now. "
            "If you are ready to edit, call batch_edit_repo_files or edit_repo_file now. "
            "Do not output prose, markdown, or code fences.]"
        )

    def run_conversation(
        self,
        user_message: str,
        conversation_history: Optional[list[dict]] = None,
    ):
        """Run the agentic loop: call model, execute tools, repeat until done."""
        messages = list(conversation_history or [])

        # Ensure the model always has repo context as a system message.
        # The upstream server prepends a system prompt, but it can be lost
        # if the AI SDK reformats messages.  When we have repo headers,
        # guarantee a system message exists with repo info.
        repo_prompt = self._build_repo_system_prompt()
        if repo_prompt:
            has_system = any(m.get("role") == "system" for m in messages)
            if has_system:
                # Append repo context to the existing system message if it
                # doesn't already mention the repo.
                for m in messages:
                    if m.get("role") == "system":
                        repo_full = f"{self.github_repo_owner}/{self.github_repo_name}"
                        if repo_full not in (m.get("content") or ""):
                            m["content"] = (m["content"] or "") + "\n\n" + repo_prompt
                        break
            else:
                # No system message at all — inject one at the start.
                messages.insert(0, {"role": "system", "content": repo_prompt})

        messages.append({"role": "user", "content": user_message})
        repo_continuation_attempts = 0
        repo_tool_enforcement_attempts = 0
        fix_intent_continuation_attempts = 0
        forced_repo_tool_choice: Optional[str] = None

        for iteration in range(self.max_iterations):
            # Compact context if it's getting too large
            messages = self._compact_context(messages)

            print(f"[hermes-agent] Iteration {iteration + 1}/{self.max_iterations}, msgs={len(messages)}", flush=True)
            if self.on_thinking:
                self.on_thinking(iteration + 1)
            response = self._call_api(messages, forced_repo_tool_choice=forced_repo_tool_choice)
            forced_repo_tool_choice = None

            choice = response["choices"][0]
            message = choice["message"]
            finish_reason = choice.get("finish_reason", "stop")
            content_preview = (message.get("content") or "")[:100]
            tool_call_count = len(message.get("tool_calls") or [])
            print(f"[hermes-agent] Response: finish_reason={finish_reason} content_len={len(message.get('content') or '')} tool_calls={tool_call_count} preview={content_preview!r}", flush=True)

            # Emit any text content
            if message.get("content"):
                if self.on_text:
                    self.on_text(message["content"])

            # Check for tool calls
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                next_forced_repo_tool_choice = self._get_forced_repo_tool_choice(messages)
                if (
                    next_forced_repo_tool_choice and
                    repo_tool_enforcement_attempts < REPO_TOOL_ENFORCEMENT_RETRY_LIMIT
                ):
                    repo_tool_enforcement_attempts += 1
                    content = message.get("content")
                    if content:
                        messages.append({"role": "assistant", "content": content})
                    enforcement_message = self._build_repo_tool_enforcement_message(
                        next_forced_repo_tool_choice
                    )
                    messages.append({"role": "user", "content": enforcement_message})
                    forced_repo_tool_choice = next_forced_repo_tool_choice
                    print(
                        f"[hermes-agent] Repo tool enforcement retry "
                        f"({repo_tool_enforcement_attempts}/{REPO_TOOL_ENFORCEMENT_RETRY_LIMIT}) "
                        f"forcing {next_forced_repo_tool_choice}.",
                        flush=True,
                    )
                    continue

                if self._should_continue_repo_turn(
                    messages,
                    message.get("content"),
                    repo_continuation_attempts,
                ):
                    repo_continuation_attempts += 1
                    content = message.get("content")
                    if content:
                        messages.append({"role": "assistant", "content": content})
                    continuation_message = self._build_repo_continuation_message()
                    messages.append({"role": "user", "content": continuation_message})
                    print(
                        f"[hermes-agent] Continuing approved repo turn after read-only stop "
                        f"({repo_continuation_attempts}/{REPO_CONTINUATION_RETRY_LIMIT}).",
                        flush=True,
                    )
                    continue

                # Last resort: if the user asked for edits (fix/apply/etc.),
                # repo_mode is active, and no edit tools have been called in
                # this turn, inject a nudge instead of breaking out.
                if (
                    self.repo_mode
                    and fix_intent_continuation_attempts < FIX_INTENT_CONTINUATION_LIMIT
                    and _latest_user_message_has_fix_intent(messages)
                    and not _messages_include_tool_call(messages, REPO_EDIT_TOOL_NAMES)
                ):
                    fix_intent_continuation_attempts += 1
                    content = message.get("content")
                    if content:
                        messages.append({"role": "assistant", "content": content})
                    messages.append({
                        "role": "user",
                        "content": (
                            "[System: The user asked you to make changes. Please use the edit tools "
                            "(batch_edit_repo_files, edit_repo_file, create_repo_file) to implement "
                            "the fixes rather than just describing them. Do not explain what you "
                            "would do — use the tools now.]"
                        ),
                    })
                    print(
                        f"[hermes-agent] Fix-intent continuation "
                        f"({fix_intent_continuation_attempts}/{FIX_INTENT_CONTINUATION_LIMIT}): "
                        f"user asked for edits but no edit tools called yet.",
                        flush=True,
                    )
                    continue
                break
            repo_continuation_attempts = 0
            repo_tool_enforcement_attempts = 0
            fix_intent_continuation_attempts = 0

            # Add assistant message with tool calls to history
            messages.append(message)

            # Execute each tool call
            for tc in tool_calls:
                func = tc["function"]
                raw_tool_name = func["name"]
                tool_name = _normalize_tool_name(raw_tool_name)
                if tool_name != raw_tool_name:
                    print(f"[hermes-agent] Normalized tool name: {raw_tool_name!r} -> {tool_name!r}", flush=True)
                try:
                    arguments = json.loads(func["arguments"])
                except json.JSONDecodeError:
                    arguments = {}

                tool_input = json.dumps(arguments)

                print(f"[hermes-agent] Tool call: {tool_name} args_keys={list(arguments.keys())} repo_tool={tool_name in REPO_TOOL_NAMES}", flush=True)
                # Repo tools emit structured ServerToolEvent JSON via the
                # on_server_tool_event callback. The frontend receives these
                # as dedicated SSE events and renders them as proposal cards,
                # file edit previews, etc.
                if tool_name in REPO_TOOL_NAMES:
                    try:
                        result = self._execute_repo_tool(tool_name, arguments)
                    except Exception as e:
                        print(f"[hermes-agent] Repo tool error ({tool_name}): {e}", flush=True)
                        result = f"Error executing {tool_name}: {str(e)}"

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": result,
                    })
                    continue

                if self.on_tool_start:
                    self.on_tool_start(tool_name, tool_input)

                result = _execute_tool(tool_name, arguments)

                if self.on_tool_end:
                    self.on_tool_end(tool_name, tool_input, result)

                # Add tool result to messages
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result,
                })

            # --- Post-tool-execution: verification and reflection ---
            executed_tool_names = [
                _normalize_tool_name(tc["function"]["name"])
                for tc in tool_calls
            ]

            # Verification: after edit tools, prompt the agent to review its changes
            made_edits = any(name in REPO_EDIT_TOOL_NAMES for name in executed_tool_names)
            if made_edits and self.repo_mode:
                messages.append({
                    "role": "user",
                    "content": (
                        "[System: You just made file changes. Before finishing, verify your work:\n"
                        "1. Did you address ALL parts of the user's request?\n"
                        "2. Are there any syntax errors, missing imports, or broken references in your changes?\n"
                        "3. Are there related files that also need updating for consistency?\n"
                        "If everything looks correct, summarize what you changed. "
                        "If you find issues, fix them now with another tool call.]"
                    ),
                })
                print(f"[hermes-agent] Injected verification prompt after edit tools.", flush=True)

            # Nudge: user requested edits but the agent only read files / didn't edit
            elif not made_edits and self.repo_mode and self.repo_edit_intent:
                messages.append({
                    "role": "user",
                    "content": (
                        "[System: The user requested changes but no edits have been made yet. "
                        "Please use the available edit tools (edit_repo_file, batch_edit_repo_files) "
                        "to implement the requested changes.]"
                    ),
                })
                print(f"[hermes-agent] Injected edit-nudge prompt (no edits made yet).", flush=True)

            # Structured reflection: every 5 iterations, check if the agent is
            # making progress or stuck in a loop
            elif iteration > 0 and iteration % 5 == 4:
                messages.append({
                    "role": "user",
                    "content": (
                        "[System: Reflection checkpoint — you have completed "
                        f"{iteration + 1} iterations so far.\n"
                        "1. Have you achieved the user's original goal?\n"
                        "2. Are you making progress or repeating the same actions?\n"
                        "3. If the goal is achieved, provide your final answer now.\n"
                        "4. If not, what is the most direct next step?]"
                    ),
                })
                print(f"[hermes-agent] Injected reflection prompt at iteration {iteration + 1}.", flush=True)
