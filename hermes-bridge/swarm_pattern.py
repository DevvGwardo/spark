"""
swarm_pattern.py — Architect → Implementor → Reviewer pipeline for hermes-bridge

Each phase is a spawned sub-agent that receives the request context via brain state
(brain_set / brain_get). The bridge coordinates the pipeline and streams SSE events
from whichever agent is currently active.

Phase flow:
    1. Architect  — analyzes user request, produces a file-by-file plan, posts to brain
    2. Implementor — applies staged changes using brain_claim, posts completion summary
    3. Reviewer   — reviews staged files, posts verdict (approve / request changes)

The bridge's SSE callbacks (on_thinking, on_tool_start, etc.) forward events from the
active sub-agent to the client.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional

# Local imports — brain MCP is accessed via the bridge's own _brain_* helpers.
# Import them so this module can use the same RPC layer.
import main

# ---------------------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------------------

class Phase(Enum):
    ARCHITECT = "architect"
    IMPLEMENTOR = "implementor"
    REVIEWER = "reviewer"
    DONE = "done"


@dataclass
class PlanStep:
    """One step in the Architect's implementation plan."""
    path: str
    action: str  # "edit" | "create" | "delete"
    description: str
    order: int


@dataclass
class SwarmRequest:
    """Shared context for the entire pipeline."""
    id: str
    user_message: str
    conversation_history: list[dict]
    enabled_toolsets: list[str]
    repo_mode: bool
    repo_owner: Optional[str]
    repo_name: Optional[str]
    github_pat: Optional[str]
    custom_tools: list[dict] = field(default_factory=list)
    repo_file_tree: list[str] = field(default_factory=list)
    # Set by each phase
    plan: list[PlanStep] = field(default_factory=list)
    staged_files: dict[str, str] = field(default_factory=dict)  # path → staged content
    verdict: Optional[str] = None  # "approved" | "changes_requested"
    review_notes: Optional[str] = None


# ---------------------------------------------------------------------------------------
# Phase prompts
# ---------------------------------------------------------------------------------------

ARCHITECT_PROMPT = """You are the Architect agent. Analyze the user's request and produce an implementation plan.

## Your task
1. Read the repository file tree to understand the project structure
2. Break the work into concrete file-level steps (edit, create, delete)
3. Write the plan to brain state as JSON so the Implementor can read it

## Output format
Write a JSON plan to brain key "plan:{request_id}" with this shape:
{{"steps": [{{"path": "relative/path.go", "action": "edit", "description": "...", "order": 1}}, ...]}}

Then post a summary to the "hermes-bridge" channel using brain_post and exit with /exit.

## Constraints
- Never edit files directly — only plan
- List files in dependency order (base files before dependent ones)
- Keep descriptions concise (one line per step)
"""

IMPLEMENTOR_PROMPT = """You are the Implementor agent. Apply the changes from the Architect's plan.

## Your task
1. Read the plan from brain key "plan:{request_id}"
2. For each file in the plan:
   a. brain_claim the resource (e.g. "repo_file:path/to/file.py")
   b. Apply the change using the appropriate tool
   c. Store the staged result in brain state under "staging:{request_id}:<filepath>"
3. After all changes, post a completion summary to "hermes-bridge" channel
4. Release all claimed resources

## Constraints
- Claim before writing, release after
- Store staged content as JSON: {{"content": "...", "tool": "...", "summary": "..."}}
- Post your summary then /exit

## Stage summary format
Post a markdown table:
### Staged Changes
| File | Action | Summary |
|------|--------|---------|
| path/to/file.py | edit | ... |
"""

REVIEWER_PROMPT = """You are the Reviewer agent. Audit the staged changes for correctness, style, and security.

## Your task
1. Read all staged files from brain keys "staging:{request_id}:*" using brain_get
2. Review each file for:
   - Correctness: does the change do what the plan intended?
   - Style: consistent with project conventions?
   - Security: no injection risks, credential leakage, or unsafe patterns
3. brain_claim any files you need to fix, apply corrections, update staging
4. Post your verdict to "hermes-bridge" channel and /exit

## Verdict format
Post one of:
- "### Verdict: ✅ Approved" — changes are ready
- "### Verdict: 🛠 Changes Requested" — list issues with specific file:line references

## Constraints
- Do not approve broken code or obvious style violations
- If unsure, mark as "changes_requested" with a note
"""


