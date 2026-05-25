"""
Team collaboration tools: tools that let agents in a team delegate work,
share context, and report progress via HTTP calls back to the Express server.
"""

import json
import os

TEAM_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "team_delegate_to_agent",
            "description": "Delegate a specific subtask to another agent in the team. Use this when you need another agent's expertise for a portion of the work.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_name": {
                        "type": "string",
                        "description": "The profile name of the agent to delegate to",
                    },
                    "subtask": {
                        "type": "string",
                        "description": "Description of the subtask to delegate",
                    },
                    "context": {
                        "type": "string",
                        "description": "Context and handoff information for the delegated task",
                    },
                },
                "required": ["agent_name", "subtask", "context"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "team_report_progress",
            "description": "Report progress on your current subtask to the team coordinator. Use this to share status updates, findings, or request help.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Summary of progress made",
                    },
                    "blockers": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of blockers preventing progress",
                    },
                },
                "required": ["summary"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "team_query_context",
            "description": "Query the shared team context store for relevant information, decisions, artifacts, or findings published by other agents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query_str": {
                        "type": "string",
                        "description": "Search query or keywords to find relevant context entries",
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of tags to filter by",
                    },
                },
                "required": ["query_str"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "team_publish_finding",
            "description": "Publish a finding, decision, or artifact to the shared team context so other agents can reference it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title for the finding",
                    },
                    "content": {
                        "type": "string",
                        "description": "Detailed content of the finding",
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Tags for categorization (e.g. ['api', 'database', 'frontend'])",
                    },
                    "importance": {
                        "type": "integer",
                        "enum": [1, 2, 3],
                        "description": "Importance level: 1=low, 2=medium, 3=high",
                    },
                },
                "required": ["title", "content", "tags"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "team_request_help",
            "description": "Request help from a specific agent or the team coordinator. Use when you are stuck or need input from another domain expert.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question or help request",
                    },
                    "target_agent": {
                        "type": "string",
                        "description": "Optional specific agent to direct the request to",
                    },
                },
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "team_signal_completion",
            "description": "Signal that your assigned subtask is complete. Provide a summary of what was accomplished.",
            "parameters": {
                "type": "object",
                "properties": {
                    "final_summary": {
                        "type": "string",
                        "description": "Summary of what was accomplished in this subtask",
                    }
                },
                "required": ["final_summary"],
            },
        },
    },
]

TEAM_TOOL_NAMES = {t["function"]["name"] for t in TEAM_TOOL_DEFINITIONS}


def _api_base() -> str:
    return os.environ.get("CLOUDCHAT_API_BASE", "http://localhost:3001")


def _team_id() -> str | None:
    return os.environ.get("TEAM_ID")


def _subtask_id() -> str | None:
    return os.environ.get("TEAM_SUBTASK_ID")


def _agent_profile() -> str:
    return os.environ.get("TEAM_AGENT_PROFILE", "unknown")


def _fetch(path: str, method: str = "GET", body: dict | None = None, retries: int = 2) -> dict | None:
    """Make an HTTP request to the Express team API.
    Retries only on 5xx and network errors; bails immediately on 4xx.
    """
    import httpx

    url = f"{_api_base()}{path}"
    for attempt in range(retries):
        try:
            kwargs: dict = {"method": method, "timeout": 10}
            if body is not None:
                kwargs["json"] = body
            with httpx.Client() as client:
                resp = client.request(**kwargs, url=url)
                # 4xx errors won't resolve on retry — bail immediately
                if 400 <= resp.status_code < 500:
                    return None
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPStatusError as e:
            if attempt == retries - 1:
                return None
            import time
            time.sleep(1)
        except Exception:
            if attempt == retries - 1:
                return None
            import time
            time.sleep(1)
    return None


def _require_team() -> str | None:
    """Return team_id if available, else None (caller handles the error)."""
    tid = _team_id()
    if not tid:
        return None
    return tid


def team_delegate_to_agent(agent_name: str, subtask: str, context: str) -> str:
    """Delegate a subtask to another agent in the team."""
    tid = _require_team()
    if not tid:
        return "Error: TEAM_ID not set. This session is not part of a team."

    result = _fetch(
        "/api/hermes/team/delegation",
        method="POST",
        body={
            "teamId": tid,
            "fromAgent": _agent_profile(),
            "toAgent": agent_name,
            "subtaskTitle": subtask,
            "handoffContext": context,
        },
    )
    if result is None:
        return "Error: Failed to create delegation (API unreachable)."
    return f"Delegation created: {subtask} → {agent_name}. Delegation ID: {result.get('delegation', {}).get('id', 'unknown')}"


