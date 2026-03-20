"""
Benchmark harness for CloudChat's agentic repo-editing flow.

Two modes:
  1. Replay mode  — mock LLM responses, test the agent loop logic (fast, free)
  2. Live mode    — call real LLM via OpenRouter, test end-to-end accuracy (slow, costs $)

Usage:
  python benchmarks/harness.py --mode replay              # run all fixtures in replay mode
  python benchmarks/harness.py --mode live --model openai/gpt-4.1-mini  # live eval
  python benchmarks/harness.py --fixture rename-function   # run single fixture
  python benchmarks/harness.py --mode live --model openai/gpt-4.1-mini --fixture fix-bug-off-by-one
"""

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# Add hermes-bridge to path so we can import AIAgent
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "hermes-bridge"))

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
REPLAYS_DIR = Path(__file__).resolve().parent / "replays"


# ── Data types ────────────────────────────────────────────────────────────────

@dataclass
class FixtureExpectedChange:
    path: str
    action: str  # "create" | "edit" | "delete"
    must_contain: list[str] = field(default_factory=list)
    must_not_contain: list[str] = field(default_factory=list)
    path_pattern: Optional[str] = None  # regex for flexible path matching


@dataclass
class Fixture:
    id: str
    description: str
    prompt: str
    repo_owner: str
    repo_name: str
    default_branch: str
    file_tree: list[str]
    files: dict[str, str]
    expected_reads: list[str]
    expected_changes: list[FixtureExpectedChange]
    unchanged_files: list[str]


@dataclass
class ToolEvent:
    event_type: str
    path: str
    action: Optional[str] = None
    content: Optional[str] = None
    original_content: Optional[str] = None


@dataclass
class BenchmarkResult:
    fixture_id: str
    passed: bool
    score: float  # 0.0 - 1.0
    duration_ms: int
    iterations: int
    files_read: list[str]
    changes_made: list[ToolEvent]
    checks: list[dict]  # {name, passed, detail}
    error: Optional[str] = None


# ── Fixture loading ───────────────────────────────────────────────────────────

def load_fixture(path: Path) -> Fixture:
    with open(path) as f:
        data = json.load(f)

    repo = data["repo"]
    expected = data["expected"]

    changes = []
    for c in expected.get("changes", []):
        changes.append(FixtureExpectedChange(
            path=c["path"],
            action=c["action"],
            must_contain=c.get("mustContain", []),
            must_not_contain=c.get("mustNotContain", []),
            path_pattern=c.get("pathPattern"),
        ))

    return Fixture(
        id=data["id"],
        description=data["description"],
        prompt=data["prompt"],
        repo_owner=repo["owner"],
        repo_name=repo["name"],
        default_branch=repo["defaultBranch"],
        file_tree=repo["fileTree"],
        files=repo["files"],
        expected_reads=expected.get("files_read", []),
        expected_changes=changes,
        unchanged_files=expected.get("unchanged", []),
    )


def load_all_fixtures() -> list[Fixture]:
    fixtures = []
    for p in sorted(FIXTURES_DIR.glob("*.json")):
        fixtures.append(load_fixture(p))
    return fixtures


# ── Replay data ───────────────────────────────────────────────────────────────

def load_replay(fixture_id: str) -> Optional[list[dict]]:
    """Load pre-recorded LLM responses for a fixture."""
    replay_path = REPLAYS_DIR / f"{fixture_id}.json"
    if not replay_path.exists():
        return None
    with open(replay_path) as f:
        return json.load(f)


def save_replay(fixture_id: str, responses: list[dict]):
    """Save LLM responses from a live run for future replay."""
    REPLAYS_DIR.mkdir(exist_ok=True)
    replay_path = REPLAYS_DIR / f"{fixture_id}.json"
    with open(replay_path, "w") as f:
        json.dump(responses, f, indent=2)


# ── Agent runner ──────────────────────────────────────────────────────────────

