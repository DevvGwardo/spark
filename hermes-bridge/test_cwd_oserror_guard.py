"""Regression tests for the cwd-OSError guard (commit ef565f4 class).

The bridge process can outlive its original working directory — a build or
cleanup step deletes it, and os.getcwd() then raises FileNotFoundError (an
OSError). Every chat request used to 500. The guard falls back to the home
directory so requests keep working. These tests pin that behavior.
"""
import asyncio
import json
import sys
import types
from unittest.mock import patch

from test_main import _FakeRequest, _invoke_chat_and_read_stream  # noqa: E402
import main  # noqa: E402


class _FakeAcpTransport:
    """Records run_prompt_blocking kwargs; never actually runs a prompt."""

    last_kwargs = None

    def module(self):
        return types.SimpleNamespace(
            acp_available=lambda: (True, ""),
            run_prompt_blocking=self._run_prompt_blocking,
            ensure_session=lambda **kwargs: None,
        )

    def _run_prompt_blocking(self, **kwargs):
        _FakeAcpTransport.last_kwargs = kwargs
        # Emit a minimal terminal event so the stream completes cleanly.
        emit = kwargs.get("emit")
        if emit:
            emit("done", {"stop": True})


def test_getcwd_oserror_falls_back_to_home():
    """os.getcwd() raising OSError must not 500 the request — the ACP prompt
    runs with the home directory as cwd instead."""
    fake = _FakeAcpTransport()

    body = main.ChatCompletionRequest.model_validate({
        "model": "auto",
        "messages": [{"role": "user", "content": "test"}],
        "stream": True,
    })
    request = _FakeRequest({"authorization": "Bearer test", "x-hermes-execution-mode": "acp"})

    def _boom():
        import errno
        raise FileNotFoundError(errno.ENOENT, "cwd does not exist")

    with patch.dict(sys.modules, {"acp_transport": fake.module()}), \
         patch.object(main.os, "getcwd", side_effect=_boom):
        response, _payload = asyncio.run(_invoke_chat_and_read_stream(request, body))

    assert response.status_code == 200
    assert _FakeAcpTransport.last_kwargs is not None
    assert _FakeAcpTransport.last_kwargs["cwd"] == main.os.path.expanduser("~")


def test_repo_root_header_wins_over_broken_cwd(tmp_path):
    """When a repo-root header points at a REAL directory under the managed
    repos root, it is used as cwd even if os.getcwd() is broken — and it is
    NOT overwritten by the home fallback. (Headers outside the managed root
    are rejected as client-controlled and fall through to the managed-clone
    lookup, so a stale client path can never become a dead cwd — see
    test_missing_header_dir_falls_through.)"""
    fake = _FakeAcpTransport()

    body = main.ChatCompletionRequest.model_validate({
        "model": "auto",
        "messages": [{"role": "user", "content": "test"}],
        "stream": True,
    })
    checkout = tmp_path / "o" / "n"
    checkout.mkdir(parents=True)
    request = _FakeRequest({
        "authorization": "Bearer test",
        "x-hermes-repo-root": str(checkout),
        "x-hermes-execution-mode": "acp",
    })

    def _boom():
        import errno
        raise FileNotFoundError(errno.ENOENT, "cwd does not exist")

    with patch.dict(sys.modules, {"acp_transport": fake.module()}), \
         patch.object(main, "_MANAGED_REPOS_ROOT", str(tmp_path)), \
         patch.object(main.os, "getcwd", side_effect=_boom):
        response, _payload = asyncio.run(_invoke_chat_and_read_stream(request, body))

    assert response.status_code == 200
    assert _FakeAcpTransport.last_kwargs["cwd"] == str(checkout)


