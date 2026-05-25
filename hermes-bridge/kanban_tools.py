"""
Kanban agent tools: tools that let the agent read/update kanban cards
via HTTP calls back to the Express server.

Defines both cloud-chat-hub-native tool names (kanban_read_current_card,
kanban_update_status, kanban_append_report) AND hermes-agent-compatible
aliases (kanban_show, kanban_complete, kanban_block, kanban_heartbeat,
kanban_comment, kanban_list, kanban_create) so models trained on either
convention work correctly.
"""

import json
import os
from urllib.parse import urlencode

KANBAN_TOOL_DEFINITIONS = [
    # ── cloud-chat-hub native tools ──────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "kanban_read_current_card",
            "description": "Read the full details of the kanban card this session is working on. Returns card spec, acceptance criteria, status, and any previous report.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kanban_update_status",
            "description": "Update the status of the current kanban card. Use 'review' when the work is ready for human review, 'blocked' when stuck, 'done' when fully completed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["review", "blocked", "done"],
                        "description": "New status lane for the card",
                    },
                    "report_summary": {
                        "type": "string",
                        "description": "Summary of what was done, key findings, or next steps (optional)",
                    },
                },
                "required": ["status"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kanban_append_report",
            "description": "Append notes or progress to the current kanban card without changing its status.",
            "parameters": {
                "type": "object",
                "properties": {
                    "notes": {
                        "type": "string",
                        "description": "Progress notes or report to append to the card",
                    }
                },
                "required": ["notes"],
            },
        },
    },
    # ── hermes-agent compatible tools ────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "kanban_show",
            "description": "Read the current task (title, body, prior attempts, parent handoffs, comments, full pre-formatted worker_context). Defaults to the env's task id.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kanban_complete",
            "description": "Finish with summary + metadata structured handoff.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Summary of what was accomplished",
                    },
                    "metadata": {
                        "type": "object",
                        "description": "Optional structured metadata for the handoff (ignored in cloud-chat-hub)",
                    },
                    "artifacts": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of artifact file paths (ignored in cloud-chat-hub)",
                    },
                },
                "required": ["summary"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kanban_block",
            "description": "Escalate for human input with a reason.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Why the task is blocked and what input is needed",
                    }
                },
                "required": ["reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kanban_heartbeat",
            "description": "Signal liveness during long operations. Pure side-effect — appends a heartbeat note to the card report.",
            "parameters": {
                "type": "object",
                "properties": {
                    "note": {
                        "type": "string",
                        "description": "Optional progress note to include with the heartbeat",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kanban_comment",
            "description": "Append a durable note to the task thread.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "Task ID to comment on (defaults to current card if omitted)",
                    },
                    "body": {
                        "type": "string",
                        "description": "Comment text to append",
                    },
                },
                "required": ["body"],
            },
        },
    },
    # ── hermes-agent orchestrator tools ──────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "kanban_list",
            "description": "List task summaries with filters for assignee, status, and limit. Intended for orchestrators discovering board work.",
            "parameters": {
                "type": "object",
                "properties": {
                    "assignee": {
                        "type": "string",
                        "description": "Filter by assigned worker profile name",
                    },
                    "status": {
                        "type": "string",
                        "description": "Filter by status lane (ready, running, blocked, done, review, backlog)",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max number of cards to return (default 50, max 200)",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kanban_create",
            "description": "Fan out into child tasks with an assignee, optional parents, and skills.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Title of the new task",
                    },
                    "assignee": {
                        "type": "string",
                        "description": "Profile name of the worker to assign",
                    },
                    "body": {
                        "type": "string",
                        "description": "Task description / spec body",
                    },
                    "parents": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional parent task IDs for dependency linking",
                    },
                    "skills": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional skill names to attach to the worker",
                    },
                },
                "required": ["title", "assignee"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kanban_link",
            "description": "Add a parent_id → child_id dependency edge between two cards. Child is demoted from ready to backlog if parent isn't done.",
            "parameters": {
                "type": "object",
                "properties": {
                    "parent_id": {
                        "type": "string",
                        "description": "ID of the parent task",
                    },
                    "child_id": {
                        "type": "string",
                        "description": "ID of the child task that depends on the parent",
                    },
                },
                "required": ["parent_id", "child_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kanban_unblock",
            "description": "Move a blocked task back to ready so the dispatcher re-picks it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "ID of the blocked task to unblock",
                    },
                },
                "required": ["task_id"],
            },
        },
    },
]