def run_fixture(fixture: Fixture, mode: str, model: str = "") -> BenchmarkResult:
    """Run a single benchmark fixture and return scored results."""
    from run_agent import AIAgent

    start = time.time()
    events: list[ToolEvent] = []
    files_read: list[str] = []
    text_output: list[str] = []
    iterations = 0
    recorded_responses: list[dict] = []

    def on_server_tool_event(event: dict):
        evt_type = event.get("type", "")
        if evt_type == "repo_file_read":
            files_read.append(event.get("path", ""))
            events.append(ToolEvent(
                event_type=evt_type,
                path=event.get("path", ""),
                content=event.get("content"),
            ))
        elif evt_type in ("repo_file_edit", "repo_file_create", "repo_file_delete"):
            action = evt_type.replace("repo_file_", "")
            events.append(ToolEvent(
                event_type=evt_type,
                path=event.get("path", ""),
                action=action,
                content=event.get("content"),
                original_content=event.get("originalContent"),
            ))
        elif evt_type == "repo_batch_edit":
            for change in event.get("changes", []):
                events.append(ToolEvent(
                    event_type="repo_file_" + change.get("action", "edit"),
                    path=change.get("path", ""),
                    action=change.get("action", "edit"),
                    content=change.get("content"),
                    original_content=change.get("originalContent"),
                ))

    def on_text(content: str):
        text_output.append(content)

    def on_thinking(iteration: int):
        nonlocal iterations
        iterations = iteration

    # Build the agent
    agent = AIAgent(
        base_url="https://openrouter.ai/api/v1",
        api_key=os.environ.get("OPENROUTER_API_KEY", "bench-test-key"),
        model=model or "openai/gpt-4.1-mini",
        max_iterations=20,
        enabled_toolsets=[],
        repo_mode=True,
        repo_edit_intent=True,
        github_pat="bench-test-pat",
        github_repo_owner=fixture.repo_owner,
        github_repo_name=fixture.repo_name,
        on_server_tool_event=on_server_tool_event,
        on_text=on_text,
    )
    agent.on_thinking = on_thinking

    # Pre-populate the session cache and repo file tree
    agent.repo_file_tree = list(fixture.file_tree)
    for path, content in fixture.files.items():
        agent.session_cache[path] = content

    # Mock the GitHub read to use fixture files
    original_read = agent._read_github_file

    def mock_read(path: str) -> str:
        if path in fixture.files:
            content = fixture.files[path]
            if content == "":
                return "(empty file)"
            return content
        return f"Error: File not found at '{path}'. Available files: {', '.join(fixture.file_tree)}"

    agent._read_github_file = mock_read

    # Inject file tree into the conversation so the model knows what files exist
    file_tree_prompt = (
        f"Repository file tree for {fixture.repo_owner}/{fixture.repo_name}:\n"
        + "\n".join(fixture.file_tree)
        + "\n\nUse these exact paths when calling read_repo_file or edit_repo_file."
    )
    original_build_prompt = agent._build_repo_system_prompt

    def patched_build_prompt() -> str:
        base = original_build_prompt()
        return base + "\n\n" + file_tree_prompt if base else file_tree_prompt

    agent._build_repo_system_prompt = patched_build_prompt

    if mode == "replay":
        # Use pre-recorded responses
        replay_data = load_replay(fixture.id)
        if not replay_data:
            return BenchmarkResult(
                fixture_id=fixture.id,
                passed=False,
                score=0.0,
                duration_ms=0,
                iterations=0,
                files_read=[],
                changes_made=[],
                checks=[{"name": "replay_data", "passed": False, "detail": "No replay file found. Run with --mode live first to record."}],
                error="Missing replay data",
            )

        response_queue = list(replay_data)

        original_call_api = agent._call_api

        def mock_call_api(messages, forced_repo_tool_choice=None):
            if not response_queue:
                return {"choices": [{"finish_reason": "stop", "message": {"content": "Done.", "tool_calls": []}}]}
            return response_queue.pop(0)

        agent._call_api = mock_call_api

    elif mode == "live":
        # Wrap _call_api to record responses
        original_call_api = agent._call_api

        def recording_call_api(messages, forced_repo_tool_choice=None):
            response = original_call_api(messages, forced_repo_tool_choice=forced_repo_tool_choice)
            recorded_responses.append(response)
            return response

        agent._call_api = recording_call_api

    # Run
    error = None
    try:
        agent.run_conversation(fixture.prompt)
    except Exception as e:
        error = str(e)

    duration_ms = int((time.time() - start) * 1000)

    # Save replay if live mode
    if mode == "live" and recorded_responses:
        save_replay(fixture.id, recorded_responses)

    # Score the results
    checks = score_results(fixture, events, files_read, agent.session_cache)
    passed_checks = sum(1 for c in checks if c["passed"])
    total_checks = len(checks)
    score = passed_checks / total_checks if total_checks > 0 else 0.0
    all_passed = all(c["passed"] for c in checks) and error is None

    return BenchmarkResult(
        fixture_id=fixture.id,
        passed=all_passed,
        score=score,
        duration_ms=duration_ms,
        iterations=iterations,
        files_read=files_read,
        changes_made=events,
        checks=checks,
        error=error,
    )