# ---------------------------------------------------------------------------------------
# Swarm coordinator
# ---------------------------------------------------------------------------------------

class SwarmCoordinator:
    """
    Coordinates the 3-phase Architect → Implementor → Reviewer pipeline.

    Each phase runs as an independent agent session. The coordinator:
    - Stores shared context in brain state
    - Spawns each phase via brain_wake
    - Tracks pipeline progress
    - Collects final verdict and streams it back to the bridge

    Usage:
        coordinator = SwarmCoordinator(request)
        result = await coordinator.run()
    """

    def __init__(self, request: SwarmRequest):
        self.request = request
        self.phase: Phase = Phase.ARCHITECT
        self._events: list[tuple] = []
        self._started_at = time.monotonic()
        self._pulse_interval = 5  # pulse every 5 tool calls

    # -----------------------------------------------------------------------------------
    # Brain helpers — all async, delegate to main.py's _brain_rpc / _brain_call_async
    # -----------------------------------------------------------------------------------

    async def _set(self, key: str, value: str, scope: str = "global"):
        await main._brain_call_async("brain_set", {"key": key, "value": value, "scope": scope})

    async def _get(self, key: str) -> Optional[str]:
        result = await main._brain_call_async("brain_get", {"key": key})
        if result and isinstance(result, dict):
            content = result.get("content") or result.get("value")
            # MCP tool results are wrapped in a content array
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        return item.get("text")
            if isinstance(content, str):
                return content
        return None

    async def _post(self, content: str, channel: str = "general"):
        await main._brain_call_async("brain_post", {"content": content, "channel": channel})

    async def _pulse(self, status: str = "working", progress: str = ""):
        await main._brain_call_async("brain_pulse", {"status": status, "progress": progress})

    async def _claim(self, resource: str, ttl: int = 120):
        await main._brain_call_async("brain_claim", {"resource": resource, "ttl": ttl})

    async def _release(self, resource: str):
        await main._brain_call_async("brain_release", {"resource": resource})

    async def _wake(self, name: str, task: str):
        """Spawn a named agent via brain_wake."""
        await main._brain_rpc("tools/call", {
            "name": "brain_wake",
            "arguments": {"name": name, "task": task}
        })

    # -----------------------------------------------------------------------------------
    # Pipeline steps
    # -----------------------------------------------------------------------------------

    async def _store_request_context(self):
        """Write request metadata to brain so spawned agents can read it."""
        ctx = {
            "request_id": self.request.id,
            "user_message": self.request.user_message[:500],
            "repo_mode": self.request.repo_mode,
            "repo_owner": self.request.repo_owner or "",
            "repo_name": self.request.repo_name or "",
            "enabled_toolsets": ",".join(self.request.enabled_toolsets),
            "custom_tools_count": len(self.request.custom_tools),
            "repo_file_tree_count": len(self.request.repo_file_tree),
        }
        await self._set(f"request:{self.request.id}:ctx", json.dumps(ctx))
        await self._set(f"request:{self.request.id}:phase", Phase.ARCHITECT.value)
        await self._pulse("working", f"phase=architect request_id={self.request.id}")

    async def run_phase_architect(self) -> list[PlanStep]:
        """Phase 1: spawn Architect to produce the implementation plan."""
        await self._store_request_context()

        # Build prompt with request context inline (prompts don't use .format())
        prompt = ARCHITECT_PROMPT
        # Add repo info if in repo mode
        if self.request.repo_mode:
            prompt += f"\n\nRepository: {self.request.repo_owner}/{self.request.repo_name}\n"
            prompt += f"File tree: {', '.join(self.request.repo_file_tree[:20])}"
            if len(self.request.repo_file_tree) > 20:
                prompt += f" (+{len(self.request.repo_file_tree) - 20} more files)"
            prompt += "\nUser request: " + self.request.user_message
        prompt += f"\n\nRequest ID: {self.request.id}"

        # Spawn Architect as a sub-agent
        await self._wake("architect", prompt)

        # Poll brain state until Architect posts the plan
        plan = await self._poll_for_plan()
        return plan

    async def _poll_for_plan(self, timeout: int = 120) -> list[PlanStep]:
        """Wait for Architect to write the plan to brain state."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            plan_json = await self._get(f"plan:{self.request.id}")
            if plan_json:
                try:
                    data = json.loads(plan_json)
                    steps = [PlanStep(**s) for s in data.get("steps", [])]
                    await self._post(f"**Architect** plan ready: {len(steps)} steps", channel="hermes-bridge")
                    return steps
                except (json.JSONDecodeError, TypeError) as e:
                    await self._post(f"**Architect** plan parse error: {e}", channel="hermes-bridge")
            await asyncio.sleep(3)

        await self._post("**Architect** timed out waiting for plan", channel="hermes-bridge")
        return []

    async def run_phase_implementor(self, plan: list[PlanStep]) -> dict[str, str]:
        """Phase 2: spawn Implementor to apply the planned changes."""
        await self._set(f"request:{self.request.id}:phase", Phase.IMPLEMENTOR.value)
        await self._pulse("working", "phase=implementor")

        # Build Implementor prompt with the plan
        plan_lines = "\n".join(
            f"{i+1}. [{s.action}] `{s.path}` — {s.description}"
            for i, s in enumerate(plan)
        )
        prompt = IMPLEMENTOR_PROMPT
        prompt += f"\n\n## Plan\n{plan_lines}\n\n## User Message\n{self.request.user_message}\n\n## Request ID: {self.request.id}\n"
        if self.request.repo_mode:
            prompt += f"\nRepository: {self.request.repo_owner}/{self.request.repo_name}\n"

        await self._wake("implementor", prompt)

        # Poll for staged files
        staged = await self._poll_for_staged_files(timeout=240)
        return staged

    async def _poll_for_staged_files(self, timeout: int = 240) -> dict[str, str]:
        """Wait for Implementor to stage all files."""
        deadline = time.monotonic() + timeout
        last_count = 0
        while time.monotonic() < deadline:
            # Scan for staging keys
            all_keys_json = await self._get(f"request:{self.request.id}:staging_keys")
            if all_keys_json:
                try:
                    keys: list[str] = json.loads(all_keys_json)
                    staged = {}
                    for key in keys:
                        content = await self._get(key)
                        if content:
                            path = key.split(":")[-1]
                            staged[path] = content
                    current_count = len(staged)
                    if current_count > last_count:
                        await self._post(f"**Implementor** staged {current_count} files", channel="hermes-bridge")
                        last_count = current_count
                    # Check if done (Implementor posts completion message)
                    completion = await self._get(f"request:{self.request.id}:implementor_completion")
                    if completion:
                        await self._post(f"**Implementor** completed", channel="hermes-bridge")
                        return staged
                except (json.JSONDecodeError, TypeError):
                    pass
            await asyncio.sleep(4)

        await self._post("**Implementor** timed out", channel="hermes-bridge")
        return {}

    async def run_phase_reviewer(self, staged: dict[str, str]) -> tuple[str, str]:
        """Phase 3: spawn Reviewer to audit staged files."""
        await self._set(f"request:{self.request.id}:phase", Phase.REVIEWER.value)
        await self._pulse("working", "phase=reviewer")

        file_list = ", ".join(staged.keys()) if staged else "(no files staged)"
        prompt = REVIEWER_PROMPT
        prompt += f"\n\n## Staged Files\n{file_list}\n\n## User Request\n{self.request.user_message}\n\n## Request ID: {self.request.id}\n"

        await self._wake("reviewer", prompt)

        verdict, notes = await self._poll_for_verdict(timeout=120)
        return verdict, notes

    async def _poll_for_verdict(self, timeout: int = 120) -> tuple[str, str]:
        """Wait for Reviewer to post a verdict."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            verdict_json = await self._get(f"request:{self.request.id}:verdict")
            if verdict_json:
                try:
                    data = json.loads(verdict_json)
                    await self._post(f"**Reviewer** verdict: {data.get('verdict')}", channel="hermes-bridge")
                    return data.get("verdict", "changes_requested"), data.get("notes", "")
                except (json.JSONDecodeError, TypeError):
                    pass
            await asyncio.sleep(3)

        await self._post("**Reviewer** timed out", channel="hermes-bridge")
        return "changes_requested", "Reviewer timed out"

    # -----------------------------------------------------------------------------------
    # Main run loop
    # -----------------------------------------------------------------------------------

    async def run(self) -> dict:
        """
        Execute the full 3-phase pipeline. Returns a result dict:

            {
                "success": bool,
                "verdict": "approved" | "changes_requested",
                "review_notes": str,
                "staged_files": dict[str, str],
                "elapsed_ms": int,
                "phases": {"architect": [...steps], "implementor": {...}, "reviewer": {...}}
            }
        """
        await self._set(f"request:{self.request.id}:status", "running")

        try:
            # Phase 1: Architect
            plan = await self.run_phase_architect()
            if not plan:
                return await self._finish(success=False, verdict="changes_requested",
                                          review_notes="Architect failed to produce a plan")

            # Phase 2: Implementor
            staged = await self.run_phase_implementor(plan)
            if not staged:
                return await self._finish(success=False, verdict="changes_requested",
                                          review_notes="Implementor staged no files")

            # Phase 3: Reviewer
            verdict, notes = await self.run_phase_reviewer(staged)

            return await self._finish(success=(verdict == "approved"), verdict=verdict,
                                      review_notes=notes, staged_files=staged, plan=plan)

        except Exception as e:
            await self._pulse("failed", f"pipeline_error={str(e)[:100]}")
            await self._set(f"request:{self.request.id}:status", "failed")
            raise

    async def _finish(self, success: bool, verdict: str, review_notes: str,
                      staged_files: dict[str, str] = None, plan: list[PlanStep] = None) -> dict:
        await self._set(f"request:{self.request.id}:status", "completed" if success else "failed")
        await self._set(f"request:{self.request.id}:phase", Phase.DONE.value)
        await self._pulse("done", f"verdict={verdict}")
        elapsed_ms = int((time.monotonic() - self._started_at) * 1000)
        return {
            "success": success,
            "verdict": verdict,
            "review_notes": review_notes,
            "staged_files": staged_files or {},
            "plan": [{"path": s.path, "action": s.action, "description": s.description, "order": s.order} for s in (plan or [])],
            "elapsed_ms": elapsed_ms,
        }