KANBAN_TOOL_NAMES = {t["function"]["name"] for t in KANBAN_TOOL_DEFINITIONS}


def _api_base() -> str:
    return os.environ.get("CLOUDCHAT_API_BASE", "http://localhost:3001")


def _fetch(path: str, method: str = "GET", body: dict | None = None, retries: int = 2) -> dict | None:
    """Make an HTTP request to the Express kanban API."""
    import httpx

    url = f"{_api_base()}{path}"
    for attempt in range(retries):
        try:
            kwargs: dict = {"method": method, "timeout": 10}
            if body is not None:
                kwargs["json"] = body
            with httpx.Client() as client:
                resp = client.request(**kwargs, url=url)
                resp.raise_for_status()
                return resp.json()
        except Exception:
            if attempt == retries - 1:
                return None
            import time
            time.sleep(1)
    return None


def _find_current_card(card_ids_to_try: list[str]) -> dict | None:
    """Try to find the card by ID, falling back to first running card."""
    data = _fetch("/api/hermes/kanban")
    if not data:
        return None
    cards = data.get("cards", [])

    # Try each candidate ID
    for cid in card_ids_to_try:
        for card in cards:
            if card.get("id") == cid:
                return card

    # Fallback: return first running card
    for card in cards:
        if card.get("status") == "running":
            return card

    return None


def _active_card_ids() -> list[str]:
    """Read card IDs from env var (comma-separated) or context."""
    ids = os.environ.get("KANBAN_CARD_ID", "")
    if ids:
        return [sid.strip() for sid in ids.split(",") if sid.strip()]
    return []


# ═══════════════════════════════════════════════════════════════════════════
# cloud-chat-hub native tools
# ═══════════════════════════════════════════════════════════════════════════

def kanban_read_current_card() -> str:
    """Read the current kanban card this agent is working on."""
    card = _find_current_card(_active_card_ids())
    if not card:
        return "Error: No active kanban card found. This session was not launched from a kanban card."

    lines = [
        f"Card: {card.get('title', 'Untitled')}",
        f"Status: {card.get('status', 'unknown')}",
        f"ID: {card.get('id', 'unknown')}",
    ]
    spec = card.get("spec", "")
    if spec:
        lines.extend(["", "Spec:", spec])
    criteria = card.get("acceptanceCriteria", [])
    if criteria:
        lines.extend(["", "Acceptance criteria:"])
        for c in criteria:
            lines.append(f"  - {c}")
    report = card.get("reportPath") or ""
    if report:
        lines.extend(["", "Previous report:", report])
    return "\n".join(lines)


def kanban_update_status(status: str, report_summary: str | None = None) -> str:
    """Update the current card's status lane."""
    card = _find_current_card(_active_card_ids())
    if not card:
        return "Error: No active kanban card found."

    cid = card["id"]
    try:
        body: dict = {"status": status}
        if report_summary:
            body["reportPath"] = report_summary
        result = _fetch(f"/api/hermes/kanban/{cid}", method="PATCH", body=body)
        if result is None:
            return "Error: Failed to update card status (API unreachable)."
        return f"Card status updated to '{status}'." + (" Report saved." if report_summary else "")
    except Exception as e:
        return f"Error updating card status: {str(e)}"


def kanban_append_report(notes: str) -> str:
    """Append notes to the current card's report field."""
    card = _find_current_card(_active_card_ids())
    if not card:
        return "Error: No active kanban card found."

    cid = card["id"]
    try:
        existing = card.get("reportPath") or ""
        new_report = (existing + "\n---\n" + notes) if existing else notes
        result = _fetch(f"/api/hermes/kanban/{cid}", method="PATCH", body={"reportPath": new_report})
        if result is None:
            return "Error: Failed to append notes (API unreachable)."
        return "Notes appended to card."
    except Exception as e:
        return f"Error appending notes: {str(e)}"


# ═══════════════════════════════════════════════════════════════════════════
# hermes-agent compatible tools
# ═══════════════════════════════════════════════════════════════════════════

def kanban_show() -> str:
    """Read the current task — hermes-agent compatible alias for kanban_read_current_card."""
    return kanban_read_current_card()


