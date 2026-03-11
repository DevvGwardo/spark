"""
AIAgent: Agentic loop over OpenRouter with tool calling.

Sends messages to a Nous Hermes model, handles tool calls (web search,
browse URL, etc.), and streams results back via callbacks.
"""

import json
import httpx
import re
from typing import Optional, Callable
from urllib.parse import quote_plus

KNOWN_UNSUPPORTED_TOOL_MODELS = {
    "nousresearch/hermes-3-llama-3.1-405b:free",
}

SUGGESTED_TOOL_MODELS = (
    "meta-llama/llama-4-maverick",
    "openai/gpt-4.1-mini",
    "google/gemini-2.5-flash",
)

REPO_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "propose_changes",
            "description": "Propose a plan of changes to the repository. Always call this before making edits. The user must approve before you proceed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "A brief summary of what will change",
                    },
                    "plan": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string", "description": "File path"},
                                "action": {"type": "string", "enum": ["create", "edit", "delete"]},
                                "description": {"type": "string", "description": "What will change"},
                            },
                            "required": ["path", "action", "description"],
                        },
                        "description": "List of file changes",
                    },
                },
                "required": ["summary", "plan"],
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
    "vision": [],
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


def _execute_tool(name: str, arguments: dict) -> str:
    """Execute a tool and return its result as a string."""
    try:
        if name == "web_search":
            return _tool_web_search(arguments["query"])
        elif name == "browse_url":
            return _tool_browse_url(arguments["url"])
        elif name == "run_command":
            return _tool_run_command(arguments["command"])
        elif name == "read_file":
            return _tool_read_file(arguments["path"])
        elif name == "write_file":
            return _tool_write_file(arguments["path"], arguments["content"])
        elif name == "execute_python":
            return _tool_execute_python(arguments["code"])
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
    with httpx.Client(timeout=20, follow_redirects=True) as client:
        resp = client.get(url, headers=headers)
        resp.raise_for_status()
    text = _strip_html(resp.text)
    # Truncate to avoid blowing up context
    if len(text) > 15000:
        text = text[:15000] + "\n\n[Content truncated]"
    return text


def _tool_run_command(command: str) -> str:
    import subprocess
    result = subprocess.run(
        command, shell=True, capture_output=True, text=True, timeout=30
    )
    output = ""
    if result.stdout:
        output += result.stdout
    if result.stderr:
        output += ("\n" if output else "") + result.stderr
    if result.returncode != 0:
        output += f"\n[Exit code: {result.returncode}]"
    return output or "(no output)"


def _tool_read_file(path: str) -> str:
    with open(path, "r") as f:
        content = f.read()
    if len(content) > 20000:
        content = content[:20000] + "\n\n[Content truncated]"
    return content


def _tool_write_file(path: str, content: str) -> str:
    import os
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
    return f"Written {len(content)} bytes to {path}"


def _tool_execute_python(code: str) -> str:
    import subprocess
    result = subprocess.run(
        ["python3", "-c", code], capture_output=True, text=True, timeout=30
    )
    output = ""
    if result.stdout:
        output += result.stdout
    if result.stderr:
        output += ("\n" if output else "") + result.stderr
    return output or "(no output)"


def _clean_model_text(text: str) -> str:
    """Clean raw model text before streaming to the user.

    Some models dump raw tool call JSON, file contents, or argument blobs
    directly in their text response alongside (or instead of) proper tool calls.
    This filters out the noise while preserving meaningful prose.
    """
    if not text:
        return text

    # Strip JSON-like blobs that look like tool call arguments
    # e.g. {"path": "...", "content": "...", "action": "edit"}
    cleaned = re.sub(
        r'\{["\s]*(?:path|content|action|changes|description|summary)["\s]*:[\s\S]{200,}?\}',
        '',
        text,
    )

    # Strip raw file content dumps: strings with many literal \n sequences
    # that look like code being passed as an argument value
    # (e.g. `"content": "import React...;\nfunction App() {\n..."`)
    cleaned = re.sub(
        r'"content"\s*:\s*"(?:[^"\\]|\\.){200,}"',
        '',
        cleaned,
    )

    # If after cleaning there's nothing meaningful left, return empty
    stripped = cleaned.strip()
    if not stripped or stripped in ('{}', '[]', ',', ';'):
        return ''

    return cleaned


