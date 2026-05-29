#!/usr/bin/env python3
"""
Kanban Background Agent Runner

Spawned as a subprocess by the Node.js server to run a kanban card
as a background agent task. Uses the hermes-bridge AIAgent which has
kanban tools (kanban_read_current_card, kanban_update_status,
kanban_append_report) registered so the agent can report back.

Usage:
    KANBAN_CARD_ID=<uuid> CLOUDCHAT_API_BASE=http://localhost:3001 \
        python3 run-kanban-agent.py

Env vars:
    KANBAN_CARD_ID       -- required, the card to process
    CLOUDCHAT_API_BASE   -- required, the Express API base URL
    HERMES_BRIDGE_DIR    -- path to cloud-chat-hub/hermes-bridge
"""

import json
import os
import sys
import time
import traceback

CLOUDCHAT_API_BASE = os.environ.get("CLOUDCHAT_API_BASE", "http://localhost:3001")
KANBAN_CARD_ID = os.environ.get("KANBAN_CARD_ID", "")
TEAM_ID = os.environ.get("TEAM_ID", "")
TEAM_SUBTASK_ID = os.environ.get("TEAM_SUBTASK_ID", "")
TEAM_SUBTASK_TITLE = os.environ.get("TEAM_SUBTASK_TITLE", "")
TEAM_SUBTASK_DESC = os.environ.get("TEAM_SUBTASK_DESC", "")

# Validate required env vars
if not KANBAN_CARD_ID:
    print("[kanban-runner] ERROR: KANBAN_CARD_ID is required", flush=True)
    sys.exit(1)


def _api_fetch(path: str, method: str = "GET", body: dict | None = None) -> dict | None:
    """Make an HTTP request to the Express kanban API."""
    import httpx

    url = f"{CLOUDCHAT_API_BASE}{path}"
    for attempt in range(3):
        try:
            kwargs: dict = {"method": method, "timeout": 15}
            if body is not None:
                kwargs["json"] = body
            with httpx.Client() as client:
                resp = client.request(**kwargs, url=url)
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            print(f"[kanban-runner] API call failed (attempt {attempt+1}/3): {e}", flush=True)
            if attempt < 2:
                time.sleep(2)
    return None


def _get_card() -> dict | None:
    """Fetch the kanban card by ID."""
    data = _api_fetch("/api/hermes/kanban?status=")
    if not data:
        return None
    for card in data.get("cards", []):
        if card.get("id") == KANBAN_CARD_ID:
            return card
    print(f"[kanban-runner] Card {KANBAN_CARD_ID[:12]}... not found in kanban list", flush=True)
    return None