def kanban_complete(summary: str, metadata: dict | None = None, artifacts: list | None = None) -> str:
    """Complete the current task — hermes-agent compatible alias.
    Maps to kanban_update_status('done', summary)."""
    return kanban_update_status("done", summary)


def kanban_block(reason: str) -> str:
    """Block the current task — hermes-agent compatible alias.
    Maps to kanban_update_status('blocked', reason)."""
    return kanban_update_status("blocked", reason)


def kanban_heartbeat(note: str | None = None) -> str:
    """Signal liveness — appends a heartbeat note to the card report."""
    timestamp = __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    msg = f"[heartbeat {timestamp}]"
    if note:
        msg += f" {note}"
    return kanban_append_report(msg)


def kanban_comment(task_id: str | None = None, body: str = "") -> str:
    """Append a comment to the task thread — hermes-agent compatible alias for kanban_append_report."""
    if not body:
        return "Error: body is required for kanban_comment."
    return kanban_append_report(body)


# ═══════════════════════════════════════════════════════════════════════════
# hermes-agent orchestrator tools
# ═══════════════════════════════════════════════════════════════════════════

def kanban_list(assignee: str | None = None, status: str | None = None, limit: int = 50) -> str:
    """List kanban cards with optional filters."""
    params = {}
    if status:
        params["status"] = status
    if assignee:
        params["worker"] = assignee

    query_string = urlencode(params) if params else ""
    path = f"/api/hermes/kanban{'?' + query_string if query_string else ''}"
    data = _fetch(path)
    if not data:
        return "Error: Failed to fetch kanban cards (API unreachable)."

    cards = data.get("cards", [])
    if not cards:
        return "No kanban cards found matching the specified filters."

    capped = cards[: min(limit, 200)]
    lines = [f"Found {len(cards)} card(s) (showing {len(capped)}):"]
    for card in capped:
        lines.append(f"\n  [{card.get('status', '?')}] {card.get('title', 'Untitled')}")
        lines.append(f"    ID: {card.get('id', '?')}")
        worker = card.get("assignedWorker")
        if worker:
            lines.append(f"    Assignee: {worker}")
    return "\n".join(lines)


def kanban_create(
    title: str,
    assignee: str,
    body: str | None = None,
    parents: list | None = None,
    skills: list | None = None,
) -> str:
    """Create a new kanban card — hermes-agent compatible alias."""
    if not title or not assignee:
        return "Error: title and assignee are required for kanban_create."

    request_body: dict = {
        "title": title,
        "assignedWorker": assignee,
        "status": "ready",
    }
    if body:
        request_body["spec"] = body
    if skills:
        # Append skills to the spec so they're visible in the card
        skills_str = "\n".join(f"- Skill: {s}" for s in skills)
        existing_spec = request_body.get("spec", "")
        request_body["spec"] = f"{existing_spec}\n\nSkills:\n{skills_str}" if existing_spec else f"Skills:\n{skills_str}"
    if parents:
        # Embed parent references in the spec for now
        parents_str = ", ".join(parents)
        existing_spec = request_body.get("spec", "")
        request_body["spec"] = f"Parents: {parents_str}\n\n{existing_spec}" if existing_spec else f"Parents: {parents_str}"

    result = _fetch("/api/hermes/kanban", method="POST", body=request_body)
    if not result:
        return "Error: Failed to create kanban card (API unreachable)."

    card = result.get("card", {})
    card_id = card.get("id", "unknown")
    return f"Kanban card created: '{title}' assigned to @{assignee} (ID: {card_id})"


def kanban_link(parent_id: str, child_id: str) -> str:
    """Create a parent→child dependency link between two kanban cards."""
    if not parent_id or not child_id:
        return "Error: parent_id and child_id are required for kanban_link."

    result = _fetch("/api/hermes/kanban/link", method="POST", body={
        "parent_id": parent_id,
        "child_id": child_id,
    })
    if not result:
        return "Error: Failed to create link (API unreachable)."
    return f"Linked: {parent_id} → {child_id}"


def kanban_unblock(task_id: str) -> str:
    """Unblock a kanban card, moving it back to ready for the dispatcher to re-pick."""
    if not task_id:
        return "Error: task_id is required for kanban_unblock."

    result = _fetch(f"/api/hermes/kanban/{task_id}/unblock", method="POST")
    if not result:
        return "Error: Failed to unblock card (API unreachable)."
    return f"Card {task_id} unblocked — moved to ready."
