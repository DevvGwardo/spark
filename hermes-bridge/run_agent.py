"""
AIAgent: Agentic loop over OpenRouter with tool calling.

Sends messages to a Nous Hermes model, handles tool calls (web search,
browse URL, etc.), and streams results back via callbacks.
"""

import json
import os
import shlex
import sys
import time
import threading
import httpx
import re
from typing import Optional, Callable
from urllib.parse import quote, quote_plus
from concurrent.futures import ThreadPoolExecutor, as_completed
from kanban_tools import (
    KANBAN_TOOL_DEFINITIONS, KANBAN_TOOL_NAMES,
    kanban_read_current_card, kanban_update_status, kanban_append_report,
    kanban_show, kanban_complete, kanban_block, kanban_heartbeat, kanban_comment,
    kanban_list, kanban_create, kanban_link, kanban_unblock,
)
from team_tools import TEAM_TOOL_DEFINITIONS, TEAM_TOOL_NAMES, team_delegate_to_agent, team_report_progress, team_query_context, team_publish_finding, team_request_help, team_signal_completion

# ── hermes-agent toolset bridge ──────────────────────────────────────────────
# Attempt to import hermes-agent's toolsets module to resolve ecosystem tool
# names. When available, cloud-chat-hub inherits hermes-agent's tool discovery
# so new tools appear automatically without updating cloud-chat-hub's code.
# Kanban and team tool definitions remain cloud-chat-hub-specific (they target
# cloud-chat-hub's Express API, not hermes-agent's kanban_db).

_hermes_toolset_names: set[str] = set()
_hermes_toolset_warning: str | None = None

try:
    # Try to find hermes-agent on sys.path
    import importlib.util
    _ts_spec = importlib.util.find_spec("toolsets")
    if _ts_spec and _ts_spec.origin:
        import toolsets as _hermes_toolsets
        _resolved = _hermes_toolsets.resolve_toolset("hermes-cli")
        _hermes_toolset_names = set(_resolved)
        print(f"[hermes-bridge] Bridged to hermes-agent toolsets: {len(_hermes_toolset_names)} ecosystem tools available", flush=True)
    else:
        _hermes_toolset_warning = "hermes-agent toolsets not found — using baked-in tool definitions"
        print(f"[hermes-bridge] {_hermes_toolset_warning}", flush=True)
except Exception as _e:
    _hermes_toolset_warning = f"hermes-agent bridge failed: {_e} — using baked-in tool definitions"
    print(f"[hermes-bridge] {_hermes_toolset_warning}", flush=True)


class _SafeWriter:
    """Wrapper around sys.stdout/stderr that swallows BrokenPipeError.

    When hermes-bridge runs as a daemon or behind a reverse proxy, the
    parent process may close the pipe unexpectedly.  Without this wrapper
    every ``print()`` call becomes a potential crash site.
    """

    def __init__(self, stream):
        self._stream = stream

    def write(self, data):
        try:
            self._stream.write(data)
        except (BrokenPipeError, OSError):
            pass

    def flush(self):
        try:
            self._stream.flush()
        except (BrokenPipeError, OSError):
            pass

    def __getattr__(self, name):
        return getattr(self._stream, name)


# Install safe writers to prevent daemon crashes on broken pipes
sys.stdout = _SafeWriter(sys.stdout)
sys.stderr = _SafeWriter(sys.stderr)


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
    "google/gemini-3.1-flash-lite-preview",
    "MiniMax-M2.7",
    "deepseek/deepseek-v3.2",
    "meta-llama/llama-4-maverick",
    "openai/gpt-4.1-mini",
    "google/gemini-2.5-flash",
)

# Approximate char threshold before context compaction kicks in.
# ~4 chars/token, so 25K tokens ≈ 100K chars. Compact when we pass 60% of that.
CONTEXT_COMPACTION_CHAR_THRESHOLD = _read_positive_int_env(
    "HERMES_CONTEXT_COMPACTION_THRESHOLD", 60000
)

# --- API retry configuration ---
API_MAX_RETRIES = 3
API_RETRY_BASE_DELAY = 1.0  # seconds; doubles each retry
API_RETRY_MAX_DELAY = 16.0
FINISH_LENGTH_MAX_CONTINUATIONS = 3
MCP_TOOL_TIMEOUT_SECONDS = 30

# --- Budget / iteration pressure ---
BUDGET_WARNING_THRESHOLD_LOW = 0.70   # 70% consumed -> soft warning
BUDGET_WARNING_THRESHOLD_HIGH = 0.90  # 90% consumed -> hard warning

# --- Context reset (harness pattern: resets > compaction for long sessions) ---
CONTEXT_RESET_ITERATION_RATIO = 0.50  # Reset at 50% of iteration budget
CONTEXT_RESET_CHAR_THRESHOLD = _read_positive_int_env(
    "HERMES_CONTEXT_RESET_THRESHOLD", 100000
)  # Also reset when context exceeds ~25K tokens

# --- Think-block handling (DeepSeek, QwQ, etc.) ---
_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)

# --- Parallel tool execution ---
_PARALLEL_SAFE_TOOLS = frozenset({
    "web_search",
    "browse_url",
    "read_file",
    "read_repo_file",
    "list_user_repos",
})
_PATH_SCOPED_TOOLS = frozenset({
    "read_file",
    "write_file",
    "read_repo_file",
    "edit_repo_file",
    "create_repo_file",
    "delete_repo_file",
})
_MAX_PARALLEL_WORKERS = 6

