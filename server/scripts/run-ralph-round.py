#!/usr/bin/env python3
"""
Ralph Round Runner

Spawned once per Ralph round by the Node.js driver (server/ralph-loop.ts).
Runs ONE fresh Hermes agent round against the round prompt (built by
shared/ralph.ts and passed via RALPH_ROUND_PROMPT) with no conversation
history, then extracts the structured report marker from the agent's final
output and prints it for the driver.

Protocol (stdout, machine-readable lines):
    RALPH_REPORT:<json>   -- round succeeded, report follows
    RALPH_ERROR:<message> -- round failed
Exit codes: 0 = report produced, 3 = no report (round-failed), 2 = setup error.

Env vars:
    RALPH_ROUND_PROMPT   -- required, full round prompt text
    RALPH_WORKSPACE_DIR  -- required, the shared workspace the round runs in
    RALPH_ROUND_TIMEOUT_MS -- optional, hard wall-clock kill (default 2700000)
"""

import json
import os
import sys
import threading

REPORT_MARKER = "RALPH_REPORT:"
ERROR_MARKER = "RALPH_ERROR:"

ROUND_TIMEOUT_MS = int(os.environ.get("RALPH_ROUND_TIMEOUT_MS", "2700000") or 2700000)


def fail(message: str, code: int) -> None:
    print(f"{ERROR_MARKER}{message}", flush=True)
    sys.exit(code)


def extract_report(text: str) -> dict | None:
    """Parse the JSON object after the LAST report marker (later text wins).

    raw_decode stops at the end of the object, so trailing prose or a closing
    code fence after the marker does not break parsing. Structural sanity
    only — full schema validation lives in the driver (shared/ralph.ts).
    """
    idx = text.rfind(REPORT_MARKER)
    while idx != -1:
        try:
            obj, _ = json.JSONDecoder().raw_decode(text[idx + len(REPORT_MARKER):].lstrip())
            if isinstance(obj, dict) and "status" in obj:
                return obj
        except ValueError:
            pass
        idx = text.rfind(REPORT_MARKER, 0, idx)
    return None


def main() -> None:
    prompt = os.environ.get("RALPH_ROUND_PROMPT", "").strip()
    workspace = os.environ.get("RALPH_WORKSPACE_DIR", "").strip()
    if not prompt:
        fail("RALPH_ROUND_PROMPT is required", 2)
    if not workspace or not os.path.isdir(workspace):
        fail(f"RALPH_WORKSPACE_DIR does not exist: {workspace}", 2)

    try:
        os.chdir(workspace)
    except OSError as e:
        fail(f"cannot chdir into workspace: {e}", 2)

    # Load the real Hermes agent adapter from the bridge (same path as the
    # kanban runner — one brain policy).
    bridge_dir = os.environ.get(
        "HERMES_BRIDGE_DIR",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "hermes-bridge"),
    )
    bridge_dir = os.path.abspath(bridge_dir)
    if bridge_dir not in sys.path:
        sys.path.insert(0, bridge_dir)

    # The venv's own site-packages entry sometimes fails to resolve when the
    # repo lives on a symlinked volume (~/spark -> /Volumes/T7 Shield/...):
    # hermes_adapter then dies with "No module named 'httpx'" even though httpx
    # is installed. Append the RESOLVED site-packages explicitly and drop any
    # inherited PYTHONPATH so foreign venvs can't shadow the bridge deps.
    os.environ.pop("PYTHONPATH", None)
    _resolved_bridge = os.path.realpath(bridge_dir)
    _sp = os.path.join(
        _resolved_bridge, ".venv", "lib",
        f"python{sys.version_info[0]}.{sys.version_info[1]}", "site-packages",
    )
    if os.path.isdir(_sp) and _sp not in sys.path:
        sys.path.append(_sp)

    try:
        from hermes_adapter import HermesAgentAdapter as _HermesAgentAdapter  # noqa: E402
    except Exception as e:  # pragma: no cover - import path issue
        fail(f"failed to load HermesAgentAdapter: {e}", 2)
        raise  # unreachable; satisfies the type checker
    HermesAgentAdapter = _HermesAgentAdapter

    # Resolve LLM config the same way the kanban runner does.
    llm_base_url = "https://crof.ai/v1"
    llm_api_key = os.environ.get("CROFAI_API_KEY", "")
    llm_model = "deepseek-v4-pro"
    try:
        import yaml  # noqa: E402

        config_path = os.path.expanduser("~/.hermes/config.yaml")
        with open(config_path) as f:
            cfg = yaml.safe_load(f) or {}
        m = cfg.get("model") or {}
        if m.get("base_url"):
            llm_base_url = m["base_url"]
        if m.get("api_key"):
            llm_api_key = m["api_key"]
        if m.get("default"):
            llm_model = m["default"]
    except Exception:
        pass  # config parse failure — rely on env or fail at adapter init

    if not llm_api_key:
        fail("no LLM API key (set CROFAI_API_KEY or model.api_key in ~/.hermes/config.yaml)", 2)

    # on_text receives per-token stream deltas, so keep every chunk verbatim
    # (including whitespace-only ones) — the marker can straddle chunks.
    captured: list[str] = []

    def on_text(text: str) -> None:
        if isinstance(text, str):
            captured.append(text)

    def on_tool_start(name: str, tool_input: str) -> None:
        args_preview = (tool_input or "")[:80]
        print(f"[ralph-runner] tool {name}({args_preview})", flush=True)

    def on_tool_end(name: str, tool_input: str, result: str) -> None:
        pass

    system_prompt = (
        "You are an autonomous worker executing one round of a multi-round loop. "
        "You have terminal and file tools; do concrete work in the current working "
        "directory. Verify what you change. Your final message MUST end with the "
        "RALPH_REPORT line exactly as instructed."
    )

    toolsets = ["terminal", "files", "web", "code_execution"]

    print(f"[ralph-runner] round start (model={llm_model}, workspace={workspace})", flush=True)
    try:
        agent = HermesAgentAdapter(
            base_url=llm_base_url,
            api_key=llm_api_key,
            model=llm_model,
            max_iterations=40,
            enabled_toolsets=toolsets,
            on_text=on_text,
            on_tool_start=on_tool_start,
            on_tool_end=on_tool_end,
        )
    except Exception as e:
        fail(f"adapter init failed: {e}", 2)

    # Hard wall-clock kill so a hung round cannot wedge the loop forever.
    timer = threading.Timer(ROUND_TIMEOUT_MS / 1000.0, lambda: os._exit(3))
    timer.daemon = True
    timer.start()

    try:
        result = agent.run_conversation(
            user_message=prompt,
            conversation_history=[{"role": "system", "content": system_prompt}],
        )
    except Exception as e:
        fail(f"agent run failed: {e}", 3)
    finally:
        timer.cancel()

    # The agent's final message is authoritative; fall back to the full stream.
    final_text = result.get("final_response") if isinstance(result, dict) else None
    if not isinstance(final_text, str) or REPORT_MARKER not in final_text:
        final_text = "".join(captured)

    parsed = extract_report(final_text)
    if parsed is None:
        fail("agent finished without a valid RALPH_REPORT marker", 3)

    print(f"{REPORT_MARKER}{json.dumps(parsed, separators=(',', ':'))}", flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
