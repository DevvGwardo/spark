"""ACP transport helpers: repo grounding, plan text, idle reaper, keepalive.

The request flow itself is ``chat_transports.acp.AcpTransport`` (spec 4.2).
Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import asyncio
import os
import re
from typing import Optional


# SSE comment keepalive for ACP streams. The Express SSE proxy
# (server/direct-sse-proxy.ts) aborts after STREAM_ACTIVITY_TIMEOUT_MS
# (default 30s) of zero bytes. File writes and approval waits are silent
# on the wire, so this MUST stay well under 30s. The agent-loop path
# heartbeats after 3s of silence (chat_transports.drain).
def _acp_sse_heartbeat_seconds() -> float:
    raw = os.environ.get("HERMES_ACP_SSE_HEARTBEAT_SECONDS", "10").strip()
    try:
        value = float(raw)
    except ValueError:
        return 10.0
    if value <= 0:
        return 10.0
    return value


ACP_SSE_HEARTBEAT_SECONDS = _acp_sse_heartbeat_seconds()


# ------------------------------------------------------------------
# ACP transport — drive the REAL hermes-agent via Agent Client Protocol
# ------------------------------------------------------------------
# ``x-hermes-execution-mode: acp`` spawns ``hermes-acp`` (hermes-agent's ACP
# stdio server) per conversation and relays its ``task/update`` notifications
# into the same SSE shapes the agent-loop transport emits, so the UI renders
# real hermes tools without any UI changes. The reimplemented loop in
# run_agent.py is not used on this path.

_acp_reaper_task = None


def _ensure_acp_reaper() -> None:
    """Start the idle-session reaper once (called from the first ACP request)."""
    global _acp_reaper_task
    if _acp_reaper_task is None or _acp_reaper_task.done():
        _acp_reaper_task = asyncio.create_task(_acp_reaper_loop())


async def _acp_reaper_loop() -> None:
    while True:
        try:
            await asyncio.sleep(60)
            import acp_transport

            closed = await acp_transport.reap_idle_sessions()
            if closed:
                print(f"[hermes-bridge] ACP idle reaper closed {closed} session(s)", flush=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass


def _content_to_text(content) -> str:
    """Coerce a normalized message content (str or multimodal list) to text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    parts.append(block["text"])
                elif isinstance(block.get("content"), str):
                    parts.append(block["content"])
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return str(content or "")


def _format_plan_text(entries) -> str:
    """Render ACP ``plan_update`` entries as markdown text for the chat stream.

    The SSE protocol has no dedicated plan event (frontend HermesEvent types
    are text / tool_activity / agent_status / reasoning / server_tool_event),
    so the plan is forwarded as visible content — the same way the swarm path
    streams its plan summary.
    """
    if not entries:
        return ""
    lines = ["\n### Plan"]
    for entry in entries:
        text = str(getattr(entry, "content", "") or "").strip()
        if not text:
            continue
        status = str(getattr(entry, "status", "") or "")
        marker = {"completed": "- [x]", "in_progress": "- [ ]", "pending": "- [ ]"}.get(status, "-")
        lines.append(f"{marker} {text}")
    return "\n".join(lines) + "\n" if len(lines) > 1 else ""


# Cap for the repo file-tree preview injected into the ACP prompt (bounds the
# added tokens while still giving the model real paths on attempt #1).
_ACP_REPO_TREE_PREVIEW_LIMIT = 150

# Managed local checkouts (see server/repo-clone-manager.ts MANAGED_REPOS_ROOT).
_MANAGED_REPOS_ROOT = os.path.join(os.path.expanduser("~"), ".cloudchat", "repos")

# Owner/name segments must be single plain directory names — never a traversal.
_SAFE_REPO_SEGMENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*\Z")


def _resolve_acp_repo_root(
    repo_root_header: str = "",
    repo_owner: str = "",
    repo_name: str = "",
) -> str:
    """Resolve the ACP session cwd to a real repo checkout.

    Preference: explicit X-Hermes-Repo-Root header (when it exists on disk),
    then the managed clone at ~/.cloudchat/repos/<owner>/<name> (covers turns
    where the client sent owner/name but no root — previously these fell back
    to the bridge process cwd, so every relative read/search missed and the
    model probed blind). Returns "" when nothing resolves; callers fall back
    to getcwd()/home as before.
    """
    header = (repo_root_header or "").strip()
    if header and os.path.isdir(header):
        return header
    owner = (repo_owner or "").strip()
    name = (repo_name or "").strip()
    if (
        owner
        and name
        and _SAFE_REPO_SEGMENT_RE.fullmatch(owner)
        and _SAFE_REPO_SEGMENT_RE.fullmatch(name)
    ):
        candidate = os.path.join(_MANAGED_REPOS_ROOT, owner, name)
        if os.path.isdir(candidate):
            return candidate
    return ""


def _build_acp_repo_context_prefix(
    *,
    repo_owner: str = "",
    repo_name: str = "",
    repo_root: str = "",
    repo_file_tree: Optional[list] = None,
) -> str:
    """Build a short repo-context preamble for the ACP user prompt.

    The ACP transport forwards only the last user message to hermes-acp, so
    without this the model starts repo turns blind (no checkout path, no file
    list) and its first tool batch is context-free probing — e.g. reads with
    empty args that render as ``read: ?`` and fail. Returns "" when there is
    no repo signal so non-repo turns are byte-identical to before.
    """
    owner = (repo_owner or "").strip()
    name = (repo_name or "").strip()
    root = (repo_root or "").strip()
    tree = [p for p in (repo_file_tree or []) if isinstance(p, str) and p.strip()]
    if not owner and not name and not root and not tree:
        return ""
    label = f"{owner}/{name}" if owner and name else (owner or name or "attached repo")
    lines = [f"[Repo context: {label}."]
    if root:
        lines.append(f"Local checkout at: {root} (this is your working directory).")
        # Name the real session tools with exact arg shapes. The server-side
        # repo prompt teaches `read_repo_file` (a loop/SDK tool that does not
        # exist in this ACP session); without this mapping the model emits
        # empty-path `read` calls that render as `read: ?` and fail, and never
        # discovers file search at all.
        lines.append(
            "File tools in this session: `read_file` {path} reads a file; "
            "`search_files` {pattern, path} searches contents (ripgrep-backed — "
            "use it instead of grep). If your instructions mention "
            "`read_repo_file`, that is `read_file` here: always pass a real "
            "`path` from the list below, never an empty one."
        )
    if tree:
        shown = tree[:_ACP_REPO_TREE_PREVIEW_LIMIT]
        lines.append(f"Known files ({len(tree)} total{', showing ' + str(len(shown)) if len(tree) > len(shown) else ''}):")
        lines.extend(f"- {path}" for path in shown)
    lines.append("Read real paths from the list above; do not guess blind paths.]")
    return "\n".join(lines)