def team_report_progress(summary: str, blockers: list | None = None) -> str:
    """Report progress on the current subtask."""
    tid = _require_team()
    if not tid:
        return "Error: TEAM_ID not set. This session is not part of a team."

    sid = _subtask_id()
    if not sid:
        return "Error: TEAM_SUBTASK_ID not set."

    # If blockers are present, notify the team coordinator
    if blockers:
        _fetch(
            f"/api/hermes/team/{tid}/blocked",
            method="POST",
            body={"subtaskId": sid, "reason": "; ".join(blockers)},
        )

    # Publish progress as a finding in team context
    tags = ["progress"]
    if blockers:
        tags.append("blocked")

    context_result = _fetch(
        f"/api/hermes/team/{tid}/context",
        method="POST",
        body={
            "type": "finding",
            "content": f"Progress update: {summary}" + (f"\nBlockers: {', '.join(blockers)}" if blockers else ""),
            "author": _agent_profile(),
            "importance": 3 if blockers else 2,
            "tags": tags,
        },
    )

    lines = [f"Progress reported: {summary}"]
    if blockers:
        lines.append(f"Blockers: {', '.join(blockers)}")
        lines.append("Team coordinator notified of blockage.")
    if context_result is None:
        lines.append("(Warning: context store unreachable)")
    return "\n".join(lines)


def team_query_context(query_str: str, tags: list | None = None) -> str:
    """Query the shared team context."""
    from urllib.parse import urlencode

    tid = _require_team()
    if not tid:
        return "Error: TEAM_ID not set. This session is not part of a team."

    # Build query params using proper encoding
    params = {"q": query_str}
    if tags:
        params["tag"] = tags  # urlencode handles lists

    result = _fetch(f"/api/hermes/team/{tid}/context?{urlencode(params, doseq=True)}")
    if result is None:
        return "Error: Failed to query team context (API unreachable)."

    entries = result.get("entries", [])
    if not entries:
        return "No matching context entries found."

    lines = [f"Found {len(entries)} context entries:"]
    for entry in entries:
        tag_str = f" [{', '.join(entry.get('tags', []))}]" if entry.get("tags") else ""
        stars = "★" * entry.get("importance", 2)
        lines.append(f"\n[{entry.get('type', 'unknown')}] {stars}{tag_str}")
        lines.append(f"  @{entry.get('author', 'unknown')}: {entry.get('content', '')[:300]}")
        lines.append(f"  (id: {entry.get('id', 'unknown')[:12]}...)")

    return "\n".join(lines)


def team_publish_finding(title: str, content: str, tags: list, importance: int = 2) -> str:
    """Publish a finding to the shared team context."""
    tid = _require_team()
    if not tid:
        return "Error: TEAM_ID not set. This session is not part of a team."

    # Determine type from tags/keywords
    entry_type = "finding"
    title_lower = title.lower()
    if "decision" in title_lower or "decided" in title_lower:
        entry_type = "decision"
    elif any(t in title_lower for t in ["artifact", "file", "code", "output"]):
        entry_type = "artifact"
    elif any(t in title_lower for t in ["question", "help", "how"]):
        entry_type = "question"

    result = _fetch(
        f"/api/hermes/team/{tid}/context",
        method="POST",
        body={
            "type": entry_type,
            "content": f"# {title}\n\n{content}",
            "author": _agent_profile(),
            "importance": importance,
            "tags": tags,
        },
    )
    if result is None:
        return "Error: Failed to publish finding (API unreachable)."
    return f"Published {entry_type}: '{title}' (importance: {importance}) — ID: {result.get('entry', {}).get('id', 'unknown')[:12]}..."


def team_request_help(question: str, target_agent: str | None = None) -> str:
    """Request help from a specific agent or the team coordinator."""
    tid = _require_team()
    if not tid:
        return "Error: TEAM_ID not set. This session is not part of a team."

    # Publish as a question in context
    content = f"Help request from @{_agent_profile()}: {question}"
    if target_agent:
        content += f"\nTarget: @{target_agent}"

    context_result = _fetch(
        f"/api/hermes/team/{tid}/context",
        method="POST",
        body={
            "type": "question",
            "content": content,
            "author": _agent_profile(),
            "importance": 3,
            "tags": ["help-request", target_agent] if target_agent else ["help-request"],
        },
    )

    if context_result is None:
        return "Error: Failed to post help request (API unreachable)."

    msg = f"Help request posted to team context."
    if target_agent:
        msg += f" Directed to @{target_agent}."
    else:
        msg += " All agents notified."
    return msg


def team_signal_completion(final_summary: str) -> str:
    """Signal that the current subtask is complete."""
    tid = _require_team()
    if not tid:
        return "Error: TEAM_ID not set. This session is not part of a team."

    sid = _subtask_id()
    if not sid:
        return "Error: TEAM_SUBTASK_ID not set."

    # Publish completion finding
    _fetch(
        f"/api/hermes/team/{tid}/context",
        method="POST",
        body={
            "type": "finding",
            "content": f"Subtask completed: {final_summary}",
            "author": _agent_profile(),
            "importance": 3,
            "tags": ["completion"],
        },
    )

    # Signal completion to coordinator
    result = _fetch(
        f"/api/hermes/team/delegation",
        method="PATCH",
        body={
            "teamId": tid,
            "subtaskId": sid,
            "status": "completed",
            "result": final_summary,
        },
    )

    if result is None:
        # Fallback: try the delegation endpoint
        _fetch(
            f"/api/hermes/team/{tid}/context",
            method="POST",
            body={
                "type": "finding",
                "content": f"Subtask marked complete (coordinator fallback): {final_summary}",
                "author": _agent_profile(),
                "importance": 2,
                "tags": ["completion"],
            },
        )

    return f"Subtask completion signaled: {final_summary[:200]}"
