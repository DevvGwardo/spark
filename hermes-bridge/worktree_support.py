"""
Git worktree isolation for hermes-bridge (Phase 8.3).

Reuses Hermes CLI's ``_setup_worktree`` so bridge/kanban runs match
``hermes --worktree`` behavior without shelling a new CLI process.

Residual gaps:
- Without gateway ``runs_parity`` / ``HERMES_RUNS_PARITY=1``, worktree cwd still forces agent-loop.
- Swarm mode does not support worktree isolation yet.
- Unpushed commits in a worktree are preserved by Hermes CLI cleanup (by design).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

_HERMES_AGENT_DIR = os.environ.get(
    "HERMES_AGENT_DIR",
    os.path.expanduser("~/.hermes/hermes-agent"),
)

# Local toolsets repo-mode normally blocks; worktree mode re-enables them.
WORKTREE_LOCAL_TOOLSETS = ("terminal", "files", "code_execution", "computer")

# Worktrees created by Hermes CLI use this prefix under .worktrees/
_WORKTREE_DIR_PREFIX = "hermes-"

_session_worktrees: list[dict[str, Any]] = []
_active_worktree: Optional[dict[str, Any]] = None


def worktree_requested(header_value: Optional[str] = None) -> bool:
    """True when X-Hermes-Worktree or HERMES_WORKTREE env requests isolation."""
    if (header_value or "").strip().lower() in ("1", "true", "yes"):
        return True
    return os.environ.get("HERMES_WORKTREE", "").strip().lower() in ("1", "true", "yes")


def is_worktree_active() -> bool:
    """True when a worktree was created and is still tracked this session."""
    return _active_worktree is not None


def get_active_worktree() -> Optional[dict[str, Any]]:
    """Return metadata for the active worktree, if any."""
    return dict(_active_worktree) if _active_worktree else None


def adjust_toolsets_for_worktree(enabled_toolsets: list[str]) -> list[str]:
    """Re-enable local filesystem toolsets when worktree isolation is active."""
    result = list(enabled_toolsets)
    for toolset in WORKTREE_LOCAL_TOOLSETS:
        if toolset not in result:
            result.append(toolset)
    return result


def _import_cli():
    if _HERMES_AGENT_DIR not in sys.path:
        sys.path.insert(0, _HERMES_AGENT_DIR)
    import cli  # type: ignore[import-not-found]

    return cli


def _track_worktree(info: dict[str, Any]) -> None:
    global _active_worktree
    _active_worktree = info
    if info not in _session_worktrees:
        _session_worktrees.append(info)


def _untrack_worktree(info: dict[str, Any]) -> None:
    global _active_worktree
    try:
        _session_worktrees.remove(info)
    except ValueError:
        pass
    if _active_worktree is info:
        _active_worktree = _session_worktrees[-1] if _session_worktrees else None


def _path_created_by_bridge(wt_path: str) -> bool:
    """Only remove worktree paths we created (hermes-* under .worktrees/)."""
    try:
        resolved = Path(wt_path).resolve()
        parts = resolved.parts
        if len(parts) < 2:
            return False
        return parts[-2] == ".worktrees" and parts[-1].startswith(_WORKTREE_DIR_PREFIX)
    except (OSError, ValueError):
        return False


def _manual_cleanup_worktree(info: dict[str, Any]) -> bool:
    """Fallback cleanup when Hermes CLI helper is unavailable."""
    wt_path = str(info.get("path") or "").strip()
    branch = str(info.get("branch") or "").strip()
    repo_root = str(info.get("repo_root") or "").strip()

    if not wt_path or not _path_created_by_bridge(wt_path):
        print(f"[worktree] Skipping manual cleanup — path not bridge-owned: {wt_path}", flush=True)
        return False

    if not Path(wt_path).exists():
        return True

    if repo_root:
        try:
            subprocess.run(
                ["git", "worktree", "unlock", wt_path],
                capture_output=True,
                text=True,
                timeout=10,
                cwd=repo_root,
            )
            subprocess.run(
                ["git", "worktree", "remove", wt_path, "--force"],
                capture_output=True,
                text=True,
                timeout=15,
                cwd=repo_root,
            )
        except Exception as exc:  # noqa: BLE001 - cleanup is best-effort; failure is logged
            print(f"[worktree] git worktree remove failed: {exc}", flush=True)

    if Path(wt_path).exists():
        try:
            shutil.rmtree(wt_path)
        except Exception as exc:  # noqa: BLE001 - failure is logged and reported via return value
            print(f"[worktree] shutil.rmtree failed: {exc}", flush=True)
            return False

    if repo_root and branch:
        try:
            subprocess.run(
                ["git", "branch", "-D", branch],
                capture_output=True,
                text=True,
                timeout=10,
                cwd=repo_root,
            )
        except Exception as exc:  # noqa: BLE001 - cleanup is best-effort; failure is logged
            print(f"[worktree] branch delete failed: {exc}", flush=True)

    print(f"[worktree] Manual cleanup complete: {wt_path}", flush=True)
    return True


def cleanup_worktree(info: Optional[dict[str, Any]] = None) -> bool:
    """
    Remove a worktree created this session.

    Prefers Hermes CLI ``_cleanup_worktree`` (preserves unpushed commits).
    Falls back to git worktree remove + shutil.rmtree for bridge-owned paths.
    """
    target = info or _active_worktree
    if not target:
        return False

    cleaned = False
    try:
        cli = _import_cli()
        cleanup_fn = getattr(cli, "_cleanup_worktree", None)
        if callable(cleanup_fn):
            cleanup_fn(target)
            cleaned = not Path(str(target.get("path") or "")).exists()
    except Exception as exc:  # noqa: BLE001 - CLI cleanup is best-effort; failure is logged and manual cleanup follows
        print(f"[worktree] CLI cleanup failed: {exc}", flush=True)

    if not cleaned:
        cleaned = _manual_cleanup_worktree(target)

    if cleaned:
        _untrack_worktree(target)
    return cleaned


def cleanup_session_worktrees() -> int:
    """Remove all worktrees tracked this session. Returns count cleaned."""
    cleaned = 0
    for info in list(_session_worktrees):
        if cleanup_worktree(info):
            cleaned += 1
    return cleaned


def maybe_setup_worktree(repo_root: Optional[str] = None) -> Optional[dict[str, Any]]:
    """
    Create an isolated git worktree and chdir into it.

    Returns worktree metadata on success, None if skipped or failed.

    When active, callers should:
    - pass ``worktree_mode=True`` to the agent adapter (disables GitHub API repo tools)
    - call ``adjust_toolsets_for_worktree`` on enabled toolsets (re-enables local files)
    - call ``cleanup_worktree`` in a finally block when the run ends
    """
    cli = _import_cli()
    root = (repo_root or "").strip() or cli._git_repo_root()
    if not root:
        print("[worktree] Requested but no git repository root found", flush=True)
        return None

    info = cli._setup_worktree(repo_root=root)
    if not info or not info.get("path"):
        print(f"[worktree] Setup failed for repo root {root}", flush=True)
        return None

    os.chdir(info["path"])
    _track_worktree(info)
    print(
        f"[worktree] Agent cwd → {info['path']} (branch {info.get('branch', '?')})",
        flush=True,
    )
    return info