def test_missing_header_dir_falls_through_to_home(tmp_path):
    """A repo-root header pointing at a nonexistent path must NOT become the
    cwd (every relative read/search would miss). With no managed clone
    matching either, the home fallback applies."""
    fake = _FakeAcpTransport()

    body = main.ChatCompletionRequest.model_validate({
        "model": "auto",
        "messages": [{"role": "user", "content": "test"}],
        "stream": True,
    })
    missing = str(tmp_path / "no-such-checkout")
    request = _FakeRequest({
        "authorization": "Bearer test",
        "x-hermes-repo-root": missing,
        "x-hermes-execution-mode": "acp",
    })

    def _boom():
        import errno
        raise FileNotFoundError(errno.ENOENT, "cwd does not exist")

    with patch.dict(sys.modules, {"acp_transport": fake.module()}), \
         patch.object(main.os, "getcwd", side_effect=_boom):
        response, _payload = asyncio.run(_invoke_chat_and_read_stream(request, body))

    assert response.status_code == 200
    assert _FakeAcpTransport.last_kwargs["cwd"] == main.os.path.expanduser("~")


def test_healthy_getcwd_still_used_when_no_repo_header():
    """Sanity: with a working os.getcwd() and no repo header, cwd == getcwd()."""
    fake = _FakeAcpTransport()

    body = main.ChatCompletionRequest.model_validate({
        "model": "auto",
        "messages": [{"role": "user", "content": "test"}],
        "stream": True,
    })
    request = _FakeRequest({"authorization": "Bearer test", "x-hermes-execution-mode": "acp"})

    with patch.dict(sys.modules, {"acp_transport": fake.module()}), \
         patch.object(main.os, "getcwd", return_value="/normal/working/dir"):
        response, _payload = asyncio.run(_invoke_chat_and_read_stream(request, body))

    assert response.status_code == 200
    assert _FakeAcpTransport.last_kwargs["cwd"] == "/normal/working/dir"


# ── ACP repo-context preamble (Sep 2026 "every read fails / read: ?") ────────
# The ACP transport forwards only the last user message to hermes-acp, so repo
# signals that arrived as headers/body never reached the model and its first
# tool batch was context-free probing (read_file with empty args). The bridge
# now inlines a short preamble (owner/name, checkout path, capped file tree).

def _acp_body(content="Analyze this for optimizations", **extra):
    payload = {
        "model": "auto",
        "messages": [{"role": "user", "content": content}],
        "stream": True,
    }
    payload.update(extra)
    return main.ChatCompletionRequest.model_validate(payload)


def _run_acp_prompt(request, body):
    fake = _FakeAcpTransport()
    _FakeAcpTransport.last_kwargs = None
    with patch.dict(sys.modules, {"acp_transport": fake.module()}):
        response, _payload = asyncio.run(_invoke_chat_and_read_stream(request, body))
    assert response.status_code == 200
    return _FakeAcpTransport.last_kwargs


def test_no_repo_signals_leaves_prompt_untouched():
    """Non-repo turns must stay byte-identical to before the preamble."""
    request = _FakeRequest({"authorization": "Bearer test", "x-hermes-execution-mode": "acp"})
    kwargs = _run_acp_prompt(request, _acp_body())
    assert kwargs["user_message"] == "Analyze this for optimizations"


def test_repo_headers_are_inlined_into_prompt():
    """Owner/name + repo-root header reach the model as a preamble."""
    request = _FakeRequest({
        "authorization": "Bearer test",
        "x-hermes-execution-mode": "acp",
        "x-hermes-repo-owner": "DevvGwardo",
        "x-hermes-repo-name": "grok-glm-flash",
        "x-hermes-repo-root": "/Users/devgwardo/.cloudchat/repos/DevvGwardo/grok-glm-flash",
    })
    kwargs = _run_acp_prompt(request, _acp_body())
    prompt = kwargs["user_message"]
    assert "DevvGwardo/grok-glm-flash" in prompt
    assert "/Users/devgwardo/.cloudchat/repos/DevvGwardo/grok-glm-flash" in prompt
    assert prompt.endswith("Analyze this for optimizations")


def test_repo_file_tree_is_inlined_and_capped():
    """A forwarded file tree gives the model real paths (bounded)."""
    tree = [f"src/file{i}.ts" for i in range(400)] + ["package.json", "README.md"]
    request = _FakeRequest({
        "authorization": "Bearer test",
        "x-hermes-execution-mode": "acp",
        "x-hermes-repo-owner": "DevvGwardo",
        "x-hermes-repo-name": "grok-glm-flash",
        "x-hermes-repo-root": "/repo",
    })
    kwargs = _run_acp_prompt(request, _acp_body(repo_file_tree=tree))
    prompt = kwargs["user_message"]
    assert "Known files" in prompt
    assert "- src/file0.ts" in prompt
    assert "- src/file399.ts" not in prompt  # capped at the preview limit
    assert f"{len(tree)} total" in prompt