# --- Destructive command detection ---
_DESTRUCTIVE_CMD_PATTERNS = re.compile(
    r"\b(rm\s+-rf|rm\s+-r|rmdir|mkfs|dd\s+if=|format\s+|fdisk|"
    r"chmod\s+-R\s+000|git\s+reset\s+--hard|git\s+clean\s+-fd|"
    r"drop\s+table|drop\s+database|truncate\s+table|"
    r">\s*/dev/sd|shutdown|reboot|init\s+0)\b",
    re.IGNORECASE,
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
            "name": "list_user_repos",
            "description": "List all repositories accessible with the current GitHub token. Use this when the active repo cannot be found (404) to discover available repos.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
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
    "kanban": KANBAN_TOOL_DEFINITIONS,
    "team": TEAM_TOOL_DEFINITIONS,

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
    all_names.extend(KANBAN_TOOL_NAMES)
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

# Models frequently hallucinate tool names from their training data (e.g.
# Claude's str_replace_editor, Cursor's apply_diff, etc.).  Map these to the
# closest real tool so the agent can recover without burning an iteration.
_HALLUCINATED_TOOL_MAP: dict[str, str] = {
    "str_replace_editor": "edit_repo_file",
    "str_replace": "edit_repo_file",
    "file_editor": "edit_repo_file",
    "apply_diff": "edit_repo_file",
    "insert_text": "edit_repo_file",
    "replace_in_file": "edit_repo_file",
    "file_read": "read_repo_file",
    "cat_file": "read_repo_file",
    "view_file": "read_repo_file",
    "open_file": "read_repo_file",
    "file_write": "create_repo_file",
    "create_file": "create_repo_file",
    "file_create": "create_repo_file",
    "delete_file": "delete_repo_file",
    "remove_file": "delete_repo_file",
    "file_delete": "delete_repo_file",
    "search": "web_search",
    "google_search": "web_search",
    "browser": "browse_url",
    "fetch_url": "browse_url",
    "terminal": "run_command",
    "bash": "run_command",
    "shell": "run_command",
    "exec": "run_command",
    "execute_command": "run_command",
    "python": "execute_python",
    "run_python": "execute_python",
    "list_repos": "list_user_repos",

    # Kanban tool aliases
    "kanban_read_card": "kanban_read_current_card",
    "read_card": "kanban_read_current_card",
    "update_card_status": "kanban_update_status",
    "update_status": "kanban_update_status",
    "append_report": "kanban_append_report",
    "append_notes": "kanban_append_report",

    # hermes-agent kanban tool aliases (non-ambiguous — not already canonical names)
    "show_task": "kanban_show",
    "complete_task": "kanban_complete",
    "block_task": "kanban_block",
    "list_tasks": "kanban_list",
    "create_task": "kanban_create",
    "comment_on_task": "kanban_comment",

    # Team tool aliases
    "delegate_to_agent": "team_delegate_to_agent",
    "delegate": "team_delegate_to_agent",
    "report_progress": "team_report_progress",
    "progress": "team_report_progress",
    "query_context": "team_query_context",
    "context_query": "team_query_context",
    "publish_finding": "team_publish_finding",
    "share_finding": "team_publish_finding",
    "request_help": "team_request_help",
    "help": "team_request_help",
    "signal_completion": "team_signal_completion",
    "complete": "team_signal_completion",
    "team_complete": "team_signal_completion",
}


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
    # Check hallucinated names from model training data
    if name in _HALLUCINATED_TOOL_MAP:
        return _HALLUCINATED_TOOL_MAP[name]
    if name.lower() in _HALLUCINATED_TOOL_MAP:
        return _HALLUCINATED_TOOL_MAP[name.lower()]
    # Check aliases (PascalCase, camelCase, etc.)
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


def _extract_think_blocks(content: str) -> tuple[str, str]:
    """Extract and remove <think>...</think> reasoning blocks.

    Returns (visible_content, reasoning_text).
    """
    if not content or "<think>" not in content:
        return content, ""
    reasoning_parts = _THINK_BLOCK_RE.findall(content)
    # findall returns the full match; strip the tags to get inner text
    reasoning_text = "\n".join(
        part.removeprefix("<think>").removesuffix("</think>").strip()
        for part in reasoning_parts
    ).strip()
    visible = _THINK_BLOCK_RE.sub("", content).strip()
    return visible, reasoning_text


# Regex for tool-call XML blocks that some models emit inline
# instead of via the structured tool_calls field.
_TOOL_CALL_XML_RE = re.compile(
    r'<(?P<tag>function_calls|function_call|tool_calls|tool_call|tool_result)\b[^>]*>.*?</(?P=tag)>',
    re.DOTALL | re.IGNORECASE,
)
# Inline ``<function=NAME>...</function>`` dialect (usually wrapped in
# ``<tool_call>``), with ``<parameter=KEY>VALUE</parameter>`` children.
# Stripped as a whole block once any contained call has been recovered.
_INLINE_FN_BLOCK_RE = re.compile(
    r'<function=[^>]*>.*?</function>',
    re.DOTALL | re.IGNORECASE,
)
# Stray opener/closer tags left behind by malformed or truncated blocks
# (e.g. an unclosed ``<tool_call>`` whose ``</tool_call>`` never arrived).
_STRAY_TOOL_TAG_RE = re.compile(
    r'\s*</?(?:tool_call|tool_calls|tool_result|function_call|function_calls)\b[^>]*>'
    r'|\s*</?function(?:=[^>]*)?>'
    r'|\s*</?parameter(?:=[^>]*)?>',
    re.IGNORECASE,
)
# Parse one ``<function=NAME>...</function>`` block (name + body of params).
_INLINE_FN_PARSE_RE = re.compile(
    r'<function=(?P<name>[^>\s]+)\s*>(?P<body>.*?)</function>',
    re.DOTALL | re.IGNORECASE,
)
# Parse one ``<parameter=KEY>VALUE</parameter>`` pair from a function body.
_INLINE_PARAM_RE = re.compile(
    r'<parameter=(?P<key>[^>\s]+)\s*>(?P<value>.*?)</parameter>',
    re.DOTALL | re.IGNORECASE,
)


def _strip_tool_call_xml(content: str) -> str:
    """Strip inline tool-call XML blocks from model output.

    Some providers (Gemma, MiniMax, DeepSeek, and small/"free" models) emit
    ``<function_calls>...``, ``<tool_call><function=NAME>...``, or ``<invoke>...``
    blocks as plain text alongside or instead of structured ``tool_calls``.
    Remove these so they don't leak into the visible message. Recovering such
    calls into executable form is handled separately by
    :func:`_parse_inline_tool_calls`.
    """
    if not content:
        return content
    content = _TOOL_CALL_XML_RE.sub('', content)
    content = _INLINE_FN_BLOCK_RE.sub('', content)
    # Remove any stray opener/closer tags from malformed or truncated blocks
    content = _STRAY_TOOL_TAG_RE.sub('', content)
    return content.strip()


def _parse_inline_tool_calls(content: str) -> list:
    """Recover structured tool calls from the inline ``<function=...>`` dialect.

    Weak/open models sometimes narrate a tool call as text in the
    ``<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>``
    form instead of returning the structured ``tool_calls`` field. Convert each
    well-formed ``<function=...>...</function>`` block into the OpenAI tool-call
    shape so the agent loop can execute it. Only well-formed (closed) blocks are
    recovered; malformed/truncated markup is left for
    :func:`_strip_tool_call_xml` to remove. Returns ``[]`` when nothing
    parseable is found.
    """
    if not content or '<function=' not in content:
        return []
    calls = []
    for i, match in enumerate(_INLINE_FN_PARSE_RE.finditer(content)):
        name = match.group('name').strip()
        if not name:
            continue
        arguments = {}
        for param in _INLINE_PARAM_RE.finditer(match.group('body')):
            key = param.group('key').strip()
            if key:
                arguments[key] = param.group('value').strip()
        calls.append({
            "id": f"inline_call_{i}",
            "type": "function",
            "function": {
                "name": name,
                "arguments": json.dumps(arguments),
            },
        })
    return calls


def _strip_think_blocks(content: str) -> str:
    """Remove <think>...</think> reasoning blocks (DeepSeek, QwQ, etc.)."""
    visible, _ = _extract_think_blocks(content)
    return visible


def _has_content_after_think_block(content: Optional[str]) -> bool:
    """Return True if *content* contains meaningful text outside <think> blocks."""
    if not content:
        return False
    stripped = _strip_think_blocks(content)
    return bool(stripped and stripped.strip())


def _sanitize_api_messages(messages: list[dict]) -> list[dict]:
    """Fix orphaned tool results that would cause provider API errors.

    A "tool" role message must always follow an assistant message containing
    the matching tool_calls.  If the assistant message was lost (e.g. after
    context compaction), we drop the orphan to avoid a 400 error.
    """
    if not messages:
        return messages

    sanitized: list[dict] = []
    last_had_tool_calls = False

    for msg in messages:
        role = msg.get("role")
        if role == "tool":
            if not last_had_tool_calls:
                # Orphaned tool result — drop it
                continue
            sanitized.append(msg)
        else:
            sanitized.append(msg)
            last_had_tool_calls = bool(msg.get("tool_calls"))

    return sanitized


def _deduplicate_tool_calls(tool_calls: list[dict]) -> list[dict]:
    """Remove duplicate tool calls from a single turn.

    Some models emit identical tool calls when confused.  Keep the first
    occurrence based on (name, arguments) identity.
    """
    seen: set[tuple[str, str]] = set()
    unique: list[dict] = []
    for tc in tool_calls:
        fn = tc.get("function") or {}
        key = (fn.get("name", ""), fn.get("arguments", ""))
        if key in seen:
            print(f"[hermes-agent] Deduplicating tool call: {fn.get('name')}", flush=True)
            continue
        seen.add(key)
        unique.append(tc)
    return unique


def _is_destructive_command(command: str) -> bool:
    """Heuristic check for potentially destructive shell commands."""
    return bool(_DESTRUCTIVE_CMD_PATTERNS.search(command))


def _should_parallelize_tool_batch(tool_calls: list[dict]) -> bool:
    """Return True if all tool calls in the batch are safe to run in parallel.

    Only tools in _PARALLEL_SAFE_TOOLS qualify.  Additionally, for
    path-scoped tools we verify there is no file-path overlap.
    """
    if len(tool_calls) < 2:
        return False

    paths_seen: set[str] = set()
    for tc in tool_calls:
        fn = tc.get("function") or {}
        name = _normalize_tool_name(fn.get("name", ""))
        if name not in _PARALLEL_SAFE_TOOLS:
            return False
        # Check path overlap for path-scoped tools
        if name in _PATH_SCOPED_TOOLS:
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except (json.JSONDecodeError, TypeError):
                args = {}
            path = args.get("path", "")
            if path and path in paths_seen:
                return False
            paths_seen.add(path)

    return True


def _get_budget_warning(iteration: int, max_iterations: int) -> Optional[str]:
    """Return a budget pressure warning if the agent is consuming too many iterations."""
    if max_iterations <= 0:
        return None
    ratio = iteration / max_iterations
    if ratio >= BUDGET_WARNING_THRESHOLD_HIGH:
        remaining = max_iterations - iteration
        return (
            f"[URGENT: You have only {remaining} iteration(s) left out of {max_iterations}. "
            "Wrap up your work NOW. Provide your final answer or make your last tool call immediately. "
            "Do not start new exploration.]"
        )
    if ratio >= BUDGET_WARNING_THRESHOLD_LOW:
        remaining = max_iterations - iteration
        return (
            f"[Budget notice: {remaining} iteration(s) remaining out of {max_iterations}. "
            "Start wrapping up — finish your current line of work and prepare a final answer.]"
        )
    return None


def _execute_tool(name: str, arguments: dict) -> str:
    """Execute a tool and return its result as a string."""
    try:
        if name == "web_search":
            return _cap_tool_response(_tool_web_search(arguments["query"]))
        elif name == "browse_url":
            return _cap_tool_response(_tool_browse_url(arguments["url"]))
        elif name == "run_command":
            cmd = arguments["command"]
            if _is_destructive_command(cmd):
                print(f"[hermes-agent] WARNING: destructive command detected: {cmd[:80]}", flush=True)
            return _cap_tool_response(_tool_run_command(cmd))
        elif name == "read_file":
            return _cap_tool_response(_tool_read_file(arguments["path"]))
        elif name == "write_file":
            return _cap_tool_response(_tool_write_file(arguments["path"], arguments["content"]))
        elif name == "execute_python":
            return _cap_tool_response(_tool_execute_python(arguments["code"]))
        elif name == "kanban_read_current_card":
            return _cap_tool_response(kanban_read_current_card())
        elif name == "kanban_update_status":
            return _cap_tool_response(kanban_update_status(
                arguments.get("status", ""),
                arguments.get("report_summary"),
            ))
        elif name == "kanban_append_report":
            return _cap_tool_response(kanban_append_report(arguments.get("notes", "")))
        elif name == "kanban_show":
            return _cap_tool_response(kanban_show())
        elif name == "kanban_complete":
            return _cap_tool_response(kanban_complete(
                arguments.get("summary", ""),
                arguments.get("metadata"),
                arguments.get("artifacts"),
            ))
        elif name == "kanban_block":
            return _cap_tool_response(kanban_block(
                arguments.get("reason", ""),
            ))
        elif name == "kanban_heartbeat":
            return _cap_tool_response(kanban_heartbeat(
                arguments.get("note"),
            ))
        elif name == "kanban_comment":
            return _cap_tool_response(kanban_comment(
                arguments.get("task_id"),
                arguments.get("body", ""),
            ))
        elif name == "kanban_list":
            return _cap_tool_response(kanban_list(
                arguments.get("assignee"),
                arguments.get("status"),
                arguments.get("limit", 50),
            ))
        elif name == "kanban_create":
            return _cap_tool_response(kanban_create(
                arguments.get("title", ""),
                arguments.get("assignee", ""),
                arguments.get("body"),
                arguments.get("parents"),
                arguments.get("skills"),
            ))
        elif name == "kanban_link":
            return _cap_tool_response(kanban_link(
                arguments.get("parent_id", ""),
                arguments.get("child_id", ""),
            ))
        elif name == "kanban_unblock":
            return _cap_tool_response(kanban_unblock(
                arguments.get("task_id", ""),
            ))
        elif name == "team_delegate_to_agent":
            return _cap_tool_response(team_delegate_to_agent(
                arguments.get("agent_name", ""),
                arguments.get("subtask", ""),
                arguments.get("context", ""),
            ))
        elif name == "team_report_progress":
            return _cap_tool_response(team_report_progress(
                arguments.get("summary", ""),
                arguments.get("blockers"),
            ))
        elif name == "team_query_context":
            return _cap_tool_response(team_query_context(
                arguments.get("query_str", ""),
                arguments.get("tags"),
            ))
        elif name == "team_publish_finding":
            return _cap_tool_response(team_publish_finding(
                arguments.get("title", ""),
                arguments.get("content", ""),
                arguments.get("tags", []),
                arguments.get("importance", 2),
            ))
        elif name == "team_request_help":
            return _cap_tool_response(team_request_help(
                arguments.get("question", ""),
                arguments.get("target_agent"),
            ))
        elif name == "team_signal_completion":
            return _cap_tool_response(team_signal_completion(
                arguments.get("final_summary", ""),
            ))
        else:
            # Self-correction: list available tools so the model can retry
            all_known: list[str] = []
            for toolset in TOOL_DEFINITIONS.values():
                for t in toolset:
                    all_known.append(t["function"]["name"])
            all_known.extend(REPO_TOOL_NAMES)
            all_known.extend(KANBAN_TOOL_NAMES)
            all_known.extend(TEAM_TOOL_NAMES)
            return (
                f"Error: Unknown tool '{name}'. "
                f"Available tools: {', '.join(sorted(all_known))}. "
                f"Please retry with one of the available tools."
            )
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
    except FileNotFoundError:
        return (
            f"[Exit code: 127]\n"
            f"Hint: Command not found. Check if the program is installed and in PATH.\n"
            f"Command: {command}"
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


def _execute_mcp_tool(
    server_url: str,
    tool_name: str,
    arguments: dict,
    api_key: Optional[str] = None,
) -> str:
    """Execute a tool on a remote MCP server via Streamable HTTP transport.

    Sends a JSON-RPC ``tools/call`` request and returns the text content
    from the response.
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
        with httpx.Client(timeout=MCP_TOOL_TIMEOUT_SECONDS) as client:
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
        return f"Error: MCP server at {server_url} timed out after {MCP_TOOL_TIMEOUT_SECONDS}s"
    except httpx.HTTPStatusError as exc:
        return f"Error: MCP server returned HTTP {exc.response.status_code}: {exc.response.text[:300]}"
    except Exception as e:
        return f"Error calling MCP tool '{tool_name}': {e}"


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
        repo_file_tree: Optional[list[str]] = None,
        custom_tools: Optional[list[dict]] = None,
        workspace_id: Optional[str] = None,
        # Accepted for parity with HermesAgentAdapter — the custom fallback
        # agent has no reasoning controls, so this is currently unused.
        reasoning_effort: Optional[str] = None,
        on_tool_start: Optional[Callable] = None,
        on_tool_end: Optional[Callable] = None,
        on_text: Optional[Callable] = None,
        on_server_tool_event: Optional[Callable] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.max_iterations = max_iterations
        requested_toolsets = enabled_toolsets or ["web", "browser", "terminal", "vision"]
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
        self.repo_file_tree = repo_file_tree or []
        self.on_tool_start = on_tool_start
        self.on_tool_end = on_tool_end
        self.on_text = on_text
        self.on_server_tool_event = on_server_tool_event
        self.on_thinking: Optional[Callable] = None
        self.on_reasoning: Optional[Callable] = None
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
                        if t["function"]["name"] in ("read_repo_file", "list_user_repos")
                    ]
            else:
                repo_tools = list(REPO_TOOL_DEFINITIONS)
            # Always include list_user_repos when PAT is available (for 404 recovery)
            if self.github_pat and not any(
                t["function"]["name"] == "list_user_repos" for t in repo_tools
            ):
                repo_tools = [
                    t for t in REPO_TOOL_DEFINITIONS
                    if t["function"]["name"] == "list_user_repos"
                ] + repo_tools
            self.tools.extend(repo_tools)

        # Add custom MCP tools from user configuration.
        # Each entry carries mcp_server_url for execution routing.
        self._mcp_tool_routes: dict[str, dict] = {}  # tool_name -> {url, api_key}
        if custom_tools:
            for ct in custom_tools:
                fn = ct.get("function", {})
                name = fn.get("name", "")
                if not name:
                    continue
                # Build OpenAI-compatible tool definition for the LLM
                tool_def = {
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": fn.get("description", ""),
                        "parameters": fn.get("parameters", {"type": "object", "properties": {}}),
                    },
                }
                self.tools.append(tool_def)
                # Store routing info for execution
                self._mcp_tool_routes[name] = {
                    "url": ct.get("mcp_server_url", ""),
                    "api_key": ct.get("mcp_server_api_key"),
                }
            if self._mcp_tool_routes:
                print(
                    f"[hermes-agent] Registered {len(self._mcp_tool_routes)} custom MCP tool(s): "
                    f"{', '.join(self._mcp_tool_routes.keys())}",
                    flush=True,
                )

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

    def _should_reset_context(self, messages: list[dict], iteration: int) -> bool:
        """Determine if a full context reset is warranted.

        Harness pattern: full resets with structured handoffs produce better
        results than in-place compaction for long-running sessions (per
        Anthropic's harness design research).
        """
        if self.max_iterations <= 0:
            return False
        # Don't reset too early — need enough history to summarize
        if iteration < 4:
            return False
        ratio = iteration / self.max_iterations
        chars = self._estimate_message_chars(messages)
        return (
            ratio >= CONTEXT_RESET_ITERATION_RATIO
            and chars >= CONTEXT_RESET_CHAR_THRESHOLD
        )

    def _build_context_handoff(self, messages: list[dict], user_message: str, iteration: int) -> list[dict]:
        """Build a fresh message list from a structured handoff artifact.

        Instead of compacting (summarising in-place), this performs a full
        context reset: the old conversation is replaced with a concise
        handoff document that captures what was done, what remains, and the
        current file state.  The model gets a clean context window.
        """
        # Collect state from the full history
        files_read: list[str] = []
        files_edited: list[str] = []
        tool_call_count = 0
        assistant_conclusions: list[str] = []

        for m in messages:
            for tc in m.get("tool_calls") or []:
                tool_call_count += 1
                fn = tc.get("function") or {}
                name = fn.get("name", "")
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                path = args.get("path", "")
                if name == "read_repo_file" and path and path not in files_read:
                    files_read.append(path)
                elif name in REPO_EDIT_TOOL_NAMES and path and path not in files_edited:
                    files_edited.append(path)

            role = m.get("role", "")
            content = (m.get("content") or "").strip()
            if role == "assistant" and content and not m.get("tool_calls"):
                # Final-style messages (no tool calls) are conclusions
                assistant_conclusions.append(content[:300])

        # Build the handoff artifact
        handoff_parts = [
            "=== CONTEXT RESET — STRUCTURED HANDOFF ===",
            f"Iteration {iteration}/{self.max_iterations}. Context was reset to maintain quality.",
            "",
            "## Work completed so far",
        ]
        if files_read:
            handoff_parts.append(f"Files read: {', '.join(files_read[:20])}")
        if files_edited:
            handoff_parts.append(f"Files edited: {', '.join(files_edited[:20])}")
        handoff_parts.append(f"Total tool calls: {tool_call_count}")

        if assistant_conclusions:
            handoff_parts.append("\n## Last assistant summary")
            handoff_parts.append(assistant_conclusions[-1])

        # Include cached file state so the model knows current contents
        if self.session_cache:
            handoff_parts.append(f"\n## Cached file contents ({len(self.session_cache)} files)")
            for path, content in list(self.session_cache.items())[:10]:
                preview = content[:200].replace("\n", " ")
                handoff_parts.append(f"  {path}: {len(content)} chars — {preview}...")

        handoff_parts.append("\n## Your task")
        handoff_parts.append("Continue working on the user's original request below. "
                             "Pick up where the previous context left off. "
                             "Do NOT re-read files you already have cached above.")

        handoff = "\n".join(handoff_parts)

        # Rebuild: system message + handoff + original user message
        new_messages: list[dict] = []

        # Preserve system message
        system_msg = next((m for m in messages if m.get("role") == "system"), None)
        if system_msg:
            new_messages.append(dict(system_msg))

        # Add the handoff as an assistant message
        new_messages.append({"role": "assistant", "content": handoff})

        # Re-inject the original user request
        new_messages.append({"role": "user", "content": user_message})

        old_chars = self._estimate_message_chars(messages)
        new_chars = self._estimate_message_chars(new_messages)
        print(
            f"[hermes-agent] Context RESET: {len(messages)} msgs ({old_chars:,} chars) -> "
            f"{len(new_messages)} msgs ({new_chars:,} chars). "
            f"Handoff: {len(files_edited)} edits, {len(files_read)} reads, "
            f"{len(self.session_cache)} cached files.",
            flush=True,
        )
        return new_messages

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

    def _list_user_repos(self) -> str:
        """List all repos accessible with the current GitHub token."""
        if not self.github_pat:
            return "Error: No GitHub token configured. Cannot list repositories."
        try:
            url = "https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member"
            headers = {
                "Authorization": f"Bearer {self.github_pat}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "Hermes-Agent",
            }
            all_repos = []
            with httpx.Client(timeout=15) as client:
                while url:
                    resp = client.get(url, headers=headers)
                    if resp.status_code == 401:
                        return "Error: GitHub token is invalid or expired. The user should update their token in Settings."
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
                return "No repositories found for this GitHub token."
            lines = []
            for repo in repos:
                name = repo.get("full_name", "?")
                desc = repo.get("description") or ""
                private = " (private)" if repo.get("private") else ""
                lines.append(f"- {name}{private}: {desc[:80]}" if desc else f"- {name}{private}")
            return f"Found {len(repos)} accessible repositories:\n" + "\n".join(lines)
        except Exception as e:
            return f"Error listing repositories: {e}"

    def _execute_repo_tool(self, tool_name: str, arguments: dict) -> str:
        """Execute a repo tool, emit events, and return the result string."""
        if tool_name == "list_user_repos":
            if self.on_tool_start:
                self.on_tool_start("list_user_repos", "")
            result = self._list_user_repos()
            if self.on_tool_end:
                self.on_tool_end("list_user_repos", "", result[:200])
            return result

        if tool_name == "read_repo_file":
            path = arguments.get("path", "")
            if self.on_tool_start:
                self.on_tool_start("read_repo_file", path)
            # Return staged/cached content if the file was already edited in
            # this session.  This prevents the model from seeing the original
            # (pre-edit) version from GitHub and re-applying the same changes.
            if path in self.session_cache:
                result = self.session_cache[path]
                if self.on_tool_end:
                    self.on_tool_end("read_repo_file", path, f"Read {len(result)} chars from {path} (cached)")
                print(f"[hermes-agent] Read {path} from session cache: {len(result)} chars", flush=True)
            else:
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
                    # Distinguish file-not-found from repo-level access issues.
                    # If the path is not the root, probe the root to check repo access.
                    if path and path != "" and path != "/":
                        root_url = f"https://api.github.com/repos/{encoded_owner}/{encoded_repo}/contents/"
                        root_resp = client.get(root_url, headers=headers)
                        if root_resp.status_code == 404:
                            return (
                                f"Error: Repository {self.github_repo_owner}/{self.github_repo_name} "
                                f"was not found (HTTP 404). The repository may have been renamed or deleted, "
                                f"or your GitHub token may lack access to it. "
                                f"Call list_user_repos to see which repositories are actually accessible "
                                f"with the current token, then inform the user of the correct repo name."
                            )
                    parent_dir = "/".join(path.split("/")[:-1]) if "/" in path else ""
                    hint = f" Try read_repo_file on the parent directory '{parent_dir}' to see available files." if parent_dir else " Try read_repo_file with path '' to list the root directory."
                    return f"Error: File not found at '{path}' in {self.github_repo_owner}/{self.github_repo_name}.{hint}"
                if resp.status_code == 403:
                    return (
                        f"Error: Access denied (HTTP 403) for '{path}' in {self.github_repo_owner}/{self.github_repo_name}. "
                        f"The GitHub token may lack the required permissions (needs 'repo' scope for private repositories)."
                    )
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

    @staticmethod
    def _should_retry_api_error(status_code: int) -> bool:
        """Return True for transient errors worth retrying."""
        if status_code == 429:  # rate limit
            return True
        if 500 <= status_code < 600:  # server errors
            return True
        if status_code == 408:  # request timeout
            return True
        return False

    def _call_api(
        self,
        messages: list[dict],
        forced_repo_tool_choice: Optional[str] = None,
    ) -> dict:
        """Make a non-streaming chat completion request with retry and backoff."""
        if self.tools and self.model in KNOWN_UNSUPPORTED_TOOL_MODELS:
            suggested_models = ", ".join(SUGGESTED_TOOL_MODELS)
            raise RuntimeError(
                f"Model '{self.model}' is not compatible with Hermes tool calls on OpenRouter. "
                f"Choose a tool-capable model like {suggested_models}."
            )

        # Sanitize messages to fix orphaned tool results
        clean_messages = _sanitize_api_messages(messages)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://cloud-chat-hub.local",
            "X-Title": "Hermes Agent",
        }
        payload: dict = {
            "model": self.model,
            "messages": clean_messages,
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

        # Reasoning config: pass through for models that support it (e.g. DeepSeek, o-series)
        model_lower = self.model.lower()
        if any(tag in model_lower for tag in ("deepseek-r1", "o1", "o3", "o4-mini", "qwq")):
            payload.setdefault("extra_body", {})
            payload["extra_body"]["reasoning"] = {"effort": "medium"}

        last_error: Optional[Exception] = None
        for attempt in range(API_MAX_RETRIES + 1):
            try:
                with httpx.Client(timeout=PROVIDER_TIMEOUT_SECONDS) as client:
                    resp = client.post(
                        f"{self.base_url}/chat/completions",
                        headers=headers,
                        json=payload,
                    )
                    resp.raise_for_status()
                return resp.json()
            except httpx.HTTPStatusError as exc:
                last_error = exc
                status_code = exc.response.status_code
                error_message = _extract_error_message(exc.response)

                if self._should_retry_api_error(status_code) and attempt < API_MAX_RETRIES:
                    delay = min(
                        API_RETRY_BASE_DELAY * (2 ** attempt),
                        API_RETRY_MAX_DELAY,
                    )
                    print(
                        f"[hermes-agent] API error {status_code} (attempt {attempt + 1}/{API_MAX_RETRIES + 1}), "
                        f"retrying in {delay:.1f}s: {error_message[:120]}",
                        flush=True,
                    )
                    time.sleep(delay)
                    continue

                raise RuntimeError(
                    f"Provider error ({status_code}) for model '{self.model}': {error_message}"
                ) from exc
            except (httpx.TimeoutException, httpx.HTTPError) as exc:
                last_error = exc
                if attempt < API_MAX_RETRIES:
                    delay = min(
                        API_RETRY_BASE_DELAY * (2 ** attempt),
                        API_RETRY_MAX_DELAY,
                    )
                    print(
                        f"[hermes-agent] Network error (attempt {attempt + 1}/{API_MAX_RETRIES + 1}), "
                        f"retrying in {delay:.1f}s: {exc}",
                        flush=True,
                    )
                    time.sleep(delay)
                    continue

                raise RuntimeError(
                    f"Failed to reach provider endpoint at {self.base_url} after "
                    f"{API_MAX_RETRIES + 1} attempts: {exc}"
                ) from exc

        # Should not reach here, but just in case
        raise RuntimeError(
            f"All {API_MAX_RETRIES + 1} API attempts failed for model '{self.model}'"
        ) from last_error

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
                "\nIMPORTANT: GitHub file access is unavailable for this request because no GitHub token was provided.\n"
                "Do NOT call read_repo_file — the tool will fail.\n"
                "Do NOT ask the user to share files, clone the repo, or provide a token.\n"
                "Answer using only the repository file tree (if available), issue text, and any other supplied context.\n"
                "Mention the limitation once briefly and focus on what you CAN answer from available context.\n"
            )
            return (
                f"You are working on the GitHub repository {repo_full}.\n"
                "GitHub API access is not available for this session (no token configured).\n\n"
                "CRITICAL RULES:\n"
                "- Do NOT ask the user clarifying questions or to provide files/tokens.\n"
                "- Do NOT list options and ask the user to choose.\n"
                "- Answer based on available context (file tree, issue text, conversation history).\n"
                "- Make reasonable assumptions and explain them.\n"
                f"{repo_access_instruction}"
                f"\n{current_turn_instruction}\n"
            )
        # Include the file tree if available so the model knows what files exist
        file_tree_section = ""
        if self.repo_file_tree:
            file_tree_section = (
                "\nThe repository file tree is available below. Use it to identify candidate files "
                "before calling read_repo_file. Do NOT ask the user to provide file paths.\n\n"
                "Repository file tree:\n"
                + "\n".join(self.repo_file_tree)
                + "\n\n"
            )
        elif self.github_pat:
            file_tree_section = (
                "\nThe repository file tree was not pre-loaded. Use read_repo_file with path '' "
                "to list the root directory and discover files.\n\n"
            )

        return (
            f"You are working on the GitHub repository {repo_full}.\n"
            "You have tools to read, edit, create, and delete files in this repo.\n\n"
            "CRITICAL RULES (apply to ALL requests — read-only AND change requests):\n"
            "- Do NOT ask the user clarifying questions. Use your judgment and explore the repo yourself.\n"
            "- Do NOT ask the user which file to look at or edit — use read_repo_file to discover the codebase.\n"
            "- Do NOT list options and ask the user to choose. Make reasonable assumptions and explain them.\n"
            "- If a tool call fails (e.g. 404), try alternative paths (read the root directory, try common file names) before giving up.\n"
            "- When you need more context, use the actual repo tools instead of prose about what you will do next.\n"
            "- Do NOT paste code blocks, pseudo-code, or raw file content when repo tools are available. Use the tools.\n\n"
            f"{file_tree_section}"
            "First determine whether the current user turn is asking for read-only repository help or for actual code changes.\n"
            "- If the user is asking what the repo is, how it works, where something lives, or for analysis/review, stay read-only: inspect files as needed and answer directly.\n"
            "- Only enter the edit workflow when the user explicitly asks you to modify the repository.\n"
            "- Never treat repo selection by itself as permission to edit.\n\n"
            "Operate like a code agent: inspect the repo with tools, make concrete changes with tools when requested, "
            "and keep narration brief.\n\n"
            "WORKFLOW — FOR CHANGE REQUESTS:\n"
            "1. Use read_repo_file to read files and understand the codebase.\n"
            "2. Use batch_edit_repo_files to apply changes.\n"
            "3. When making changes, address ALL requested changes, not just one.\n"
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
        last_content_with_tools: Optional[str] = None  # fallback for empty responses
        length_continuations = 0  # track finish_reason="length" retries
        context_was_reset = False  # track whether we've done a full reset
        edit_contract_injected = False  # track planning contract injection

        for iteration in range(self.max_iterations):
            # Full context reset (once) when the session is long-running.
            # Harness pattern: resets with structured handoffs beat in-place
            # compaction for maintaining output quality (Anthropic research).
            if not context_was_reset and self._should_reset_context(messages, iteration):
                messages = self._build_context_handoff(messages, user_message, iteration)
                context_was_reset = True
            else:
                # Fall back to compaction when reset isn't warranted
                messages = self._compact_context(messages)

            # Budget pressure warning
            budget_warning = _get_budget_warning(iteration, self.max_iterations)
            if budget_warning:
                print(f"[hermes-agent] {budget_warning}", flush=True)

            print(f"[hermes-agent] Iteration {iteration + 1}/{self.max_iterations}, msgs={len(messages)}", flush=True)
            if self.on_thinking:
                self.on_thinking(iteration + 1)
            response = self._call_api(messages, forced_repo_tool_choice=forced_repo_tool_choice)
            forced_repo_tool_choice = None

            choice = response["choices"][0]
            message = choice["message"]
            finish_reason = choice.get("finish_reason", "stop")
            raw_content = message.get("content") or ""

            # Extract <think> blocks from reasoning models (DeepSeek, QwQ, etc.)
            if raw_content and "<think>" in raw_content:
                visible_content, reasoning_text = _extract_think_blocks(raw_content)
                message["content"] = visible_content
                if reasoning_text and self.on_reasoning:
                    self.on_reasoning(reasoning_text)
            else:
                visible_content = raw_content
            # Recover tool calls the model emitted as inline <function=...> text
            # instead of the structured tool_calls field, so the intended tool
            # actually runs instead of leaking into the visible message.
            if not message.get("tool_calls"):
                recovered_calls = _parse_inline_tool_calls(visible_content)
                if recovered_calls:
                    message["tool_calls"] = recovered_calls
                    print(
                        f"[hermes-agent] Recovered {len(recovered_calls)} inline tool call(s) "
                        f"from text: {[c['function']['name'] for c in recovered_calls]}",
                        flush=True,
                    )
            # Strip inline tool-call XML (function_calls, tool_call, invoke, etc.)
            # that some models emit as text alongside / instead of structured tool_calls
            visible_content = _strip_tool_call_xml(visible_content)
            message["content"] = visible_content

            # OpenRouter returns reasoning_content for some models (o-series, DeepSeek-R1)
            api_reasoning = message.get("reasoning_content") or ""
            if api_reasoning and self.on_reasoning:
                self.on_reasoning(api_reasoning)

            tool_call_count = len(message.get("tool_calls") or [])
            content_preview = visible_content[:100]
            print(f"[hermes-agent] Response: finish_reason={finish_reason} content_len={len(visible_content)} tool_calls={tool_call_count} preview={content_preview!r}", flush=True)

            # Handle finish_reason="length" — response was truncated
            if finish_reason == "length" and length_continuations < FINISH_LENGTH_MAX_CONTINUATIONS:
                length_continuations += 1
                if visible_content:
                    messages.append({"role": "assistant", "content": visible_content})
                    if self.on_text:
                        self.on_text(visible_content)
                messages.append({
                    "role": "user",
                    "content": "[System: Your response was truncated due to length. Please continue from where you left off.]",
                })
                print(
                    f"[hermes-agent] finish_reason=length, continuation {length_continuations}/{FINISH_LENGTH_MAX_CONTINUATIONS}",
                    flush=True,
                )
                continue
            length_continuations = 0  # reset on non-length finish

            # Empty content fallback — use prior turn content if model returns blank
            if not visible_content and not message.get("tool_calls") and last_content_with_tools:
                print("[hermes-agent] Empty response, using prior content as fallback", flush=True)
                visible_content = last_content_with_tools
                message["content"] = visible_content

            # Emit any text content (inject budget warning into the stream if needed)
            if visible_content:
                if self.on_text:
                    self.on_text(visible_content)
                if budget_warning and self.on_text:
                    self.on_text(f"\n\n> *{budget_warning}*\n\n")

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

            # Deduplicate tool calls
            tool_calls = _deduplicate_tool_calls(tool_calls)

            # Track content for empty-response fallback
            if visible_content and tool_calls:
                last_content_with_tools = visible_content

            # Add assistant message with tool calls to history
            messages.append(message)

            # --- Parse and validate tool call arguments ---
            parsed_tool_calls: list[tuple[dict, str, dict]] = []  # (tc, tool_name, arguments)
            for tc in tool_calls:
                func = tc["function"]
                raw_tool_name = func["name"]
                tool_name = _normalize_tool_name(raw_tool_name)
                if tool_name != raw_tool_name:
                    print(f"[hermes-agent] Normalized tool name: {raw_tool_name!r} -> {tool_name!r}", flush=True)

                # Invalid JSON recovery: inject error tool result instead of silent {}
                try:
                    arguments = json.loads(func["arguments"])
                except (json.JSONDecodeError, TypeError):
                    error_msg = (
                        f"Error: Invalid JSON in tool call arguments for '{tool_name}'. "
                        f"Raw arguments: {func.get('arguments', '')[:200]}. "
                        "Please retry with valid JSON arguments."
                    )
                    print(f"[hermes-agent] Invalid JSON for {tool_name}: {func.get('arguments', '')[:100]}", flush=True)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": error_msg,
                    })
                    continue

                parsed_tool_calls.append((tc, tool_name, arguments))

            # --- Execute tool calls (parallel or sequential) ---
            if _should_parallelize_tool_batch([tc for tc, _, _ in parsed_tool_calls]):
                # Parallel execution for read-only safe tools
                print(f"[hermes-agent] Executing {len(parsed_tool_calls)} tool calls in parallel", flush=True)
                results: dict[str, str] = {}  # tc_id -> result

                def _run_one(tc_tuple):
                    tc, tool_name, arguments = tc_tuple
                    tool_input = json.dumps(arguments)
                    if self.on_tool_start:
                        self.on_tool_start(tool_name, tool_input)
                    if tool_name in REPO_TOOL_NAMES:
                        try:
                            result = self._execute_repo_tool(tool_name, arguments)
                        except Exception as e:
                            result = f"Error executing {tool_name}: {str(e)}"
                    elif tool_name in self._mcp_tool_routes:
                        route = self._mcp_tool_routes[tool_name]
                        result = _execute_mcp_tool(
                            route["url"], tool_name, arguments, route.get("api_key"),
                        )
                    else:
                        result = _execute_tool(tool_name, arguments)
                    if self.on_tool_end:
                        self.on_tool_end(tool_name, tool_input, result)
                    return tc["id"], result

                with ThreadPoolExecutor(max_workers=min(_MAX_PARALLEL_WORKERS, len(parsed_tool_calls))) as executor:
                    futures = {executor.submit(_run_one, t): t for t in parsed_tool_calls}
                    for future in as_completed(futures):
                        tc_id, result = future.result()
                        results[tc_id] = result

                # Append results in original order
                for tc, tool_name, arguments in parsed_tool_calls:
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": results.get(tc["id"], "Error: result not found"),
                    })
            else:
                # Sequential execution
                for tc, tool_name, arguments in parsed_tool_calls:
                    tool_input = json.dumps(arguments)

                    is_mcp = tool_name in self._mcp_tool_routes
                    print(f"[hermes-agent] Tool call: {tool_name} args_keys={list(arguments.keys())} repo_tool={tool_name in REPO_TOOL_NAMES} mcp={is_mcp}", flush=True)
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

                    if is_mcp:
                        route = self._mcp_tool_routes[tool_name]
                        result = _execute_mcp_tool(
                            route["url"], tool_name, arguments, route.get("api_key"),
                        )
                    else:
                        result = _execute_tool(tool_name, arguments)

                    if self.on_tool_end:
                        self.on_tool_end(tool_name, tool_input, result)

                    # Add tool result to messages
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": result,
                    })

            # --- Inject budget pressure into last tool result ---
            if budget_warning and messages and messages[-1].get("role") == "tool":
                messages[-1]["content"] = messages[-1]["content"] + f"\n\n{budget_warning}"

            # --- Post-tool-execution: verification and reflection ---
            executed_tool_names = [
                tool_name for _, tool_name, _ in parsed_tool_calls
            ]

            # Evaluator phase: after edit tools, run a skeptical review.
            # Harness pattern: separate evaluator tuned toward skepticism
            # catches issues that self-evaluating generators miss (Anthropic
            # harness design research).  The evaluator should resist the urge
            # to declare everything "looks good" — it must actively search
            # for problems.
            made_edits = any(name in REPO_EDIT_TOOL_NAMES for name in executed_tool_names)
            if made_edits and self.repo_mode:
                messages.append({
                    "role": "user",
                    "content": (
                        "[System — EVALUATOR PHASE: Briefly review the changes "
                        "you just staged.\n\n"
                        "Check: (1) Did you address the user's full request? "
                        "(2) Any obvious syntax errors or missing imports? "
                        "(3) Does the code style match the repo?\n\n"
                        "If everything looks correct, provide a short summary "
                        "of what was changed and stop. Do NOT re-apply the same "
                        "edits. Do NOT read files you just edited — the staged "
                        "content is already applied. Only make additional tool "
                        "calls if you find a concrete, specific bug in your "
                        "changes.]"
                    ),
                })
                print(f"[hermes-agent] Injected evaluator phase after edit tools.", flush=True)

            # Contract phase: when the agent has read files and has edit
            # intent but hasn't started editing, inject a planning contract.
            # Harness pattern: pre-agreement on "done" between planner and
            # evaluator bridges high-level specs to testable implementation
            # (Anthropic harness design research).
            elif not made_edits and self.repo_mode and self.repo_edit_intent:
                did_read = any(name == "read_repo_file" for name in executed_tool_names)
                if did_read and not edit_contract_injected:
                    edit_contract_injected = True
                    messages.append({
                        "role": "user",
                        "content": (
                            "[System — PLANNING CONTRACT: Before editing, write a "
                            "brief plan (3-8 lines) that states:\n"
                            "1. Which files you will modify/create/delete\n"
                            "2. What each change achieves\n"
                            "3. What 'done' looks like — how would someone verify "
                            "your changes work?\n\n"
                            "Then immediately begin implementing with the repo "
                            "edit tools.  The evaluator will grade your work "
                            "against this contract.]"
                        ),
                    })
                    print(f"[hermes-agent] Injected planning contract prompt.", flush=True)
                else:
                    messages.append({
                        "role": "user",
                        "content": (
                            "[System: The user requested changes but no edits "
                            "have been made yet. Use the available edit tools "
                            "(edit_repo_file, batch_edit_repo_files) to "
                            "implement the requested changes now.]"
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