def main():
    print(f"[kanban-runner] Starting for card {KANBAN_CARD_ID[:12]}...", flush=True)

    # 1. Fetch the card
    card = _get_card()
    if not card:
        print("[kanban-runner] ERROR: Could not fetch card", flush=True)
        sys.exit(1)

    title = card.get("title", "Untitled")
    spec = card.get("spec", "")
    acceptance_criteria = card.get("acceptanceCriteria", [])
    print(f"[kanban-runner] Card: {title}", flush=True)

    # 2. Set env var so kanban_tools can find the card
    os.environ["KANBAN_CARD_ID"] = KANBAN_CARD_ID

    # 3. Import the hermes-bridge AIAgent (has kanban tools baked in)
    bridge_dir = os.environ.get(
        "HERMES_BRIDGE_DIR",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "hermes-bridge"),
    )
    bridge_dir = os.path.abspath(bridge_dir)
    if bridge_dir not in sys.path:
        sys.path.insert(0, bridge_dir)

    try:
        from run_agent import AIAgent
        print("[kanban-runner] Loaded hermes-bridge AIAgent", flush=True)
    except Exception as e:
        print(f"[kanban-runner] ERROR loading AIAgent: {e}", flush=True)
        traceback.print_exc()
        sys.exit(1)

    # 4. Look up the LLM provider config from hermes config
    config_path = os.path.expanduser("~/.hermes/config.yaml")
    llm_base_url = "https://crof.ai/v1"
    llm_api_key = os.environ.get("CROFAI_API_KEY", "")
    llm_model = "deepseek-v4-pro"

    try:
        import yaml
        with open(config_path) as f:
            cfg = yaml.safe_load(f)
        if cfg and "model" in cfg:
            m = cfg["model"]
            if m.get("base_url"):
                llm_base_url = m["base_url"]
            if m.get("api_key"):
                llm_api_key = m["api_key"]
            if m.get("default"):
                llm_model = m["default"]
    except Exception:
        pass  # config parse failure — rely on env or empty key

    if not llm_api_key:
        print("[kanban-runner] ERROR: No LLM API key found. Set CROFAI_API_KEY environment variable or configure model.api_key in ~/.hermes/config.yaml", flush=True)
        sys.exit(1)

    # 5. Pre-clone repo for GitHub-sourced tasks
    card_source = card.get("source", "")
    card_external_ref = card.get("externalRef", "")
    source_url = card.get("sourceUrl", "")
    work_dir = None
    gh_repo = None
    gh_issue_num = None

    if card_source == "github" and card_external_ref:
        # externalRef format: "owner/repo#number"
        import re as _re
        _repo_match = _re.match(r"^([\w.-]+/[\w.-]+)#(\d+)", card_external_ref)
        if _repo_match:
            gh_repo = _repo_match.group(1)
            gh_issue_num = int(_repo_match.group(2))
            work_dir = os.path.join("/tmp", f"kanban-{KANBAN_CARD_ID[:8]}")
            print(f"[kanban-runner] GitHub task: {gh_repo}#{gh_issue_num}", flush=True)
            print(f"[kanban-runner] Pre-cloning to {work_dir}...", flush=True)
            
            import subprocess as _sp
            try:
                # Remove if exists from a previous run
                if os.path.exists(work_dir):
                    _sp.run(["rm", "-rf", work_dir], check=False)
                
                clone_result = _sp.run(
                    ["gh", "repo", "clone", gh_repo, work_dir],
                    capture_output=True, text=True, timeout=120,
                )
                if clone_result.returncode == 0:
                    print(f"[kanban-runner] Clone successful: {work_dir}", flush=True)
                    os.chdir(work_dir)
                else:
                    print(f"[kanban-runner] Clone failed: {clone_result.stderr[:200]}", flush=True)
                    work_dir = None  # Fall back to no pre-clone
            except Exception as clone_err:
                print(f"[kanban-runner] Clone error: {clone_err}", flush=True)
                work_dir = None

    # 6. Build the system prompt from card
    system_prompt_lines = [
        "You are working on a Kanban task card. Use the kanban tools to read card details and report progress.",
        "",
        f"Title: {title}",
    ]

    # Add team context when running as part of a team
    is_team_task = bool(TEAM_ID)
    if is_team_task:
        system_prompt_lines.extend([
            "",
            "You are part of a **multi-agent team** working on a specific subtask of a larger task.",
            "Collaboration is essential: use team tools to delegate, share context, and report progress.",
            f"- Your Team ID: {TEAM_ID[:12]}...",
            f"- Your Subtask ID: {TEAM_SUBTASK_ID[:12]}...",
            f"- Your Subtask: {TEAM_SUBTASK_TITLE}",
        ])
        if TEAM_SUBTASK_DESC:
            system_prompt_lines.append(f"- Subtask description: {TEAM_SUBTASK_DESC}")
        system_prompt_lines.append(
            "- Use team_signal_completion() when you finish your subtask, NOT kanban_complete"
        )

    if spec and spec.strip():
        system_prompt_lines.extend(["", "Spec:", spec.strip()])
    if acceptance_criteria:
        system_prompt_lines.extend(["", "Acceptance criteria:"])
        for c in acceptance_criteria:
            system_prompt_lines.append(f"- {c}")
    system_prompt_lines.extend([
        "",
        "Available tools:",
        "- kanban_show — read the full card details, spec, acceptance criteria, and status",
        "- kanban_complete — mark the task as done with a summary of what was accomplished",
        "- kanban_block — mark the task as blocked with a reason explaining what's needed",
        "- kanban_heartbeat — signal you're still working during long operations",
        "- kanban_comment — append progress notes without changing status",
    ])

    # GitHub-specific instructions — only for tasks linked to GitHub issues
    if card_source == "github" and gh_repo and gh_issue_num:
        system_prompt_lines.extend([
            "",
            "For tasks sourced from GitHub (source: github):",
            "- The repository is already cloned and ready at your current working directory",
            "- You have full terminal access with `gh` CLI authenticated",
            f"- Post progress updates to the issue: `gh issue comment {gh_issue_num} --repo {gh_repo} --body \"update\"`",
            "- Comment at milestones: (1) started analysis, (2) root cause found, (3) fix in progress, (4) PR opened",
            "- Analyze the codebase, write the fix, and create a PR",
            "- Use `gh pr create` to open the pull request against the main branch",
            "- Post the PR URL via kanban_comment AND as a final summary comment on the issue",
            "- Final summary: what changed, which files, why this fix, and the PR link",
            "- Mark the task as done ONLY after the PR is created and CI is passing",
        ])
    if is_team_task:
        system_prompt_lines.extend([
            "",
            "Team collaboration tools:",
            "- team_publish_finding — share findings/decisions with the team",
            "- team_query_context — read what other team members have published",
            "- team_delegate_to_agent — delegate work to another team member",
            "- team_report_progress — report progress and blockers",
            "- team_request_help — ask for help from another agent",
            "- team_signal_completion — signal your subtask is done (use this instead of kanban_complete)",
        ])
    system_prompt_lines.extend([
        "",
        "When you complete the task, call kanban_complete with a summary of what was accomplished."
        if not is_team_task else
        "When you complete your subtask, call team_signal_completion with a summary of what was accomplished.",
    ])
    system_prompt = "\n".join(system_prompt_lines)

    # 6. Capture final response and live tool activity
    captured_output: list[str] = []
    tool_activity: list[str] = []
    tool_count = 0

    def on_text(text: str):
        captured_output.append(text)

    def on_tool_start(name: str, tool_input: str):
        nonlocal tool_count
        tool_count += 1
        args_preview = tool_input[:80] if tool_input else ""
        summary = f"{name}({args_preview})" if args_preview else name
        tool_activity.append(f"[{tool_count}] {summary}")
        print(f"[kanban-runner] ⚡ {summary}", flush=True)
        _api_fetch(
            f"/api/hermes/kanban/{KANBAN_CARD_ID}",
            method="PATCH",
            body={"reportPath": f"Running tool {tool_count}: {summary}"},
        )

    def on_tool_end(name: str, tool_input: str, result: str):
        pass

    # 7. Create and run the agent
    try:
        # Build toolset list — add "team" tools when running as part of a team
        toolsets = ["web", "browser", "terminal", "files", "code_execution", "kanban"]
        if TEAM_ID and TEAM_SUBTASK_ID:
            toolsets.append("team")
        print(f"[kanban-runner] Using toolsets: {toolsets}", flush=True)

        print(f"[kanban-runner] Creating AIAgent (model={llm_model})...", flush=True)
        agent = AIAgent(
            base_url=llm_base_url,
            api_key=llm_api_key,
            model=llm_model,
            max_iterations=30,
            enabled_toolsets=toolsets,
            on_text=on_text,
            on_tool_start=on_tool_start,
            on_tool_end=on_tool_end,
        )
        print(f"[kanban-runner] Agent created, running conversation...", flush=True)

        agent.run_conversation(
            user_message=f"Work this Kanban card: {title}",
            conversation_history=[{"role": "system", "content": system_prompt}],
        )

        # Build a detailed report from tool activity + text output
        text_summary = "\n".join(captured_output).strip() if captured_output else ""
        tool_summary = "\n".join(tool_activity) if tool_activity else "No tool calls recorded"
        report_parts = [f"Tools used ({tool_count}):", tool_summary]
        if text_summary:
            # Trim text to avoid overflowing the reportPath; key excerpts are enough
            text_excerpt = text_summary[:1500]
            if len(text_summary) > 1500:
                text_excerpt += "\n[...truncated]"
            report_parts.extend(["", "Response:", text_excerpt])
        report = "\n\n".join(report_parts)

        print(f"[kanban-runner] Agent completed. {tool_count} tools, {len(text_summary)} chars text", flush=True)
        print(f"[kanban-runner] Report: {report[:200]}...", flush=True)

        # Write final report to the card and mark as done
        _api_fetch(
            f"/api/hermes/kanban/{KANBAN_CARD_ID}",
            method="PATCH",
            body={"reportPath": report[:2000], "status": "done"},
        )
        print(f"[kanban-runner] Card marked as done", flush=True)

    except Exception as e:
        print(f"[kanban-runner] Agent error: {e}", flush=True)
        traceback.print_exc()
        # Update card status to blocked if agent errored
        _api_fetch(
            f"/api/hermes/kanban/{KANBAN_CARD_ID}",
            method="PATCH",
            body={"status": "blocked", "reportPath": f"Agent error: {str(e)}"},
        )
        sys.exit(1)

    print(f"[kanban-runner] Done processing card {KANBAN_CARD_ID[:12]}...", flush=True)


if __name__ == "__main__":
    main()