def test_prefix_builder_empty_without_signals():
    assert main._build_acp_repo_context_prefix() == ""
    assert main._build_acp_repo_context_prefix(repo_owner="", repo_name="") == ""


def test_prefix_builder_ignores_non_string_tree_entries():
    prefix = main._build_acp_repo_context_prefix(
        repo_owner="o", repo_name="n", repo_root="/repo",
        repo_file_tree=["a.ts", None, 42, ""],
    )
    assert "- a.ts" in prefix
    assert "None" not in prefix


# ── ACP tool_end output cap (Wave2: mirror agent-loop limits on SSE) ─────────
# The agent-loop path caps tool_end payloads (500 chars default; 4000 for
# todo/delegate_task/process/terminal — main.py on_tool_end). The ACP path
# must apply the same bound before forwarding tool output to SSE
# tool_activity events, or one large read ships the whole file to the client.

def test_acp_tool_end_chat_content_stays_bounded():
    """The SSE chat-content half never embeds raw output (summary note only)."""
    note = main._format_tool_end_text("read_file", "x" * 100_000)
    assert len(note) < 500
    assert "x" * 1000 not in note


def test_acp_tool_end_sse_output_mirrors_agent_loop_cap():
    """A 100KB ACP tool result must reach SSE tool_activity capped at the
    agent-loop default (500 chars; 4000 for todo/delegate_task/process/
    terminal)."""
    huge = "y" * 100_000

    class _HugeOutputTransport(_FakeAcpTransport):
        def _run_prompt_blocking(self, **kwargs):
            emit = kwargs.get("emit")
            if emit:
                emit("tool_end", "read_file", '{"path": "big.txt"}', huge)
                emit("done", {"stop": True})

    request = _FakeRequest({
        "authorization": "Bearer test", "x-hermes-execution-mode": "acp",
    })
    with patch.dict(sys.modules, {"acp_transport": _HugeOutputTransport().module()}):
        response, payload = asyncio.run(
            _invoke_chat_and_read_stream(request, _acp_body())
        )
    assert response.status_code == 200
    outputs = []
    for line in payload.decode().splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        try:
            data = json.loads(line[5:])
        except (ValueError, TypeError):
            continue
        ta = ((data.get("choices") or [{}])[0].get("delta") or {}).get("tool_activity")
        if ta and ta.get("status") == "completed":
            outputs.append(ta.get("output") or "")
    assert outputs, "expected a completed tool_activity event in the SSE stream"
    for out in outputs:
        assert len(out) <= 500, (
            f"ACP tool_activity output uncapped ({len(out)} chars; "
            "agent-loop caps at 500)"
        )


# ── Missing-checkout warning (B3: loud failure, not blind probing) ───────────
# A repo turn with no resolvable checkout must warn visibly instead of running
# in an unrelated cwd where every relative read misses.

def test_cwd_warning_fires_on_unresolved_repo_signal():
    warning = main._cwd_missing_warning(
        resolved_repo_root="",
        repo_owner="DevvGwardo",
        repo_name="grok-glm-flash",
    )
    assert warning is not None
    assert "No local checkout found" in warning
    assert "DevvGwardo/grok-glm-flash" in warning


def test_cwd_warning_quiet_when_resolved_or_non_repo():
    assert main._cwd_missing_warning(resolved_repo_root="/repo/a", repo_owner="o", repo_name="n") is None
    assert main._cwd_missing_warning() is None
    assert main._cwd_missing_warning(repo_owner="", repo_name="") is None


def test_cwd_warning_fires_on_tree_only_signal():
    warning = main._cwd_missing_warning(repo_file_tree=["src/a.ts"])
    assert warning is not None
    assert "No local checkout found" in warning
