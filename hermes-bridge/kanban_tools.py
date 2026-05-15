"""
Kanban agent tools: tools that let the agent read/update kanban cards
via HTTP calls back to the Express server.
"""

import json
import os

KANBAN_TOOL_DEFINITIONS = [
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