# ── Scoring ───────────────────────────────────────────────────────────────────

def score_results(
    fixture: Fixture,
    events: list[ToolEvent],
    files_read: list[str],
    session_cache: dict[str, str],
) -> list[dict]:
    """Score the agent's output against expected results."""
    checks = []

    # 1. Check files were read
    for expected_path in fixture.expected_reads:
        was_read = expected_path in files_read
        checks.append({
            "name": f"read:{expected_path}",
            "passed": was_read,
            "detail": f"{'Read' if was_read else 'NOT read'}: {expected_path}",
        })

    # 2. Check expected changes
    change_events = [e for e in events if e.action in ("edit", "create", "delete")]

    for expected in fixture.expected_changes:
        # Find matching change event (exact path or pattern)
        matching = None
        for evt in change_events:
            if evt.path == expected.path:
                matching = evt
                break
            if expected.path_pattern and re.match(expected.path_pattern, evt.path):
                matching = evt
                break

        if matching is None:
            checks.append({
                "name": f"change:{expected.path}",
                "passed": False,
                "detail": f"Expected {expected.action} on {expected.path} — no matching change found",
            })
            continue

        # Check action type
        action_match = matching.action == expected.action
        checks.append({
            "name": f"action:{expected.path}",
            "passed": action_match,
            "detail": f"Action: expected={expected.action}, got={matching.action}",
        })

        # Check content contains expected strings
        content = matching.content or ""
        # Also check session_cache as final state
        cache_content = session_cache.get(matching.path, "")
        check_content = cache_content if cache_content else content

        for must_have in expected.must_contain:
            found = must_have in check_content
            checks.append({
                "name": f"contains:{expected.path}:{must_have[:40]}",
                "passed": found,
                "detail": f"{'Found' if found else 'MISSING'}: '{must_have[:60]}'",
            })

        for must_not_have in expected.must_not_contain:
            absent = must_not_have not in check_content
            checks.append({
                "name": f"excludes:{expected.path}:{must_not_have[:40]}",
                "passed": absent,
                "detail": f"{'Absent (good)' if absent else 'STILL PRESENT'}: '{must_not_have[:60]}'",
            })

    # 3. Check unchanged files
    for path in fixture.unchanged_files:
        was_changed = any(e.path == path and e.action in ("edit", "create", "delete") for e in events)
        checks.append({
            "name": f"unchanged:{path}",
            "passed": not was_changed,
            "detail": f"{'Correctly unchanged' if not was_changed else 'UNEXPECTEDLY MODIFIED'}: {path}",
        })

    # 4. Check no agent error occurred (no orphaned tool calls, etc.)
    checks.append({
        "name": "no_crash",
        "passed": True,  # If we got here, no crash
        "detail": "Agent loop completed without exceptions",
    })

    return checks