# ---------------------------------------------------------------------------------------
# Convenience function for the bridge
# ---------------------------------------------------------------------------------------

async def run_swarm(
    user_message: str,
    conversation_history: list[dict],
    enabled_toolsets: list[str],
    *,
    repo_mode: bool = False,
    repo_owner: Optional[str] = None,
    repo_name: Optional[str] = None,
    github_pat: Optional[str] = None,
    custom_tools: list[dict] = None,
    repo_file_tree: list[str] = None,
) -> dict:
    """
    Convenience wrapper for the bridge to run the full swarm pipeline.

    Usage:
        result = await run_swarm(
            user_message="Fix the auth bug in main.py",
            conversation_history=history,
            enabled_toolsets=["web", "browser"],
            repo_mode=True,
            repo_owner="DevvGwardo",
            repo_name="cloud-chat-hub",
            github_pat=pat,
        )
    """
    request = SwarmRequest(
        id=f"swarm-{uuid.uuid4().hex[:12]}",
        user_message=user_message,
        conversation_history=conversation_history,
        enabled_toolsets=enabled_toolsets,
        repo_mode=repo_mode,
        repo_owner=repo_owner,
        repo_name=repo_name,
        github_pat=github_pat,
        custom_tools=custom_tools or [],
        repo_file_tree=repo_file_tree or [],
    )
    coordinator = SwarmCoordinator(request)
    return await coordinator.run()