def _format_pseudo_tool_call(name: str, arguments: dict) -> str:
    """Format a repo tool call as pseudo-tool syntax for frontend extraction.

    String values are serialized with json.dumps so the frontend's
    decodeQuotedString (which uses JSON.parse) can parse them correctly,
    including newlines, tabs, and embedded quotes.
    """
    parts = []
    for key, value in arguments.items():
        if isinstance(value, str):
            parts.append(f'{key}={json.dumps(value)}')
        elif isinstance(value, (list, dict)):
            parts.append(f'{key}={json.dumps(value)}')
        elif isinstance(value, bool):
            parts.append(f'{key}={"True" if value else "False"}')
        elif value is None:
            parts.append(f'{key}=None')
        else:
            parts.append(f'{key}={value}')
    return f'{name}({", ".join(parts)})'


class AIAgent:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        max_iterations: int = 30,
        enabled_toolsets: Optional[list[str]] = None,
        repo_mode: bool = False,
        skip_propose_changes: bool = False,
        github_pat: Optional[str] = None,
        github_repo_owner: Optional[str] = None,
        github_repo_name: Optional[str] = None,
        on_tool_start: Optional[Callable] = None,
        on_tool_end: Optional[Callable] = None,
        on_text: Optional[Callable] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.max_iterations = max_iterations
        self.enabled_toolsets = enabled_toolsets or ["web", "browser", "vision"]
        self.repo_mode = repo_mode
        self.skip_propose_changes = skip_propose_changes
        self.github_pat = github_pat
        self.github_repo_owner = github_repo_owner
        self.github_repo_name = github_repo_name
        self.on_tool_start = on_tool_start
        self.on_tool_end = on_tool_end
        self.on_text = on_text
        self.on_thinking: Optional[Callable] = None

        # Build tool list from enabled toolsets
        self.tools = []
        for toolset in self.enabled_toolsets:
            self.tools.extend(TOOL_DEFINITIONS.get(toolset, []))

        # Add repo tools when in repo mode
        if self.repo_mode:
            repo_tools = REPO_TOOL_DEFINITIONS
            if self.skip_propose_changes:
                repo_tools = [t for t in repo_tools if t["function"]["name"] != "propose_changes"]
            self.tools.extend(repo_tools)

    def _read_github_file(self, path: str) -> str:
        """Read a file from GitHub using the API. Falls back to a hint if no credentials."""
        if not self.github_pat or not self.github_repo_owner or not self.github_repo_name:
            return (
                f"Note: As a Hermes agent, you cannot directly read '{path}' from GitHub. "
                f"Use the repository file tree in the system prompt to understand the structure. "
                f"When editing files, write the complete new content based on common patterns "
                f"for this file type. The user will review your changes before they are applied."
            )
        try:
            url = f"https://api.github.com/repos/{self.github_repo_owner}/{self.github_repo_name}/contents/{path}"
            headers = {
                "Authorization": f"Bearer {self.github_pat}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "Hermes-Agent",
            }
            with httpx.Client(timeout=15) as client:
                resp = client.get(url, headers=headers)
                if resp.status_code == 404:
                    return f"File not found: {path}"
                resp.raise_for_status()
            data = resp.json()
            if not data.get("content"):
                if isinstance(data, list):
                    return f"'{path}' is a directory, not a file."
                return f"File content unavailable for '{path}'."
            import base64
            content = base64.b64decode(data["content"]).decode("utf-8")
            # Truncate very large files to avoid blowing up context
            if len(content) > 30000:
                content = content[:30000] + "\n\n[Content truncated at 30000 chars]"
            print(f"[hermes-agent] Read {path} from GitHub: {len(content)} chars", flush=True)
            return content
        except Exception as e:
            print(f"[hermes-agent] Failed to read {path} from GitHub: {e}", flush=True)
            return f"Error reading file '{path}' from GitHub: {str(e)}"

    def _call_api(self, messages: list[dict]) -> dict:
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
            payload["tools"] = self.tools
            payload["tool_choice"] = "auto"

        with httpx.Client(timeout=120) as client:
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
        return (
            f"You are working on the GitHub repository {repo_full}.\n"
            "You have tools to read, edit, create, and delete files in this repo.\n\n"
            "WORKFLOW — ALWAYS FOLLOW THIS:\n"
            "1. For a NEW change request, FIRST use propose_changes to present a plan. Wait for user approval.\n"
            "2. If the user is approving a previous proposal, do NOT call propose_changes again.\n"
            "3. After approval, use read_repo_file to read files, then batch_edit_repo_files to apply changes.\n"
            "4. Do NOT ask the user which file to edit — explore the repo yourself using read_repo_file.\n"
            "5. Do NOT ask clarifying questions. Use your judgment, explore the repo to understand the codebase, and propose changes directly. If the request is ambiguous, make reasonable assumptions and explain them in your proposal.\n"
            "6. When making changes, address ALL requested changes, not just one.\n"
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

        for iteration in range(self.max_iterations):
            print(f"[hermes-agent] Iteration {iteration + 1}/{self.max_iterations}, msgs={len(messages)}", flush=True)
            if self.on_thinking:
                self.on_thinking(iteration + 1)
            response = self._call_api(messages)

            choice = response["choices"][0]
            message = choice["message"]
            finish_reason = choice.get("finish_reason", "stop")
            content_preview = (message.get("content") or "")[:100]
            tool_call_count = len(message.get("tool_calls") or [])
            print(f"[hermes-agent] Response: finish_reason={finish_reason} content_len={len(message.get('content') or '')} tool_calls={tool_call_count} preview={content_preview!r}", flush=True)

            # Emit any text content (cleaned of raw code/arg dumps)
            if message.get("content"):
                if self.on_text:
                    cleaned = _clean_model_text(message["content"])
                    if cleaned:
                        self.on_text(cleaned)

            # Check for tool calls
            tool_calls = message.get("tool_calls")
            if not tool_calls or finish_reason == "stop":
                break

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
                # Repo tools are forwarded to the frontend via pseudo-tool syntax
                # in the text stream. The frontend's pseudo-tool extraction system
                # parses these and renders them as proper UI elements (proposal cards,
                # file edit previews, etc.) and stages changes in the changeset store.
                if tool_name in REPO_TOOL_NAMES:
                    # read_repo_file is handled server-side (reads from GitHub API)
                    # so we use tool activity callbacks instead of pseudo-tool text.
                    # All other repo tools emit pseudo-tool syntax for the frontend.
                    if tool_name == "read_repo_file":
                        path = arguments.get("path", "")
                        if self.on_tool_start:
                            self.on_tool_start("read_repo_file", path)
                        result = self._read_github_file(path)
                        if self.on_tool_end:
                            self.on_tool_end("read_repo_file", path, f"Read {len(result)} chars from {path}")
                    else:
                        pseudo_text = "\n\n" + _format_pseudo_tool_call(tool_name, arguments) + "\n\n"
                        if self.on_text:
                            self.on_text(pseudo_text)

                        if tool_name == "propose_changes":
                            result = "Proposal sent to the user for review. Wait for their approval before making changes. Do NOT proceed with edits until approved."
                        else:
                            result = f"Change to '{arguments.get('path', '')}' has been staged for the user to review."

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": result,
                    })

                    # After propose_changes, stop the agent loop immediately so the
                    # frontend can show the proposal and wait for user approval.
                    # Without this, models like llama-4-maverick ignore the "wait"
                    # instruction and proceed to edit files in the same turn, causing
                    # an infinite approval loop.
                    if tool_name == "propose_changes":
                        print(f"[hermes-agent] Stopping after propose_changes to wait for user approval.", flush=True)
                        return

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