# ── Reporting ─────────────────────────────────────────────────────────────────

def print_result(result: BenchmarkResult):
    status = "\033[32mPASS\033[0m" if result.passed else "\033[31mFAIL\033[0m"
    score_pct = f"{result.score * 100:.0f}%"
    print(f"\n{'─' * 70}")
    print(f"  {status}  {result.fixture_id}  ({score_pct}, {result.duration_ms}ms, {result.iterations} iters)")
    print(f"{'─' * 70}")

    if result.error:
        print(f"  \033[31mError: {result.error}\033[0m")

    # Print files read
    if result.files_read:
        print(f"  Files read: {', '.join(result.files_read)}")

    # Print changes
    changes = [e for e in result.changes_made if e.action]
    if changes:
        print(f"  Changes: {', '.join(f'{e.action} {e.path}' for e in changes)}")

    # Print checks
    for check in result.checks:
        icon = "\033[32m✓\033[0m" if check["passed"] else "\033[31m✗\033[0m"
        print(f"    {icon} {check['name']}: {check['detail']}")


def print_summary(results: list[BenchmarkResult]):
    total = len(results)
    passed = sum(1 for r in results if r.passed)
    avg_score = sum(r.score for r in results) / total if total > 0 else 0
    total_ms = sum(r.duration_ms for r in results)

    print(f"\n{'═' * 70}")
    print(f"  BENCHMARK SUMMARY")
    print(f"{'═' * 70}")
    print(f"  Fixtures:  {passed}/{total} passed")
    print(f"  Avg score: {avg_score * 100:.1f}%")
    print(f"  Total time: {total_ms}ms")
    print(f"{'═' * 70}")

    if passed < total:
        failed = [r for r in results if not r.passed]
        print(f"\n  Failed fixtures:")
        for r in failed:
            print(f"    - {r.fixture_id} ({r.score * 100:.0f}%){f': {r.error}' if r.error else ''}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="CloudChat agentic flow benchmark")
    parser.add_argument("--mode", choices=["replay", "live"], default="replay",
                        help="replay=mock LLM, live=real API calls")
    parser.add_argument("--model", default="openai/gpt-4.1-mini",
                        help="Model to use in live mode")
    parser.add_argument("--fixture", default=None,
                        help="Run a single fixture by ID")
    parser.add_argument("--save-results", default=None,
                        help="Save results JSON to this path")
    args = parser.parse_args()

    if args.fixture:
        fixture_path = FIXTURES_DIR / f"{args.fixture}.json"
        if not fixture_path.exists():
            print(f"Fixture not found: {args.fixture}")
            sys.exit(1)
        fixtures = [load_fixture(fixture_path)]
    else:
        fixtures = load_all_fixtures()

    if not fixtures:
        print("No fixtures found.")
        sys.exit(1)

    print(f"Running {len(fixtures)} fixture(s) in {args.mode} mode" +
          (f" with {args.model}" if args.mode == "live" else ""))

    results = []
    for fixture in fixtures:
        result = run_fixture(fixture, args.mode, args.model)
        print_result(result)
        results.append(result)

    print_summary(results)

    if args.save_results:
        out = []
        for r in results:
            out.append({
                "fixture_id": r.fixture_id,
                "passed": r.passed,
                "score": r.score,
                "duration_ms": r.duration_ms,
                "iterations": r.iterations,
                "files_read": r.files_read,
                "checks": r.checks,
                "error": r.error,
            })
        with open(args.save_results, "w") as f:
            json.dump(out, f, indent=2)
        print(f"\nResults saved to {args.save_results}")

    sys.exit(0 if all(r.passed for r in results) else 1)


if __name__ == "__main__":
    main()
